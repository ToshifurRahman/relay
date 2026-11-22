import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// SEC-05: nothing the server keeps private may reach the browser. The web app is bundled from
// apps/web/src alone, so two things are checked: the source never names a server-only variable or
// imports server code, and the built bundle (when it exists) carries none of those names either.
const WEB = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(WEB, 'src');
const DIST = path.join(WEB, 'dist');

// Every variable apps/api/src/lib/config.ts reads. None of them may be referenced by the client.
const SERVER_VARIABLES = [
  'DATABASE_URL',
  'DATABASE_DIRECT_URL',
  'REDIS_URL',
  'SQS_ENDPOINT',
  'SQS_QUEUE_NAME',
  'SQS_DLQ_NAME',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'PORTKEY_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'BACKUP_API_KEY',
  'OPS_TOKEN',
  'SNS_ENDPOINT',
  'SNS_TOPIC_ARN',
  'BREVO_API_KEY',
  'TURNSTILE_SECRET_KEY',
  'SMTP_URL',
];

// Shapes a real credential takes, so a value pasted into the source is caught even unnamed.
const SECRET_SHAPES = [
  /AKIA[0-9A-Z]{16}/,
  /ASIA[0-9A-Z]{16}/,
  /postgres(ql)?:\/\/[^:@/\s]+:[^@/\s]+@/,
  /rediss?:\/\/[^:@/\s]*:[^@/\s]+@/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

function filesUnder(dir: string, extensions: string[]): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full, extensions);
    return extensions.some((ext) => entry.name.endsWith(ext)) ? [full] : [];
  });
}

const sourceFiles = filesUnder(SRC, ['.ts', '.tsx']);
const bundleFiles = filesUnder(DIST, ['.js', '.css', '.html', '.json']);

describe('client bundle secrets', () => {
  it('scans the files it claims to (the scan is not empty)', () => {
    expect(sourceFiles.length).toBeGreaterThan(50);
  });

  it('never names a server-only variable in the client source', () => {
    const offenders = sourceFiles
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return SERVER_VARIABLES.some((name) => text.includes(name));
      })
      .map((file) => path.relative(WEB, file));
    expect(offenders).toEqual([]);
  });

  it('never imports server code', () => {
    const offenders = sourceFiles
      .filter((file) =>
        /from\s+['"][^'"]*(apps\/api|@relay\/api)[^'"]*['"]/.test(readFileSync(file, 'utf8'))
      )
      .map((file) => path.relative(WEB, file));
    expect(offenders).toEqual([]);
  });

  it('carries no credential shape in the client source', () => {
    const offenders = sourceFiles
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return SECRET_SHAPES.some((shape) => shape.test(text));
      })
      .map((file) => path.relative(WEB, file));
    expect(offenders).toEqual([]);
  });

  // The build is not part of every test run, so this only runs when dist/ exists (CI builds it
  // before the suite; a bare `vitest` run may not have).
  it.skipIf(!existsSync(DIST))(
    'carries no server variable or credential in the built bundle',
    () => {
      expect(bundleFiles.length).toBeGreaterThan(0);
      const offenders = bundleFiles
        .filter((file) => {
          const text = readFileSync(file, 'utf8');
          return (
            SERVER_VARIABLES.some((name) => text.includes(name)) ||
            SECRET_SHAPES.some((shape) => shape.test(text))
          );
        })
        .map((file) => path.relative(WEB, file));
      expect(offenders).toEqual([]);
    }
  );

  it.skipIf(!existsSync(DIST))('ships no source map', () => {
    const maps = filesUnder(DIST, ['.map']);
    expect(maps.map((file) => path.relative(WEB, file))).toEqual([]);
  });
});
