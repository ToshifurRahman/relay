/**
 * Story 7.12.3 (REL-06), fix round 1. Three gaps in the first cut of the client timeout:
 *
 * 1. The 408 was not retryable. `query-client.ts` refuses to retry every 4xx, so a cold-start
 *    timeout ended on the error card with no automatic retry, which is the opposite of what the
 *    timeout is for. A timeout and a rate limit are both worth retrying; a 404 is not.
 * 2. The timeout covered only the wait for response headers. A server that sends headers and then
 *    stalls the body left the page loading forever.
 * 3. A caller signal that was already aborted never fired the `abort` listener, so the request
 *    was sent anyway.
 */
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';

import { server } from '@/test/server';

import { ApiError, request } from './api';
import { createQueryClient } from './query-client';

function retryFor(error: Error): boolean {
  const retry = createQueryClient().getDefaultOptions().queries?.retry;
  if (typeof retry !== 'function') throw new Error('expected a retry function');
  return retry(0, error);
}

describe('query client retry policy', () => {
  it('retries a 408 timeout, which is what a cold start looks like', () => {
    expect(retryFor(new ApiError(408, null, 'The request timed out. Please try again.'))).toBe(
      true
    );
  });

  it('retries a 429 rate limit', () => {
    expect(retryFor(new ApiError(429, null, 'Too many requests'))).toBe(true);
  });

  it('does not retry a 404, which will not fix itself', () => {
    expect(retryFor(new ApiError(404, null, 'Not found'))).toBe(false);
  });

  it('does not retry a 400', () => {
    expect(retryFor(new ApiError(400, { errors: { subject: 'Too short' } }))).toBe(false);
  });

  it('still retries a network error and stops after two attempts', () => {
    const retry = createQueryClient().getDefaultOptions().queries?.retry;
    if (typeof retry !== 'function') throw new Error('expected a retry function');
    expect(retry(0, new TypeError('Failed to fetch'))).toBe(true);
    expect(retry(2, new TypeError('Failed to fetch'))).toBe(false);
  });
});

describe('request timeout covers the body', () => {
  it('rejects with a 408 when the server sends headers and then stalls the body', async () => {
    server.use(
      http.get('/api/stalled', () => {
        // Headers arrive at once; the body never does. A real server can do this when it is
        // killed mid-response or when a proxy holds the connection open.
        const body = new ReadableStream({
          start() {
            // Never enqueue and never close.
          },
        });
        return new HttpResponse(body, { status: 200 });
      })
    );

    const error = (await request('/api/stalled', { timeoutMs: 100 }).catch((e: unknown) => e)) as
      ApiError | undefined;
    expect(error).toBeInstanceOf(ApiError);
    expect(error?.status).toBe(408);
  });

  it('still reads a normal body well inside the timeout', async () => {
    server.use(http.get('/api/body', () => HttpResponse.json({ ok: true })));
    await expect(request<{ ok: boolean }>('/api/body', { timeoutMs: 5000 })).resolves.toEqual({
      ok: true,
    });
  });
});

describe('request with an already-aborted caller signal', () => {
  it('rejects before sending anything', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const controller = new AbortController();
    controller.abort();

    const error = (await request('/api/never', { signal: controller.signal }).catch(
      (e: unknown) => e
    )) as Error | undefined;

    expect(error).toBeInstanceOf(Error);
    expect(error?.name).toBe('AbortError');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
