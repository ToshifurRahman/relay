import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ENV_KEYS } from '../../../api/src/lib/config.js';

// SEC-05: nothing the server keeps private may reach the browser. The web app is bundled from
// apps/web/src alone, so two things are checked: the source never names a server-only variable or
// imports server code, and the built bundle carries none of those names either.
//
// The bundle check builds the app into a temp directory on every run rather than reading
// apps/web/dist. dist is gitignored and CI's web-test step never builds it, so a check that
// skipped when dist was absent would silently pass in CI — the one place it has to hold.
const WEB = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(WEB, 'src');

// Every variable the API's config schema reads, taken from the schema itself so the list cannot
// drift from apps/api/src/lib/config.ts. None of them may be referenced by the client. Matched on
// word boundaries: a bare `PORT` would otherwise hit `SUPPORT` or `EXPORT`.
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

beforeAll(async () => {
  dist = mkdtempSync(path.join(tmpdir(), 'bundle-secrets-'));
  // Cloudflare's published always-pass site key, so the build needs no real configuration.
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
});

describe('client bundle secrets', () => {
  it('scans the files it claims to (the scan is not empty)', () => {
    expect(sourceFiles.length).toBeGreaterThan(50);
    expect(bundleFiles.length).toBeGreaterThan(0);
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
