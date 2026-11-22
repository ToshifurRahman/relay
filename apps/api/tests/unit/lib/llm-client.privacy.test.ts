/**
 * Story 7.12.2 — a provider's error body and the model's own output are untrusted text: they can
 * quote the customer's ticket, the whole prompt, or another ticket's content. `LlmCallError`'s
 * message is logged (Pino), stored in `ai_interactions.error_message` and written to
 * `ticket_events.detail`, so it may carry outcome codes only, never that text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LlmCallError, type LlmProvider, triage } from '../../../src/lib/llm-client.js';

// Planted in every place untrusted text can appear: the error body and the model's arguments.
const SENTINEL = 'SENTINEL-PRIV-7F2C';

const PROVIDER: LlmProvider = {
  name: 'primary',
  gateway: 'groq',
  apiKey: 'test-key',
  model: 'test-model',
};

beforeEach(() => {
  // Hermetic: a developer shell that exports LLM_MODE=fake would otherwise short-circuit the
  // fetch path these tests exist to exercise (see review-base-1.md).
  vi.stubEnv('LLM_MODE', 'real');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function failure(): Promise<LlmCallError> {
  const err = await triage(PROVIDER, 'Subject', 'Description').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(LlmCallError);
  return err as LlmCallError;
}

describe('LlmCallError carries no untrusted text (story 7.12.2)', () => {
  it('does not put the provider error body in the http_error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: `your prompt was: ${SENTINEL} cannot sign in` }), {
          status: 400,
        })
      )
    );

    const err = await failure();

    expect(err.outcome).toBe('http_error');
    expect(err.httpStatus).toBe(400);
    expect(err.message).not.toContain(SENTINEL);
    // Still diagnosable from the code alone.
    expect(err.message).toContain('400');
  });

  it('does not put the model arguments in a JSON parse error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          choices: [{ message: { function_call: { arguments: `{oops ${SENTINEL}` } } }],
        })
      )
    );

    const err = await failure();

    expect(err.outcome).toBe('invalid_response');
    expect(err.message).not.toContain(SENTINEL);
  });

  it('does not put received values in a schema validation error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          choices: [
            {
              message: {
                function_call: {
                  arguments: JSON.stringify({
                    category: SENTINEL,
                    priority: SENTINEL,
                    sentiment: 'neutral',
                    escalate: false,
                    recommended_team: 'support',
                    issue_summary: 'x',
                  }),
                },
              },
            },
          ],
        })
      )
    );

    const err = await failure();

    expect(err.outcome).toBe('invalid_response');
    expect(err.message).not.toContain(SENTINEL);
  });

  it('does not put an unparseable response body in the invalid_response message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(`<html>${SENTINEL}</html>`)));

    const err = await failure();

    expect(err.outcome).toBe('invalid_response');
    expect(err.message).not.toContain(SENTINEL);
  });

  it('serialises without the untrusted text, so a logger cannot leak it', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: `received '${SENTINEL}'` }), { status: 422 })
        )
    );

    const err = await failure();
    const asPinoWouldSerialiseIt = JSON.stringify({ type: err.name, message: err.message });

    expect(asPinoWouldSerialiseIt).not.toContain(SENTINEL);
    expect(err.httpStatus).toBe(422);
  });
});
