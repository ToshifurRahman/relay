import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { app } from '../../../src/app.js';
import { pool } from '../../../src/lib/db.js';
import {
  type AiInteractionRecord,
  insertAiInteraction,
} from '../../../src/repositories/ai-interactions.js';
import { insertTicket } from '../../../src/repositories/tickets.js';
import type { AiInteractionsBody, AiSummaryBody } from '../../helpers/api-types.js';
import request from '../../helpers/ops-session.js';

const createdIds: string[] = [];

afterEach(async () => {
  if (createdIds.length) {
    await pool.query('DELETE FROM ai_interactions WHERE ticket_id = ANY($1::uuid[])', [createdIds]);
    await pool.query('DELETE FROM tickets WHERE id = ANY($1::uuid[])', [createdIds]);
    createdIds.length = 0;
  }
});

afterAll(async () => {
  await pool.end();
});

function record(
  overrides: Partial<AiInteractionRecord> & { ticketId: string }
): AiInteractionRecord {
  return {
    operation: 'triage',
    provider: 'primary',
    model: 'test-model',
    outcome: 'success',
    durationMs: 100,
    ...overrides,
  };
}

describe('GET /api/ops/ai-interactions', () => {
  it('returns a paginated list shape', async () => {
    const ticket = await insertTicket('TICK-OPS-001', 'Sub', 'Desc');
    createdIds.push(ticket.id);
    await insertAiInteraction(record({ ticketId: ticket.id }));

    const res = await request(app)
      .get<AiInteractionsBody>('/api/ops/ai-interactions')
      .query({ ticketId: ticket.id });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.interactions).toHaveLength(1);
    expect(res.body.interactions[0]).toMatchObject({
      ticketId: ticket.id,
      provider: 'primary',
      outcome: 'success',
    });
  });

  it('returns 400 for an invalid outcome filter', async () => {
    const res = await request(app)
      .get<AiInteractionsBody>('/api/ops/ai-interactions')
      .query({ outcome: 'not-a-real-outcome' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid query parameters' });
  });

  it('returns 400 for a malformed ticketId', async () => {
    const res = await request(app)
      .get<AiInteractionsBody>('/api/ops/ai-interactions')
      .query({ ticketId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/ops/ai-interactions/summary', () => {
  // The summary aggregates the whole table over a time window, so any absolute value is only
  // stable on an empty database: a row left by an earlier run (a crashed suite, a manual probe)
  // inside the window changes the counts, and a stray failure row changes the ratio. The test
  // therefore measures the deltas its own insert makes, and checks the ratio against the totals
  // the same response reports rather than against a hardcoded 1.
  interface TriageTotals {
    count: number;
    successCount: number;
    successRate: number;
  }

  async function primaryTriageTotals(): Promise<TriageTotals | undefined> {
    const res = await request(app).get<AiSummaryBody>('/api/ops/ai-interactions/summary');
    expect(res.status).toBe(200);
    const row = res.body.summary.find(
      (s: { provider: string; operation: string }) =>
        s.provider === 'primary' && s.operation === 'triage'
    );
    return (
      row && {
        count: row.count,
        successCount: row.successCount,
        successRate: row.successRate,
      }
    );
  }

  it('returns a summary shape with the default 24h window', async () => {
    const before = (await primaryTriageTotals()) ?? { count: 0, successCount: 0, successRate: 0 };

    const ticket = await insertTicket('TICK-OPS-002', 'Sub', 'Desc');
    createdIds.push(ticket.id);
    await insertAiInteraction(record({ ticketId: ticket.id }));

    const res = await request(app).get<AiSummaryBody>('/api/ops/ai-interactions/summary');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('since');
    expect(res.body).toHaveProperty('until');
    // This test's own ticket was created inside the window.
    expect(res.body.ticketsInWindow).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(res.body.summary)).toBe(true);

    const after = (await primaryTriageTotals())!;
    // Exactly one more call and one more success than before: this test's own insert, and
    // nothing else. Any stray row in the window (success or failure) only shifts both baselines.
    expect(after.count).toBe(before.count + 1);
    expect(after.successCount).toBe(before.successCount + 1);
    // The ratio is the response's own successes over its own calls, so a stray failure row
    // changes both sides together instead of breaking the assertion.
    expect(after.successRate).toBeCloseTo(after.successCount / after.count, 10);
  });

  it('returns 400 for a malformed since date', async () => {
    const res = await request(app)
      .get<AiSummaryBody>('/api/ops/ai-interactions/summary')
      .query({ since: 'not-a-date' });
    expect(res.status).toBe(400);
  });
});
