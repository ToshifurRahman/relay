/**
 * Story 7.12.8 AI safety — `customerReply` leakage trace.
 *
 * Path under test: the stored processing row -> buildFullTicketView (ops) -> toPublicTicketView
 * -> the JSON a customer route returns, and the socket payload the ticket room receives.
 *
 * The reply itself is the model's text, so it is the one field that may reach a customer. Nothing
 * beside it may: not `internalNote`/`sentiment`/`escalate`/`recommendedTeam`/`issueSummary`, not
 * provider metadata, not another ticket.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TicketPhases } from '../../../src/domain/ticket-phases.js';
import * as socket from '../../../src/lib/socket.js';
import { emitTicketUpdate } from '../../../src/services/ticket-updates.js';
import { type FullTicketView, toPublicTicketView } from '../../../src/services/ticket-views.js';

const REPLY = 'Sorry about the double charge. We have refunded it.';

const PHASES: TicketPhases = {
  triage: {
    status: 'completed',
    output: {
      category: 'billing',
      priority: 'high',
      sentiment: 'frustrated',
      escalate: true,
      recommendedTeam: 'billing-team',
      issueSummary: 'Double charge on the March invoice',
    },
  },
  draft: {
    status: 'completed',
    output: {
      customerReply: REPLY,
      internalNote: 'Refund issued via Stripe; check for a duplicate webhook.',
      nextActions: ['Confirm refund', 'Audit webhooks'],
    },
  },
};

const INTERNAL_VALUES = [
  'frustrated',
  'Double charge on the March invoice',
  'billing-team',
  'Refund issued via Stripe',
  'Confirm refund',
];

function fullView(overrides: Partial<FullTicketView> = {}): FullTicketView {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    referenceNumber: 'TICK-AISAFE-TRACE',
    subject: 'Charged twice',
    description: 'I was charged twice for the March invoice.',
    status: 'completed',
    createdAt: new Date('2026-11-24T00:00:00.000Z'),
    failureReason: null,
    failedAt: null,
    events: [],
    eventsNextCursor: null,
    phases: PHASES,
    notification: { state: 'none', maskedEmail: null },
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('customerReply public trace (story 7.12.8)', () => {
  it('exposes the reply and nothing else from the draft stage', () => {
    const publicView = toPublicTicketView(fullView());

    expect(publicView.phases.draft).toEqual({
      status: 'completed',
      output: { customerReply: REPLY },
    });
  });

  it('never carries an internal field name or value on the wire', () => {
    const wire = JSON.stringify(toPublicTicketView(fullView()));

    for (const key of [
      'internalNote',
      'nextActions',
      'nextSteps',
      'sentiment',
      'escalate',
      'recommendedTeam',
      'issueSummary',
      'failureReason',
      'failedAt',
    ]) {
      expect(wire).not.toContain(`"${key}"`);
    }
    for (const value of INTERNAL_VALUES) expect(wire).not.toContain(value);
  });

  it('does not carry another ticket in the same fetch', () => {
    const other = fullView({
      id: '22222222-2222-4222-8222-222222222222',
      referenceNumber: 'TICK-AISAFE-OTHER',
      subject: 'Totally different issue',
      description: 'A different customer, a different problem.',
      phases: {
        triage: {
          status: 'completed',
          output: {
            category: 'technical',
            priority: 'low',
            sentiment: 'neutral',
            escalate: false,
            recommendedTeam: 'tech-support',
            issueSummary: 'Other ticket summary',
          },
        },
        draft: {
          status: 'completed',
          output: {
            customerReply: 'Other ticket reply.',
            internalNote: 'Other internal note.',
            nextActions: ['Other action'],
          },
        },
      },
    });

    const one = JSON.stringify(toPublicTicketView(fullView()));
    expect(one).not.toContain('Other ticket reply.');
    expect(one).not.toContain(other.referenceNumber);
    expect(one).not.toContain(other.description);
  });

  it('does not expose internal fields while the draft is still running', () => {
    const publicView = toPublicTicketView(
      fullView({
        status: 'processing',
        phases: { triage: PHASES.triage, draft: { status: 'processing' } },
      })
    );

    expect(publicView.phases.draft).toEqual({ status: 'processing' });
    expect(JSON.stringify(publicView)).not.toContain(REPLY);
  });

  it('emits only the event name to the ticket room, never the reply', () => {
    const seen: Array<{ room: string; event: string; payload: unknown }> = [];
    vi.spyOn(socket, 'getEmitter').mockReturnValue({
      to: (room: string) => ({
        emit: (event: string, payload: unknown) => seen.push({ room, event, payload }),
      }),
    } as never);

    emitTicketUpdate('11111111-1111-4111-8111-111111111111', 'ticket.completed');

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      room: '11111111-1111-4111-8111-111111111111',
      event: 'ticket:update',
    });
    expect(JSON.stringify(seen)).not.toContain(REPLY);
    expect(JSON.stringify(seen)).not.toContain('internalNote');
    expect(JSON.stringify(seen)).not.toContain('sentiment');
  });
});
