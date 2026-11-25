import { io as ioClient } from 'socket.io-client';

// Read-only live check: it never signs in, never submits a ticket, never calls the LLM and
// never sends a cookie. It reads only SMOKE_BASE_URL and loads no .env file.

export const SMOKE_WAKE_TIMEOUT_MS = 90_000;
export const SMOKE_REQUEST_TIMEOUT_MS = 15_000;
export const SMOKE_SOCKET_TIMEOUT_MS = 15_000;

const WAKE_ATTEMPTS = 3;
const WAKE_RETRY_DELAY_MS = 5_000;

export const TICKET_ID = '00000000-0000-0000-0000-000000000000';

export interface SmokeOptions {
  requestTimeoutMs?: number;
  wakeTimeoutMs?: number;
  socketTimeoutMs?: number;
  wakeAttempts?: number;
  wakeRetryDelayMs?: number;
  print?: (line: string) => void;
}

export interface CheckOutcome {
  pass: boolean;
  actual: string;
}

export interface SmokeCheck {
  name: string;
  expected: string;
  run: () => Promise<CheckOutcome>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// A response body never appears in a failure line, and neither does the base URL.
function failureReason(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network error';
}

function requestInit(init: RequestInit, timeoutMs: number): RequestInit {
  return {
    ...init,
    redirect: 'manual',
    credentials: 'omit',
    signal: AbortSignal.timeout(timeoutMs),
  };
}

// The signal stays attached while the body is read, so a body that never ends is a timeout.
async function fetchStatus(url: string, init: RequestInit, timeoutMs: number): Promise<number> {
  const response = await fetch(url, requestInit(init, timeoutMs));
  await response.text();
  return response.status;
}

export function buildChecks(baseUrl: string, options: SmokeOptions = {}): SmokeCheck[] {
  const requestTimeoutMs = options.requestTimeoutMs ?? SMOKE_REQUEST_TIMEOUT_MS;
  const wakeTimeoutMs = options.wakeTimeoutMs ?? SMOKE_WAKE_TIMEOUT_MS;
  const socketTimeoutMs = options.socketTimeoutMs ?? SMOKE_SOCKET_TIMEOUT_MS;
  const wakeAttempts = options.wakeAttempts ?? WAKE_ATTEMPTS;
  const wakeRetryDelayMs = options.wakeRetryDelayMs ?? WAKE_RETRY_DELAY_MS;
  const url = (path: string) => new URL(path, baseUrl).toString();

  const expectStatus = (
    name: string,
    path: string,
    expected: number,
    init: RequestInit = {}
  ): SmokeCheck => ({
    name,
    expected: String(expected),
    run: async () => {
      try {
        const status = await fetchStatus(url(path), init, requestTimeoutMs);
        return { pass: status === expected, actual: String(status) };
      } catch (error) {
        return { pass: false, actual: failureReason(error) };
      }
    },
  });

  // The first request wakes a sleeping free-plan instance, so it gets the long timeout and
  // retries the transient failures a cold start returns.
  const wake: SmokeCheck = {
    name: 'health-live',
    expected: '200',
    run: async () => {
      let actual = 'network error';
      for (let attempt = 1; attempt <= wakeAttempts; attempt += 1) {
        try {
          const status = await fetchStatus(url('/health/live'), { method: 'GET' }, wakeTimeoutMs);
          actual = String(status);
          if (status === 200) return { pass: true, actual };
          if (status !== 502 && status !== 503 && status !== 504) return { pass: false, actual };
        } catch (error) {
          actual = failureReason(error);
        }
        if (attempt < wakeAttempts) await sleep(wakeRetryDelayMs);
      }
      return { pass: false, actual };
    },
  };

  const session: SmokeCheck = {
    name: 'ops-session-signed-out',
    expected: '200 {"signedIn":false}',
    run: async () => {
      try {
        const response = await fetch(
          url('/api/ops/session'),
          requestInit({ method: 'GET' }, requestTimeoutMs)
        );
        const text = await response.text();
        if (response.status !== 200) return { pass: false, actual: String(response.status) };
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          return { pass: false, actual: 'invalid JSON' };
        }
        const signedIn = (body as { signedIn?: unknown } | null)?.signedIn;
        return { pass: signedIn === false, actual: `200 signedIn=${String(signedIn)}` };
      } catch (error) {
        return { pass: false, actual: failureReason(error) };
      }
    },
  };

  const socket: SmokeCheck = {
    name: 'socket-ops-subscribe-refused',
    expected: 'ack rejected',
    run: () =>
      new Promise<CheckOutcome>((resolve) => {
        const client = ioClient(baseUrl, {
          path: '/socket.io/',
          transports: ['websocket'],
          reconnection: false,
          forceNew: true,
        });
        let settled = false;
        function finish(outcome: CheckOutcome) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          client.disconnect();
          resolve(outcome);
        }
        const timer = setTimeout(() => finish({ pass: false, actual: 'no ack' }), socketTimeoutMs);
        client.on('connect', () => {
          client.emit('ops:subscribe', (ack: unknown) => {
            const reply = ack as { ok?: unknown; error?: unknown } | null;
            const refused =
              reply !== null &&
              typeof reply === 'object' &&
              reply.ok === false &&
              reply.error === 'unauthorized';
            finish(
              refused
                ? { pass: true, actual: 'ack rejected' }
                : { pass: false, actual: `ack ${JSON.stringify(ack)}` }
            );
          });
        });
        client.on('connect_error', () => finish({ pass: false, actual: 'connect error' }));
      }),
  };

  return [
    wake,
    expectStatus('health-ready', '/health/ready', 200),
    expectStatus('tickets-list-unauthorized', '/api/tickets', 401),
    expectStatus('ticket-replay-unauthorized', `/api/tickets/${TICKET_ID}/replay`, 401, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
    expectStatus('ops-ai-interactions-unauthorized', '/api/ops/ai-interactions', 401),
    expectStatus(
      'ops-ai-interactions-summary-unauthorized',
      '/api/ops/ai-interactions/summary',
      401
    ),
    expectStatus('ops-ticket-unauthorized', `/api/ops/tickets/${TICKET_ID}`, 401),
    expectStatus('ops-ticket-events-unauthorized', `/api/ops/tickets/${TICKET_ID}/events`, 401),
    session,
    socket,
  ];
}

export async function runSmoke(baseUrl: string, options: SmokeOptions = {}): Promise<number> {
  const print = options.print ?? console.log;
  const checks = buildChecks(baseUrl, options);
  let passed = 0;
  for (const check of checks) {
    let outcome: CheckOutcome;
    try {
      outcome = await check.run();
    } catch {
      outcome = { pass: false, actual: 'error' };
    }
    if (outcome.pass) passed += 1;
    print(
      outcome.pass
        ? `PASS ${check.name}`
        : `FAIL ${check.name}: ${check.expected} got ${outcome.actual}`
    );
  }
  print(`SUMMARY ${passed}/${checks.length}`);
  return passed === checks.length ? 0 : 1;
}

export function usageLine(): string {
  return 'Usage: SMOKE_BASE_URL=https://<host> bun run smoke:live';
}

export function resolveBaseUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    return url.origin;
  }
  return null;
}

export async function runCli(
  env: Record<string, string | undefined>,
  options: SmokeOptions = {}
): Promise<number> {
  const baseUrl = resolveBaseUrl(env.SMOKE_BASE_URL);
  if (!baseUrl) {
    (options.print ?? console.log)(usageLine());
    return 2;
  }
  return runSmoke(baseUrl, options);
}

if (import.meta.main) {
  // Bun.env, not the Node global: tests/guards/env-access.test.ts allows that global only in config.
  process.exit(await runCli(Bun.env));
}
