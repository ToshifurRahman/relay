/**
 * The combined production entry point, booted under Bun so both the API and the worker run
 * in one process. See tests/helpers/entry-process.ts for the isolation it runs in.
 */
import { io as connect } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createTicket,
  type EntryProcess,
  startEntry,
  waitForHealth,
  waitForStatus,
} from '../helpers/entry-process.js';

let entry: EntryProcess | undefined;

afterEach(async () => {
  await entry?.stop();
  entry = undefined;
});

describe('combined main entry point', () => {
  it('serves the API, processes a ticket, and exits cleanly on SIGTERM', async () => {
    entry = await startEntry('src/main.ts');
    await waitForHealth(entry);

    const id = await createTicket(entry);
    await waitForStatus(entry, id, 'completed');

    expect(await entry.terminate()).toBe(0);
    expect(entry.output()).toContain('Shutdown complete');
  }, 60_000);

  it('finishes a ticket that is mid-processing when SIGTERM arrives', async () => {
    // Each fake LLM call takes 2s, so the ticket is still in flight when the signal lands.
    entry = await startEntry('src/main.ts', { LLM_FAKE_DELAY_MS: '2000' });
    await waitForHealth(entry);

    const id = await createTicket(entry);
    await waitForStatus(entry, id, 'processing');

    expect(await entry.terminate()).toBe(0);
    expect(entry.output()).toContain('Worker stopping; draining in-flight work');
    expect(entry.output()).toContain('Shutdown complete');

    // The server is gone, so read the final state from the database.
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: entry.databaseUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{ status: string }>(
        'SELECT status FROM tickets WHERE id = $1',
        [id]
      );
      expect(rows[0]?.status).toBe('completed');
    } finally {
      await client.end();
    }
  }, 60_000);

  it('exits 0 even with a websocket client still connected', async () => {
    entry = await startEntry('src/main.ts');
    await waitForHealth(entry);

    const socket = connect(entry.base, { transports: ['websocket'], reconnection: false });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });

    try {
      const code = await entry.terminate();
      expect(code, entry.output()).toBe(0);
    } finally {
      socket.close();
    }
  }, 60_000);

  it('drains background emails and alerts before closing the pool (REL-05)', async () => {
    entry = await startEntry('src/main.ts');
    await waitForHealth(entry);

    expect(await entry.terminate()).toBe(0);
    const output = entry.output();
    // The step runs after the worker drains and before Postgres closes, so a delivery that was
    // still in flight can finish and record its outcome. The spawned process logs through
    // pino-pretty (NODE_ENV=test), which wraps the field name in ANSI codes, so match the value.
    const background = output.indexOf('"background-work"');
    const postgres = output.indexOf('"postgres"');
    expect(background).toBeGreaterThan(-1);
    expect(postgres).toBeGreaterThan(background);
    expect(output).toContain('Shutdown complete');
  }, 60_000);
});
