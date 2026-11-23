# Launch audit: Frontend production (7.12.6)

Audit date: 2026-11-23, against `audit/7.12.6-frontend-prod` from `main` at `859a692`. It covers
the 7.12.6 checks: bundle sizes against the 500 kB warning, error boundaries, behaviour when the
API is cold or down, dev-only code or MSW in the build, and a live a11y + Lighthouse pass. Source
and the built `apps/web/dist` were inspected locally; live checks ran against
`https://ticket-pipeline.onrender.com` with read-only, low-volume probes only (HTTP status, headers,
the public HTML, and one Lighthouse run per page — no forms submitted, no `/ops` sign-in attempts).

Severity uses the pre-audit scale: Critical and High block go-live; a Medium or Low may ship only
as an accepted risk with a reason. Finding IDs are `FE-NN`.

## Summary

| Severity | Found | Fixed | Accepted | Open |
| -------- | ----- | ----- | -------- | ---- |
| Critical | 0     | 0     | 0        | 0    |
| High     | 2     | 2     | 0        | 0    |
| Medium   | 0     | 0     | 0        | 0    |
| Low      | 1     | 1     | 0        | 0    |

No Critical or High finding is open. Every finding was fixed on this branch, each with a
failing-first regression test whose red output is in `reports/logs/red-fe-*.log`.

## Checks run

All build and test commands ran from the worktree through `run-check.sh`, one at a time.

### 1. Bundle sizes vs the 500 kB warning

Production build — `env VITE_TURNSTILE_SITE_KEY=1x00000000000000000000AA bun --filter @relay/web build`
(exit 0, 339 modules, 282 ms), run after every code change on this branch; the full asset table is
in the build log. JS chunks and the CSS, raw and gzip (fonts and the `.br`/`.gz` precompressed twins
are omitted for brevity):

| Asset                       | Raw       | Gzip      |
| --------------------------- | --------- | --------- |
| `index-*.js` (entry)        | 361.30 kB | 114.30 kB |
| `new-ticket-*.js` (lazy)    | 66.05 kB  | 22.87 kB  |
| `ops-*.js` (lazy)           | 61.84 kB  | 20.44 kB  |
| `socket-*.js` (lazy)        | 41.22 kB  | 12.88 kB  |
| `feed-status-*.js` (lazy)   | 34.46 kB  | 9.74 kB   |
| `useMutation-*.js` (shared) | 9.53 kB   | 3.29 kB   |
| `ticket-*.js` (lazy)        | 7.16 kB   | 2.99 kB   |
| `confirm-*.js` (lazy)       | 3.50 kB   | 1.46 kB   |
| `ops-layout-*.js` (lazy)    | 2.59 kB   | 1.23 kB   |
| `turnstile-*.js` (lazy)     | 1.66 kB   | 0.83 kB   |
| `index-*.css`               | 47.54 kB  | 10.00 kB  |

The entry chunk is 361.30 kB raw / 114.30 kB gzip, comfortably under the 500 kB warning. Route
splitting already holds the heavy pages out of the entry (`routes.tsx` lazies `new`, `t/:ref`,
`confirm`, `ops` and the ops layout), so no `manualChunks` change was needed. The precompress
plugin writes `.br`/`.gz` next to every text asset; the server serves them by `Accept-Encoding`.
`apps/web/dist` was removed after inspection and is absent at the gate run.

### 2. Error boundaries

Before this audit there was **no** error boundary anywhere in `apps/web/src` (`ErrorBoundary` /
`getDerivedStateFromError` / `componentDidCatch` matched nothing). A render exception in any route
would unmount the whole tree and leave a blank page. See FE-01.

### 3. Cold / down API, offline, disconnected states

Reviewed every user-facing page: `/` (static), `/new` (form), `/t/:ref` (query + socket),
`/confirm` (two queries), `/ops` (session + list + feed). The one API-boundary defect found is
FE-02 (confirm page). Built on top of the 7.12.3 `api.ts` timeout
(408) and `query-client.ts` retry rules, the ticket page and ops console already show a retry
panel and keep their layout; the ticket page's socket reconnects and re-invalidates on `connect`.
The ops drawer and list already split 404 ("Ticket not found", no retry) from transient failure
("Couldn't load the ticket" + Try again), so no change was needed there. The ticket page's own
load error panel (`TicketLoadError`) offers Try again and preserves the reference.

`/new` on a transient failure keeps the customer's work: on a 5xx the form leaves the subject and
description values in place, renders a `role="alert"` message ("We couldn't send your ticket.
Please try again."), and resets Turnstile for a fresh single-use token in its `finally` block
(`apps/web/src/features/tickets/components/ticket-form.tsx:85-88,149-153`; covered by
`pages/new-ticket.test.tsx` "keeps the values and shows a retry message when the API fails").

### 4. No dev-only code or MSW in the production build

Scanned the built `apps/web/dist` (before deleting it) and the live bundle
`/assets/index-COWO5Le0.js` (360,335 bytes) for `mockServiceWorker`, `msw`,
`ReactQueryDevtools`, `localhost:`, `console.log`, `debugger` and `sourceMappingURL`. Every pattern
returned **0** occurrences in both. Source scan (`apps/web/src/**`) found no `import.meta.env.DEV`,
no `localhost` URLs, and no `console.*`. `msw` is a devDependency used only by `src/test/**` and
`*.test.tsx`, which the build never includes. The existing `guards/bundle-secrets.test.ts` (owned
by 7.12.5) already builds to a temp dir and asserts no server variables, credential shapes or source
maps in the bundle; it passes.

### 5. Live probes (read-only, low volume)

```
GET /            -> 200  2,092 B   (HTML shell; assets served separately)
GET /new         -> 200  2,092 B
GET /privacy     -> 200  2,092 B
GET /legal/privacy -> 200  2,092 B
GET /legal/terms -> 200  2,092 B
GET /terms       -> 200  2,092 B
GET /ops         -> 200  2,092 B
GET /nope        -> 200  2,092 B   (SPA: any path serves the shell, the 404 renders client-side)
GET /health/live  -> 200  {"status":"ok"}
GET /health/ready -> 200  {"status":"ok"}
```

Response headers on `/` (relevant to frontend production readiness): a full CSP (no
`unsafe-inline` for scripts, `object-src 'none'`, `frame-ancestors 'none'`), HSTS
`max-age=15552000; includeSubDomains`, `X-Content-Type-Options: nosniff`,
`Cross-Origin-Opener-Policy: same-origin`, `Referrer-Policy: strict-origin-when-cross-origin`.
These come from the API's security-headers middleware and are outside 7.12.6's owned files; they
are recorded here as passing evidence, not changed.

Lighthouse 13.6.0 (mobile preset, one run per page, local Google Chrome 157 via the installed
`lighthouse` binary, no `@latest` runner) against four live routes:

| Page             | Performance | Accessibility | Best practices | SEO |
| ---------------- | ----------- | ------------- | -------------- | --- |
| `/`              | 100         | 100           | 100            | 100 |
| `/new`           | 100         | 100           | 100            | 100 |
| `/legal/privacy` | 100         | 100           | 100            | 100 |
| `/legal/terms`   | 100         | 100           | 100            | 100 |

The only non-passing a11y detail on every page was `label-content-name-mismatch` (weight 0,
"hidden"), which pointed at the same header home link — that is FE-03 below. It is a real WCAG
2.5.3 defect even though the aggregate score rounded to 100; it is fixed on this branch and the
live deploy still carries the old bundle until the next release. Results were written to a scratch
dir outside the repo; `.lighthouseci/` is not used and is absent at the gate run.

## Findings

| ID    | Severity | Location                                                                                                                        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                    | Fix or accepted-risk reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Status |
| ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| FE-01 | High     | `apps/web/src/components/error-boundary.tsx` (new); `app/main.tsx`, `app/layout/public-layout.tsx`, `app/layout/ops-layout.tsx` | No error boundary existed anywhere in `apps/web/src`. A render exception in any route unmounted the whole tree: the customer saw a blank page with no shell, no message and no way home, and React's default console output is invisible to them.                                                                                                                                                                           | Fixed: added `ErrorBoundary` (class component, `getDerivedStateFromError`), mounted keyed by `pathname` around `<Outlet>` in both layouts and once above `AppRoutes` as a last resort. It prints a fixed "Something went wrong" panel with Try again and a home link, and never renders the thrown message or stack (avoids leaking internal paths). Keyed by path so navigating away clears it. Failing-first tests `components/error-boundary.frontend.test.tsx` and `app/routes.frontend.test.tsx` (red: `reports/logs/red-fe-frontend-states.log`, 6 failed).                                                                                                                                                                              | fixed  |
| FE-02 | High     | `apps/web/src/pages/confirm.tsx`                                                                                                | `/confirm/:token` treated **any** preview failure as a dead link: on a 408 timeout, 502/503, or offline the page rendered "This link has expired or was already used". A customer whose live link met a cold-starting API was told the link was spent and given no retry, so they would not re-open the working email link. A failed confirm POST was mislabelled the same way: a 502 on the click also rendered "expired". | Fixed: `preview.isError` now renders a distinct "We couldn't check this link" panel with a Try again button (`preview.refetch`); only a `{ valid: false }` answer claims expiry. The confirm mutation shows a retry panel for anything other than the server's 410 (spent token), and only 410 reaches the expired panel; the retry panel is held in local state so it stays mounted while the retry runs rather than flashing back to the Confirm button. Failing-first GET tests in `pages/confirm.frontend.test.tsx` (red: `reports/logs/red-fe-frontend-states.log`, 3 failed) and POST tests (red: `reports/logs/red-fe-confirm-post.log`, 502 failed pre-fix, 410 held) plus the existing `pages/confirm.test.tsx` (2 tests) still pass. | fixed  |
| FE-03 | Low      | `apps/web/src/app/layout/site-header.tsx`                                                                                       | The logo link had `aria-label="Home"` over visible text "RELAY". Lighthouse `label-content-name-mismatch` (WCAG 2.5.3 label-in-name) failed: a speech-input user saying what they see ("Relay") could not activate it.                                                                                                                                                                                                      | Fixed: `aria-label="Relay home"` keeps the visible wordmark in the accessible name. Failing-first test `app/layout/site-header.frontend.test.tsx` (red: `reports/logs/red-fe-home-link-name.log`, 2 failed; green after).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | fixed  |

## Regression tests added

- `apps/web/src/components/error-boundary.frontend.test.tsx` — boundary renders children, shows
  the recovery panel, never leaks the message/stack, offers a working home link, recovers on Try again.
- `apps/web/src/app/routes.frontend.test.tsx` — public and ops shells survive a page that throws,
  keep header/footer, and do not leak the message.
- `apps/web/src/pages/confirm.frontend.test.tsx` — timeout and 502/503 do not claim expiry; retry
  recovers a valid link; a `{ valid: false }` answer still shows the expired panel; a 502 on the
  click offers a working retry (recovering on the second POST) and only a 410 claims expiry.
- `apps/web/src/app/layout/site-header.frontend.test.tsx` — the home link's accessible name contains
  the visible "Relay" wordmark.

Red logs: `reports/logs/red-fe-frontend-states.log` (6 failed, 1 passed), `red-fe-home-link-name.log`
(2 failed), `red-fe-confirm-post.log` (POST half: 1 failed / 1 passed pre-fix). Green:
`green-fe-frontend-states.log` (12 passed), `green-fe-home-link-name.log` (2 passed),
`green-fe-confirm-post.log` (8 passed across both confirm files).

## Dead-surface cleanup (7.12.5 handoff)

Four `apps/web/src` exports/files with no importer were handed over from the code-health audit.
Each was checked across all of `apps/web` (source, tests and guards; no dynamic import) before a
change, and the production build above was rerun afterwards:

- `components/ui/popover.tsx` (`Popover`, `PopoverTrigger`, `PopoverContent`) — removed; nothing
  imported it, so the only remaining reference to `@radix-ui/react-popover` went with it. The
  dependency stays in `apps/web/package.json` (out of scope here) but no longer affects the bundle.
- `features/tickets/components/status-pill.tsx` `statusLabel` — removed; `StatusPill` in the same
  file reads the same `PILLS` map directly and remains the sole consumer.
- `test/fake-socket.ts` `FakeSocket` type — removed; the three importing tests use
  `ReturnType<typeof createFakeSocket>` instead, `createFakeSocket` itself is unchanged.
- `lib/socket.ts` `resetSocketForTests` — removed; no test called it (each test mocks
  `@/lib/socket` wholesale), so the shared `getSocket` singleton is the only export left.

## Gates (single-threaded `run-check.sh`, `apps/web/dist` and `.lighthouseci` absent)

| Gate                             | Result                                     | Exit |
| -------------------------------- | ------------------------------------------ | ---- |
| `bun run format:check`           | All matched files use Prettier code style  | 0    |
| `bun run lint --concurrency=off` | clean, `--max-warnings 0`                  | 0    |
| `bun run typecheck`              | clean                                      | 0    |
| `@relay/api` unit                | 524 passed / 0 failed, 59 files, 0 skipped | 0    |
| `@relay/api` integration         | 369 passed / 0 failed, 35 files, 0 skipped | 0    |
| `@relay/web` test                | 316 passed / 0 failed, 35 files, 0 skipped | 0    |

Counts match the Wave 3 baseline (~524/369/300) plus the 16 frontend tests added here (300 → 316).
The same six gates pass under a clean `env -i` shell with only the explicit test variables set
(`reports/logs/fe-fix1-clean-web.log`: `@relay/web` 316 passed, 0 skipped), so no hidden shell
exports are required.

## Parked items from the pre-audit

- **7.12.6** carries no parked items of its own. The frontend-adjacent parked line ("how the web
  app and sockets behave when Render wakes from sleep") sits under 7.12.3; the client side of that
  is the 30s timeout + retry in `api.ts`/`query-client.ts` (REL-06) and is exercised here.
