/**
 * Story 7.12.3 (REL-05): the worker fires customer emails and ops alerts without awaiting them
 * (`void notifyIfDue(...)`, `alertNeedsAttention(...)`), so a ticket's processing task can finish
 * while its email is still in flight. On a Render redeploy the process is stopped right after the
 * worker drains, and the notification claim (`completed_notified_at`) is already set, so an email
 * cut off here is never retried: it is dropped silently. Shutdown must drain this background work
 * before the database pool closes.
 */
import { describe, expect, it, vi } from 'vitest';

const pendingNotifications = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const pendingAlerts = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('../../../src/services/customer-notifications.js', () => ({ pendingNotifications }));
vi.mock('../../../src/services/ops-alerts.js', () => ({ pendingAlerts }));

import { drainBackgroundWork } from '../../../src/services/background-work.js';

describe('drainBackgroundWork', () => {
  it('waits for both pending notifications and pending alerts', async () => {
    await drainBackgroundWork();
    expect(pendingNotifications).toHaveBeenCalledTimes(1);
    expect(pendingAlerts).toHaveBeenCalledTimes(1);
  });

  it('does not reject when one drain fails, so the other still runs', async () => {
    pendingNotifications.mockRejectedValueOnce(new Error('mailer down'));
    await expect(drainBackgroundWork()).resolves.toBeUndefined();
    expect(pendingAlerts).toHaveBeenCalledTimes(1);
  });
});
