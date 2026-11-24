/**
 * Story 7.12.11 Epic 7 delivery audit: every finding the pre-audit raised must be disposed of in
 * `docs/audit/launch/11-epic-7-delivery.md`, and nothing Critical or High may still be open.
 *
 * The pre-audit (`docs/audit/pre-audit.md`, 7.0.9) is the audit's own backlog: 52 `PA-*` findings
 * across stories 5.6, 7.1 to 7.5, 7.7 to 7.11 and 7.13, plus seven parked bullets. The delivery
 * audit closes the epic, so a finding that quietly disappears between the pre-audit and the launch
 * gate would be the one failure this story exists to prevent. This guard reads both documents and
 * fails unless every `PA-*` id appears in the delivery ledger with an explicit disposition.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../../../../..');
const PRE_AUDIT = path.join(ROOT, 'docs/audit/pre-audit.md');
const DELIVERY = path.join(ROOT, 'docs/audit/launch/11-epic-7-delivery.md');

const read = (file: string) => readFileSync(file, 'utf8');

/** `PA-7.10-03`, `PA-5.6-01`: story, then a two-digit finding number. */
const PA_ID = /\bPA-\d+(?:\.\d+)?-\d+\b/g;
/** The same pattern without `g`: a global regex is stateful across `.test()` calls. */
const IS_PA_ID = /^\bPA-\d+(?:\.\d+)?-\d+\b$/;

const preAuditIds = (): string[] =>
  [...new Set(read(PRE_AUDIT).match(PA_ID) ?? [])].sort((a, b) =>
    a.localeCompare(b, 'en', { numeric: true })
  );

/** A disposition table row: `| PA-7.4-07 | Low | Closed | ... |`. */
const DISPOSITIONS = ['Closed', 'Fixed', 'Accepted', 'Deferred to 7.13'] as const;

type Row = { id: string; cells: string[] };

function ledgerRows(doc: string): Row[] {
  return doc
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map((line) =>
      line
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean)
    )
    .filter((cells) => IS_PA_ID.test(cells[0] ?? ''))
    .map((cells) => ({ id: cells[0], cells }));
}

describe('pre-audit disposition ledger (7.12.11)', () => {
  it('finds the pre-audit findings it is meant to dispose of', () => {
    // A guard that silently reads zero findings would pass on an empty or renamed document.
    expect(preAuditIds().length).toBeGreaterThanOrEqual(52);
  });

  it('disposes of every pre-audit PA-* finding', () => {
    const rows = new Map(ledgerRows(read(DELIVERY)).map((row) => [row.id, row]));
    const missing = preAuditIds().filter((id) => !rows.has(id));
    expect(missing).toEqual([]);
  });

  it('gives every ledger row one valid disposition', () => {
    const bad = ledgerRows(read(DELIVERY))
      .filter((row) => !DISPOSITIONS.some((status) => row.cells.includes(status)))
      .map((row) => `${row.id}: ${row.cells.slice(1).join(' / ')}`);
    expect(bad).toEqual([]);
  });

  it('lists no finding twice with conflicting dispositions', () => {
    const seen = new Map<string, string>();
    const conflicts: string[] = [];
    for (const row of ledgerRows(read(DELIVERY))) {
      const status = DISPOSITIONS.find((candidate) => row.cells.includes(candidate));
      const first = seen.get(row.id);
      if (first && status && first !== status) conflicts.push(`${row.id}: ${first} vs ${status}`);
      if (!first && status) seen.set(row.id, status);
    }
    expect(conflicts).toEqual([]);
  });

  it('leaves no Critical or High finding open', () => {
    // A carried-over Critical or High would block go-live, so the only allowed dispositions for
    // one are Closed, Fixed, or Deferred to 7.13 (the post-gate go-live story).
    const open = ledgerRows(read(DELIVERY))
      .filter((row) => row.cells[1] === 'Critical' || row.cells[1] === 'High')
      .filter((row) => row.cells.includes('Accepted'))
      .map((row) => row.id);
    expect(open).toEqual([]);
  });

  it('names the severity of every finding it disposes of', () => {
    const unrated = ledgerRows(read(DELIVERY))
      .filter((row) => !['Critical', 'High', 'Medium', 'Low'].includes(row.cells[1] ?? ''))
      .map((row) => `${row.id}: ${row.cells.slice(1).join(' / ')}`);
    expect(unrated).toEqual([]);
  });

  it('accounts for the parked pre-audit items', () => {
    // The seven bullets under "Parked for Launch Audit" are not PA-* ids, so each is claimed by
    // naming the wave that picked it up in the parked-items table.
    const doc = read(DELIVERY);
    const parked = doc.slice(doc.indexOf('## Parked items'));
    expect(parked).not.toBe('');
    for (const owner of ['7.12.1', '7.12.2', '7.12.3', '7.12.4', '7.12.7', '7.12.8', '7.12.9']) {
      expect(parked).toContain(owner);
    }
  });

  it('records the deployed build separately from origin/main', () => {
    // The epic ships in waves, so the deployed site can lag main. Claiming unshipped work is live
    // would make the whole verification table misleading.
    const doc = read(DELIVERY);
    expect(doc).toMatch(/9631ec8/);
    expect(doc).toMatch(/deployed/i);
  });
});
