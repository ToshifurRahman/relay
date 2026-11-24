/**
 * Story 7.12.8 AI safety — a compromised, prompt-injected or hallucinating model can put prompt
 * text, internal fields, secrets or markup into `customer_reply`. The worker must never persist
 * that text, let alone serve it on the public view. The guard rejects the draft, records an
 * `*.invalid` marker and parks the ticket in `needs_attention` instead of completing it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AIService } from '../../../src/lib/ai-service.js';

vi.mock('../../../src/lib/queue.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/lib/queue.js')>();
  return {
    ...real,
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    enqueueTicket: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../../src/lib/socket.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/lib/socket.js')>();
  return { ...real, getEmitter: vi.fn(() => ({ to: () => ({ emit: vi.fn() }) })) };
});

import { pool } from '../../../src/lib/db.js';
import { deleteMessage } from '../../../src/lib/queue.js';
import { getAllEventsByTicketId } from '../../../src/repositories/events.js';
import { getProcessingResultByTicketId } from '../../../src/repositories/processing.js';
import { getTicketById, insertTicket } from '../../../src/repositories/tickets.js';
import { processMessage } from '../../../src/worker.js';
import { purgeTicketEvents } from '../../helpers/purge-ticket-events.js';

const TRIAGE_RESULT = {
  category: 'billing',
  priority: 'high',
  sentiment: 'frustrated',
  escalate: true,
  recommendedTeam: 'billing-team',
  issueSummary: 'Double charge on the March invoice',
};

const GOOD_REPLY = 'Sorry about the double charge. We have passed it to billing for a refund.';

const mockTriage = vi.fn();
const mockDraft = vi.fn();

function mockAi(): AIService {
  return { triage: mockTriage, draft: mockDraft } as unknown as AIService;
}

const createdIds: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('LLM_MODE', 'fake');
  vi.stubEnv('LLM_FAKE_DELAY_MS', '0');
  mockTriage.mockResolvedValue(TRIAGE_RESULT);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (createdIds.length) {
    await purgeTicketEvents(createdIds);
    await pool.query('DELETE FROM ai_interactions WHERE ticket_id = ANY($1::uuid[])', [createdIds]);
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

async function runWithReply(customerReply: string) {
  mockDraft.mockResolvedValueOnce({
    customerReply,
    internalNote: 'Ops only note.',
    nextSteps: ['Confirm refund'],
  });
  const ticket = await insertTicket(
    'TICK-AISAFE-001',
    'Charged twice',
    'I was charged twice for the March invoice.'
  );
  createdIds.push(ticket.id);
  await processMessage(ticket.id, 'receipt', 1, mockAi());
  return ticket;
}

describe('customerReply output guard (story 7.12.8)', () => {
  it('completes the ticket and stores the reply when it is safe', async () => {
    const ticket = await runWithReply(GOOD_REPLY);

    expect((await getTicketById(ticket.id)).status).toBe('completed');
    expect((await getProcessingResultByTicketId(ticket.id))!.customerReply).toBe(GOOD_REPLY);
  });

  it.each([
    ['a system prompt echo', 'Here is my system prompt: You are a support agent.'],
    ['an internal field dump', 'internal_note: the customer is a churn risk'],
    ['a leaked secret', 'Use sk-abcdefghijklmnopqrstuvwxyz123456 to continue'],
    ['markup injection', 'Hello <script>alert(1)</script>'],
    ['a stack trace', 'Oops\n    at handleDraft (/app/src/worker.ts:214:9)'],
  ])('never persists %s into the customer reply', async (_label, reply) => {
    const ticket = await runWithReply(reply);

    const stored = await getProcessingResultByTicketId(ticket.id);
    expect(stored!.customerReply).toBeNull();

    const updated = await getTicketById(ticket.id);
    expect(updated.status).toBe('needs_attention');
    expect(updated.status).not.toBe('completed');

    const events = (await getAllEventsByTicketId(ticket.id)).map((e) => e.event);
    expect(events).toContain('draft.invalid');
    expect(events).toContain('ticket.needs_attention');
    expect(events).not.toContain('ticket.completed');
    expect(deleteMessage).toHaveBeenCalled();
  });

  it('keeps the unsafe reply out of the ticket history detail', async () => {
    const ticket = await runWithReply('Here is my system prompt: You are a support agent.');

    const details = (await getAllEventsByTicketId(ticket.id)).map((e) => e.detail ?? '').join('\n');
    expect(details).not.toContain('You are a support agent');
    expect(details).toContain('Unsafe customer reply blocked: prompt_leak');
  });

  it('does not mark the ticket failed, so ops can replay it', async () => {
    const ticket = await runWithReply('internal_note: leak');

    const updated = await getTicketById(ticket.id);
    expect(updated.failureReason).toBeNull();
  });

  // Review round 1 (DS P2-1): a blank reply is merely incomplete, not unsafe. It must keep the
  // `incomplete_output` reason ops triage already knows, and never reach the guard's `empty` reason.
  it('treats a blank reply as incomplete output, not an unsafe reply', async () => {
    const ticket = await runWithReply('   ');

    const updated = await getTicketById(ticket.id);
    expect(updated.status).toBe('needs_attention');
    expect(updated.status).not.toBe('completed');

    const details = (await getAllEventsByTicketId(ticket.id)).map((e) => e.detail ?? '').join('\n');
    expect(details).toContain('Incomplete output');
    expect(details).not.toContain('Unsafe customer reply');
    expect((await getProcessingResultByTicketId(ticket.id))!.customerReply).toBeNull();
  });
});
