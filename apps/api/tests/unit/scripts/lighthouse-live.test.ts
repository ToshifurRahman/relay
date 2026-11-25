import { createRequire } from 'node:module';
import path from 'node:path';

import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import {
  lhciEnv,
  type LighthouseDeps,
  main,
  type Print,
  resolveMode,
  type StackHandle,
  UsageError,
} from '../../../../../scripts/lighthouse.js';

const ROOT = path.resolve(import.meta.dirname, '../../../../..');
const CONFIG = path.join(ROOT, 'lighthouserc.cjs');
const nodeRequire = createRequire(import.meta.url);

const LOCAL_BASE = 'http://localhost:3101';

type Env = Record<string, string | undefined>;

// lighthouserc.cjs is a CommonJS module that reads process.env at require time, so each case
// installs its own environment, drops the module cache, and restores the previous environment.
function loadConfig(env: Env): { ci: Record<string, unknown> } {
  const saved: Env = {};
  for (const key of ['LH_BASE_URL', 'LH_TICKET_REF', 'LH_LIVE_URL']) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
  delete nodeRequire.cache[CONFIG];
  try {
    return nodeRequire(CONFIG) as { ci: Record<string, unknown> };
  } finally {
    delete nodeRequire.cache[CONFIG];
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

type Collect = { url: string[]; numberOfRuns: number; settings: unknown };
type MatrixEntry = { matchingUrlPattern: string; assertions: Record<string, unknown> };
type Assert = { assertMatrix: MatrixEntry[] };

const collectOf = (config: { ci: Record<string, unknown> }) => config.ci.collect as Collect;
const assertOf = (config: { ci: Record<string, unknown> }) => config.ci.assert as Assert;

const MIN = ['error', { minScore: 0.9, aggregationMethod: 'median' }];

const LOCAL_URLS = [
  `${LOCAL_BASE}/`,
  `${LOCAL_BASE}/new`,
  `${LOCAL_BASE}/t/TP-000123`,
  `${LOCAL_BASE}/confirm/lighthouse-token`,
  `${LOCAL_BASE}/ops`,
  `${LOCAL_BASE}/legal/privacy`,
  `${LOCAL_BASE}/legal/terms`,
  `${LOCAL_BASE}/nope`,
];

describe('lighthouserc.cjs local mode', () => {
  it('keeps the exact eight-URL list and three runs', () => {
    const config = loadConfig({ LH_BASE_URL: LOCAL_BASE, LH_TICKET_REF: 'TP-000123' });

    expect(collectOf(config).url).toEqual(LOCAL_URLS);
    expect(collectOf(config).numberOfRuns).toBe(3);
    expect(collectOf(config).settings).toEqual({
      chromeFlags: '--headless=new --no-sandbox',
    });
  });

  it('keeps the four categories at a 0.9 median on crawlable pages and no SEO on confirm/ops', () => {
    const config = loadConfig({ LH_BASE_URL: LOCAL_BASE, LH_TICKET_REF: 'TP-000123' });
    const [crawlable, privatePages] = assertOf(config).assertMatrix;

    expect(assertOf(config).assertMatrix).toHaveLength(2);
    expect(crawlable.matchingUrlPattern).toBe('^(?!.*/(confirm|ops)(/|$)).*$');
    expect(crawlable.assertions).toEqual({
      'categories:performance': MIN,
      'categories:accessibility': MIN,
      'categories:best-practices': MIN,
      'categories:seo': MIN,
    });
    expect(privatePages.matchingUrlPattern).toBe('/(confirm|ops)(/|$)');
    expect(privatePages.assertions).toEqual({
      'categories:performance': MIN,
      'categories:accessibility': MIN,
      'categories:best-practices': MIN,
    });
  });

  it('still requires LH_TICKET_REF outside live mode', () => {
    expect(() => loadConfig({ LH_BASE_URL: LOCAL_BASE })).toThrow(/LH_TICKET_REF/);
  });
});

describe('lighthouserc.cjs live mode', () => {
  const LIVE = 'https://ticket-pipeline.onrender.com';
  const liveEnv = { LH_BASE_URL: LIVE, LH_LIVE_URL: LIVE };
  const liveUrl = (suffix: string) => `${LIVE}${suffix}`;

  it('drops /t/:ref when there is no ticket ref', () => {
    const urls = collectOf(loadConfig(liveEnv)).url;

    expect(urls).toEqual([
      liveUrl('/'),
      liveUrl('/new'),
      liveUrl('/confirm/lighthouse-token'),
      liveUrl('/ops'),
      liveUrl('/legal/privacy'),
      liveUrl('/legal/terms'),
      liveUrl('/nope'),
    ]);
  });

  it('keeps /t/:ref when the operator supplies one', () => {
    const config = loadConfig({ ...liveEnv, LH_TICKET_REF: 'TP-009999' });

    expect(collectOf(config).url).toContain(liveUrl('/t/TP-009999'));
    expect(collectOf(config).numberOfRuns).toBe(3);
  });

  it('keeps the same assertion matrix and the read-only /confirm page', () => {
    const config = loadConfig(liveEnv);

    expect(collectOf(config).url).toContain(liveUrl('/confirm/lighthouse-token'));
    expect(assertOf(config).assertMatrix).toHaveLength(2);
    expect(assertOf(config).assertMatrix[0].assertions).toMatchObject({
      'categories:performance': MIN,
      'categories:seo': MIN,
    });
  });

  it('normalises a trailing slash on the base URL', () => {
    const urls = collectOf(loadConfig({ LH_BASE_URL: `${LIVE}/`, LH_LIVE_URL: `${LIVE}/` })).url;

    expect(urls[0]).toBe(liveUrl('/'));
    expect(urls[1]).toBe(liveUrl('/new'));
    const afterHost = urls.map((url) => url.slice(`${LIVE}/`.length));
    expect(afterHost.every((path) => !path.includes('//'))).toBe(true);
  });
});

describe('resolveMode', () => {
  it('defaults to the local stack when LH_LIVE_URL is unset', () => {
    expect(resolveMode({})).toEqual({ mode: 'local', baseUrl: LOCAL_BASE });
  });

  it('ignores a blank LH_LIVE_URL', () => {
    expect(resolveMode({ LH_LIVE_URL: '   ' })).toEqual({ mode: 'local', baseUrl: LOCAL_BASE });
  });

  it('selects live mode for an https URL and trims a trailing slash', () => {
    expect(resolveMode({ LH_LIVE_URL: 'https://example.test/' })).toEqual({
      mode: 'live',
      baseUrl: 'https://example.test',
      ticketRef: undefined,
    });
  });

  it('carries an optional ticket ref into live mode', () => {
    expect(resolveMode({ LH_LIVE_URL: 'https://example.test', LH_TICKET_REF: ' TP-1 ' })).toEqual({
      mode: 'live',
      baseUrl: 'https://example.test',
      ticketRef: 'TP-1',
    });
  });

  it.each(['http://example.test', 'ftp://example.test', 'example.test', 'not a url'])(
    'rejects %s as a non-https live URL',
    (value) => {
      expect(() => resolveMode({ LH_LIVE_URL: value })).toThrow(UsageError);
    }
  );
});

type Ticket = { ticketId: string; referenceNumber: string };

type Calls = {
  build: Mock<() => number>;
  startStack: Mock<() => StackHandle>;
  stopStack: Mock<(stack: StackHandle) => Promise<void>>;
  waitForHealth: Mock<(base: string) => Promise<void>>;
  seedTicket: Mock<(base: string) => Promise<Ticket>>;
  waitForCompletion: Mock<(base: string, referenceNumber: string) => Promise<void>>;
  cleanupTicket: Mock<(ticketId: string) => Promise<void>>;
  autorun: Mock<(env: Record<string, string>) => number>;
};

function fakeDeps(): { deps: LighthouseDeps; calls: Calls } {
  const stack: StackHandle = { kill: vi.fn(), exited: Promise.resolve(0) };
  const calls: Calls = {
    build: vi.fn(() => 0),
    startStack: vi.fn(() => stack),
    stopStack: vi.fn(() => Promise.resolve()),
    waitForHealth: vi.fn(() => Promise.resolve()),
    seedTicket: vi.fn(() => Promise.resolve({ ticketId: 't1', referenceNumber: 'TP-000123' })),
    waitForCompletion: vi.fn(() => Promise.resolve()),
    cleanupTicket: vi.fn(() => Promise.resolve()),
    autorun: vi.fn(() => 0),
  };
  return { deps: { ...calls, chromePath: () => '/chrome' }, calls };
}

function io(): { print: Mock<Print>; printError: Mock<Print> } {
  return { print: vi.fn<Print>(), printError: vi.fn<Print>() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lighthouse main: live mode', () => {
  it('runs only lhci, with no build, stack or seed, and skips /t/:ref without a ref', async () => {
    const { deps, calls } = fakeDeps();
    const { print, printError } = io();

    const code = await main({ LH_LIVE_URL: 'https://example.test' }, deps, print, printError);

    expect(code).toBe(0);
    expect(calls.build).not.toHaveBeenCalled();
    expect(calls.startStack).not.toHaveBeenCalled();
    expect(calls.waitForHealth).not.toHaveBeenCalled();
    expect(calls.seedTicket).not.toHaveBeenCalled();
    expect(calls.waitForCompletion).not.toHaveBeenCalled();
    expect(calls.cleanupTicket).not.toHaveBeenCalled();
    expect(calls.autorun).toHaveBeenCalledTimes(1);
    expect(calls.autorun).toHaveBeenCalledWith({
      LH_BASE_URL: 'https://example.test',
      LH_LIVE_URL: 'https://example.test',
      LH_CHROME_PATH: '/chrome',
    });
    expect(printError).not.toHaveBeenCalled();
    expect(print.mock.calls.flat().join('\n')).toMatch(/\/t\/:ref is skipped/i);
  });

  it('passes the operator ticket ref through when one is supplied', async () => {
    const { deps, calls } = fakeDeps();
    const { print } = io();

    const code = await main(
      { LH_LIVE_URL: 'https://example.test', LH_TICKET_REF: 'TP-009999' },
      deps,
      print,
      vi.fn()
    );

    expect(code).toBe(0);
    expect(calls.autorun).toHaveBeenCalledWith({
      LH_BASE_URL: 'https://example.test',
      LH_LIVE_URL: 'https://example.test',
      LH_CHROME_PATH: '/chrome',
      LH_TICKET_REF: 'TP-009999',
    });
    expect(print.mock.calls.flat().join('\n')).not.toMatch(/skip/i);
  });

  it('returns the lhci exit code and never touches the local flow', async () => {
    const { deps, calls } = fakeDeps();
    calls.autorun.mockReturnValue(7);

    const code = await main({ LH_LIVE_URL: 'https://example.test' }, deps, vi.fn(), vi.fn());

    expect(code).toBe(7);
    expect(calls.build).not.toHaveBeenCalled();
    expect(calls.seedTicket).not.toHaveBeenCalled();
  });
});

describe('lighthouse main: usage errors', () => {
  it('exits 2 with a usage line for a non-https LH_LIVE_URL', async () => {
    const { deps, calls } = fakeDeps();
    const { print, printError } = io();

    const code = await main({ LH_LIVE_URL: 'http://example.test' }, deps, print, printError);

    expect(code).toBe(2);
    const output = printError.mock.calls.flat().join('\n');
    expect(output).toMatch(/https/);
    expect(output).toContain('bun run lighthouse');
    expect(calls.autorun).not.toHaveBeenCalled();
    expect(calls.build).not.toHaveBeenCalled();
  });
});

describe('lighthouse main: local mode unchanged', () => {
  it('builds, starts the stack, seeds a ticket, runs lhci and cleans up', async () => {
    const { deps, calls } = fakeDeps();
    const { print, printError } = io();

    const code = await main({}, deps, print, printError);

    expect(code).toBe(0);
    expect(calls.build).toHaveBeenCalledTimes(1);
    expect(calls.startStack).toHaveBeenCalledTimes(1);
    expect(calls.waitForHealth).toHaveBeenCalledWith(LOCAL_BASE);
    expect(calls.seedTicket).toHaveBeenCalledWith(LOCAL_BASE);
    expect(calls.waitForCompletion).toHaveBeenCalledWith(LOCAL_BASE, 'TP-000123');
    expect(calls.autorun).toHaveBeenCalledWith({
      LH_BASE_URL: LOCAL_BASE,
      LH_CHROME_PATH: '/chrome',
      LH_TICKET_REF: 'TP-000123',
    });
    expect(calls.stopStack).toHaveBeenCalledTimes(1);
    expect(calls.cleanupTicket).toHaveBeenCalledWith('t1');
    expect(printError).not.toHaveBeenCalled();
  });

  it('stops after a failed build without starting the stack', async () => {
    const { deps, calls } = fakeDeps();
    calls.build.mockReturnValue(1);

    const code = await main({}, deps, vi.fn(), vi.fn());

    expect(code).toBe(1);
    expect(calls.startStack).not.toHaveBeenCalled();
    expect(calls.autorun).not.toHaveBeenCalled();
  });

  it('stops the stack and cleans the ticket even when lhci fails', async () => {
    const { deps, calls } = fakeDeps();
    calls.autorun.mockReturnValue(3);

    const code = await main({}, deps, vi.fn(), vi.fn());

    expect(code).toBe(3);
    expect(calls.stopStack).toHaveBeenCalledTimes(1);
    expect(calls.cleanupTicket).toHaveBeenCalledWith('t1');
  });
});

describe('lhciEnv', () => {
  it('omits LH_LIVE_URL and LH_TICKET_REF for a local run without them', () => {
    expect(lhciEnv({ baseUrl: LOCAL_BASE, live: false, chromePath: '/chrome' })).toEqual({
      LH_BASE_URL: LOCAL_BASE,
      LH_CHROME_PATH: '/chrome',
    });
  });

  it('marks live mode and copies the ref when present', () => {
    expect(
      lhciEnv({
        baseUrl: 'https://example.test',
        live: true,
        ticketRef: 'TP-1',
        chromePath: '/chrome',
      })
    ).toEqual({
      LH_BASE_URL: 'https://example.test',
      LH_LIVE_URL: 'https://example.test',
      LH_TICKET_REF: 'TP-1',
      LH_CHROME_PATH: '/chrome',
    });
  });
});
