/**
 * Story 7.12.9 - the words the API sends must match the public pages. The Terms say the demo has
 * no support team, so a customer email that says a ticket is "flagged for the team" contradicts
 * them, and an ops alert still branded "Ticket Pipe" names a product that no longer exists.
 *
 * These assertions read the copy the senders build, so the same drift fails here as on the site.
 */
import { describe, expect, it } from 'vitest';

import {
  buildConfirmEmail,
  buildReplyReadyEmail,
  buildSnagEmail,
} from '../../src/services/notification-emails.js';
import { buildAlertMessage } from '../../src/services/ops-alerts.js';

const ctx = {
  subject: 'Export broken',
  referenceNumber: 'TICK-1760000000000-7A4D2C9E',
  url: 'https://example.test/t/TICK-1760000000000-7A4D2C9E',
};

const alerts = {
  referenceNumber: 'TICK-1760000000000-7A4D2C9E',
  ticketId: '00000000-0000-4000-8000-000000000000',
  reason: 'incomplete_output',
  occurredAt: new Date('2026-11-24T10:00:00Z'),
} as Parameters<typeof buildAlertMessage>[0];

describe('customer email copy matches the legal pages (7.12.9 check 2)', () => {
  it('never claims a support team the demo does not have', () => {
    for (const mail of [buildConfirmEmail(ctx), buildReplyReadyEmail(ctx), buildSnagEmail(ctx)]) {
      expect(mail.text).not.toMatch(/the team\b/i);
      expect(mail.html).not.toMatch(/the team\b/i);
      expect(`${mail.subject} ${mail.text}`).not.toMatch(/Ticket Pipe/);
    }
  });

  it('points the snag mail at the ops console instead', () => {
    expect(buildSnagEmail(ctx).text).toMatch(/flagged on the ops console/);
  });
});

describe('ops alert branding matches the product name (7.12.9 check 4)', () => {
  it('names Relay, not the retired working title', () => {
    const { subject } = buildAlertMessage(alerts);
    expect(subject).toMatch(/^\[Relay\] /);
    expect(subject).not.toMatch(/Ticket Pipe/);
  });
});
