/**
 * Story 7.12.2 — one structured line per request. The confirmation token is a bearer credential
 * and the ticket reference is all anyone needs to open a ticket, so neither may reach the log.
 * The line records the matched route pattern instead of the concrete URL.
 *
 * The app is built with a temporary `web/dist`, so the route is resolved in the registration
 * order the image really ships: every route, then `app.use('*', staticFiles)` from `mountWebApp`.
 * Without that wildcard these tests passed for the wrong reason (review finding 1).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../../src/app.js';
import { logger } from '../../../src/lib/logger.js';

const SENTINEL = 'SENTINEL-PRIV-7F2C';

let dist: string;
let app: ReturnType<typeof createApp>;
let lines: unknown[];

beforeAll(() => {
  dist = mkdtempSync(path.join(tmpdir(), 'request-logger-dist-'));
  mkdirSync(path.join(dist, 'assets'), { recursive: true });
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>app shell</title>');
  writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)');
  app = createApp({ webDistDir: dist });
});

afterAll(() => {
  rmSync(dist, { recursive: true, force: true });
});

beforeEach(() => {
  lines = [];
  vi.spyOn(logger, 'info').mockImplementation((...args: unknown[]) => {
    lines.push(args[0]);
  });
  vi.spyOn(logger, 'debug').mockImplementation((...args: unknown[]) => {
    lines.push(args[0]);
  });
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
});

describe('request log redaction (story 7.12.2)', () => {
  it('keeps a confirmation token out of the log line', async () => {
    await app.request(`/api/notifications/confirm/${SENTINEL}`);

    expect(JSON.stringify(lines)).not.toContain(SENTINEL);
    expect(lines).toContainEqual(
      expect.objectContaining({ path: '/api/notifications/confirm/:token', method: 'GET' })
    );
  });

  it('keeps a ticket reference out of the log line', async () => {
    await app.request(`/api/tickets/ref/${SENTINEL}`);

    expect(JSON.stringify(lines)).not.toContain(SENTINEL);
    expect(lines).toContainEqual(
      expect.objectContaining({ path: '/api/tickets/ref/:referenceNumber' })
    );
  });

  it('keeps a ticket id out of the log line', async () => {
    await app.request(`/api/tickets/${SENTINEL}`);

    expect(JSON.stringify(lines)).not.toContain(SENTINEL);
    expect(lines).toContainEqual(expect.objectContaining({ path: '/api/tickets/:id' }));
  });

  it('keeps the reference out of the page URL, which the app shell serves', async () => {
    // The customer page is /t/<reference>. It falls through the API routes to the SPA fallback
    // under the static wildcard, so it must log as `unmatched`, not echo the reference.
    await app.request(`/t/${SENTINEL}`, { headers: { accept: 'text/html' } });

    expect(JSON.stringify(lines)).not.toContain(SENTINEL);
    expect(lines).toContainEqual(expect.objectContaining({ path: 'unmatched', status: 200 }));
  });

  it('still logs the API route pattern when the app shell is mounted after it', async () => {
    // The deployed order ends in `app.use('*', staticFiles)`; the wildcard must not mask the route.
    await app.request(`/api/tickets/ref/${SENTINEL}`);

    expect(lines).toContainEqual(
      expect.objectContaining({ path: '/api/tickets/ref/:referenceNumber' })
    );
  });

  it('logs an unknown API path as unmatched rather than echoing it', async () => {
    await app.request(`/api/does-not-exist/${SENTINEL}`);

    expect(JSON.stringify(lines)).not.toContain(SENTINEL);
    expect(lines).toContainEqual(expect.objectContaining({ path: 'unmatched', status: 404 }));
  });
});
