import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockTriage = vi.hoisted(() => vi.fn());
const mockDraft = vi.hoisted(() => vi.fn());
const mockIsBackupConfigured = vi.hoisted(() => vi.fn());
// Story 7.12.7: the guard is replaced here so a refusal can be placed exactly where a provider call
// would start. The three states of the real guard are covered by spend-guard.ops.test.ts.
const mockSpendGuard = vi.hoisted(() => vi.fn<() => Promise<void>>());

vi.mock('../../../src/lib/spend-guard.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/lib/spend-guard.js')>();
  return { ...real, assertLlmSpendAllowed: mockSpendGuard };
});

vi.mock('../../../src/lib/llm-client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/lib/llm-client.js')>();
  return {
    ...real,
    triage: mockTriage,
    draft: mockDraft,
    isBackupConfigured: mockIsBackupConfigured,
    getPrimaryProvider: () => ({
      name: 'primary',
      gateway: 'groq',
      apiKey: 'primary-key',
      model: 'primary-model',
    }),
    getBackupProvider: () => ({
      name: 'backup',
      gateway: 'groq',
      apiKey: 'backup-key',
      model: 'backup-model',
    }),
  };
});

import { AIService } from '../../../src/lib/ai-service.js';
import { LlmCallError } from '../../../src/lib/llm-client.js';
import { logger } from '../../../src/lib/logger.js';
import { LlmSpendCapReached } from '../../../src/lib/spend-guard.js';
import type { AiInteractionRecord } from '../../../src/repositories/ai-interactions.js';

const TRIAGE_OUTPUT = {
  category: 'technical',
  priority: 'high' as const,
  sentiment: 'frustrated' as const,
  escalate: false,
  recommended_team: 'tech-support',
  issue_summary: 'Customer cannot log in',
};

const DRAFT_OUTPUT = {
  customer_reply: 'We are looking into your login issue.',
  internal_note: 'Check auth service logs.',
  next_steps: ['Check auth logs', 'Reset session'],
};

function successResult<T>(output: T) {
  return { output, usage: { promptTokens: 10, completionTokens: 20 }, httpStatus: 200 };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsBackupConfigured.mockReturnValue(true);
  mockSpendGuard.mockResolvedValue(undefined);
});

describe('AIService.triage', () => {
  it('records a single success interaction when the primary provider succeeds', async () => {
    mockTriage.mockResolvedValueOnce(successResult(TRIAGE_OUTPUT));
    const recorder = vi.fn().mockResolvedValue(undefined);
    const service = new AIService(recorder);

    await service.triage('ticket-1', 'Subject', 'Description');

    expect(recorder).toHaveBeenCalledTimes(1);
    expect(recorder).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: 'ticket-1',
        operation: 'triage',
        provider: 'primary',
        outcome: 'success',
      })
    );
  });

  it('records a failure then a success when the backup rescues a failed primary', async () => {
    mockTriage
      .mockRejectedValueOnce(new LlmCallError('http_error', 'rate limited', 429))
      .mockResolvedValueOnce(successResult(TRIAGE_OUTPUT));
    const recorder = vi.fn().mockResolvedValue(undefined);
    const service = new AIService(recorder);

    const result = await service.triage('ticket-2', 'Subject', 'Description');

    expect(result.category).toBe(TRIAGE_OUTPUT.category);
    expect(recorder).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = recorder.mock.calls.map(([r]) => r as AiInteractionRecord);
    expect(firstCall).toMatchObject({
      provider: 'primary',
      outcome: 'http_error',
      httpStatus: 429,
    });
    expect(secondCall).toMatchObject({ provider: 'backup', outcome: 'success' });
  });

  it('records two failures and rethrows the primary error when both providers fail', async () => {
    mockTriage
      .mockRejectedValueOnce(new LlmCallError('network_error', 'primary down'))
      .mockRejectedValueOnce(new LlmCallError('network_error', 'backup down'));
    const recorder = vi.fn().mockResolvedValue(undefined);
    const service = new AIService(recorder);

    await expect(service.triage('ticket-3', 'Subject', 'Description')).rejects.toThrow(
      'primary down'
    );

    expect(recorder).toHaveBeenCalledTimes(2);
    const outcomes = recorder.mock.calls.map(([r]) => (r as AiInteractionRecord).outcome);
    expect(outcomes).toEqual(['network_error', 'network_error']);
  });

  it('records a single failure and skips the backup when it is not configured', async () => {
    mockIsBackupConfigured.mockReturnValue(false);
    mockTriage.mockRejectedValueOnce(new LlmCallError('timeout', 'timed out'));
    const recorder = vi.fn().mockResolvedValue(undefined);
    const service = new AIService(recorder);

    await expect(service.triage('ticket-4', 'Subject', 'Description')).rejects.toThrow('timed out');

    expect(recorder).toHaveBeenCalledTimes(1);
    expect(mockDraft).not.toHaveBeenCalled();
  });

  it('still returns the AI result when the recorder throws', async () => {
    mockTriage.mockResolvedValueOnce(successResult(TRIAGE_OUTPUT));
    const recorder = vi.fn().mockRejectedValue(new Error('DB unavailable'));
    const service = new AIService(recorder);

    const result = await service.triage('ticket-5', 'Subject', 'Description');

    expect(result.category).toBe(TRIAGE_OUTPUT.category);
  });
});

describe('AIService.draft', () => {
  const triageResult = {
    category: 'technical',
    priority: 'high',
    sentiment: 'frustrated',
    escalate: false,
    recommendedTeam: 'tech-support',
    issueSummary: 'Customer cannot log in',
  };

  it('records a single success interaction when the primary provider succeeds', async () => {
    mockDraft.mockResolvedValueOnce(successResult(DRAFT_OUTPUT));
    const recorder = vi.fn().mockResolvedValue(undefined);
    const service = new AIService(recorder);

    await service.draft('ticket-6', 'Subject', 'Description', triageResult);

    expect(recorder).toHaveBeenCalledTimes(1);
    expect(recorder).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketId: 'ticket-6',
        operation: 'draft',
        provider: 'primary',
        outcome: 'success',
      })
    );
  });
});

// Story 7.12.7: the guard must stop the call before either provider is reached. The unit tests in
// spend-guard.ops.test.ts prove the guard itself; these prove AIService consults it in the right
// place, once for the primary, so the backup is never tried and nothing is recorded.
describe('AIService with LLM spend capped', () => {
  const triageResult = {
    category: 'technical',
    priority: 'high',
    sentiment: 'frustrated',
    escalate: false,
    recommendedTeam: 'tech-support',
    issueSummary: 'Customer cannot log in',
  };

  it('refuses triage before the primary call and never reaches the backup', async () => {
    mockSpendGuard.mockRejectedValue(new LlmSpendCapReached('LLM spend is switched off'));

    const recorder = vi.fn().mockResolvedValue(undefined);
    const service = new AIService(recorder);

    await expect(service.triage('ticket-spend-1', 'Subject', 'Description')).rejects.toBeInstanceOf(
      LlmSpendCapReached
    );

    expect(mockTriage).not.toHaveBeenCalled();
    expect(mockSpendGuard).toHaveBeenCalledTimes(1);
    expect(recorder).not.toHaveBeenCalled();
    // The fallback is skipped outright, not merely attempted and refused again.
    expect(mockIsBackupConfigured).not.toHaveBeenCalled();
  });

  it('refuses the draft before the primary call, so a capped ticket writes no interaction', async () => {
    mockSpendGuard.mockRejectedValue(
      new LlmSpendCapReached('LLM daily spend cap reached (5 calls)')
    );

    const recorder = vi.fn().mockResolvedValue(undefined);
    const service = new AIService(recorder);

    await expect(
      service.draft('ticket-spend-2', 'Subject', 'Description', triageResult)
    ).rejects.toBeInstanceOf(LlmSpendCapReached);

    expect(mockDraft).not.toHaveBeenCalled();
    expect(mockSpendGuard).toHaveBeenCalledTimes(1);
    expect(recorder).not.toHaveBeenCalled();
  });

  it('logs the refusal as its own outcome, not as a network error', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    mockSpendGuard.mockRejectedValue(new LlmSpendCapReached('LLM spend is switched off'));

    const service = new AIService(vi.fn().mockResolvedValue(undefined));
    await expect(service.triage('ticket-spend-3', 'Subject', 'Description')).rejects.toBeInstanceOf(
      LlmSpendCapReached
    );

    const entries = warn.mock.calls.map((args) => JSON.stringify(args));
    expect(entries.some((line) => line.includes('spend_cap_reached'))).toBe(true);
    expect(entries.some((line) => line.includes('network_error'))).toBe(false);
    expect(entries.some((line) => line.includes('trying backup'))).toBe(false);
    warn.mockRestore();
  });
});
