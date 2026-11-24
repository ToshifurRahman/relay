import { setTimeout as sleep } from 'node:timers/promises';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const mockQueue = vi.hoisted(
  () =>
    [] as Array<{
      ticketId: string;
      referenceNumber: string;
      receiptHandle: string;
      attemptNumber: number;
    }>
);

const TRIAGE_RESULT = triageResult();

const DRAFT_RESULT = draftResult();

vi.mock('../../../src/lib/ai-service.js', () => ({
  AIService: class {
    async triage() {
      await sleep(120);
      return TRIAGE_RESULT;
    }
    async draft() {
      await sleep(120);
      return DRAFT_RESULT;
    }
  },
}));

vi.mock('../../../src/lib/socket.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/lib/socket.js')>();
  return { ...real, getEmitter: vi.fn(() => ({ to: () => ({ emit: () => {} }) })) };
});

vi.mock('../../../src/lib/queue.js', () => ({
  enqueueTicket: vi.fn((ticketId: string, referenceNumber: string) => {
    mockQueue.push({
      ticketId,
      referenceNumber,
      receiptHandle: `receipt-${ticketId}`,
      attemptNumber: 1,
    });
    return Promise.resolve();
  }),
  receiveMessages: vi.fn((options?: { maxMessages?: number }) => {
    const maxMessages = Math.max(1, Math.min(10, Math.floor(options?.maxMessages ?? 10)));
    return Promise.resolve(mockQueue.splice(0, maxMessages));
  }),
  deleteMessage: vi.fn(() => Promise.resolve()),
}));

import { pool } from '../../../src/lib/db.js';
import { enqueueTicket } from '../../../src/lib/queue.js';
import { getAllEventsByTicketId } from '../../../src/repositories/events.js';
import { getTicketById, insertTicket } from '../../../src/repositories/tickets.js';
import { run } from '../../../src/worker.js';
import { draftResult, triageResult } from '../../fixtures/ai-output.js';
import { purgeTicketEvents } from '../../helpers/purge-ticket-events.js';

const createdIds: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  mockQueue.length = 0;

  if (createdIds.length) {
    await purgeTicketEvents(createdIds);
    await pool.query('DELETE FROM ticket_processing WHERE ticket_id = ANY($1::uuid[])', [
      createdIds,
    ]);
    await pool.query('DELETE FROM tickets WHERE id = ANY($1::uuid[])', [createdIds]);
    createdIds.length = 0;
  }
});

afterAll(async () => {
  await pool.end();
});

describe('run — surge concurrency', () => {
  it('processes 20 simultaneous submissions without serial start blocking', async () => {
    const batchSize = 20;
    const now = Date.now();

    const tickets = await Promise.all(
      Array.from({ length: batchSize }, (_, i) =>
        insertTicket(`TICK-CONC-${now}-${i}`, `Subject ${i}`, `Description ${i}`)
      )
    );
    createdIds.push(...tickets.map((t) => t.id));

    await Promise.all(tickets.map((ticket) => enqueueTicket(ticket.id, ticket.referenceNumber)));

    await run({ concurrency: 5, stopWhenIdle: true, receiveWaitTimeSeconds: 0 });

    const ticketStates = await Promise.all(tickets.map((ticket) => getTicketById(ticket.id)));
    expect(ticketStates.every((ticket) => ticket.status === 'completed')).toBe(true);

    const ticketEvents = await Promise.all(
      tickets.map((ticket) => getAllEventsByTicketId(ticket.id))
    );
    const startedAt = ticketEvents
      .map((events) => events.find((event) => event.event === 'triage.started')?.occurredAt)
      .filter((value): value is Date => value instanceof Date);
    const completedAt = ticketEvents
      .map((events) => events.find((event) => event.event === 'ticket.completed')?.occurredAt)
      .filter((value): value is Date => value instanceof Date);

    expect(startedAt).toHaveLength(batchSize);
    expect(completedAt).toHaveLength(batchSize);

    const firstCompletionMs = Math.min(...completedAt.map((date) => date.getTime()));
    const startedBeforeFirstCompletion = startedAt.filter(
      (date) => date.getTime() <= firstCompletionMs
    ).length;

    expect(startedBeforeFirstCompletion).toBeGreaterThanOrEqual(5);
  });

  // resolveWorkerConcurrency ignores an override that is not a positive integer, so a bad
  // value cannot stall the loop: a concurrency of 0 would make `inFlight.size >= concurrency`
  // true on the first pass, and every message would wait for a slot that never frees. The
  // observable proof is that the fallback (WORKER_CONCURRENCY, default 10) processed the
  // ticket, which the zero override could not have done.
  it('falls back to the configured concurrency when the override is not a positive integer', async () => {
    const ticket = await insertTicket(
      `TICK-CONC-ZERO-${Date.now()}`,
      'Zero override',
      'Zero override falls back'
    );
    createdIds.push(ticket.id);
    await enqueueTicket(ticket.id, ticket.referenceNumber);

    await run({ concurrency: 0, stopWhenIdle: true, receiveWaitTimeSeconds: 0 });

    expect((await getTicketById(ticket.id)).status).toBe('completed');
    // Bounded well under the 30s default: if the fallback ever stopped applying, this case
    // would hang with no slot ever free, and it should fail as a timeout rather than sit there.
  }, 15_000);
});
