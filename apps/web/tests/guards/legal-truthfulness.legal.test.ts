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

const brand = source('config/brand.ts');
const legal = source('content/legal.ts');
const landing = source('features/landing/content.ts');
const pricing = source('features/landing/components/pricing.tsx');
const footer = source('app/layout/site-footer.tsx');
const thread = source('features/tickets/components/ticket-thread.tsx');
const success = source('features/tickets/components/ticket-success.tsx');
const pill = source('features/tickets/components/status-pill.tsx');

describe('legal pages name every real processor (7.12.9 check 1)', () => {
  it('points the legal contact at the renamed repository', () => {
    expect(brand).toContain("repoUrl: 'https://github.com/ToshifurRahman/relay'");
    expect(`${brand}${legal}${footer}`).not.toMatch(/ToshifurRahman\/ticket-pipe/);
  });

  it('names each processor the deployment actually uses', () => {
    for (const processor of [
      'Render',
      'Neon',
      'Upstash',
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
    for (const file of [landing, thread, pill]) {
      expect(file).not.toMatch(/the team\b/i);
      expect(file).not.toMatch(/our team/i);
      expect(file).not.toMatch(/support team/i);
    }
  });

  it('makes no unmeasured delivery promise', () => {
    expect(success).not.toMatch(/within a minute/i);
  });
});

describe('the site says it is a portfolio demo (check 3 and 4)', () => {
  it('prints the demo label in the footer of every public page', () => {
    expect(footer).toMatch(/portfolio demo/i);
  });

  it('renders the pricing note inside the rates section', () => {
    expect(pricing).toMatch(/PRICING_HEADING\.note/);
  });

  it('labels the pricing as illustrative and sells nothing', () => {
    // The note sits beside the tier heading and the buttons only ever open the demo form.
    expect(landing).toMatch(/Illustrative rates/i);
    expect(landing).toMatch(/not real plans/i);
    for (const command of ['Start free', 'Start with Team', 'Ask us']) {
      expect(landing).not.toContain(command);
    }
    expect(landing).toContain("cta: 'Try the demo'");
  });

  it('keeps the legal notice truthful rather than calling the pages a mock', () => {
    expect(legal).not.toMatch(/mock of what a real one would say/);
  });
});
