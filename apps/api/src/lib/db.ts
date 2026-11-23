import pg from 'pg';

import { pickConfig } from './config.js';

const { Pool } = pg;

// Story 7.12.3 (REL-03): every wait on Postgres is bounded. Without these, a Neon cold start or
// a black-holed host hangs the query forever and every later request queues behind the exhausted
// pool. The connect budget stays under the /health/ready probe's own 4s deadline, so a probe that
// already answered 503 does not leave a connection attempt holding a slot.
export const DB_CONNECT_TIMEOUT_MS = 3_000;
export const DB_STATEMENT_TIMEOUT_MS = 15_000;
export const DB_IDLE_TIMEOUT_MS = 30_000;
// Neon's free tier caps connections; a small pool per process keeps the API and the worker
// inside it while still allowing the worker's default concurrency of 10 to make progress.
export const DB_POOL_MAX = 10;

export function poolOptions(connectionString: string): pg.PoolConfig {
  return {
    connectionString,
    connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
    // Both are needed: `statement_timeout` is enforced by the server, `query_timeout` by the
    // client, so a server that never answers at all is still cut off.
    statement_timeout: DB_STATEMENT_TIMEOUT_MS,
    query_timeout: DB_STATEMENT_TIMEOUT_MS,
    idleTimeoutMillis: DB_IDLE_TIMEOUT_MS,
    max: DB_POOL_MAX,
  };
}

let instance: pg.Pool | undefined;

// Created on first use, so importing this module never needs DATABASE_URL: the entry points
// validate the environment before they touch the pool. Only DATABASE_URL is read, so a script
// that needs the database alone (purge) does not need the rest of the environment.
function current(): pg.Pool {
  instance ??= new Pool(poolOptions(pickConfig(['DATABASE_URL']).DATABASE_URL));
  return instance;
}

// A stand-in for the pool that behaves like it: methods are bound to the real pool, and
// `instanceof pg.Pool` and `in` answer for the real pool too.
export const pool: pg.Pool = new Proxy({} as pg.Pool, {
  get(_target, property) {
    const value: unknown = Reflect.get(current(), property, current());
    return typeof value === 'function' ? (value as () => unknown).bind(current()) : value;
  },
  has: (_target, property) => Reflect.has(current(), property),
  getPrototypeOf: () => Reflect.getPrototypeOf(current()),
});
