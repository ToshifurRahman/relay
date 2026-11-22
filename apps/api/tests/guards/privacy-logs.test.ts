/**
 * Story 7.12.2 — the Pino log is the one place PII is easiest to leak by accident. This guard
 * covers the two shapes that smuggled it in before: a message built by interpolating a variable
 * (which can hold ticket text or a provider error body) and a logger object that spreads an
 * untrusted record. Structured fields and fixed messages are the pattern.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { sourceFiles } from '../helpers/source-files.js';

const SRC = path.resolve(import.meta.dirname, '../../src');
const rel = (file: string) => path.relative(SRC, file);

const LOGGER_CALL = /logger\.(?:trace|debug|info|warn|error|fatal)\(/g;

/** The same text with every string literal's body removed, so `...` in a message is not a spread. */
function withoutStrings(source: string): string {
  let out = '';
  let inString: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === inString) {
        inString = null;
        out += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      out += ch;
    } else {
      out += ch;
    }
  }
  return out;
}

/** The arguments of every logger call, from the opening paren to its matching close. */
function loggerCalls(source: string): { args: string; templated: boolean; spreads: boolean }[] {
  const calls: { args: string; templated: boolean; spreads: boolean }[] = [];
  for (const match of source.matchAll(LOGGER_CALL)) {
    let depth = 0;
    let inString: string | null = null;
    let i = match.index + match[0].length - 1;
    const start = i + 1;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === inString) inString = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') inString = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    const args = source.slice(start, i);
    calls.push({
      args,
      // A backtick alone is just punctuation inside a fixed sentence; `${` is interpolation.
      templated: args.includes('${'),
      // `{ ...row }` spreads every field (email, ticket text) onto the line at once, wherever it
      // appears in the object — first property or after fixed ones such as `step`. String bodies
      // are stripped first, so the `...` in a message like 'polling...' is not mistaken for one.
      spreads: /\.\.\./.test(withoutStrings(args)),
    });
  }
  return calls;
}

describe('Pino log boundary (story 7.12.2)', () => {
  it('never builds a log message by interpolating a variable', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => loggerCalls(readFileSync(file, 'utf8')).some((call) => call.templated))
      .map(rel);

    expect(offenders).toEqual([]);
  });

  it('never spreads an untrusted record into a log object', () => {
    // `{ ...record }` puts every field of a row (email, ticket text) on the line at once.
    const offenders = sourceFiles(SRC)
      .filter((file) => loggerCalls(readFileSync(file, 'utf8')).some((call) => call.spreads))
      .map(rel);

    expect(offenders).toEqual([]);
  });

  it('does not hand a whole error object to the log for the AI paths', () => {
    // The provider/AI error text is the one with untrusted content; everywhere else an `err`
    // comes from pg, Redis or the SDK, which do not echo customer data.
    const aiFiles = ['lib/ai-service.ts', 'lib/llm-client.ts'].map((p) => path.join(SRC, p));
    for (const file of aiFiles) {
      for (const call of loggerCalls(readFileSync(file, 'utf8'))) {
        expect(call.args).not.toMatch(/\berr\b\s*[,}]/);
      }
    }
  });

  it('the checks really do catch the old shapes (the guard is not vacuous)', () => {
    const leaked = [
      'logger.warn(`Primary AI service failed: ${message}`);',
      "logger.error({ err, record }, 'Failed to persist');",
    ].map((line) => loggerCalls(line));
    expect(leaked[0][0].templated).toBe(true);
    expect(leaked[1][0].args).toMatch(/\berr\b\s*[,}]/);

    const spread = "logger.error({ ...row, step: 'x' }, 'Failed');";
    expect(loggerCalls(spread)[0].spreads).toBe(true);

    // A spread that is not the first property must be caught too (review P2).
    const trailingSpread = "logger.error({ ticketId, ...row }, 'Failed');";
    expect(loggerCalls(trailingSpread)[0].spreads).toBe(true);

    // A fixed sentence with backticks in it is not interpolation.
    const fixed = "logger.warn({ dir: d }, 'run `bun build` first');";
    expect(loggerCalls(fixed)[0]).toMatchObject({ templated: false, spreads: false });
  });
});
