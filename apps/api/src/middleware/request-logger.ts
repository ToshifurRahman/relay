import { createMiddleware } from 'hono/factory';

import { logger } from '../lib/logger.js';

export type AppEnv = { Variables: { requestId: string } };

// Every `/health` route (live, ready, and the bare alias) is matched at a segment boundary, so
// `/healthy` is not quiet.
const HEALTH_PATH = /^\/health(\/|$)/;

// One structured line per request, tagged with a request id (the caller's `x-request-id`
// when present) that is echoed back so a client report can be matched to a log line.
// Health checks are logged at debug: orchestrators poll them constantly.
//
// The line records the matched route pattern, not the concrete URL: the confirmation token is a
// bearer credential and the ticket reference is all anyone needs to open a ticket, so neither
// may reach the log (story 7.12.2). A path with no matched route (a 404) is logged as `unmatched`.
export const requestLogger = createMiddleware<AppEnv>(async (c, next) => {
  const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('x-request-id', requestId);
  const start = performance.now();
  await next();
  const level = HEALTH_PATH.test(c.req.path) ? 'debug' : 'info';
  const matched = c.req.matchedRoutes.at(-1)?.path;
  const route = matched && matched !== '/*' ? matched : 'unmatched';
  logger[level](
    {
      requestId,
      method: c.req.method,
      path: route,
      status: c.res.status,
      durationMs: Math.round(performance.now() - start),
    },
    'request'
  );
});
