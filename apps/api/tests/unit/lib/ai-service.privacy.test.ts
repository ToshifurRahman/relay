/**
 * Story 7.12.2 — AIService is the last place a provider error is seen before it is logged, stored
 * and written to the ticket history. Both boundaries matter: the log line must carry codes and
 * identifiers only, and the `ai_interactions.error_message` it hands the recorder must not carry
 * the provider's text either. A failed call's message can quote the customer's ticket or the
 * whole prompt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const triageStub = vi.hoisted(() => ({
  impl: null as null | ((...args: unknown[]) => Promise<unknown>),
}));
const backup = vi.hoisted(() => ({ configured: false }));

// Only the provider lookup and the backup switch are replaced. `triage` delegates to the real
// implementation unless a test queues a rejection, so the stored-error tests below run the real
// `llm-client` path against a stubbed `fetch`.
vi.mock('../../../src/lib/llm-client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/lib/llm-client.js')>();
  return {
    ...real,
    triage: (...args: unknown[]) => {
      if (triageStub.impl) return triageStub.impl(...args);
      return real.triage(...(args as Parameters<typeof real.triage>));
    },
    isBackupConfigured: () => backup.configured,
    getPrimaryProvider: () => ({
      name: 'primary',
      gateway: 'groq',
      apiKey: 'primary-key',
      model: 'primary-model',
    }),
    getBackupProvider: () => ({
      name: 'backup',
      gateway: 'google',
      apiKey: 'backup-key',
      model: 'backup-model',
    }),
  };
});

import { AIService } from '../../../src/lib/ai-service.js';
import { LlmCallError } from '../../../src/lib/llm-client.js';
import { logger } from '../../../src/lib/logger.js';
import type { AiInteractionRecord } from '../../../src/repositories/ai-interactions.js';

const SENTINEL = 'SENTINEL-PRIV-7F2C';

let logged: string;

beforeEach(() => {
  logged = '';
  backup.configured = false;
  triageStub.impl = null;
  // Hermetic: a shell that exports LLM_MODE=fake would otherwise short-circuit the real
  // `llm-client` path the stored-error tests exist to exercise.
  vi.stubEnv('LLM_MODE', 'real');
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      logged += `${JSON.stringify(args)}\n`;
    });
  }
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function recorded(recorder: ReturnType<typeof vi.fn>): AiInteractionRecord[] {
  return recorder.mock.calls.map(([record]) => record as AiInteractionRecord);
}

describe('AIService log boundary (story 7.12.2)', () => {
  // These three isolate the log boundary: `triage` is mocked to reject with an already-built
  // `LlmCallError`, so they prove nothing about what the recorder stores. The stored-error
  // boundary is covered below by the tests that run the real `llm-client`.
  it('keeps provider error text out of the log when the call fails and no backup is configured', async () => {
    triageStub.impl = () =>
      Promise.reject(
        new LlmCallError('http_error', `LLM call failed: 400 {"error":"${SENTINEL}"}`, 400)
      );
    const recorder = vi.fn().mockResolvedValue(undefined);

    await new AIService(recorder)
      .triage('ticket-1', 'Subject', 'Description')
      .catch(() => undefined);

    expect(logged).not.toContain(SENTINEL);
    // The cause is still identifiable without the text.
    expect(logged).toContain('http_error');
  });

  it('logs outcome codes only when both the primary and the backup fail', async () => {
    backup.configured = true;
    triageStub.impl = vi
      .fn()
      .mockRejectedValueOnce(
        new LlmCallError('http_error', `primary failed: 500 {"error":"${SENTINEL}"}`, 500)
      )
      .mockRejectedValueOnce(new LlmCallError('timeout', `backup failed: ${SENTINEL}`));
    const recorder = vi.fn().mockResolvedValue(undefined);

    await new AIService(recorder)
      .triage('ticket-3', 'Subject', 'Description')
      .catch(() => undefined);

    expect(logged).not.toContain(SENTINEL);
    // Both branches of the fallback were exercised and the both-fail line names each outcome.
    expect(logged).toContain('Both primary and backup AI services failed');
    expect(logged).toContain('primaryOutcome');
    expect(logged).toContain('backupOutcome');
    expect(logged).toContain('timeout');
  });

  it('keeps provider error text out of the log when recording the interaction fails', async () => {
    triageStub.impl = () => Promise.reject(new LlmCallError('network_error', `boom ${SENTINEL}`));
    const recorder = vi.fn().mockRejectedValue(new Error('DB unavailable'));

    await new AIService(recorder)
      .triage('ticket-2', 'Subject', 'Description')
      .catch(() => undefined);

    expect(logged).not.toContain(SENTINEL);
  });
});

describe('AIService stored-error boundary (story 7.12.2)', () => {
  it('stores codes, not the provider error body, when a real provider call fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: `your prompt was: ${SENTINEL} cannot sign in` }), {
          status: 400,
        })
      )
    );
    const recorder = vi.fn().mockResolvedValue(undefined);

    await new AIService(recorder)
      .triage('ticket-1', 'Subject', 'Description')
      .catch(() => undefined);

    expect(logged).not.toContain(SENTINEL);
    const [record] = recorded(recorder);
    expect(record).toBeDefined();
    expect(record.errorMessage).not.toContain(SENTINEL);
    // The cause stays identifiable without the text.
    expect(record.outcome).toBe('http_error');
    expect(record.httpStatus).toBe(400);
    expect(record.errorMessage).toContain('400');
  });

  it('stores only the error class for a plain Error thrown during triage', async () => {
    triageStub.impl = () => Promise.reject(new Error(`triage blew up: ${SENTINEL}`));
    const recorder = vi.fn().mockResolvedValue(undefined);

    await new AIService(recorder)
      .triage('ticket-2', 'Subject', 'Description')
      .catch(() => undefined);

    expect(logged).not.toContain(SENTINEL);
    const [record] = recorded(recorder);
    expect(record).toBeDefined();
    expect(record.errorMessage).not.toContain(SENTINEL);
    // A plain Error has no code, so the class name is all that is kept.
    expect(record.errorMessage).toBe('Error');
    expect(record.outcome).toBe('network_error');
  });
});
