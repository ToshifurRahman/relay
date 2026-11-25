import { createServer, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { Server as SocketServer } from 'socket.io';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveBaseUrl, runCli, runSmoke, usageLine } from '../../../scripts/smoke-live.js';

const ZERO = '00000000-0000-0000-0000-000000000000';

interface ResponseSpec {
  status: number;
  body?: string;
  contentType?: string;
  location?: string;
  stall?: boolean;
}

interface FakeOptions {
  responses?: Record<string, ResponseSpec>;
  liveSequence?: number[];
  socketAck?: unknown;
}

interface Fake {
  baseUrl: string;
  hits: string[];
  close: () => Promise<void>;
}

const open: Fake[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((fake) => fake.close()));
});

function defaults(): Record<string, ResponseSpec> {
  const json = 'application/json';
  return {
    'GET /health/live': { status: 200, body: '{"status":"ok"}', contentType: json },
    'GET /health/ready': { status: 200, body: '{"status":"ok"}', contentType: json },
    'GET /api/tickets': { status: 401 },
    [`POST /api/tickets/${ZERO}/replay`]: { status: 401 },
    'GET /api/ops/ai-interactions': { status: 401 },
    'GET /api/ops/ai-interactions/summary': { status: 401 },
    [`GET /api/ops/tickets/${ZERO}`]: { status: 401 },
    [`GET /api/ops/tickets/${ZERO}/events`]: { status: 401 },
    'GET /api/ops/session': { status: 200, body: '{"signedIn":false}', contentType: json },
  };
}

function send(res: ServerResponse, spec: ResponseSpec): void {
  res.writeHead(spec.status, {
    ...(spec.contentType ? { 'content-type': spec.contentType } : {}),
    ...(spec.location ? { location: spec.location } : {}),
  });
  if (spec.stall) {
    res.write(spec.body ?? '{');
    return;
  }
  res.end(spec.body ?? '');
}

async function startFake(options: FakeOptions = {}): Promise<Fake> {
  const responses = { ...defaults(), ...options.responses };
  const hits: string[] = [];
  let liveHits = 0;
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const key = `${req.method ?? 'GET'} ${path}`;
    hits.push(key);
    if (key === 'GET /health/live' && options.liveSequence) {
      const index = Math.min(liveHits, options.liveSequence.length - 1);
      liveHits += 1;
      send(res, { status: options.liveSequence[index] });
      return;
    }
    send(res, responses[key] ?? { status: 404 });
  });
  const ioServer = new SocketServer(server);
  ioServer.on('connection', (socket) => {
    socket.on('ops:subscribe', (ack?: (value: unknown) => void) => {
      if (options.socketAck === null) return;
      ack?.(options.socketAck ?? { ok: false, error: 'unauthorized' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  let closed = false;
  const fake: Fake = {
    baseUrl: `http://127.0.0.1:${port}`,
    hits,
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        void ioServer.close(() => resolve());
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  open.push(fake);
  return fake;
}

function capture(): { lines: string[]; print: (line: string) => void } {
  const lines: string[] = [];
  return { lines, print: (line) => lines.push(line) };
}

async function closedBaseUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

describe('smoke-live all checks pass', () => {
  it('prints one PASS per check and exits 0', async () => {
    const fake = await startFake();
    const { lines, print } = capture();

    const code = await runSmoke(fake.baseUrl, { print });

    expect(code).toBe(0);
    expect(lines.filter((line) => line.startsWith('PASS '))).toHaveLength(10);
    expect(lines).toContain('PASS health-live');
    expect(lines).toContain('PASS health-ready');
    expect(lines).toContain('PASS tickets-list-unauthorized');
    expect(lines).toContain('PASS ticket-replay-unauthorized');
    expect(lines).toContain('PASS ops-ai-interactions-unauthorized');
    expect(lines).toContain('PASS ops-ai-interactions-summary-unauthorized');
    expect(lines).toContain('PASS ops-ticket-unauthorized');
    expect(lines).toContain('PASS ops-ticket-events-unauthorized');
    expect(lines).toContain('PASS ops-session-signed-out');
    expect(lines).toContain('PASS socket-ops-subscribe-refused');
    expect(lines.at(-1)).toBe('SUMMARY 10/10');
  });

  it('never sends a cookie or a credential', async () => {
    const fake = await startFake();
    const { print } = capture();

    await runSmoke(fake.baseUrl, { print });

    const session = fake.hits.filter((hit) => hit === 'GET /api/ops/session');
    expect(session).toHaveLength(1);
    expect(fake.hits).not.toContain('POST /api/ops/session');
  });
});

describe('smoke-live HTTP guards', () => {
  it('fails a protected route that answers 200', async () => {
    const fake = await startFake({ responses: { 'GET /api/tickets': { status: 200 } } });
    const { lines, print } = capture();

    const code = await runSmoke(fake.baseUrl, { print });

    expect(code).toBe(1);
    expect(lines).toContain('FAIL tickets-list-unauthorized: 401 got 200');
  });

  it('fails a redirect instead of following it', async () => {
    const fake = await startFake({
      responses: { 'GET /api/tickets': { status: 302, location: '/followed' } },
    });
    const { lines, print } = capture();

    const code = await runSmoke(fake.baseUrl, { print });

    expect(code).toBe(1);
    expect(lines).toContain('FAIL tickets-list-unauthorized: 401 got 302');
    expect(fake.hits).not.toContain('GET /followed');
  });

  it('fails when the session reports signedIn true', async () => {
    const fake = await startFake({
      responses: {
        'GET /api/ops/session': {
          status: 200,
          body: '{"signedIn":true}',
          contentType: 'application/json',
        },
      },
    });
    const { lines, print } = capture();

    const code = await runSmoke(fake.baseUrl, { print });

    expect(code).toBe(1);
    expect(lines).toContain(
      'FAIL ops-session-signed-out: 200 {"signedIn":false} got 200 signedIn=true'
    );
  });

  it('fails a non-JSON session body', async () => {
    const fake = await startFake({
      responses: {
        'GET /api/ops/session': { status: 200, body: 'not json', contentType: 'text/plain' },
      },
    });
    const { lines, print } = capture();

    const code = await runSmoke(fake.baseUrl, { print });

    expect(code).toBe(1);
    expect(lines).toContain('FAIL ops-session-signed-out: 200 {"signedIn":false} got invalid JSON');
  });

  it('fails within the timeout when a body never ends', async () => {
    const fake = await startFake({
      responses: { 'GET /api/ops/session': { status: 200, stall: true } },
    });
    const { lines, print } = capture();
    const started = Date.now();

    const code = await runSmoke(fake.baseUrl, { print, requestTimeoutMs: 100 });

    expect(code).toBe(1);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(lines).toContain('FAIL ops-session-signed-out: 200 {"signedIn":false} got timeout');
  });
});

describe('smoke-live wake retry', () => {
  it('retries a 503 and passes once the service is awake', async () => {
    const fake = await startFake({ liveSequence: [503, 200] });
    const { lines, print } = capture();

    const code = await runSmoke(fake.baseUrl, { print, wakeRetryDelayMs: 5 });

    expect(code).toBe(0);
    expect(lines).toContain('PASS health-live');
    expect(fake.hits.filter((hit) => hit === 'GET /health/live')).toHaveLength(2);
  });

  it('fails after the last attempt when the service never wakes', async () => {
    const fake = await startFake({ liveSequence: [503] });
    const { lines, print } = capture();

    const code = await runSmoke(fake.baseUrl, { print, wakeAttempts: 2, wakeRetryDelayMs: 5 });

    expect(code).toBe(1);
    expect(lines).toContain('FAIL health-live: 200 got 503');
    expect(fake.hits.filter((hit) => hit === 'GET /health/live')).toHaveLength(2);
  });
});

describe('smoke-live socket guard', () => {
  it('fails when the socket ack allows the subscription', async () => {
    const fake = await startFake({ socketAck: { ok: true } });
    const { lines, print } = capture();

    const code = await runSmoke(fake.baseUrl, { print, socketTimeoutMs: 500 });

    expect(code).toBe(1);
    expect(lines.find((line) => line.startsWith('FAIL socket-ops-subscribe-refused'))).toContain(
      'got ack {"ok":true}'
    );
  });

  it('fails within the timeout when the socket never acks', async () => {
    const fake = await startFake({ socketAck: null });
    const { lines, print } = capture();
    const started = Date.now();

    const code = await runSmoke(fake.baseUrl, { print, socketTimeoutMs: 100 });

    expect(code).toBe(1);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(lines).toContain('FAIL socket-ops-subscribe-refused: ack rejected got no ack');
  });
});

describe('smoke-live unreachable server', () => {
  it('fails every check when the connection is refused', async () => {
    const baseUrl = await closedBaseUrl();
    const { lines, print } = capture();

    const code = await runSmoke(baseUrl, {
      print,
      requestTimeoutMs: 200,
      socketTimeoutMs: 200,
      wakeAttempts: 1,
    });

    expect(code).toBe(1);
    expect(lines).toContain('FAIL health-live: 200 got network error');
    expect(lines).toContain('SUMMARY 0/10');
  });
});

describe('smoke-live base URL validation', () => {
  it('exits 2 with a usage line when SMOKE_BASE_URL is missing', async () => {
    const { lines, print } = capture();

    expect(await runCli({}, { print })).toBe(2);
    expect(lines).toContain(usageLine());
  });

  it.each([
    'http://example.com',
    'https://',
    'ftp://localhost',
    'not a url',
    'http://127.0.0.1.example.com',
  ])('exits 2 for %s', async (value) => {
    const { lines, print } = capture();

    expect(await runCli({ SMOKE_BASE_URL: value }, { print })).toBe(2);
    expect(lines).toContain(usageLine());
  });

  it('accepts https and local http URLs', () => {
    expect(resolveBaseUrl('https://deploy.example.test')).toBe('https://deploy.example.test');
    expect(resolveBaseUrl('http://localhost:3200')).toBe('http://localhost:3200');
    expect(resolveBaseUrl('http://127.0.0.1:3200')).toBe('http://127.0.0.1:3200');
  });
});
