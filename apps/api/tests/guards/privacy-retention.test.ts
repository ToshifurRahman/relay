/**
 * Story 7.12.2 — `/privacy` promises "Tickets, replies and their history are deleted 30 days
 * after you send them" and "Your email address is deleted with the ticket". Both claims are
 * only true while the web copy, the purge constant and the purge's delete list agree, so this
 * guard fails the moment one of the three drifts.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const API = path.resolve(import.meta.dirname, '../..');
const REPO = path.resolve(API, '../..');

const retention = readFileSync(path.join(API, 'src/services/ticket-retention.ts'), 'utf8');
const retentionRepo = readFileSync(path.join(API, 'src/repositories/ticket-retention.ts'), 'utf8');
const legal = readFileSync(path.join(REPO, 'apps/web/src/content/legal.ts'), 'utf8');

describe('/privacy retention truthfulness (story 7.12.2)', () => {
  it('promises the same number of days the purge enforces', () => {
    const days = /RETENTION_DAYS\s*=\s*(\d+)/.exec(retention)?.[1];
    expect(days).toBeTruthy();
    expect(legal).toContain(`RETENTION_DAYS_TEXT = '${days} days'`);
  });

  it('deletes every table the privacy page says is deleted with the ticket', () => {
    for (const table of [
      'ticket_notifications',
      'ticket_events',
      'tickets',
      'ai_interactions',
      'ticket_processing',
    ]) {
      expect(retentionRepo).toMatch(new RegExp(`DELETE FROM ${table}\\b`));
    }
  });

  it('runs the sweep from the process the deployment starts', () => {
    // Render runs `bun src/main.ts` (apps/api/scripts/start.sh); the retention service is only
    // real in production if that entry point starts it.
    expect(readFileSync(path.join(API, 'src/main.ts'), 'utf8')).toMatch(/startRetentionSweep\(\)/);
    expect(readFileSync(path.join(API, 'scripts/start.sh'), 'utf8')).toMatch(
      /exec bun src\/main\.ts/
    );
  });
});
