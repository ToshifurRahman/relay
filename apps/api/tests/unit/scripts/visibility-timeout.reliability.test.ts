/**
 * Story 7.12.3 (REL-01): the queue's visibility timeout must cover the worker's worst-case
 * processing time for one message, or SQS redelivers a message that is still being worked on.
 * Each redelivery increments ApproximateReceiveCount, so a slow-but-successful ticket can be
 * marked failed by a second receive while the first worker is still running it, and the two
 * runs duplicate AI calls and ticket events.
 *
 * Worst case for one receive, from the code: triage (primary + backup, each AI_TIMEOUT_MS) then
 * draft (primary + backup, each AI_TIMEOUT_MS) = 2 stages x 2 providers x AI_TIMEOUT_MS.
 */
import { describe, expect, it } from 'vitest';

import { VISIBILITY_TIMEOUT_S, worstCaseProcessingMs } from '../../../scripts/setup-infra.js';
import { loadConfig } from '../../../src/lib/config.js';

const MINIMAL: Record<string, string> = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  SQS_QUEUE_NAME: 'tickets',
  SQS_ENDPOINT: 'http://localhost:4566',
  LLM_MODE: 'fake',
};

describe('queue visibility timeout', () => {
  it('covers the worst-case processing time of one message with margin', () => {
    const { AI_TIMEOUT_MS } = loadConfig(MINIMAL);
    const worstCaseMs = worstCaseProcessingMs(AI_TIMEOUT_MS);
    expect(VISIBILITY_TIMEOUT_S * 1000).toBeGreaterThan(worstCaseMs);
  });

  it('derives the worst case as two stages, each with a primary and a backup call', () => {
    expect(worstCaseProcessingMs(30_000)).toBe(2 * 2 * 30_000);
  });

  it('stays within the SQS maximum of twelve hours', () => {
    expect(VISIBILITY_TIMEOUT_S).toBeGreaterThan(0);
    expect(VISIBILITY_TIMEOUT_S).toBeLessThanOrEqual(12 * 60 * 60);
  });
});
