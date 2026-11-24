/**
 * Story 7.12.8 AI safety — provider and Portkey outage behaviour, end to end through AIService
 * against a stubbed `fetch`. Every case here is deterministic: no live provider is contacted.
 *
 * The contract under test:
 *  - a failing primary is retried once on the backup, and a ticket is not lost
 *  - both failing (or Portkey itself failing) surfaces one LlmCallError, no crash
 *  - the error a caller sees carries codes only, never a provider body, key or prompt text
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SENTINEL = 'SENTINEL-OUTAGE-9C1E';
const PRIMARY_KEY = 'gsk_primary_secret_key_value';
const BACKUP_KEY = 'gsk_backup_secret_key_value';

const mockIsBackupConfigured = vi.hoisted(() => vi.fn());
const mockGetPrimary = vi.hoisted(() => vi.fn());
const mockGetBackup = vi.hoisted(() => vi.fn());

vi.mock('../../../src/lib/llm-client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/lib/llm-client.js')>();
  return {
    ...real,
    isBackupConfigured: mockIsBackupConfigured,
    getPrimaryProvider: mockGetPrimary,
    getBackupProvider: mockGetBackup,
  };
});

import { AIService } from '../../../src/lib/ai-service.js';
import { LlmCallError } from '../../../src/lib/llm-client.js';
import type { AiInteractionRecord } from '../../../src/repositories/ai-interactions.js';

const TRIAGE_OUTPUT = {
  category: 'technical',
  priority: 'high',
  sentiment: 'frustrated',
  escalate: false,
  recommended_team: 'tech-support',
  issue_summary: 'Customer cannot log in',
};

function okResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { function_call: { arguments: JSON.stringify(TRIAGE_OUTPUT) } } }],
      usage: { prompt_tokens: 5, completion_tokens: 7 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

beforeEach(() => {
  vi.stubEnv('LLM_MODE', 'real');
  vi.stubEnv('AI_TIMEOUT_MS', '5000');
  mockIsBackupConfigured.mockReturnValue(true);
  mockGetPrimary.mockReturnValue({
    name: 'primary',
    gateway: 'groq',
    apiKey: PRIMARY_KEY,
    model: 'primary-model',
  });
  mockGetBackup.mockReturnValue({
    name: 'backup',
    gateway: 'google',
    apiKey: BACKUP_KEY,
    model: 'backup-model',
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

type Recorder = ReturnType<typeof vi.fn>;

function recorder(): Recorder {
  return vi.fn().mockResolvedValue(undefined);
}

function records(fn: Recorder): AiInteractionRecord[] {
  return fn.mock.calls.map(([r]) => r as AiInteractionRecord);
}

function asRecorder(rec: Recorder): (record: AiInteractionRecord) => Promise<void> {
  return rec as unknown as (record: AiInteractionRecord) => Promise<void>;
}

async function triageError(fetchMock: unknown, rec: Recorder = recorder()): Promise<LlmCallError> {
  vi.stubGlobal('fetch', fetchMock);
  const err = await new AIService(asRecorder(rec))
    .triage('ticket-1', 'Subject', 'Description')
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(LlmCallError);
  return err as LlmCallError;
}

describe('primary outage falls back to the backup (story 7.12.8)', () => {
  it.each([
    ['HTTP 429', () => new Response('rate limited', { status: 429 })],
    ['HTTP 500', () => new Response('boom', { status: 500 })],
    ['HTTP 502', () => new Response('bad gateway', { status: 502 })],
    ['HTTP 503', () => new Response('unavailable', { status: 503 })],
    ['a network error', () => Promise.reject(new Error('ECONNRESET'))],
    ['a malformed body', () => new Response('<html>nope</html>', { status: 200 })],
  ])('recovers on the backup after primary %s and keeps the ticket', async (_label, primary) => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => {
        const r = primary();
        return r instanceof Promise ? r : Promise.resolve(r);
      })
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal('fetch', fetchMock);
    const rec = recorder();

    const result = await new AIService(asRecorder(rec)).triage(
      'ticket-1',
      'Subject',
      'Description'
    );

    expect(result.category).toBe(TRIAGE_OUTPUT.category);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(records(rec).map((r) => [r.provider, r.outcome])).toEqual([
      ['primary', expect.not.stringMatching(/^success$/)],
      ['backup', 'success'],
    ]);
  });

  it('treats a primary timeout as recoverable on the backup', async () => {
    const timeoutError = new Error('The operation timed out');
    timeoutError.name = 'TimeoutError';
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal('fetch', fetchMock);
    const rec = recorder();

    const result = await new AIService(asRecorder(rec)).triage(
      'ticket-1',
      'Subject',
      'Description'
    );

    expect(result.category).toBe(TRIAGE_OUTPUT.category);
    expect(records(rec).map((r) => r.outcome)).toEqual(['timeout', 'success']);
  });

  it('treats a schema-invalid primary response as recoverable on the backup', async () => {
    const bad = new Response(
      JSON.stringify({
        choices: [{ message: { function_call: { arguments: JSON.stringify({ category: 'x' }) } } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(okResponse());
    vi.stubGlobal('fetch', fetchMock);
    const rec = recorder();

    await new AIService(asRecorder(rec)).triage('ticket-1', 'Subject', 'Description');

    expect(records(rec).map((r) => r.outcome)).toEqual(['invalid_response', 'success']);
  });
});

describe('double failure surfaces one coded error (story 7.12.8)', () => {
  it('throws the primary error after recording both attempts, without crashing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('primary says ' + SENTINEL, { status: 500 }))
      .mockResolvedValueOnce(new Response('backup says ' + SENTINEL, { status: 503 }));
    const rec = recorder();

    const err = await triageError(fetchMock, rec);

    expect(err.outcome).toBe('http_error');
    expect(err.httpStatus).toBe(500);
    expect(records(rec).map((r) => [r.provider, r.outcome])).toEqual([
      ['primary', 'http_error'],
      ['backup', 'http_error'],
    ]);
  });

  it('leaks no provider body, API key or prompt text in the surfaced error', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error(`connect failed for ${PRIMARY_KEY}`))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: SENTINEL }), { status: 500 }));

    const err = await triageError(fetchMock);
    const wire = `${err.message} ${err.name} ${JSON.stringify(err)}`;

    expect(wire).not.toContain(SENTINEL);
    expect(wire).not.toContain(PRIMARY_KEY);
    expect(wire).not.toContain(BACKUP_KEY);
    expect(wire).not.toContain('Subject');
    expect(wire).not.toContain('Description');
  });

  it('skips the backup entirely when none is configured and still surfaces one coded error', async () => {
    mockIsBackupConfigured.mockReturnValue(false);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('nope', { status: 500 }));
    const rec = recorder();

    const err = await triageError(fetchMock, rec);

    expect(err.outcome).toBe('http_error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(records(rec)).toHaveLength(1);
  });

  it.each([
    ['an empty JSON object', {}],
    ['JSON without choices', { usage: { prompt_tokens: 1 } }],
    ['choices that is not an array', { choices: null }],
  ])('reports %s as a coded invalid_response, never an uncaught TypeError', async (_l, body) => {
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );
    const rec = recorder();
    vi.stubGlobal('fetch', fetchMock);
    const err = await new AIService(asRecorder(rec))
      .triage('ticket-1', 'Subject', 'Description')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LlmCallError);
    expect((err as LlmCallError).outcome).toBe('invalid_response');
    expect(records(rec).every((r) => r.outcome === 'invalid_response')).toBe(true);
  });

  it('records a Portkey gateway outage as a network error, not a crash', async () => {
    const portkeyDown = Object.assign(new Error('getaddrinfo ENOTFOUND api.portkey.ai'), {
      code: 'ENOTFOUND',
    });
    const fetchMock = vi.fn().mockRejectedValue(portkeyDown);
    const rec = recorder();

    const err = await triageError(fetchMock, rec);

    expect(err.outcome).toBe('network_error');
    expect(err.message).toContain('ENOTFOUND');
    expect(records(rec).every((r) => r.outcome === 'network_error')).toBe(true);
  });
});
