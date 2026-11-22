import { createMiddleware } from 'hono/factory';

import { logger } from '../lib/logger.js';

export type AppEnv = { Variables: { requestId: string } };

// Every `/health` route (live, ready, and the bare alias) is matched at a segment boundary, so
// `/healthy` is not quiet.
const HEALTH_PATH = /^\/health(\/|$)/;

// The confirmation link's token is a bearer credential: whoever holds it can confirm the
// subscription. It travels in the path, so the logged path keeps the route and drops the token.
// Two paths carry it: the API preview route (`/api/notifications/confirm/<token>`) and the link
// the customer actually clicks, which the web app serves (`/confirm/<token>`). Matched without
// case: the SPA fallback serves any spelling of the route, so `/CONFIRM/<token>` reaches the
// logger with a real token too. The route is logged lowercased, so one route is one log value.
const CONFIRM_TOKEN_PATH = /^\/(api\/notifications\/confirm|confirm)\/[^/]+/i;

export function redactPath(path: string): string {
  return path.replace(
    CONFIRM_TOKEN_PATH,
    (match, route: string) => `/${route.toLowerCase()}/:token`
  );
}

// One structured line per request, tagged with a request id (the caller's `x-request-id`
// when present) that is echoed back so a client report can be matched to a log line.
// Health checks are logged at debug: orchestrators poll them constantly.
export const requestLogger = createMiddleware<AppEnv>(async (c, next) => {
  const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('x-request-id', requestId);
  const start = performance.now();
  await next();
  const level = HEALTH_PATH.test(c.req.path) ? 'debug' : 'info';
  logger[level](
    {
      requestId,
      method: c.req.method,
      path: redactPath(c.req.path),
      status: c.res.status,
      durationMs: Math.round(performance.now() - start),
    },
    'request'
  );
});
