/**
 * Story 7.12.2 — AIService is the last place a provider error is seen before it is logged, stored
 * and written to the ticket history. Its logs must carry codes and identifiers only: the message
 * of a failed call can quote the customer's ticket or the whole prompt.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockTriage = vi.hoisted(() => vi.fn());

vi.mock('../../../src/lib/llm-client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/lib/llm-client.js')>();
  return {
    ...real,
    triage: mockTriage,
    isBackupConfigured: () => false,
    getPrimaryProvider: () => ({
      name: 'primary',
      gateway: 'groq',
      apiKey: 'primary-key',
      model: 'primary-model',
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
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      logged += `${JSON.stringify(args)}\n`;
    });
  }
  vi.clearAllMocks();
});

describe('AIService log boundary (story 7.12.2)', () => {
  it('keeps provider error text out of the log when both the call and the backup fail', async () => {
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

  it('keeps provider error text out of the log when recording the interaction fails', async () => {
    mockTriage.mockRejectedValueOnce(new LlmCallError('network_error', `boom ${SENTINEL}`));
    const recorder = vi.fn().mockRejectedValue(new Error('DB unavailable'));

    await new AIService(recorder)
      .triage('ticket-2', 'Subject', 'Description')
      .catch(() => undefined);

    expect(logged).not.toContain(SENTINEL);
  });
});
