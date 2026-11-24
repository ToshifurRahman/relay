import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const redis = vi.hoisted(() => ({
  incr: vi.fn<(key: string) => Promise<number>>(),
  expire: vi.fn<(key: string, seconds: number) => Promise<unknown>>(),
  connect: vi.fn(() => Promise.resolve()),
  quit: vi.fn(() => Promise.resolve()),
  destroy: vi.fn(),
  eval: vi.fn(),
}));

vi.mock('redis', () => ({
  createClient: () => ({
    incr: redis.incr,
    expire: redis.expire,
    connect: redis.connect,
    quit: redis.quit,
    destroy: redis.destroy,
    eval: redis.eval,
    on: () => undefined,
    get isReady() {
      return true;
    },
  }),
}));

import { parseEnv } from '../../../src/lib/config.js';
import { closeCounters } from '../../../src/lib/counters.js';
import { assertLlmSpendAllowed, LlmSpendCapReached } from '../../../src/lib/spend-guard.js';

const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  SQS_QUEUE_NAME: 'tickets',
  SQS_ENDPOINT: 'http://localhost:4566',
  // Fake mode keeps the key requirements out of these cases; the cap is independent of the mode.
  LLM_MODE: 'fake',
};

const NOW = new Date('2026-11-24T10:00:00.000Z');

beforeEach(() => {
  redis.incr.mockReset();
  redis.expire.mockReset();
  redis.incr.mockResolvedValue(1);
  redis.expire.mockResolvedValue(true);
  vi.stubEnv('LLM_DAILY_CAP', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeCounters();
});

describe('LLM_DAILY_CAP config', () => {
  it('is undefined when unset (no ceiling) and accepts an explicit cap', () => {
    const off = parseEnv(BASE_ENV);
    expect(off.success && off.data.LLM_DAILY_CAP).toBeUndefined();
    const on = parseEnv({ ...BASE_ENV, LLM_DAILY_CAP: '1200' });
    expect(on.success && on.data.LLM_DAILY_CAP).toBe(1200);
  });

  it('accepts 0 as the explicit kill-switch value', () => {
    const result = parseEnv({ ...BASE_ENV, LLM_DAILY_CAP: '0' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.LLM_DAILY_CAP).toBe(0);
  });

  it.each(['-1', 'lots', '1.5'])('rejects LLM_DAILY_CAP=%s by name', (value) => {
    const result = parseEnv({ ...BASE_ENV, LLM_DAILY_CAP: value });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues.map((i) => i.variable)).toContain('LLM_DAILY_CAP');
  });

  it('refuses the local placeholder credentials rule before it reaches LLM_DAILY_CAP', () => {
    // Sanity that the new field did not disturb the neighbouring AWS rule (PA-7.3-02).
    const result = parseEnv({ ...BASE_ENV, SQS_ENDPOINT: undefined, LLM_DAILY_CAP: '10' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues.map((i) => i.variable)).toContain('AWS_ACCESS_KEY_ID');
    expect(result.issues.map((i) => i.variable)).not.toContain('LLM_DAILY_CAP');
  });
});

describe('assertLlmSpendAllowed', () => {
  it('does nothing when the cap is unset, without touching Redis', async () => {
    vi.stubEnv('LLM_DAILY_CAP', '');
    await expect(assertLlmSpendAllowed(NOW)).resolves.toBeUndefined();
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('LLM_DAILY_CAP=0 is the kill switch: the first call is refused and Redis is never reached', async () => {
    vi.stubEnv('LLM_DAILY_CAP', '0');
    await expect(assertLlmSpendAllowed(NOW)).rejects.toBeInstanceOf(LlmSpendCapReached);
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('allows calls up to the cap and refuses the one past it', async () => {
    vi.stubEnv('LLM_DAILY_CAP', '2');
    redis.incr.mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(3);

    await expect(assertLlmSpendAllowed(NOW)).resolves.toBeUndefined();
    await expect(assertLlmSpendAllowed(NOW)).resolves.toBeUndefined();
    await expect(assertLlmSpendAllowed(NOW)).rejects.toBeInstanceOf(LlmSpendCapReached);
    expect(redis.incr).toHaveBeenCalledWith('llm:day:2026-11-24');
  });

  it('starts the counter window with an expiry past the UTC-day boundary', async () => {
    vi.stubEnv('LLM_DAILY_CAP', '5');
    await assertLlmSpendAllowed(NOW);
    expect(redis.expire).toHaveBeenCalledWith('llm:day:2026-11-24', 86400 + 3600);
  });

  it('fails closed when the counter cannot answer', async () => {
    vi.stubEnv('LLM_DAILY_CAP', '5');
    redis.incr.mockRejectedValue(new Error('redis down'));

    await expect(assertLlmSpendAllowed(NOW)).rejects.toBeInstanceOf(LlmSpendCapReached);
  });

  it('never puts a ticket field into the refusal message', async () => {
    vi.stubEnv('LLM_DAILY_CAP', '1');
    redis.incr.mockResolvedValue(2);
    await expect(assertLlmSpendAllowed(NOW)).rejects.toMatchObject({
      message: 'LLM daily spend cap reached (1 calls)',
    });
  });
});
