import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { debug, info } = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn() }));

vi.mock('../../../src/lib/logger.js', () => ({ logger: { debug, info } }));

import { type AppEnv, requestLogger } from '../../../src/middleware/request-logger.js';
import { mountWebApp } from '../../../src/middleware/web-app.js';

const app = new Hono<AppEnv>();
app.use('*', requestLogger);
app.all('*', (c) => c.text('ok'));

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

  // SEC-01: the confirmation link's token is a bearer credential. It travels in the path, so a
  // plain `path` field would write it to the production log stream, where anyone with log access
  // could confirm a subscription. The logged path keeps the route and drops the token.
  it('never logs the confirmation token from the path', async () => {
    await app.request('/api/notifications/confirm/SUPERSECRETTOKEN123');
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain('SUPERSECRETTOKEN123');
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/notifications/confirm/:token' }),
      'request'
    );
  });

  it('keeps the rest of the path intact when redacting', async () => {
    await app.request('/api/notifications/confirm/abc/extra');
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/notifications/confirm/:token/extra' }),
      'request'
    );
  });

  it('leaves paths that are not confirmation links alone', async () => {
    await app.request('/api/notifications/confirm');
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/notifications/confirm' }),
      'request'
    );
  });
});

// The link the customer actually clicks is `${siteUrl()}/confirm/${token}`
// (services/customer-notifications.ts), served by the web app's `confirm/:token` route, not by
// the API preview path above. The logger runs before the web app is mounted, so it sees that
// path too, and it must redact it the same way.
describe('request logger on the web confirmation route', () => {
  let dist: string;
  const webApp = new Hono<AppEnv>();

  beforeAll(() => {
    dist = mkdtempSync(path.join(tmpdir(), 'confirm-route-'));
    writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>app shell</title>');
    webApp.use('*', requestLogger);
    mountWebApp(webApp, dist);
  });

  afterAll(() => {
    rmSync(dist, { recursive: true, force: true });
  });

  it('never logs the token from the emailed /confirm/<token> link', async () => {
    const res = await webApp.request('/confirm/REALEMAILTOKEN999', {
      headers: { accept: 'text/html' },
    });
    expect(res.status).toBe(200);
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain('REALEMAILTOKEN999');
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/confirm/:token' }),
      'request'
    );
  });

  it('leaves the bare /confirm route alone', async () => {
    await webApp.request('/confirm', { headers: { accept: 'text/html' } });
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ path: '/confirm' }), 'request');
  });

  // The SPA fallback serves any casing of the route, so `/CONFIRM/<token>` reaches the logger with
  // a real token in the path. The emailed link is lowercase, but a redaction that only matches the
  // spelling the app happens to emit is one refactor away from leaking.
  it.each(['/CONFIRM/UPPERTOKEN123', '/Confirm/MixedTOKEN123'])(
    'never logs the token from %s',
    async (path) => {
      const res = await webApp.request(path, { headers: { accept: 'text/html' } });
      expect(res.status).toBe(200);
      const logged = JSON.stringify(info.mock.calls);
      expect(logged).not.toContain('TOKEN123');
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/confirm/:token' }),
        'request'
      );
    }
  );
});
