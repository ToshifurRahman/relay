import { logger } from '../lib/logger.js';
import { pendingNotifications } from './customer-notifications.js';
import { pendingAlerts } from './ops-alerts.js';

/**
 * Story 7.12.3 (REL-05): the worker starts customer emails and ops alerts without awaiting them
 * (`void notifyIfDue(...)`, `alertNeedsAttention(...)`), so a ticket's processing task can finish
 * while its email is still in flight. On a Render redeploy the process stops right after the
 * worker drains, and the notification claim (`completed_notified_at`) is already set, so an email
 * cut off here is never retried: it is dropped silently. Shutdown drains this work before the
 * database pool closes.
 *
 * Each drain is independent and never rejects: a mailer outage must not stop the alert drain, and
 * a failed drain must not turn a graceful shutdown into a crash.
 */
export async function drainBackgroundWork(): Promise<void> {
  const results = await Promise.allSettled([pendingNotifications(), pendingAlerts()]);
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.error({ err: result.reason }, 'Background work did not drain before shutdown');
    }
  }
}
