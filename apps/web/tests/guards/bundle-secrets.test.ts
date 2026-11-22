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
const API_DIR = path.resolve(WEB, '../api');
const CONFIG_SOURCE = path.join(API_DIR, 'src/lib/config.ts');

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

// Every module specifier a file names, whatever the form: `import x from '…'`, `export … from '…'`,
// side-effect `import '…'`, dynamic `import('…')` and `require('…')`. A check that only looked at
// `from '…'` would miss the other four, and any of them can pull server code into the bundle.
//
// Comments are removed first so a commented-out import is not reported. The scan walks the source
// rather than matching a regex, because a `//` inside a string (a URL, a message) is not a comment
// and a regex cannot tell the difference. Regex literals are left alone: none in the client source
// contains `//` or `/*`, and a false positive here fails loudly rather than passing silently.
function withoutComments(source: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      out += char;
      if (char === '\\') out += source[++i] ?? '';
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      out += char;
    } else if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out += '\n';
    } else if (char === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i++;
      out += ' ';
    } else {
      out += char;
    }
  }
  return out;
}

function moduleSpecifiers(source: string): string[] {
  const code = withoutComments(source);
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s*(['"])([^'"]+)\1/g, // import … from '…' and export … from '…'
    /\bimport\s*(['"])([^'"]+)\1/g, // side-effect import '…'
    /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g, // dynamic import('…')
    /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g, // require('…')
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) specifiers.push(match[2]);
  }
  return specifiers;
}

// A specifier that reaches server code: the `@relay/api` package (exact or subpath), a path that
// names `apps/api`, or a relative specifier that resolves inside `apps/api`. Resolution is what
// catches `../../api/src/…`, which names no package and no `apps/api` segment.
function reachesServerCode(specifier: string, fromFile: string): boolean {
  if (specifier === '@relay/api' || specifier.startsWith('@relay/api/')) return true;
  if (/(^|\/)apps\/api(\/|$)/.test(specifier)) return true;
  if (!specifier.startsWith('.')) return false;
  const resolved = path.resolve(path.dirname(fromFile), specifier);
  const relative = path.relative(API_DIR, resolved);
  // `path.relative` gives `../…` for anything outside, so a sibling like `apps/api-other` is not
  // mistaken for the API directory.
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function serverImportsIn(files: string[]): string[] {
  return files
    .filter((file) =>
      moduleSpecifiers(readFileSync(file, 'utf8')).some((spec) => reachesServerCode(spec, file))
    )
    .map((file) => path.relative(WEB, file));
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
    // leave every check below scanning for an empty list and passing. The last key is pinned too:
    // a mid-block brace-depth shift would drop the trailing keys and still leave a plausible list.
    expect(ENV_KEYS.length).toBeGreaterThanOrEqual(10);
    expect(ENV_KEYS).toEqual(
      expect.arrayContaining([
        'DATABASE_URL',
        'REDIS_URL',
        'OPS_TOKEN',
        'PORTKEY_API_KEY',
        'AWS_SECRET_ACCESS_KEY',
        'TICKET_DAILY_CAP',
      ])
    );
  });

  it('never names a server-only variable in the client source', () => {
    expect(offendersIn(sourceFiles, SERVER_VARIABLES)).toEqual([]);
  });

  it('never imports server code', () => {
    expect(serverImportsIn(sourceFiles)).toEqual([]);
  });

  it('catches every import form that reaches server code', () => {
    // The check above is only as good as the specifiers it sees. Each form below is one a
    // developer could plausibly write, and each must be rejected; the accepted cases guard
    // against a helper that rejects everything. The file each line sits in matters: a relative
    // specifier is resolved against it, so `../../api/…` only reaches `apps/api` from
    // `apps/web/src/`, and `../../../api/…` from `apps/web/src/app/`.
    const deep = path.join(SRC, 'app/main.tsx');
    const shallow = path.join(SRC, 'main.tsx');
    const rejected: [string, string][] = [
      ["import { ENV_KEYS } from '../../../api/src/lib/config.js';", deep],
      ["import { x } from '../../api/src/lib/config.js';", shallow],
      ["const m = await import('../../../api/src/lib/config.js');", deep],
      ["import '../../../api/src/lib/config.js';", deep],
      ["export { ENV_KEYS } from '../../../api/src/lib/config.js';", deep],
      ["const m = require('../../../api/src/lib/config.js');", deep],
      ["import { x } from '@relay/api';", shallow],
      ["import { x } from '@relay/api/lib/config.js';", shallow],
      ["import { x } from 'apps/api/src/lib/config.js';", shallow],
    ];
    for (const [line, from] of rejected) {
      expect(moduleSpecifiers(line).some((spec) => reachesServerCode(spec, from))).toBe(true);
    }

    const accepted: [string, string][] = [
      ["import { api } from '../lib/api.js';", deep],
      ["import './styles.css';", deep],
      ["const m = await import('./routes.js');", deep],
      ["export { x } from '../features/tickets/lib/ticket-ref.js';", deep],
      // A sibling directory whose name merely starts with `api` is not the API package.
      ["import { x } from '../../api-other/src/lib/config.js';", shallow],
      // A commented-out import is not an import.
      ["// import { ENV_KEYS } from '../../../api/src/lib/config.js';", deep],
      ["/* import '../../../api/src/lib/config.js'; */", deep],
    ];
    for (const [line, from] of accepted) {
      expect(moduleSpecifiers(line).some((spec) => reachesServerCode(spec, from))).toBe(false);
    }
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
