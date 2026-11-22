/**
 * Story 7.12.3 (REL-06): a request that never answers must not leave the UI loading forever.
 * On Render's free plan the service spins down and the first request after a cold start can hang
 * for many seconds; a black-holed connection never answers at all. React Query only retries a
 * request that rejects, so without a client-side timeout a hung fetch leaves the ticket page on
 * its skeleton and the ops console on its spinner indefinitely, with no error and no retry.
 */
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '@/test/server';

import { ApiError, request, REQUEST_TIMEOUT_MS } from './api';

describe('request timeout', () => {
  it('defaults to a finite, generous timeout', () => {
    expect(Number.isFinite(REQUEST_TIMEOUT_MS)).toBe(true);
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    // Long enough for a Render cold start, short enough that a person does not wait forever.
    expect(REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  it('rejects with a 408 ApiError when the server never answers', async () => {
    server.use(
      http.get('/api/slow', async () => {
        // Never resolves: the request hangs, like a black-holed connection.
        await new Promise(() => {});
        return HttpResponse.json({});
      })
    );
    const error = (await request('/api/slow', { timeoutMs: 50 }).catch((e: unknown) => e)) as
      ApiError | undefined;
    expect(error).toBeInstanceOf(ApiError);
    expect(error?.status).toBe(408);
  });

  it('still returns a normal response well inside the timeout', async () => {
    server.use(http.get('/api/fast', () => HttpResponse.json({ ok: true })));
    await expect(request<{ ok: boolean }>('/api/fast', { timeoutMs: 5000 })).resolves.toEqual({
      ok: true,
    });
  });
});
