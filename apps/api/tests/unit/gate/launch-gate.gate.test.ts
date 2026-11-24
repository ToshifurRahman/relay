import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../../../../..');
const GATE = path.join(ROOT, 'scripts/gate.sh');
const DOCS = path.join(ROOT, 'docs/audit/launch');
const GATE_DOC = path.join(DOCS, 'gate.md');

const FIXTURE_TIMEOUT = 30_000;
const temporaryDirs: string[] = [];

afterAll(() => {
  for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'relay-gate-'));
  temporaryDirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
  return dir;
}

function runGate(args: string[]) {
  return spawnSync('bash', [GATE, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

function launchDocNames(): string[] {
  return readdirSync(DOCS)
    .filter((name) => /^\d\d-.+\.md$/.test(name))
    .sort();
}

type Finding = {
  id: string;
  severity: string;
  location: string;
  reason: string;
  status: string;
};

const SEVERITIES = new Set(['Critical', 'High', 'Medium', 'Low', 'P0', 'P1', 'P2']);

function cells(line: string): string[] {
  const stripped = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return stripped.split('|').map((cell) => cell.trim());
}

function findings(file: string): Finding[] {
  const rows: Finding[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const row = cells(line);
    if (row.length < 5 || !/^[A-Z]+-\d+$/.test(row[0])) continue;
    if (!SEVERITIES.has(row[1])) continue;
    rows.push({
      id: row[0],
      severity: row[1],
      location: row[2],
      reason: row[4],
      status: row[row.length - 1],
    });
  }
  return rows;
}

function riskLevel(severity: string): 'Critical' | 'High' | 'Medium' | 'Low' {
  if (severity === 'P0') return 'Critical';
  if (severity === 'P1') return 'High';
  if (severity === 'P2') return 'Low';
  return severity as 'Critical' | 'High' | 'Medium' | 'Low';
}

function runDocsCheck(docsDir: string) {
  return runGate(['--check-docs-only', '--docs-dir', docsDir]);
}

describe('scripts/gate.sh Launch Gate runner', () => {
  it('is present, executable and syntactically valid', () => {
    expect(statSync(GATE).isFile()).toBe(true);
    expect(statSync(GATE).mode & 0o111).not.toBe(0);
    const parse = spawnSync('bash', ['-n', GATE], { encoding: 'utf8' });
    expect(parse.status, parse.stderr).toBe(0);
  });

  it('replaces the legacy ux-ui-agent-skills plugin helper', () => {
    const body = readFileSync(GATE, 'utf8');
    expect(body).not.toMatch(/ux-ui-agent-skills/);
    expect(body).not.toMatch(/\.claude\/plugins/);
    expect(body).not.toMatch(/CLAUDE_PLUGIN_DATA/);
    expect(body).toMatch(/set -euo pipefail/);
  });

  it('runs every required step and cleans the browser output dirs', () => {
    const body = readFileSync(GATE, 'utf8');
    for (const command of [
      'format:check',
      'lint --concurrency=off',
      'typecheck',
      'test:unit',
      'test:integration',
      'test:e2e',
      'lighthouse',
      'bun audit',
      'gitleaks',
    ]) {
      expect(body).toContain(command);
    }
    expect(body).toMatch(/trap\s+\w+\s+EXIT/);
    expect(body).toContain('apps/web/dist');
    expect(body).toContain('.lighthouseci');
    expect(body).toMatch(/--skip-browser/);
    expect(body).toMatch(/--check-docs-only/);
  });

  it(
    'passes the audit-doc check on every existing launch audit doc',
    () => {
      expect(launchDocNames()).toEqual(
        expect.arrayContaining(['01-security.md', '10-portfolio-readiness.md'])
      );
      const result = runDocsCheck(DOCS);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toMatch(/0 open Critical\/High/);
    },
    FIXTURE_TIMEOUT
  );

  it(
    'fails the audit-doc check on an Open High finding',
    () => {
      const dir = fixture({
        '01-fixture.md': [
          '# Fixture',
          '',
          '| ID   | Severity | Location | Evidence | Fix | Status |',
          '| ---- | -------- | -------- | -------- | --- | ------ |',
          '| T-01 | High     | x        | y        | z   | Open   |',
          '',
        ].join('\n'),
      });
      const result = runDocsCheck(dir);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toMatch(/T-01/);
    },
    FIXTURE_TIMEOUT
  );

  it(
    'fails the audit-doc check on an Open Critical finding',
    () => {
      const dir = fixture({
        '02-fixture.md': [
          '| ID   | Severity | Location | Evidence | Fix | Status |',
          '| ---- | -------- | -------- | -------- | --- | ------ |',
          '| T-02 | Critical | x        | y        | z   | open   |',
          '',
        ].join('\n'),
      });
      expect(runDocsCheck(dir).status).not.toBe(0);
    },
    FIXTURE_TIMEOUT
  );

  it(
    'passes when Critical/High findings are fixed, accepted or a Medium is open',
    () => {
      const dir = fixture({
        '03-fixture.md': [
          '| ID   | Severity | Location | Evidence | Fix | Status   |',
          '| ---- | -------- | -------- | -------- | --- | -------- |',
          '| T-03 | High     | x        | y        | z   | Fixed    |',
          '| T-04 | Critical | x        | y        | z   | Accepted |',
          '| T-05 | Medium   | x        | y        | z   | Open     |',
          '',
        ].join('\n'),
      });
      const result = runDocsCheck(dir);
      expect(result.status, result.stdout + result.stderr).toBe(0);
    },
    FIXTURE_TIMEOUT
  );
});

describe('docs/audit/launch/gate.md rollup', () => {
  it('references every launch audit doc that exists', () => {
    const gate = readFileSync(GATE_DOC, 'utf8');
    for (const name of launchDocNames()) expect(gate).toContain(name);
    expect(gate).toContain('11-epic-7-delivery.md');
  });

  it('records an explicit gate decision and no open Critical or High', () => {
    const gate = readFileSync(GATE_DOC, 'utf8');
    expect(gate).toMatch(/Gate decision:/);
    expect(gate).toMatch(/0 open Critical/);
    expect(gate).toMatch(/0 open High/);
    const hasDelivery = launchDocNames().includes('11-epic-7-delivery.md');
    if (!hasDelivery) {
      expect(gate).toMatch(/PENDING 7\.12\.11/);
      expect(gate).not.toMatch(/Gate decision:\s*(GO|go)\b/);
    }
  });

  it('lists every accepted Medium and Low risk from the audit docs with a reason', () => {
    const accepted = launchDocNames()
      .flatMap((name) => findings(path.join(DOCS, name)).map((f) => ({ ...f, doc: name })))
      .filter(
        (f) =>
          f.status.toLowerCase().startsWith('accepted') &&
          ['Medium', 'Low'].includes(riskLevel(f.severity))
      );
    expect(accepted.length).toBeGreaterThan(0);

    const register = new Map<string, string[]>();
    for (const line of readFileSync(GATE_DOC, 'utf8').split('\n')) {
      if (!line.trim().startsWith('|')) continue;
      const row = cells(line);
      if (row.length < 5 || !/^[A-Z]+-\d+$/.test(row[0])) continue;
      register.set(row[0], row);
    }

    const missing = accepted.filter((f) => !register.has(f.id)).map((f) => f.id);
    expect(missing).toEqual([]);

    for (const finding of accepted) {
      const row = register.get(finding.id)!;
      expect(row[1], `${finding.id} severity`).toBe(finding.severity);
      expect(row[2], `${finding.id} area doc`).toBe(finding.doc);
      expect(row[4].length, `${finding.id} reason`).toBeGreaterThan(40);
    }

    for (const id of register.keys()) {
      expect(accepted.map((f) => f.id)).toContain(id);
    }
  });

  it('records the real automated gate evidence', () => {
    const gate = readFileSync(GATE_DOC, 'utf8');
    expect(gate).toMatch(/scripts\/gate\.sh/);
    expect(gate).toMatch(/gitleaks/);
    expect(gate).toMatch(/bun audit/);
    expect(gate).toMatch(/test:e2e/);
    expect(gate).toMatch(/lighthouse/i);
  });
});
