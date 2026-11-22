import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const counters = vi.hoisted(() => ({ hit: vi.fn(), hitWithin: vi.fn() }));
const notifications = vi.hoisted(() => ({
  claimCompleted: vi.fn(),
  claimSnag: vi.fn(),
  confirmByTokenHash: vi.fn(),
  deleteSubscription: vi.fn(),
  getNotificationStatus: vi.fn(),
  insertSubscription: vi.fn(),
  peekByTokenHash: vi.fn(),
  recordNotificationError: vi.fn(),
}));
const tickets = vi.hoisted(() => ({ getTicketById: vi.fn() }));
const events = vi.hoisted(() => ({ recordTicketEvent: vi.fn() }));
const updates = vi.hoisted(() => ({ emitTicketUpdate: vi.fn() }));

vi.mock('../../../src/lib/counters.js', () => ({
  hit: counters.hit,
  hitWithin: counters.hitWithin,
}));
vi.mock('../../../src/repositories/notifications.js', () => notifications);
vi.mock('../../../src/repositories/tickets.js', () => tickets);
vi.mock('../../../src/services/ticket-events.js', () => events);
vi.mock('../../../src/services/ticket-updates.js', () => updates);

import { setMailerForTests } from '../../../src/lib/mailer.js';
import {
  notifyIfDue,
  pendingNotifications,
  requestNotification,
} from '../../../src/services/customer-notifications.js';

const ticket = {
  id: '2b4f8a4e-0f4d-4f10-9e5d-2e9f6c1a7b30',
  referenceNumber: 'TICK-1795361694366-B4C4452A',
  subject: 'Printer jams',
  status: 'completed',
};

const dayKey = () => `notify:sent:${new Date().toISOString().slice(0, 10)}`;

beforeEach(() => {
  vi.resetAllMocks();
  process.env.MAIL_DRIVER = 'memory';
  process.env.MAIL_FROM = 'relay@example.test';
  process.env.PUBLIC_SITE_URL = 'https://relay.test';
  process.env.MAIL_DAILY_CAP = '250';
  tickets.getTicketById.mockResolvedValue(ticket);
  notifications.claimCompleted.mockResolvedValue('customer@example.test');
  notifications.insertSubscription.mockResolvedValue(true);
  notifications.recordNotificationError.mockResolvedValue(undefined);
  events.recordTicketEvent.mockResolvedValue(undefined);
});

afterEach(() => {
  setMailerForTests(null);
});

describe('customer-email free-tier guard', () => {
  it('fails closed when the daily cap cannot be verified', async () => {
    const send = vi.fn(async () => {});
    setMailerForTests({ send });
    counters.hit.mockRejectedValue(new Error('Redis is down'));
    counters.hitWithin.mockRejectedValue(new Error('Redis is down'));

    await notifyIfDue(ticket.id);
    await pendingNotifications();

    expect(send).not.toHaveBeenCalled();
    expect(counters.hitWithin).toHaveBeenCalledWith(dayKey(), 24 * 60 * 60);
    expect(notifications.recordNotificationError).toHaveBeenCalledWith(ticket.id, 'quota');
    expect(events.recordTicketEvent).toHaveBeenCalledWith(
      ticket,
      'notification.failed',
      'reply_ready:quota'
    );
  });

  it('still sends when the counter answers under the cap', async () => {
    const send = vi.fn(async () => {});
    setMailerForTests({ send });
    counters.hitWithin.mockResolvedValue(1);

    await notifyIfDue(ticket.id);
    await pendingNotifications();

    expect(send).toHaveBeenCalledTimes(1);
    expect(notifications.recordNotificationError).not.toHaveBeenCalled();
  });

  it('bounds the opt-in counter instead of calling the unbounded one', async () => {
    tickets.getTicketById.mockResolvedValue({ ...ticket, status: 'queued' });
    counters.hitWithin.mockResolvedValue(1);
    setMailerForTests({ send: vi.fn(async () => {}) });

    const view = await requestNotification(ticket.id, 'customer@example.test', '203.0.113.9');

    expect(view.state).toBe('pending');
    expect(counters.hitWithin).toHaveBeenCalledWith('notify:optin:203.0.113.9', 3600);
  });

  it('returns a 503 when the opt-in limiter cannot answer', async () => {
    tickets.getTicketById.mockResolvedValue({ ...ticket, status: 'queued' });
    counters.hitWithin.mockRejectedValue(new Error('Redis timeout'));
    setMailerForTests({ send: vi.fn(async () => {}) });

    await expect(
      requestNotification(ticket.id, 'customer@example.test', '203.0.113.9')
    ).rejects.toMatchObject({
      status: 503,
      message: "We can't accept new requests right now. Please try again shortly.",
    });
    expect(notifications.insertSubscription).not.toHaveBeenCalled();
  });
});
