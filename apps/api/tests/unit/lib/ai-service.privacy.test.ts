/**
 * Story 7.12.2 — AIService is the last place a provider error is seen before it is logged, stored
 * and written to the ticket history. Its logs must carry codes and identifiers only: the message
 * of a failed call can quote the customer's ticket or the whole prompt.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockTriage = vi.hoisted(() => vi.fn());
const backup = vi.hoisted(() => ({ configured: false }));

vi.mock('../../../src/lib/llm-client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/lib/llm-client.js')>();
  return {
    ...real,
    triage: mockTriage,
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

const SENTINEL = 'SENTINEL-PRIV-7F2C';

let logged: string;

beforeEach(() => {
  logged = '';
  backup.configured = false;
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      logged += `${JSON.stringify(args)}\n`;
    });
  }
  vi.clearAllMocks();
});

describe('AIService log boundary (story 7.12.2)', () => {
  it('keeps provider error text out of the log when the call fails and no backup is configured', async () => {
    mockTriage.mockRejectedValueOnce(
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
    mockTriage.mockRejectedValueOnce(
      new LlmCallError('http_error', `primary failed: 500 {"error":"${SENTINEL}"}`, 500)
    );
    mockTriage.mockRejectedValueOnce(new LlmCallError('timeout', `backup failed: ${SENTINEL}`));
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
    mockTriage.mockRejectedValueOnce(new LlmCallError('network_error', `boom ${SENTINEL}`));
    const recorder = vi.fn().mockRejectedValue(new Error('DB unavailable'));

    await new AIService(recorder)
      .triage('ticket-2', 'Subject', 'Description')
      .catch(() => undefined);

    expect(logged).not.toContain(SENTINEL);
  });
});
