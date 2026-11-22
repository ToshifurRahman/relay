/**
 * Story 7.12.2 — one structured line per request. The confirmation token is a bearer credential
 * and the ticket reference is all anyone needs to open a ticket, so neither may reach the log.
 * The line records the matched route pattern instead of the concrete URL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { app } from '../../../src/app.js';
import { logger } from '../../../src/lib/logger.js';

const SENTINEL = 'SENTINEL-PRIV-7F2C';

let lines: unknown[];

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
    // The customer page is /t/<reference>; it matches no API route, so it must log as
    // `unmatched` rather than echoing the reference.
    await app.request(`/t/${SENTINEL}`, { headers: { accept: 'text/html' } });

    expect(JSON.stringify(lines)).not.toContain(SENTINEL);
    expect(lines).toContainEqual(expect.objectContaining({ path: 'unmatched' }));
  });
});
