import type { Subprocess } from 'bun';

// Local Lighthouse gate (story 6.8): >= 90 in all four categories on /, /new and /t/:ref.
// Local mode builds the web app, runs the e2e stack (API + worker, fake LLM) on its own port,
// seeds one finished ticket for the /t/:ref page, then runs `lhci autorun` with lighthouserc.cjs.
// Needs `docker compose up -d`, migrations and `bun --filter @relay/api setup`, like the e2e tests.
// Not part of `test:e2e`: performance scores are noisy and the run takes a few minutes.
//
// Live mode (story 7.13) points the same assertions at an external site instead:
// `LH_LIVE_URL=https://<host> [LH_TICKET_REF=<ref>] bun run lighthouse`. It starts no stack,
// builds nothing and writes nothing; the live site cannot be seeded headlessly (Turnstile), so a
// /t/:ref page is only checked when the operator supplies a ref from a manual submission.

export const PORT = 3101;
export const LOCAL_BASE = `http://localhost:${PORT}`;

export const USAGE =
  'Usage: LH_LIVE_URL=https://<host> [LH_TICKET_REF=<ref>] bun run lighthouse (or no LH_LIVE_URL for the local stack)';

export type Env = Record<string, string | undefined>;

export type LighthouseMode =
  { mode: 'local'; baseUrl: string } | { mode: 'live'; baseUrl: string; ticketRef?: string };

export interface StackHandle {
  kill: (signal?: Parameters<Subprocess['kill']>[0]) => void;
  exited: Promise<number>;
}

export interface LhciEnvInput {
  baseUrl: string;
  live: boolean;
  ticketRef?: string;
  chromePath: string;
}

// What `lhci autorun` reads. lighthouserc.cjs sees LH_LIVE_URL as the live-mode flag and treats
// LH_TICKET_REF as optional; a local run always passes a freshly seeded ref.
export function lhciEnv({
  baseUrl,
  live,
  ticketRef,
  chromePath,
}: LhciEnvInput): Record<string, string> {
  return {
    LH_BASE_URL: baseUrl,
    ...(live ? { LH_LIVE_URL: baseUrl } : {}),
    ...(ticketRef ? { LH_TICKET_REF: ticketRef } : {}),
    LH_CHROME_PATH: chromePath,
  };
}

export class UsageError extends Error {}

// An https `LH_LIVE_URL` selects live mode; anything else is a usage error. A blank value counts
// as unset so a stray `LH_LIVE_URL=` in a shell does not turn the local gate into a live run.
export function resolveMode(env: Env): LighthouseMode {
  const raw = env.LH_LIVE_URL?.trim();
  if (!raw) return { mode: 'local', baseUrl: LOCAL_BASE };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`LH_LIVE_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'https:') {
    throw new UsageError(`LH_LIVE_URL must be an https:// URL, got: ${raw}`);
  }

  const ticketRef = env.LH_TICKET_REF?.trim() || undefined;
  return { mode: 'live', baseUrl: raw.replace(/\/+$/, ''), ticketRef };
}

export interface LighthouseDeps {
  build: () => number | Promise<number>;
  startStack: () => StackHandle | Promise<StackHandle>;
  stopStack: (stack: StackHandle) => void | Promise<void>;
  waitForHealth: (base: string) => void | Promise<void>;
  seedTicket: (base: string) => Promise<{ ticketId: string; referenceNumber: string }>;
  waitForCompletion: (base: string, referenceNumber: string) => void | Promise<void>;
  cleanupTicket: (ticketId: string) => void | Promise<void>;
  autorun: (env: Record<string, string>) => number | Promise<number>;
  chromePath: () => string | Promise<string>;
}

export type Print = (line: string) => void;

async function localRun(deps: LighthouseDeps, printError: Print): Promise<number> {
  if ((await deps.build()) !== 0) return 1;

  const stack = await deps.startStack();
  let ticketId: string | undefined;
  try {
    await deps.waitForHealth(LOCAL_BASE);
    const ticket = await deps.seedTicket(LOCAL_BASE);
    ticketId = ticket.ticketId;
    await deps.waitForCompletion(LOCAL_BASE, ticket.referenceNumber);

    return await deps.autorun(
      lhciEnv({
        baseUrl: LOCAL_BASE,
        live: false,
        ticketRef: ticket.referenceNumber,
        chromePath: await deps.chromePath(),
      })
    );
  } finally {
    await deps.stopStack(stack);
    if (ticketId) {
      try {
        await deps.cleanupTicket(ticketId);
      } catch (err) {
        printError(`cleanup failed: ${String(err)}`);
      }
    }
  }
}

// Live mode only collects: no build, no stack, no seed and no database or .env access. A
// missing LH_TICKET_REF drops /t/:ref from lighthouserc.cjs and prints why, once.
export async function main(
  env: Env,
  deps: LighthouseDeps,
  print: Print = (line) => console.log(line),
  printError: Print = (line) => console.error(line)
): Promise<number> {
  let mode: LighthouseMode;
  try {
    mode = resolveMode(env);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    printError(`lighthouse: ${err.message}`);
    printError(USAGE);
    return 2;
  }

  if (mode.mode === 'local') return localRun(deps, printError);

  if (!mode.ticketRef) {
    print('lighthouse: LH_TICKET_REF is not set, so /t/:ref is skipped in live mode.');
  }
  return deps.autorun(
    lhciEnv({
      baseUrl: mode.baseUrl,
      live: true,
      ticketRef: mode.ticketRef,
      chromePath: await deps.chromePath(),
    })
  );
}

function run(cmd: string[], env: Record<string, string> = {}): number {
  const result = Bun.spawnSync(cmd, {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: { ...process.env, ...env },
  });
  return result.exitCode;
}

function defaultDeps(): LighthouseDeps {
  return {
    build: () => run(['bun', '--filter', '@relay/web', 'build']),

    startStack: () =>
      Bun.spawn(['bun', '--env-file=.env', 'e2e/stack.ts'], {
        stdio: ['ignore', 'inherit', 'inherit'],
        env: {
          ...process.env,
          PORT: String(PORT),
          LLM_MODE: 'fake',
          LLM_FAKE_DELAY_MS: '0',
          OPS_TOKEN: 'lighthouse-ops-token',
        },
      }) satisfies Subprocess,

    stopStack: async (stack) => {
      stack.kill('SIGTERM');
      await stack.exited;
    },

    waitForHealth: async (base) => {
      for (let i = 0; ; i++) {
        if (i === 60) throw new Error('the stack did not start');
        if (
          await fetch(`${base}/health`).then(
            (r) => r.ok,
            () => false
          )
        )
          return;
        await Bun.sleep(500);
      }
    },

    seedTicket: async (base) => {
      const created = await fetch(`${base}/api/tickets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: 'Lighthouse check',
          description: 'The totals on my invoice do not add up.',
          turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX',
        }),
      });
      if (created.status !== 201) throw new Error(`could not create a ticket: ${created.status}`);
      return (await created.json()) as { ticketId: string; referenceNumber: string };
    },

    waitForCompletion: async (base, referenceNumber) => {
      for (let i = 0; ; i++) {
        if (i === 60) throw new Error('the ticket did not complete');
        const view = await fetch(`${base}/api/tickets/ref/${referenceNumber}`).then(
          (r) => r.json() as Promise<{ status: string }>
        );
        if (view.status === 'completed') return;
        await Bun.sleep(500);
      }
    },

    cleanupTicket: async (ticketId) => {
      const { removeTicket } = await import('../e2e/helpers/cleanup-ticket.js');
      await removeTicket(ticketId);
    },

    autorun: (env) => run(['bunx', 'lhci', 'autorun', '--config=lighthouserc.cjs'], env),

    chromePath: async () => {
      const { chromium } = await import('@playwright/test');
      return chromium.executablePath();
    },
  };
}

if (import.meta.main) {
  process.exit(await main(process.env, defaultDeps()));
}
