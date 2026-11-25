// Story 6.8 quality gate. `bun run lighthouse` (scripts/lighthouse.ts) either builds the local
// site, starts the e2e stack and seeds one finished ticket, or (with LH_LIVE_URL) points the same
// assertions at an external URL. Either way it sets LH_BASE_URL for this file.
// Default mobile preset (what DevTools shows a reviewer): throttled CPU and network.

// Live mode is flagged by LH_LIVE_URL. The live site cannot be seeded headlessly (Turnstile), so
// LH_TICKET_REF is optional there: without it, /t/:ref has no page to visit and is left out.
const live = Boolean(process.env.LH_LIVE_URL);
const ref = process.env.LH_TICKET_REF?.trim();
if (!process.env.LH_BASE_URL)
  throw new Error('Run this through `bun run lighthouse`: LH_BASE_URL is not set.');
if (!live && !ref)
  throw new Error(
    'Run this through `bun run lighthouse`: LH_BASE_URL / LH_TICKET_REF are not set.'
  );

// A trailing slash on the base would double up in `${base}/`; normalise it once.
const base = process.env.LH_BASE_URL.replace(/\/+$/, '');

const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];
const MIN_SCORE = { minScore: 0.9, aggregationMethod: 'median' };

module.exports = {
  ci: {
    collect: {
      url: [
        `${base}/`,
        `${base}/new`,
        ...(ref ? [`${base}/t/${ref}`] : []),
        // Read-only: the page previews the token with a GET and only POSTs on a button click,
        // which Lighthouse never presses, so this stays in the live list too.
        `${base}/confirm/lighthouse-token`,
        `${base}/ops`,
        `${base}/legal/privacy`,
        `${base}/legal/terms`,
        `${base}/nope`,
      ],
      numberOfRuns: 3,
      chromePath: process.env.LH_CHROME_PATH,
      settings: { chromeFlags: '--headless=new --no-sandbox' },
    },
    assert: {
      assertMatrix: [
        {
          // Crawlable pages: all four categories.
          matchingUrlPattern: '^(?!.*/(confirm|ops)(/|$)).*$',
          assertions: Object.fromEntries(
            CATEGORIES.map((c) => [`categories:${c}`, ['error', MIN_SCORE]])
          ),
        },
        {
          // These two are noindex on purpose (a private link, a staff console), so SEO's
          // is-crawlable audit fails by design and is left out.
          matchingUrlPattern: '/(confirm|ops)(/|$)',
          assertions: Object.fromEntries(
            CATEGORIES.filter((c) => c !== 'seo').map((c) => [
              `categories:${c}`,
              ['error', MIN_SCORE],
            ])
          ),
        },
      ],
    },
    upload: { target: 'filesystem', outputDir: '.lighthouseci' },
  },
};
