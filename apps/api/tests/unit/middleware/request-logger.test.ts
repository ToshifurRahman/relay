import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { debug, info, warn } = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

// `warn` is mocked too: importing `app.ts` runs its module-level `createApp()`, which mounts the
// real `web/dist` and warns when it is absent, as it is in a test checkout.
vi.mock('../../../src/lib/logger.js', () => ({ logger: { debug, info, warn } }));

import { createApp } from '../../../src/app.js';
import { type AppEnv, requestLogger } from '../../../src/middleware/request-logger.js';
import { mountWebApp } from '../../../src/middleware/web-app.js';

const app = new Hono<AppEnv>();
app.use('*', requestLogger);
app.get('/health', (c) => c.text('ok'));
app.get('/health/live', (c) => c.text('ok'));
app.get('/health/ready', (c) => c.text('ok'));
app.get('/healthy', (c) => c.text('ok'));
app.get('/health-check', (c) => c.text('ok'));
app.get('/api/x', (c) => c.text('ok'));

beforeEach(() => {
  debug.mockReset();
  info.mockReset();
});

describe('request logger levels', () => {
  it.each(['/health', '/health/live', '/health/ready'])('logs %s at debug', async (path) => {
    const res = await app.request(path);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith(expect.objectContaining({ path, status: 200 }), 'request');
    expect(info).not.toHaveBeenCalled();
  });

  it.each(['/healthy', '/health-check', '/api/x'])('logs %s at info', async (path) => {
    const res = await app.request(path);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ path, status: 200 }), 'request');
    expect(debug).not.toHaveBeenCalled();
  });

  it("echoes the caller's x-request-id", async () => {
    const res = await app.request('/health/live', { headers: { 'x-request-id': 'abc-123' } });
    expect(res.headers.get('x-request-id')).toBe('abc-123');
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'abc-123' }),
      'request'
    );
  });
});

// SEC-01: the confirmation link's token is a bearer credential. It travels in the path, so a
// plain `path` field would write it to the production log stream, where anyone with log access
// could confirm a subscription. The line records the matched route pattern instead, which keeps
// the route and drops every dynamic segment.
//
// The app is built with a temporary `web/dist` so the routes resolve in the order the image
// really ships: every API route, then `app.use('*', staticFiles)` from `mountWebApp`. Without
// that wildcard these tests passed for the wrong reason.
describe('request logger on the confirmation routes', () => {
  let dist: string;
  let realApp: ReturnType<typeof createApp>;
  // The API preview route's handler reads the database, which a unit test does not have. The
  // route is registered here at the same pattern the real router uses, so the logger resolves it
  // exactly as it does in the image; `request-logger.privacy.test.ts` covers the real app.
  const apiApp = new Hono<AppEnv>();

  beforeAll(() => {
    dist = mkdtempSync(path.join(tmpdir(), 'confirm-route-'));
    writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>app shell</title>');
    realApp = createApp({ webDistDir: dist });
    apiApp.use('*', requestLogger);
    apiApp.get('/api/notifications/confirm/:token', (c) => c.json({ ok: true }));
    mountWebApp(apiApp, dist);
  });

  afterAll(() => {
    rmSync(dist, { recursive: true, force: true });
  });

  it('never logs the token from the API preview route', async () => {
    await apiApp.request('/api/notifications/confirm/SUPERSECRETTOKEN123');
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain('SUPERSECRETTOKEN123');
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/notifications/confirm/:token' }),
      'request'
    );
  });

  it('never logs the token from the emailed /confirm/<token> link', async () => {
    // The link the customer actually clicks is `${siteUrl()}/confirm/${token}`
    // (services/customer-notifications.ts), served by the web app's `confirm/:token` route, not
    // by the API preview path above. It falls through the API routes to the SPA fallback under
    // the static wildcard, so it logs as `unmatched` rather than echoing the token.
    const res = await realApp.request('/confirm/REALEMAILTOKEN999', {
      headers: { accept: 'text/html' },
    });
    expect(res.status).toBe(200);
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain('REALEMAILTOKEN999');
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ path: 'unmatched' }), 'request');
  });

  it('logs the bare /confirm route without a token', async () => {
    const res = await realApp.request('/confirm', { headers: { accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ path: 'unmatched' }), 'request');
  });

  // The SPA fallback serves any casing of the route, so `/CONFIRM/<token>` reaches the logger with
  // a real token in the path. The emailed link is lowercase, but a redaction that only matches the
  // spelling the app happens to emit is one refactor away from leaking.
  it.each(['/CONFIRM/UPPERTOKEN123', '/Confirm/MixedTOKEN123'])(
    'never logs the token from %s',
    async (path) => {
      const res = await realApp.request(path, { headers: { accept: 'text/html' } });
      expect(res.status).toBe(200);
      const logged = JSON.stringify(info.mock.calls);
      expect(logged).not.toContain('TOKEN123');
      expect(info).toHaveBeenCalledWith(expect.objectContaining({ path: 'unmatched' }), 'request');
    }
  );

  it('never logs a token from a confirmation path with a trailing segment', async () => {
    await apiApp.request('/api/notifications/confirm/SUPERSECRETTOKEN123/extra');
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain('SUPERSECRETTOKEN123');
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ path: 'unmatched' }), 'request');
  });
});
