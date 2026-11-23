/**
 * Story 7.12.3 (REL-04): the ops-session Redis client queues commands while it is disconnected,
 * so a Redis outage made every sign-in, session check and sign-out hang instead of failing. The
 * request path must give up within a bound, like the counters already do (lib/counters.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const redis = vi.hoisted(() => ({
  set: vi.fn(),
  get: vi.fn(),
  pTTL: vi.fn(),
  del: vi.fn(),
  incr: vi.fn(),
  expire: vi.fn(),
  connect: vi.fn(() => Promise.resolve()),
  quit: vi.fn(() => Promise.resolve()),
}));

vi.mock('redis', () => ({
  createClient: () => ({
    set: redis.set,
    get: redis.get,
    pTTL: redis.pTTL,
    del: redis.del,
    incr: redis.incr,
    expire: redis.expire,
    connect: redis.connect,
    quit: redis.quit,
    on: () => undefined,
  }),
}));

import {
  closeOpsSessionStore,
  isSignInLocked,
  lookupSession,
  OPS_SESSION_TIMEOUT_MS,
} from '../../../src/lib/ops-session.js';

beforeEach(() => {
  for (const fn of Object.values(redis)) {
    if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset();
  }
  redis.connect.mockResolvedValue(undefined);
  redis.quit.mockResolvedValue(undefined);
});

afterEach(async () => {
  await closeOpsSessionStore();
});

describe('ops-session Redis bounds', () => {
  it('defaults to a short timeout', () => {
    expect(OPS_SESSION_TIMEOUT_MS).toBeGreaterThan(0);
    expect(OPS_SESSION_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });

  it('rejects a session lookup within the bound when Redis never answers', async () => {
    redis.pTTL.mockReturnValue(new Promise(() => {}));
    const started = Date.now();
    await expect(lookupSession('some-session-id')).rejects.toThrow(/did not answer/);
    expect(Date.now() - started).toBeLessThan(OPS_SESSION_TIMEOUT_MS + 1000);
  });

  it('rejects a lockout check within the bound when Redis never answers', async () => {
    redis.get.mockReturnValue(new Promise(() => {}));
    const started = Date.now();
    await expect(isSignInLocked('1.2.3.4')).rejects.toThrow(/did not answer/);
    expect(Date.now() - started).toBeLessThan(OPS_SESSION_TIMEOUT_MS + 1000);
  });

  it('still answers normally when Redis is healthy', async () => {
    redis.pTTL.mockResolvedValue(60_000);
    const session = await lookupSession('some-session-id');
    expect(typeof session?.hash).toBe('string');
    expect(session?.expiresAt).toBeInstanceOf(Date);
  });
});
