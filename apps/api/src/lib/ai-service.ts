import type { ProcessingResult } from '../domain/ticket-phases.js';
import {
  type AiInteractionRecord,
  type AiOperation,
  insertAiInteraction,
} from '../repositories/ai-interactions.js';
import {
  draft as draftLlm,
  getBackupProvider,
  getPrimaryProvider,
  isBackupConfigured,
  LlmCallError,
  type LlmOutcome,
  type LlmProvider,
  triage as triageLlm,
  type TriageOutput,
} from './llm-client.js';
import { logger } from './logger.js';
import { assertLlmSpendAllowed } from './spend-guard.js';

type TriageResult = Omit<ProcessingResult, 'customerReply' | 'internalNote' | 'nextSteps'>;
type DraftResult = { customerReply: string; internalNote: string; nextSteps: string[] };
type AiInteractionRecorder = (record: AiInteractionRecord) => Promise<void>;

export class AIService {
  constructor(private readonly recorder: AiInteractionRecorder = insertAiInteraction) {}

  private async recordInteraction(record: AiInteractionRecord): Promise<void> {
    try {
      await this.recorder(record);
    } catch (err) {
      // The record itself holds only ids and codes; the database error's text is not logged.
      logger.error(
        { ticketId: record.ticketId, operation: record.operation, errName: errorName(err) },
        'Failed to persist AI interaction record'
      );
    }
  }

  private async attempt<T>(
    ticketId: string,
    operation: AiOperation,
    provider: LlmProvider,
    call: () => Promise<{
      output: T;
      usage: { promptTokens: number | null; completionTokens: number | null };
    }>
  ): Promise<T> {
    // Story 7.12.7: the spend guard runs immediately before every provider call, primary or
    // backup, so a cap reached mid-ticket stops here rather than at the next ticket. It sits
    // outside the try below on purpose: a refusal is not a provider outcome, so it records no
    // AI interaction and is never reported as a network error. The call itself is never made.
    await assertLlmSpendAllowed();
    const start = performance.now();
    try {
      const { output, usage } = await call();
      const durationMs = Math.round(performance.now() - start);
      await this.recordInteraction({
        ticketId,
        operation,
        provider: provider.name,
        model: provider.model,
        outcome: 'success',
        durationMs,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
      });
      logger.info(
        { ticketId, operation, provider: provider.name, model: provider.model, durationMs },
        'AI call succeeded'
      );
      return output;
    } catch (err) {
      const durationMs = Math.round(performance.now() - start);
      const outcome = err instanceof LlmCallError ? err.outcome : 'network_error';
      const httpStatus = err instanceof LlmCallError ? err.httpStatus : undefined;
      // Only an LlmCallError's message is built from fixed codes. Anything else can carry the
      // provider's own text, so only its name is recorded (story 7.12.2).
      const errorMessage = err instanceof LlmCallError ? err.message : errorName(err);
      await this.recordInteraction({
        ticketId,
        operation,
        provider: provider.name,
        model: provider.model,
        outcome,
        durationMs,
        httpStatus,
        errorMessage,
      });
      logger.warn(
        {
          ticketId,
          operation,
          provider: provider.name,
          model: provider.model,
          durationMs,
          outcome,
          httpStatus,
          errName: errorName(err),
        },
        'AI call failed'
      );
      throw err;
    }
  }

  async triage(ticketId: string, subject: string, description: string): Promise<TriageResult> {
    const primary = getPrimaryProvider();

    try {
      const output = await this.attempt(ticketId, 'triage', primary, () =>
        triageLlm(primary, subject, description)
      );
      return mapTriageOutput(output);
    } catch (primaryError) {
      if (!isBackupConfigured()) {
        logger.warn(
          { ticketId, operation: 'triage', outcome: errorOutcome(primaryError) },
          'Primary AI service failed and backup is not configured'
        );
        throw primaryError;
      }

      logger.warn(
        { ticketId, operation: 'triage', outcome: errorOutcome(primaryError) },
        'Primary AI service failed, trying backup'
      );
      const backup = getBackupProvider();
      try {
        const output = await this.attempt(ticketId, 'triage', backup, () =>
          triageLlm(backup, subject, description)
        );
        logger.info({ ticketId, operation: 'triage' }, 'Backup AI service succeeded');
        return mapTriageOutput(output);
      } catch (backupError) {
        logger.error(
          {
            ticketId,
            operation: 'triage',
            primaryOutcome: errorOutcome(primaryError),
            backupOutcome: errorOutcome(backupError),
          },
          'Both primary and backup AI services failed'
        );
        throw primaryError; // Throw primary error to maintain existing behavior
      }
    }
  }

  async draft(
    ticketId: string,
    subject: string,
    description: string,
    triage: TriageResult
  ): Promise<DraftResult> {
    const triageOutput: TriageOutput = {
      category: triage.category,
      priority: triage.priority as TriageOutput['priority'],
      sentiment: triage.sentiment as TriageOutput['sentiment'],
      escalate: triage.escalate,
      recommended_team: triage.recommendedTeam,
      issue_summary: triage.issueSummary,
    };

    const primary = getPrimaryProvider();

    try {
      const output = await this.attempt(ticketId, 'draft', primary, () =>
        draftLlm(primary, subject, description, triageOutput)
      );
      return mapDraftOutput(output);
    } catch (primaryError) {
      if (!isBackupConfigured()) {
        logger.warn(
          { ticketId, operation: 'draft', outcome: errorOutcome(primaryError) },
          'Primary AI service failed and backup is not configured'
        );
        throw primaryError;
      }

      logger.warn(
        { ticketId, operation: 'draft', outcome: errorOutcome(primaryError) },
        'Primary AI service failed, trying backup'
      );
      const backup = getBackupProvider();
      try {
        const output = await this.attempt(ticketId, 'draft', backup, () =>
          draftLlm(backup, subject, description, triageOutput)
        );
        logger.info({ ticketId, operation: 'draft' }, 'Backup AI service succeeded');
        return mapDraftOutput(output);
      } catch (backupError) {
        logger.error(
          {
            ticketId,
            operation: 'draft',
            primaryOutcome: errorOutcome(primaryError),
            backupOutcome: errorOutcome(backupError),
          },
          'Both primary and backup AI services failed'
        );
        throw primaryError; // Throw primary error to maintain existing behavior
      }
    }
  }
}

/** A fixed code for the log: never an error's own message, which can quote untrusted text. */
function errorName(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name ? name : 'Error';
}

function errorOutcome(err: unknown): LlmOutcome {
  return err instanceof LlmCallError ? err.outcome : 'network_error';
}

function mapTriageOutput(triageOutput: TriageOutput): TriageResult {
  return {
    category: triageOutput.category,
    priority: triageOutput.priority,
    sentiment: triageOutput.sentiment,
    escalate: triageOutput.escalate,
    recommendedTeam: triageOutput.recommended_team,
    issueSummary: triageOutput.issue_summary,
  };
}

function mapDraftOutput(draftOutput: {
  customer_reply: string;
  internal_note: string;
  next_steps: string[];
}): DraftResult {
  return {
    customerReply: draftOutput.customer_reply,
    internalNote: draftOutput.internal_note,
    nextSteps: draftOutput.next_steps,
  };
}
