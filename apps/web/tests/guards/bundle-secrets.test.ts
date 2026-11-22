import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// SEC-05: nothing the server keeps private may reach the browser. The web app is bundled from
// apps/web/src alone, so two things are checked: the source never names a server-only variable or
// imports server code, and the built bundle carries none of those names either.
//
// The bundle check builds the app into a temp directory on every run rather than reading
// apps/web/dist. dist is gitignored and CI's web-test step never builds it, so a check that
// skipped when dist was absent would silently pass in CI — the one place it has to hold.
const WEB = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(WEB, 'src');
const CONFIG_SOURCE = path.resolve(WEB, '../../apps/api/src/lib/config.ts');

// The variable list comes from the API's config schema, so it cannot drift from the server. It is
// read from the source at run time rather than imported: the Dockerfile's `web` stage copies
// apps/web/ without apps/api/src/, and a static import of a file that is not there fails the
// stage's `tsc -b` with TS2307. Reading the text keeps the build self-contained and still fails
// loudly if the schema moves or stops being an object literal.
function envKeysFromConfigSource(source: string): string[] {
  const start = source.indexOf('const fields = z.object({');
  if (start === -1) throw new Error('config.ts no longer declares `const fields = z.object({`');
  const keys: string[] = [];
  let depth = 0;
  for (const line of source.slice(start).split('\n')) {
    // Keys sit one level inside the object literal, two spaces in. Nested objects and comments
    // are deeper or do not match, so only the schema's own variables are collected.
    if (depth === 1) {
      const key = /^ {2}([A-Z][A-Z0-9_]*):/.exec(line);
      if (key) keys.push(key[1]);
    }
    for (const char of line) {
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
    }
    if (depth === 0) break;
  }
  return keys;
}

const ENV_KEYS = envKeysFromConfigSource(readFileSync(CONFIG_SOURCE, 'utf8'));

// Every variable the API's config schema reads. None of them may be referenced by the client.
// Matched on word boundaries: a bare `PORT` would otherwise hit `SUPPORT` or `EXPORT`.
const SERVER_VARIABLES = ENV_KEYS.map((key) => new RegExp(`\\b${key}\\b`));

// Shapes a real credential takes, so a value pasted into the source is caught even unnamed.
const SECRET_SHAPES = [
  /AKIA[0-9A-Z]{16}/,
  /ASIA[0-9A-Z]{16}/,
  /postgres(ql)?:\/\/[^:@/\s]+:[^@/\s]+@/,
  /rediss?:\/\/[^:@/\s]*:[^@/\s]+@/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

function filesUnder(dir: string, extensions: string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full, extensions);
    return extensions.some((ext) => entry.name.endsWith(ext)) ? [full] : [];
  });
}

function offendersIn(files: string[], patterns: (string | RegExp)[]): string[] {
  return files
    .filter((file) => {
      const text = readFileSync(file, 'utf8');
      return patterns.some((pattern) =>
        typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text)
      );
    })
    .map((file) => path.relative(WEB, file));
}

const sourceFiles = filesUnder(SRC, ['.ts', '.tsx']);

let dist: string;
let bundleFiles: string[];
let previousSiteKey: string | undefined;

beforeAll(async () => {
  dist = mkdtempSync(path.join(tmpdir(), 'bundle-secrets-'));
  // Cloudflare's published always-pass site key, so the build needs no real configuration.
  previousSiteKey = process.env.VITE_TURNSTILE_SITE_KEY;
  process.env.VITE_TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
  await build({
    root: WEB,
    logLevel: 'error',
    build: { outDir: dist, emptyOutDir: true },
  });
  bundleFiles = filesUnder(dist, ['.js', '.css', '.html', '.json']);
}, 180_000);

afterAll(() => {
  rmSync(dist, { recursive: true, force: true });
  // Restore the environment the suite found, including the absent case, so a later test in this
  // worker does not inherit a value it never set.
  if (previousSiteKey === undefined) delete process.env.VITE_TURNSTILE_SITE_KEY;
  else process.env.VITE_TURNSTILE_SITE_KEY = previousSiteKey;
});

describe('client bundle secrets', () => {
  it('scans the files it claims to (the scan is not empty)', () => {
    expect(sourceFiles.length).toBeGreaterThan(50);
    expect(bundleFiles.length).toBeGreaterThan(0);
  });

  it('reads a real variable list from the config schema', () => {
    // A refactor that moved the schema, or an extraction that matched nothing, would otherwise
    // leave every check below scanning for an empty list and passing.
    expect(ENV_KEYS.length).toBeGreaterThanOrEqual(10);
    expect(ENV_KEYS).toEqual(
      expect.arrayContaining([
        'DATABASE_URL',
        'REDIS_URL',
        'OPS_TOKEN',
        'PORTKEY_API_KEY',
        'AWS_SECRET_ACCESS_KEY',
      ])
    );
  });

  it('never names a server-only variable in the client source', () => {
    expect(offendersIn(sourceFiles, SERVER_VARIABLES)).toEqual([]);
  });

  it('never imports server code', () => {
    const serverImport = /from\s+['"][^'"]*(apps\/api|@relay\/api)[^'"]*['"]/;
    expect(offendersIn(sourceFiles, [serverImport])).toEqual([]);
  });

  it('carries no credential shape in the client source', () => {
    expect(offendersIn(sourceFiles, SECRET_SHAPES)).toEqual([]);
  });

  it('carries no server variable or credential in the built bundle', () => {
    expect(offendersIn(bundleFiles, [...SERVER_VARIABLES, ...SECRET_SHAPES])).toEqual([]);
  });

  it('ships no source map', () => {
    expect(filesUnder(dist, ['.map']).map((file) => path.relative(WEB, file))).toEqual([]);
  });
});
