# Launch audit: Portfolio readiness (7.12.10)

Audit date: 2026-11-24, against `audit/7.12.10-portfolio-readiness` from `main` at `2dfbd56`. It
covers the 7.12.10 checks — a fresh clone to a running stack using the README only, a secret scan over
the full git history, README and `docs/*.md` against the live system, screenshots against the live
site, and repository metadata (description, topics, licence) — plus the parked pre-audit items
`PA-7.13-01` to `PA-7.13-04` (`docs/audit/pre-audit.md`).

Local work ran against the real codebase on the shared compose stack (Postgres `5433`, Redis `6379`,
LocalStack `4566`, Mailpit `1025/8025`) with throwaway database `ticket_pipe_audit_portfolio_test`.
No containers were started, stopped or restarted, and no `FLUSHDB`/`FLUSHALL` was run.

Live checks against `https://ticket-pipeline.onrender.com` were read-only and low volume: five `GET`s
(`/health/live`, `/health/ready`, `/`, `/privacy`, `/terms`), no writes, no auth attempts, no load.
Nothing was mutated on GitHub either; the repository settings were only read.

Severity uses the same scale as the pre-audit: Critical and High block go-live, and a Medium or Low
may ship only as an accepted risk with a reason. Finding IDs are `PORT-NN`.

## Summary

| Severity | Found | Fixed | Accepted | Open |
| -------- | ----- | ----- | -------- | ---- |
| Critical | 0     | 0     | 0        | 0    |
| High     | 3     | 3     | 0        | 0    |
| Medium   | 3     | 3     | 0        | 0    |
| Low      | 2     | 2     | 0        | 0    |

No Critical or High finding is open. Every fixed finding has a failing-first regression test
(`apps/api/tests/unit/portfolio/portfolio-docs.portfolio.test.ts`) whose red runs are
`reports/logs/red-portfolio-docs.log` (8 failed, 3 passed) and `reports/logs/red-portfolio-fix1.log`
(3 failed, 11 passed), and whose green runs are `reports/logs/green-portfolio-docs.log` (11 passed)
and `reports/logs/green-portfolio-fix1.log` (14 passed).

## Checks run

| #   | Check                                              | Command / location                                                                                                                                                                 | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Fresh clone to running stack, README only          | `/tmp/relay-fresh-clone-test` cloned from the worktree, then README steps verbatim; log `reports/logs/portfolio-fresh-clone.log`                                                   | Reached a running API. `bun install` 0; `migrate` 0; `setup` 0; `GET /health/live` `200 {"status":"ok"}`; `GET /health/ready` `200 {"status":"ok"}`. Two defects found and fixed (**PORT-01**, **PORT-02**). Pass after the README fixes.                                                                                                                                                                                                                           |
| 2   | Full git history secret scan                       | `git rev-list --all` (397 commits, 27 refs) searched for AWS keys, credential URIs, API tokens, private keys and vendor keys; log `reports/logs/portfolio-history-secret-scan.log` | `clean`: 0 AWS-key hits, 0 credential-URI hits, 0 private-key hits, 0 vendor-key hits, no `.env` ever committed (`.env.example` only). Two `sk-`/`AIza` shaped strings exist only as fake keys in `customer-reply-guard.ai-safety.test.ts` fixtures (**PORT-06**). `gitleaks` is not on `PATH`; the scan is `git grep` over every reachable commit. Pass.                                                                                                           |
| 3   | README and `docs/*.md` against the live system     | `curl` probes in `reports/logs/portfolio-live-probe.log`; links resolved with a script and the new guard test                                                                      | Live: `/health/live` `200`, `/health/ready` `200`, `/` `200`, `/privacy` `200`, `/terms` `200`, HSTS, CSP and `frame-ancestors 'none'` present. Every relative link in README and `docs/*.md` resolves. Five defects fixed (**PORT-01**, **PORT-02**, **PORT-03**, **PORT-04**, **PORT-05**). Pass.                                                                                                                                                                 |
| 4   | Screenshots against the live site                  | `docs/screenshots/` (8 files), `scripts/screenshots.ts`, regenerated `mobile-ticket.png`; per-row pixel profile of every PNG; log `reports/logs/portfolio-screenshots-regen.log`   | Seven of the eight already showed the Relay brand, the current routes and the current ops console. `mobile-ticket.png` did not: the phone context had no `reducedMotion` and the shot was taken mid print-in, so the print-in clip stopped it at row 500 of 1688 and the thread, customer message, reply and Office use were absent (**PORT-08**, fixed). Regenerated: 780x2688, content on 73.9% of rows to row 2637, verified by eye and by the guard test. Pass. |
| 5   | Repository metadata (description, topics, licence) | `GH_TOKEN=... gh repo view ToshifurRahman/relay --json ...`; local `LICENSE` and `package.json`                                                                                    | Local: no `LICENSE`, no `license` field (**PORT-05**, fixed). GitHub: `description ""`, `homepageUrl ""`, `licenseInfo null`, `repositoryTopics null` (**PORT-07**, accepted as a pre-go-live operator action: the settings are GitHub-side and are recorded with the exact command). Pass.                                                                                                                                                                         |

## Findings

| ID      | Severity | Location                                                                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Fix or accepted-risk reason                                                                                                                                                                                                                                                                                                                                                                                    | Status   |
| ------- | -------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| PORT-01 | High     | `README.md:1`                                                               | CI badge and both links pointed at `github.com/ToshifurRahman/ticket-pipe`, which is an old name; the repository is `ToshifurRahman/relay`. A visitor's badge and clone link were broken.                                                                                                                                                                                                                                                                                      | Pointed the badge and both links at `ToshifurRahman/relay`. Pinned by the guard test.                                                                                                                                                                                                                                                                                                                          | Fixed    |
| PORT-02 | High     | `README.md` Quick start                                                     | The documented quick start could not reach a running stack. `bun --filter @relay/api migrate` with an empty `.env` exits `1` (`Invalid environment: DATABASE_URL: required`), and the flow never documented the local `DATABASE_URL`/`REDIS_URL`/`SQS_*` values or the `setup` step a true fresh reader needs.                                                                                                                                                                 | Documented the required local values, added the `setup` step, and stated that the scripts read the root `.env` themselves and fail with the named variable when it is empty. Pinned by the guard test.                                                                                                                                                                                                         | Fixed    |
| PORT-03 | High     | `README.md` Deployment                                                      | The README had no live URL, no cold-start note and no "do not submit real personal data" notice (`PA-7.13-03`, `PA-7.13-01`); the deployed site is public and the free tier sleeps.                                                                                                                                                                                                                                                                                            | Added the live demo URL, a cold-start paragraph (next to the read-only `/health/live` and `/health/ready` commands), and a plain "treat any ticket as public, do not submit real personal data" notice. Pinned by the guard test.                                                                                                                                                                              | Fixed    |
| PORT-04 | Medium   | `README.md` Quick start                                                     | The README listed `Node 20+`, but the root `package.json` declares `engines.node >=24.22.1`, and `CONTRIBUTING.md` already said 24.22.1. A reader on Node 20 would install a toolchain the repo does not support. Also the SQS/ElasticMQ endpoint option (`docs/production-infra.md` §7, `PA-7.13-03`) was absent.                                                                                                                                                             | Corrected the Node version and added a "Queue options" table covering AWS SQS, LocalStack and ElasticMQ with the one-variable switch and its caveats. Pinned by the guard test.                                                                                                                                                                                                                                | Fixed    |
| PORT-05 | Medium   | repository root; `package.json`                                             | There was no `LICENSE` file and no `license` field, so GitHub reports `licenseInfo: null` and the code had no stated terms.                                                                                                                                                                                                                                                                                                                                                    | Added an MIT `LICENSE` (copyright `Md. Toshifur Rahman`, matching the repository owner) and `"license": "MIT"` in the root `package.json`. Pinned by the guard test.                                                                                                                                                                                                                                           | Fixed    |
| PORT-06 | Low      | `apps/api/tests/unit/domain/customer-reply-guard.ai-safety.test.ts:291-292` | The full-history scan flags `sk-...` and `AIza...` shaped strings. They are deliberate fake keys inside a guard test's negative cases, not credentials; the guard needs them to prove a leaked key is blocked.                                                                                                                                                                                                                                                                 | Accepted risk: they are obvious fakes in a file that exists to reject secrets, and removing them would delete the very coverage this scan relies on. Recorded here so the next scan does not re-raise it as new.                                                                                                                                                                                               | Accepted |
| PORT-07 | Low      | GitHub repository settings                                                  | `description`, `homepageUrl` and `repositoryTopics` are all empty on `ToshifurRahman/relay`. `licenseInfo` will populate from the merged `LICENSE` with no action.                                                                                                                                                                                                                                                                                                             | Accepted as a pre-go-live operator action: these are GitHub-side settings, and Gate 1 must not mutate GitHub. Exact command in "Operator actions" below.                                                                                                                                                                                                                                                       | Accepted |
| PORT-08 | Medium   | `docs/screenshots/mobile-ticket.png`; `scripts/screenshots.ts:223`          | The committed phone capture was blank below its header: content stopped at row 500 of 1688, so the ply row, thread, customer message, reply and Office use were all missing. The phone context was the only capture without `reducedMotion: 'reduce'`, and its `screenshot()` passed no `animations: 'disabled'`, so the print-in animation's `clip-path: inset(0 0 100% 0)` was still applied when the shot was taken. Check 4's "all eight match" claim was therefore false. | Mirrored the still context's `reducedMotion: 'reduce'`, awaited the reply, the Office use aside and the fonts, and took the shot with `animations: 'disabled'` and `fullPage: true`. Regenerated `mobile-ticket.png` (780x2688, content on 73.9% of rows through row 2637) and replaced the false claim with the measured result. Pinned by the guard test, which decodes the PNG and fails a clipped capture. | Fixed    |

## Not in this story's files (handoff)

Two stale "Ticket Pipe" strings sat in files this story does not own. Both are now handled:

- `apps/api/src/services/ops-alerts.ts:25` — the ops alert **Subject** was `[Ticket Pipe] ...`. The
  sibling `audit/7.12.9-legal-truthfulness` branch sets it to `[Relay]` (verified on that branch), and
  this story updated the example in `docs/ops.md` to match, so the docs and the code agree once both
  merge. This story does not edit `apps/api/src/**`.
- `apps/web/src/config/brand.ts:17` — `repoUrl` is still `https://github.com/ToshifurRahman/ticket-pipe`.
  The footer "source" link therefore points at the old repository name. Handoff to the web owner
  (`audit-legal` owns `apps/web/**` this wave).

## Operator actions (not run in Gate 1)

After `LICENSE` is on `main`, GitHub fills `licenseInfo` by itself. The other three settings are a
maintainer's one-time action, copy-paste ready:

```bash
GH_TOKEN=$(gh auth token --user ToshifurRahman) gh repo edit ToshifurRahman/relay \
  --description "Support-ticket pipeline: LLM triage and drafting, async SQS worker, live ops console" \
  --homepage "https://ticket-pipeline.onrender.com" \
  --add-topic support-tickets,llm,bun,hono,postgresql,redis,aws-sqs,react,typescript
```

## Secret scan

Full-history scan (`reports/logs/portfolio-history-secret-scan.log`): `clean`. 397 commits and 27
refs were searched for `AKIA`/`ASIA` AWS keys, `rediss://`/`postgres://` credential URIs,
`sk-`/`ghp_`/`AIza`/`xox*` tokens, `BEGIN * PRIVATE KEY` blocks and vendor keys. No credential, no
private key and no committed `.env` was found; the only token-shaped strings are the fake keys in
`PORT-06`. `gitleaks` is not installed locally (exit `127`), so the scan is `git grep` over
`git rev-list --all`, the same detection set `7.12.12` re-runs in CI. The branch diff scan against
`origin/main` is empty:

```
git diff --name-only -G'(AKIA[0-9A-Z]{16}|rediss?://[^:@/ ]*:[^@/ ]+@|postgres(ql)?://[^:@/ ]+:[^@/ ]+@.*neon)' origin/main...HEAD
(no output)
```

No matched secret value is printed anywhere in this document or its logs.

## README and docs alignment (detail)

The README links to `CONTRIBUTING.md`, `DESIGN.md`, `PRODUCT.md`, `render.yaml` and eight files under
`docs/`. All resolve, and every relative link across `docs/*.md` resolves too; the guard test keeps
it that way. Claims spot-checked against the code:

- `/health/ready` runs `SELECT 1` (`apps/api/src/routes/health.ts`), so it reports a suspended
  database truthfully, as the README now says.
- Retention is 30 days (`apps/api/src/services/ticket-retention.ts`, `RETENTION_DAYS = 30`), as the
  data notice says.
- The demo routes named in the README (`/` and `/new`) exist in `apps/web/src/app/routes.tsx`.
- The queue options match `docker-compose.yml` (LocalStack `4566`, `setup` service, `elasticmq`
  profile) and `docs/production-infra.md` §7.

## Screenshots (detail)

The eight files are `landing.png`, `new-ticket.png`, `ticket-live.png`, `ticket-completed.png`,
`ops-list.png`, `ops-drawer.png`, `mobile-ticket.png` and `customer-flow.gif`, all committed in
`b81a7bc` (2026-10-22, "regenerate the README screenshots ... for the finished redesign").

Inspected directly, seven of the eight were current: the header says `RELAY`, the forms and ticket
pages match the current routes, and the ops console shows the current KPI strip, tabs, drawer and
`REPLAY FROM DRAFT` action. No "Ticket Pipe" text appears in any of them.

`mobile-ticket.png` was not. Its per-row pixel profile against the page background (RGB `8,19,15`)
showed content on only 405 of 1688 rows and nothing at all below row 500: the ply row, the thread,
the customer message, the reply and the Office use aside were missing because the capture was taken
while the print-in animation still had its `clip-path: inset(0 0 100% 0)` applied. The phone context
was the only one without `reducedMotion: 'reduce'`, and its `screenshot()` passed no
`animations: 'disabled'`.

The phone block now mirrors the still context's `reducedMotion: 'reduce'`, waits for the reply text,
the Office use aside and `document.fonts.ready`, and calls `screenshot({ animations: 'disabled',
fullPage: true })`. Only `mobile-ticket.png` was regenerated; the other seven were restored
byte-identical, so the diff carries one screenshot. The regenerated file is 780x2688 with content on
1986 of 2688 rows (73.9%) reaching row 2637, and the ply row, thread, customer message, reply,
Office use and footer are all visible.

`scripts/screenshots.ts` needs `NODE_ENV` that is not `production` (the stack refuses `LLM_MODE=fake`
in production) and rate-limit headroom on the shared Redis counters for its six tickets. It was run
as `env NODE_ENV=test TICKET_DAILY_CAP=100000 TICKET_IP_HOURLY_LIMIT=1000 bun run screenshots`; no
counter was reset. Every process it started was stopped and `apps/web/dist` was removed afterwards.

## Regression tests added

`apps/api/tests/unit/portfolio/portfolio-docs.portfolio.test.ts` (14 tests, no Docker, no network):

- LICENSE exists, is non-empty, is MIT and names the copyright holder; `package.json` agrees.
- Every relative link in `README.md` resolves, and every relative link in the feature docs (the
  `docs/audit/**` runbooks are excluded because their evidence paths are report-side) resolves.
- `README.md` has no `ticket-pipe` repository URL and does contain the `relay` URL, the live demo
  URL, the cold-start note, the "do not submit real personal data" notice, the ElasticMQ/`SQS_ENDPOINT`
  option, and the `24.22.1` Node version the root `package.json` requires.
- Every screenshot `README.md` embeds exists and is non-empty.
- The phone context in `scripts/screenshots.ts` sets `reducedMotion: 'reduce'` and its shot passes
  `animations: 'disabled'`.
- `mobile-ticket.png` decodes to a real capture: content on at least 70% of rows and the last content
  row within 100px of the bottom. The old blank file scores 0.24 and fails; the regenerated one
  scores 0.74 and passes, so a clipped capture fails the suite instead of shipping silently. The PNG
  is decoded with Node's `zlib` only (IHDR, the IDAT stream and the five scanline filters), so the
  check needs no image dependency.
- `docs/ops.md` no longer documents the retired `[Ticket Pipe]` alert subject.

Red: `reports/logs/red-portfolio-docs.log` (8 failed, 3 passed) and `reports/logs/red-portfolio-fix1.log`
(3 failed, 11 passed). Green: `reports/logs/green-portfolio-docs.log` (11 passed) and
`reports/logs/green-portfolio-fix1.log` (14 passed).
