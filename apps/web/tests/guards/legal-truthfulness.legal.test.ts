/**
 * Story 7.12.9 - the public pages must be true to the deployment. These guards read the source
 * that builds every customer-facing page and fail when the copy drifts from what the code does:
 * a real processor missing from /privacy, a stale repository URL, a commercial offer with no
 * demo label, a support team the demo does not have, or a time promise nothing measures.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const WEB = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(WEB, 'src');

const source = (file: string) => readFileSync(path.join(SRC, file), 'utf8');

// JSX wraps a sentence across lines, so match against the sentence, not the source layout.
const flat = (text: string) => text.replace(/\s+/g, ' ');

const brand = source('config/brand.ts');
const legal = source('content/legal.ts');
const landing = source('features/landing/content.ts');
const pricing = source('features/landing/components/pricing.tsx');
const footer = source('app/layout/site-footer.tsx');
const thread = source('features/tickets/components/ticket-thread.tsx');
const success = source('features/tickets/components/ticket-success.tsx');
const newTicket = source('pages/new-ticket.tsx');
const pill = source('features/tickets/components/status-pill.tsx');
const replay = source('features/ops/components/replay-button.tsx');

describe('legal pages name every real processor (7.12.9 check 1)', () => {
  it('points the legal contact at the renamed repository', () => {
    expect(brand).toContain("repoUrl: 'https://github.com/ToshifurRahman/relay'");
    expect(`${brand}${legal}${footer}`).not.toMatch(/ToshifurRahman\/ticket-pipe/);
  });

  it('names each processor the deployment actually uses', () => {
    // The cache provider is the one `docs/production-infra.md` records for production: Redis
    // Cloud. The code reaches it through the generic `redis` client on REDIS_URL, so only the
    // runbook knows the company, and the page must agree with the runbook.
    for (const processor of [
      'Render',
      'Neon',
      'Redis Cloud',
      'AWS',
      'Brevo',
      'Cloudflare',
      'Portkey',
      'Groq',
      'Google',
    ]) {
      expect(legal).toContain(processor);
    }
  });

  it('names no processor the deployment does not use', () => {
    // A phantom provider is as untrue as a missing one, and this one was on the page once.
    expect(legal).not.toMatch(/Upstash/);
  });

  it('bounds the IP rate-limit counter to an hour or less', () => {
    // Every IP-keyed key expires in <= 1 h: tickets:ip 3600 s, notify:optin 3600 s, the ops
    // sign-in lockout 900 s. The 25 h window belongs to tickets:day, which holds no address.
    expect(legal).toMatch(/an hour or less/i);
    expect(legal).not.toMatch(/a little over a day|a day at most/i);
  });

  it('does not claim analytics that the built site may not ship', () => {
    // VITE_CF_ANALYTICS_TOKEN is optional, so a claim that visits are counted is only true when
    // the copy makes it conditional. Both places that mention counting must say so.
    expect(legal).toMatch(/when visit counting is switched on[^.]*counts visits/i);
    expect(legal).toMatch(/If it is switched off, the site sets no analytics cookie or beacon/i);
  });
});

describe('nothing suggests a real company or a support team (check 2 and 4)', () => {
  it('names no corporate entity and no placeholder contact address', () => {
    const copy = `${brand}${legal}${landing}${pricing}${footer}`;
    expect(copy).not.toMatch(/\b(Inc|LLC|Ltd|GmbH)\.?\b/);
    expect(copy).not.toMatch(/[A-Za-z0-9._-]+@(?:relay|ticket-pipe)\.[a-z]+/);
    expect(copy).not.toMatch(/support@|privacy@|legal@/);
  });

  it('does not claim a team that the demo does not have', () => {
    for (const file of [landing, thread, newTicket, pill, success]) {
      expect(file).not.toMatch(/the team\b/i);
      expect(file).not.toMatch(/our team/i);
      expect(file).not.toMatch(/support team/i);
    }
  });

  it('makes no unmeasured delivery promise', () => {
    // The lead on /new and the success panel are the same page; a promise on one is a promise.
    // JSX wraps the sentence, so flatten the source before matching it.
    for (const file of [newTicket, success]) {
      expect(flat(file)).not.toMatch(/within a minute/i);
      expect(flat(file)).not.toMatch(/usually arrives/i);
    }
  });

  it('points the ops console at the console, not a team', () => {
    expect(replay).toMatch(/Re-queued from the ops console/);
    expect(replay).not.toMatch(/the team\b/i);
  });
});

describe('the site says it is a portfolio demo (check 3 and 4)', () => {
  it('prints the demo label in the footer of every public page', () => {
    expect(footer).toMatch(/portfolio demo/i);
  });

  it('labels the pricing as illustrative, renders the note, and sells nothing', () => {
    // The note sits beside the tier heading and the buttons only ever open the demo form.
    expect(landing).toMatch(/Illustrative rates/i);
    expect(landing).toMatch(/not real plans/i);
    expect(pricing).toMatch(/PRICING_HEADING\.note/);
    for (const command of ['Start free', 'Start with Team', 'Ask us']) {
      expect(landing).not.toContain(command);
    }
    expect(landing).toContain("cta: 'Try the demo'");
  });

  it('keeps the legal notice truthful rather than calling the pages a mock', () => {
    expect(legal).not.toMatch(/mock of what a real one would say/);
  });
});
