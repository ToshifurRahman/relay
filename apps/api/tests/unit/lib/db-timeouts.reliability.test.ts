/**
 * Story 7.12.3 (REL-03): the Postgres pool must not wait forever. Without a connect timeout a
 * Neon cold start or a black-holed host hangs the query, and every later request queues behind
 * the exhausted pool. Without a statement timeout a single slow query holds a slot indefinitely.
 */
import { describe, expect, it } from 'vitest';

import {
  DB_CONNECT_TIMEOUT_MS,
  DB_IDLE_TIMEOUT_MS,
  DB_POOL_MAX,
  DB_STATEMENT_TIMEOUT_MS,
  poolOptions,
} from '../../../src/lib/db.js';

const URL = 'postgresql://u:p@localhost:5433/ticket_pipe';

describe('Postgres pool timeouts', () => {
  it('bounds connecting, the statement and the idle lifetime', () => {
    expect(poolOptions(URL)).toMatchObject({
      connectionString: URL,
      connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
      statement_timeout: DB_STATEMENT_TIMEOUT_MS,
      query_timeout: DB_STATEMENT_TIMEOUT_MS,
      idleTimeoutMillis: DB_IDLE_TIMEOUT_MS,
      max: DB_POOL_MAX,
    });
  });

  it('keeps every bound finite and positive', () => {
    for (const value of [
      DB_CONNECT_TIMEOUT_MS,
      DB_STATEMENT_TIMEOUT_MS,
      DB_IDLE_TIMEOUT_MS,
      DB_POOL_MAX,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it('fails a connection attempt well inside the health probe budget', () => {
    // /health/ready gives up after 4s; a connect timeout longer than that would leave the
    // probe's query running and holding a pool slot after the probe already answered 503.
    expect(DB_CONNECT_TIMEOUT_MS).toBeLessThanOrEqual(4000);
  });
});
