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
// may reach the log (stories 7.12.1 and 7.12.2). A path with no matched route (a 404, or a page
// the SPA fallback serves) is logged as `unmatched`.
export const requestLogger = createMiddleware<AppEnv>(async (c, next) => {
  const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('x-request-id', requestId);
  const start = performance.now();
  await next();
  const level = HEALTH_PATH.test(c.req.path) ? 'debug' : 'info';
  // `mountWebApp` registers `app.use('*', staticFiles)` after every route, so the final match in
  // the deployed image is always the wildcard. Take the last match that is not a wildcard.
  const route = [...c.req.matchedRoutes].reverse().find((r) => !r.path.endsWith('*'))?.path;
  logger[level](
    {
      requestId,
      method: c.req.method,
      path: route ?? 'unmatched',
      status: c.res.status,
      durationMs: Math.round(performance.now() - start),
    },
    'request'
  );
});
