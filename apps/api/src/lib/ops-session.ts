import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { createClient } from 'redis';

import { collectIssues, getConfig } from './config.js';
import { logger } from './logger.js';

export const OPS_SESSION_COOKIE = 'ops_session';
// A fixed lifetime: the Redis TTL and the cookie's Max-Age are the same and never extended.
export const SESSION_TTL_S = 12 * 60 * 60;
// Story 7.12.3 (REL-04): the lazy client queues commands while it is disconnected, so a Redis
// outage made every sign-in, session check and sign-out hang instead of failing. The request
// path gives up within this bound, like the counters already do (lib/counters.ts).
export const OPS_SESSION_TIMEOUT_MS = 2000;

const MAX_FAILED_SIGN_INS = 5;
const SIGN_IN_WINDOW_S = 15 * 60;

const sessionKey = (hash: string) => `ops:session:${hash}`;
const failureKey = (ip: string) => `ops:signin-fail:${ip}`;

export const hashSessionId = (id: string) => createHash('sha256').update(id).digest('hex');

export interface OpsSession {
  /** What Redis is keyed by. Never the cookie value itself. */
  hash: string;
  expiresAt: Date;
}

// Only what this module calls. createClient()'s generics don't line up across call sites
// (see the note in socket.ts), so the client is tracked structurally.
interface SessionRedis {
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
  pTTL(key: string): Promise<number>;
  del(key: string): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  quit(): Promise<unknown>;
}
let client: SessionRedis | null = null;

// Its own lazily opened connection: the Socket.IO clients are for pub/sub only.
function redis(): SessionRedis {
  if (!client) {
    const created = createClient({ url: getConfig().REDIS_URL });
    created.on('error', (err) => logger.error({ err }, 'Redis ops-session client error'));
    client = created;
    void created
      .connect()
      .catch((err) => logger.error({ err }, 'Redis ops-session client failed to connect'));
  }
  return client;
}

export async function closeOpsSessionStore(): Promise<void> {
  const current = client;
  client = null;
  if (current) await Promise.allSettled([current.quit()]);
}

/**
 * Bounds a Redis command so a disconnected client's queued command cannot hang the request.
 * The command itself is not cancelled (node-redis has no per-command abort); the caller simply
 * stops waiting, which is what the request path needs.
 */
async function within<T>(work: Promise<T>, timeoutMs: number = OPS_SESSION_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Ops session store did not answer within ${timeoutMs}ms`)),
      timeoutMs
    );
  });
  try {
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** In production the token must be set and long enough that guessing is infeasible. */
export function assertOpsTokenConfigured(): void {
  const [message] = collectIssues(['OPS_TOKEN']);
  if (message) throw new Error(message);
}

export const isOpsSignInConfigured = () => Boolean(getConfig().OPS_TOKEN);

// Hashing first gives both sides the same length, which timingSafeEqual requires.
export function checkOpsToken(candidate: string): boolean {
  const expected = getConfig().OPS_TOKEN;
  if (!expected) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(candidate), digest(expected));
}

export async function createSession(): Promise<{ id: string; expiresAt: Date }> {
  const id = randomBytes(32).toString('base64url');
  await within(
    redis().set(sessionKey(hashSessionId(id)), JSON.stringify({ createdAt: Date.now() }), {
      EX: SESSION_TTL_S,
    })
  );
  return { id, expiresAt: new Date(Date.now() + SESSION_TTL_S * 1000) };
}

export async function lookupSession(id: string | undefined): Promise<OpsSession | null> {
  if (!id) return null;
  const hash = hashSessionId(id);
  const ttlMs = await within(redis().pTTL(sessionKey(hash)));
  // -2: no such key. -1: a key with no expiry, which this module never writes.
  if (ttlMs <= 0) return null;
  return { hash, expiresAt: new Date(Date.now() + ttlMs) };
}

export async function destroySession(id: string): Promise<string> {
  const hash = hashSessionId(id);
  await within(redis().del(sessionKey(hash)));
  return hash;
}

export function sessionIdFromCookieHeader(header: string | undefined): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === OPS_SESSION_COOKIE)
      return part.slice(eq + 1).trim() || undefined;
  }
  return undefined;
}

export async function isSignInLocked(ip: string): Promise<boolean> {
  const count = Number(await within(redis().get(failureKey(ip))));
  return count >= MAX_FAILED_SIGN_INS;
}

export async function recordFailedSignIn(ip: string): Promise<void> {
  const key = failureKey(ip);
  const count = await within(redis().incr(key));
  // The window starts at the first failure; later ones don't extend it.
  if (count === 1) await within(redis().expire(key, SIGN_IN_WINDOW_S));
}
