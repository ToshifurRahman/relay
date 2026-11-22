/**
 * Story 7.12.3 (REL-01), fix round 1: the visibility timeout was a fixed 300s while
 * `AI_TIMEOUT_MS` is operator-configurable (`render.yaml` leaves it `sync: false`). Above 75s the
 * 2 x 2 x AI_TIMEOUT_MS worst case passes 300s and the original defect returns: SQS redelivers a
 * message that is still being worked on. The timeout is derived from the configured value at
 * setup time instead, with the 300s floor kept for the default 30s.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_VISIBILITY_TIMEOUT_S,
  resolveSetupConfig,
  visibilityTimeoutSeconds,
  worstCaseProcessingMs,
} from '../../../scripts/setup-infra.js';

const LOCAL = {
  SQS_QUEUE_NAME: 'tickets',
  SQS_ENDPOINT: 'http://localhost:4566',
};

describe('derived visibility timeout', () => {
  it('keeps the 300s floor at the default 30s AI timeout', () => {
    expect(visibilityTimeoutSeconds(30_000)).toBe(300);
  });

  it('scales above the worst case when AI_TIMEOUT_MS is raised', () => {
    const aiTimeoutMs = 90_000;
    const derived = visibilityTimeoutSeconds(aiTimeoutMs);
    expect(derived).toBeGreaterThan(worstCaseProcessingMs(aiTimeoutMs) / 1000);
    expect(derived).toBeGreaterThan(300);
  });

  it('stays within the SQS maximum for a very large AI timeout', () => {
    expect(visibilityTimeoutSeconds(3_600_000)).toBeLessThanOrEqual(MAX_VISIBILITY_TIMEOUT_S);
  });

  it('reads AI_TIMEOUT_MS from the environment it is given', () => {
    expect(resolveSetupConfig({ ...LOCAL, AI_TIMEOUT_MS: '90000' }).AI_TIMEOUT_MS).toBe(90_000);
  });

  it('defaults AI_TIMEOUT_MS to 30s when it is unset', () => {
    expect(resolveSetupConfig(LOCAL).AI_TIMEOUT_MS).toBe(30_000);
  });

  it('refuses a configuration whose derived timeout would exceed the SQS maximum', () => {
    // 2 x 2 x 3,600,000ms = 4 hours; x2.5 = 10 hours, still inside 12h. 7,200,000ms is not.
    expect(() => resolveSetupConfig({ ...LOCAL, AI_TIMEOUT_MS: '7200000' })).toThrow(
      /visibility timeout/i
    );
  });
});
