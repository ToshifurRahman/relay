# Epic 7 delivery audit (7.12.11)

Audit date: 2026-11-24, against `origin/main` at `9631ec8` (Wave 5 merged) and against the live
deployment `https://ticket-pipeline.onrender.com` with read-only, low-volume probes. It re-checks
every acceptance criterion of stories 5.6, 7.1 to 7.5 and 7.7 to 7.11, and it disposes of every
finding the pre-audit raised (`docs/audit/pre-audit.md`, 7.0.9): 52 `PA-*` findings and the seven
parked bullets at `pre-audit.md:580-590`. The per-area audits `01` to `10` are the primary record
for their own checks; this document is the roll-up that proves nothing fell between them.

Severity uses the pre-audit scale: Critical and High block go-live, and a Medium or Low may ship
only as an accepted risk with a reason. Finding IDs are `DEL-NN`.

## Summary

| Severity | Found | Fixed | Accepted | Deferred | Open |
| -------- | ----- | ----- | -------- | -------- | ---- |
| Critical | 0     | 0     | 0        | 0        | 0    |
| High     | 0     | 0     | 0        | 0        | 0    |
| Medium   | 1     | 0     | 1        | 0        | 0    |
| Low      | 1     | 1     | 0        | 0        | 0    |

No Critical or High finding is open. The pre-audit's seven High findings (`PA-7.1-01`,
`PA-7.1-02`, `PA-7.2-01`, `PA-7.4-01`, `PA-7.8-01`, `PA-7.9-01`, `PA-7.13-01`) are either fixed on
`main` with their own regression tests, or, for `PA-7.13-01`, explicitly deferred to story 7.13
because it is a go-live procedure, not code. The one Low found here (the mobile message clamp) is
fixed with a failing-first test; the one Medium accepted is the free-plan pinger decision, whose
launch condition is already recorded in `docs/deployment.md` and `04-cost-limits.md` (`COST-04`).

## Deployed build versus `origin/main`

The epic shipped in waves, so "verified in the code" and "verified live" are recorded separately
rather than blurred together.

| Thing                             | `origin/main` `9631ec8`                                                                                                                                      | Deployed `ticket-pipeline.onrender.com`                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Web bundle                        | includes every Wave 5 copy change (footer demo label, "Try the demo" buttons, "Illustrative rates", "Redis Cloud", no "within a minute", no "With our team") | carries all of those markers and none of the retired strings, so the deployed web build is the Wave 5 build |
| Mobile message clamp (this audit) | fixed on this branch; not on `main`, so not deployed                                                                                                         | still the pre-fix markup (`line-clamp-4` on the padded panel); the sliced fifth line is live today          |
| API                               | `/health/live`, `/health/ready`, `/api/ops/session`, the 401 wall, CSP, HSTS                                                                                 | same responses and headers as `main` (probes below)                                                         |
| Stories 7.12.11 and 7.12.12       | this branch and its sibling                                                                                                                                  | not deployed, by design: the gate records the verdict before go-live                                        |

An empty `apps/web/src` diff between the last two merges (`c6b7efc` to `9631ec8`) means the web
sources at `9631ec8` are the sources the deployed bundle was built from. Nothing below claims that
this branch's clamp fix is live; it is not, and `DEL-01` says so.

## Live probes (read-only, low volume)

Run on 2026-11-24 from the worktree; raw output in `reports/logs/delivery-live-probes.log`. No form
was submitted, no sign-in attempted, no ticket created, no lockout triggered.

```
GET /health/live    -> 200 {"status":"ok"}         GET /              -> 200 2092 B
GET /health/ready   -> 200 {"status":"ok"}         GET /new           -> 200 2092 B
GET /api/ops/session -> 200 {"signedIn":false}     GET /privacy       -> 200 2092 B
GET /api/tickets     -> 401 {"error":"Unauthorized"}   GET /terms     -> 200 2092 B
GET /api/ops/ai-interactions -> 401 {"error":"Unauthorized"}   GET /legal/privacy -> 200 2092 B
GET /api/ops/tickets/<uuid>  -> 401 {"error":"Unauthorized"}   GET /ops    -> 200 2092 B
POST /api/tickets/<uuid>/replay -> 401 {"error":"Unauthorized"}
```

Headers on `/health/live`: CSP with `frame-ancestors 'none'`, `frame-src
https://challenges.cloudflare.com`, `script-src` without `unsafe-inline`, `script-src-attr 'none'`,
`object-src 'none'`, `base-uri 'self'`; HSTS `max-age=15552000; includeSubDomains`;
`X-Content-Type-Options: nosniff`; `Referrer-Policy: strict-origin-when-cross-origin`;
`Cross-Origin-Opener-Policy: same-origin`; `Cross-Origin-Resource-Policy: same-origin`;
`server: cloudflare` with `x-render-origin-server: Render`.

## Story-by-story acceptance criteria

Each row states the criterion as the story and the pre-audit define it after the plan's corrections,
then the codebase evidence on `9631ec8` and the live evidence. Test paths are the regression tests
that would fail if the behaviour regressed.

| Story                            | Acceptance criterion                                                                                                                                       | Codebase evidence (`9631ec8`)                                                                                                                                                                                                                                                                                                                                     | Live evidence                                                                                    | Result         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------- |
| 5.6 Protected ops endpoints      | Ops routes, ticket list and replay reject a caller without a session; public events carry no `detail`                                                      | `routes/ops.ts:14` `opsRouter.use('*', requireOpsSession)`; `routes/tickets.ts:9,16` per route; `lib/socket.ts` `ops:subscribe` acks `unauthorized`; `services/ticket-views.ts` `toPublicEvent` returns event + time only; `tests/api/ops/auth.test.ts`, `tests/integration/server.test.ts`                                                                       | list, replay, `/api/ops/*`, `/api/ops/tickets/:id` all `401 {"error":"Unauthorized"}`            | Pass           |
| 7.1 Production build             | Bun runs the TypeScript; `bun run build` type-checks the API and builds the web app; `bun run start` runs API and worker together; JSON logs in production | root `package.json` `build` = `tsc --noEmit -p apps/api && bun --filter @relay/web build`, `start` = `bun --filter @relay/api start`; `apps/api/package.json` `start` `bun src/main.ts`, plus `start:api`/`start:worker`; `main.ts` owns one shutdown with a 25 s deadline; `lib/logger.ts:7` drops `pino-pretty` in production; `tests/integration/main.test.ts` | n/a (build property)                                                                             | Pass           |
| 7.2 Container image              | Pinned Bun base, frozen lockfile, non-root, no `.env`/tests/dev deps, three `VITE_*` build args, `HEALTHCHECK`                                             | `Dockerfile:7,22` pinned `oven/bun:1.3.14`; `:9-11` three args; `:18-19` the build fails without `VITE_TURNSTILE_SITE_KEY`; `:34` `USER bun`; `:37-39` health check on `/health/live`; `.dockerignore`; `scripts/image-smoke.ts`                                                                                                                                  | n/a (image property)                                                                             | Pass           |
| 7.3 Validated configuration      | One schema validates once; modules read the object, not `process.env`; production refuses unsafe values                                                    | `lib/config.ts` is the only `process.env` reader (`tests/guards/env-access.test.ts`); `DATABASE_DIRECT_URL`, `TURNSTILE_SECRET_KEY`, `LLM_DAILY_CAP` in the schema; fail-closed rules for `LLM_MODE=fake`, `MAIL_DRIVER=memory`, a short `OPS_TOKEN`, a missing Turnstile secret; `tests/unit/entry-config.test.ts`                                               | n/a (startup property)                                                                           | Pass           |
| 7.4 Hardened HTTP layer          | Security headers and a CSP that lets the real page work; body and field limits; a proxy-aware client address                                               | `middleware/security-headers.ts` (`frameSrc` `challenges.cloudflare.com`, `styleSrcAttr`, `connectSrc` self + `wss:`); `middleware/origin-policy.ts`; `app.ts` body limit 100 KB; `middleware/client-ip.ts` prefers `CF-Connecting-IP`; tests pin each                                                                                                            | CSP, HSTS, nosniff, COOP/CORP as listed above; a cross-origin POST is refused (01, check 9)      | Pass           |
| 7.5 Abuse protection             | Server-side Turnstile on submit; a per-address hourly limit and a daily cap; friendly 403/429                                                              | `lib/turnstile.ts` `verifyTurnstile`; `services/submission-guard.ts` `checkIpLimit` (`tickets:ip:*`, 3600 s), `checkDailyCap` (`tickets:day:*`, `TICKET_DAILY_CAP`), `checkTurnstile`; opt-in route verifies the token too; `tests/api/tickets/submit.test.ts`                                                                                                    | n/a (would need a submission, deliberately not sent)                                             | Pass           |
| 7.7 Continuous integration       | One workflow runs the full check on PRs and `main`, with Mailpit, migrate and setup, plus commitlint                                                       | `.github/workflows/ci.yml` `check` job: services, `Migrate`, `Create queues and topics`, format, lint, typecheck, unit, integration, web, web build, image, e2e, commitlint; serial step for the two known-flaky files; README badge                                                                                                                              | CI badge resolves; `main` CI is green at `9631ec8`                                               | Pass           |
| 7.8 Production infrastructure    | Real AWS queues can be created; two IAM identities; SNS publish; a documented queue host decision                                                          | `scripts/setup-infra.ts` `hasEndpoint()` treats empty as unset and refuses the local placeholder with real AWS; `infra/iam/runtime-policy.json` (`sqs:GetQueueUrl                                                                                                                                                                                                 | SendMessage                                                                                      | ReceiveMessage | DeleteMessage`, `sns:Publish`), `infra/iam/setup-policy.json`; `docs/production-infra.md` §3, §7 | n/a (console-side) | Pass |
| 7.9 Continuous deployment        | A blueprint or documented settings; migrations before the server starts; deploys only after CI                                                             | `render.yaml` one web service, `dockerCommand: sh scripts/start.sh`, `healthCheckPath: /health/ready`, `autoDeployTrigger: checksPass`; `scripts/start.sh` `set -e` + migrate + `exec bun src/main.ts`; `docs/deployment.md`                                                                                                                                      | `/api/ops/session` `signedIn:false` and `/health/ready` 200 show the migrated service is serving | Pass           |
| 7.10 Uptime and error monitoring | `/health/live` without a database, `/health/ready` with one, `/health` as an alias; quiet health logging                                                   | `routes/health.ts:14,31,32` (`/live` process only, `/ready` `SELECT 1` under a 4 s deadline, `/` the same handler); `middleware/request-logger.ts` quiets the `/health` prefix                                                                                                                                                                                    | `/health/live` 200 (process), `/health/ready` 200 (database reachable)                           | Pass           |
| 7.11 Rename to the brand         | Product, README, repo links and Render service all say Relay; no old working title in user-facing copy                                                     | `config/brand.ts` `name: 'Relay'`, `repoUrl` `github.com/ToshifurRahman/relay`, no `isWorkingName`; `README.md:3` title Relay and relay URLs; `render.yaml:6` `name: relay`; `services/ops-alerts.ts` subject `[Relay]`; `tests/unit/portfolio/portfolio-docs.portfolio.test.ts`                                                                                  | live shell title and footer read Relay; the live pages carry no old title                        | Pass           |

Every row above is also exercised by the project gates: `@relay/api` unit and integration,
`@relay/web`, `typecheck`, `lint` and `format:check` all pass on this branch (counts in the
subtask report).

## Pre-audit disposition ledger

Every `PA-*` finding from `docs/audit/pre-audit.md`, with the disposition and where the closure is
proved. `Closed` means the audit's own recomputation found the defect gone, `Fixed` means a change
with a regression test closed it (the test is named), `Accepted` is a recorded risk with a reason,
and `Deferred to 7.13` is a go-live procedure outside this story. A test,
`apps/api/tests/unit/delivery/pre-audit-disposition.delivery.test.ts`, parses this table and fails
if any `PA-*` id of the pre-audit is missing, unrated, doubled or open at Critical or High.

| ID         | Severity | Story | Evidence and closure                                                                                                                                                                    | Status           |
| ---------- | -------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| PA-5.6-01  | Low      | 5.6   | The ClickUp task is open while its work is merged. 5.6 closes; the one leftover (a production 401 check) is `PA-7.13-02`, executed below.                                               | Closed           |
| PA-7.1-01  | High     | 7.1   | No `tsc` to `dist/`; Bun runs the sources. `package.json` `build` type-checks instead; `apps/api/tsconfig.json` stays `noEmit`-friendly.                                                | Fixed            |
| PA-7.1-02  | High     | 7.1   | `apps/api/src/main.ts` starts the HTTP server and the worker in one process; `Dockerfile:40` `CMD ["bun","src/main.ts"]`.                                                               | Fixed            |
| PA-7.1-03  | Medium   | 7.1   | `worker.ts` `run({ signal })` takes an `AbortSignal`; `main.ts` owns one ordered shutdown (`tests/integration/main.test.ts`).                                                           | Fixed            |
| PA-7.1-04  | Medium   | 7.1   | Root `build`/`start` and workspace `start`/`start:api`/`start:worker` scripts exist.                                                                                                    | Fixed            |
| PA-7.1-05  | Low      | 7.1   | The story wording is corrected for Hono and `apps/web/dist`; README and `docs/deployment.md` use the current stack.                                                                     | Fixed            |
| PA-7.2-01  | High     | 7.2   | `Dockerfile:9-19` declares the three args and fails the build without the Turnstile key; `scripts/image-smoke.ts` pins the failure.                                                     | Fixed            |
| PA-7.2-02  | Medium   | 7.2   | Both stages pin `oven/bun:1.3.14`.                                                                                                                                                      | Fixed            |
| PA-7.2-03  | Medium   | 7.2   | `HEALTHCHECK` runs `bun -e fetch(...)` against `/health/live` and follows `$PORT`.                                                                                                      | Fixed            |
| PA-7.2-04  | Low      | 7.2   | `README.md:152,161` documents the `docker run` invocations, including `--no-healthcheck` for a worker-only container.                                                                   | Fixed            |
| PA-7.3-01  | Medium   | 7.3   | `lib/config.ts` validates once at startup; `db`, `queue` and `socket` build lazily; `tests/guards/env-access.test.ts` keeps `process.env` to that one module.                           | Fixed            |
| PA-7.3-02  | Medium   | 7.3   | Real AWS keys are required unless `SQS_ENDPOINT` is set; `setup-infra.ts` also refuses the local placeholder.                                                                           | Fixed            |
| PA-7.3-03  | Medium   | 7.3   | The three `assert*` rules moved into the schema and keep their messages (`tests/api/ops/session.test.ts:126`).                                                                          | Fixed            |
| PA-7.3-04  | Medium   | 7.3   | `.env.example` lists every schema key, pinned by `tests/guards/env-example.test.ts`.                                                                                                    | Fixed            |
| PA-7.3-05  | Low      | 7.3   | `MAIL_FROM=noreply@example.com`; the Brevo sender limitation is stated in `docs/customer-email.md:30-32`.                                                                               | Fixed            |
| PA-7.4-01  | High     | 7.4   | The CSP allows `frame-src challenges.cloudflare.com`, `script-src` + `connect-src` for the analytics beacon, `style-src-attr`, and `wss:` for sockets; `tests/api/web/headers.test.ts`. | Fixed            |
| PA-7.4-02  | Medium   | 7.4   | `hono/secure-headers` and `clientIp()` replace helmet and `trust proxy`.                                                                                                                | Fixed            |
| PA-7.4-03  | Medium   | 7.4   | Socket.IO `cors` is the `PUBLIC_SITE_URL` origin, with localhost only outside production.                                                                                               | Fixed            |
| PA-7.4-04  | Medium   | 7.4   | Fonts are self-hosted; `font-src 'self'` and no font hosts in the policy.                                                                                                               | Fixed            |
| PA-7.4-05  | Medium   | 7.4   | The 100 KB body limit covers every public POST route and is tested per route.                                                                                                           | Fixed            |
| PA-7.4-06  | Low      | 7.4   | `app/analytics.tsx` carries the corrected path comment and needs the 7.2 build arg.                                                                                                     | Fixed            |
| PA-7.4-07  | Low      | 7.4   | Verified on the deployed service: `clientIp()` prefers `CF-Connecting-IP`, and the live origin is Cloudflare-only (01, SEC-02 and its `dig` evidence).                                  | Closed           |
| PA-7.5-01  | Medium   | 7.5   | `counters.ts` is reused for `tickets:ip:*` (hourly) and `tickets:day:*` (UTC day).                                                                                                      | Fixed            |
| PA-7.5-02  | Medium   | 7.5   | The notification opt-in route verifies the Turnstile token as well (`controllers/notifications.ts`), with tests.                                                                        | Fixed            |
| PA-7.5-03  | Medium   | 7.5   | Calls per ticket are counted and documented: 12 per slot, 14 in the failure-recording case (04, check 9).                                                                               | Fixed            |
| PA-7.5-04  | Medium   | 7.5   | The limit is tested with and without the header, and the startup note is `docs/deployment.md` "Checking the client address (PA-7.5-04)".                                                | Fixed            |
| PA-7.7-01  | Medium   | 7.7   | The workflow mirrors the compose services (Postgres, Redis, LocalStack, Mailpit) and runs migrate and setup before the tests.                                                           | Fixed            |
| PA-7.7-02  | Medium   | 7.7   | One `check` job runs the whole gate set, plus the web build, the image and commitlint; Bun and Node are pinned.                                                                         | Fixed            |
| PA-7.7-03  | Medium   | 7.7   | e2e runs as its own pull-request job with `LLM_MODE=fake` and the accessibility spec.                                                                                                   | Fixed            |
| PA-7.7-04  | Medium   | 7.7   | The two known-flaky files run in one serial step with `--no-file-parallelism --maxWorkers=1` and no retries (`.github/workflows/ci.yml:117`).                                           | Fixed            |
| PA-7.7-05  | Low      | 7.7   | The README carries the CI badge.                                                                                                                                                        | Fixed            |
| PA-7.8-01  | High     | 7.8   | `setup-infra.ts:64-90`: an empty endpoint means real AWS, the local placeholder is refused, and the visibility timeout is computed rather than defaulted.                               | Fixed            |
| PA-7.8-02  | Medium   | 7.8   | Two identities: `infra/iam/setup-policy.json` (create/attribute) and `infra/iam/runtime-policy.json` (four queue calls plus `sns:Publish`).                                             | Fixed            |
| PA-7.8-03  | Medium   | 7.8   | ElasticMQ needs a host that does not sleep; the local switch was executed and documented (`07`, check 6). Recorded as `OPS-03` and as the launch condition in `docs/deployment.md`.     | Accepted         |
| PA-7.8-04  | Medium   | 7.8   | Measured: 23 code-derived commands per full journey (27 with first-hit `EXPIRE`s), 0 while idle, 5 connections; Redis Cloud Free is 30 MB/30 connections (04, check 7).                 | Closed           |
| PA-7.8-05  | Medium   | 7.8   | `migrate.ts` prefers `DATABASE_DIRECT_URL` and falls back to `DATABASE_URL`; both are in the schema, `.env.example` and `render.yaml`.                                                  | Fixed            |
| PA-7.8-06  | Low      | 7.8   | `docs/ops.md` "Manual steps: AWS free-tier expiry" carries the calendar reminder, the $1 budget and the SNS verification steps.                                                         | Fixed            |
| PA-7.9-01  | High     | 7.9   | `apps/api/scripts/start.sh` runs `set -e`, the migration, then `exec bun src/main.ts`, so a failed migration never serves. `render.yaml` runs it as `dockerCommand`.                    | Fixed            |
| PA-7.9-02  | Medium   | 7.9   | `/health/ready` (database, 4 s deadline) is the Render health check, so a suspended Neon fails truthfully instead of failing the deploy on `/health`.                                   | Fixed            |
| PA-7.9-03  | Medium   | 7.9   | `render.yaml:13` `autoDeployTrigger: checksPass`, so a deploy waits for CI.                                                                                                             | Fixed            |
| PA-7.9-04  | Low      | 7.9   | Git history scanned for secrets (01 check 16; 10 check 2, 397 commits): clean.                                                                                                          | Fixed            |
| PA-7.10-01 | Medium   | 7.10  | `/health/live` and `/health/ready` exist and `/health` is the same ready handler (`routes/health.ts:14,31,32`).                                                                         | Fixed            |
| PA-7.10-02 | Medium   | 7.10  | The request logger quiets the `/health` prefix, not one exact path.                                                                                                                     | Fixed            |
| PA-7.10-03 | Low      | 7.10  | The keep-awake dependency on a shared process is stated in `docs/deployment.md` "Free plan behavior" and in the README's cold-start paragraph.                                          | Fixed            |
| PA-7.11-01 | Low      | 7.11  | `config/brand.ts:1-3` carries the current path and story number; no stale comment remains.                                                                                              | Fixed            |
| PA-7.11-02 | Medium   | 7.11  | The repo, README and Render service are renamed; the internal `@relay/*` scope, the database name and the root package name stay `ticket-pipe` on purpose.                              | Accepted         |
| PA-7.11-03 | Medium   | 7.11  | The public URL stays `ticket-pipeline.onrender.com`; `PUBLIC_SITE_URL` and `VITE_SITE_URL` are set from it in the dashboard, and Turnstile's hostname list matches it.                  | Accepted         |
| PA-7.11-04 | Low      | 7.11  | `README.md:3` reads `# Relay`.                                                                                                                                                          | Fixed            |
| PA-7.13-01 | High     | 7.13  | A headless smoke test cannot pass Turnstile. Deferred to the go-live story as a split: automated health and 401 checks (run below) plus a manual submit-and-watch checklist.            | Deferred to 7.13 |
| PA-7.13-02 | Medium   | 7.13  | Executed read-only on 2026-11-24: the ticket list, replay, `/api/ops/*` and `/api/ops/tickets/:id` all answer 401 without a session. Re-run at go-live.                                 | Closed           |
| PA-7.13-03 | Medium   | 7.13  | The README now carries the live URL, the cold-start note, the "no real personal data" notice and the queue options (`PORT-03`, `PORT-04`).                                              | Closed           |
| PA-7.13-04 | Low      | 7.13  | Moving every live story to Production is the last step after the gate records go.                                                                                                       | Deferred to 7.13 |

### Parked items (`pre-audit.md:580-590`)

The parked list is not made of `PA-*` ids, so each bullet is claimed by the audit that picked it up.

| Parked item                                                       | Owner  | Result                                                                                                                                            |
| ----------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in lockout keyed by `clientIp()`; confirm it on Render       | 7.12.1 | Corrected rather than confirmed: the key was the shared Cloudflare edge (`SEC-02`), now `CF-Connecting-IP`.                                       |
| Scan git history for secrets (`PA-7.9-04`)                        | 7.12.1 | Clean over 397 commits (10, check 2).                                                                                                             |
| Run a dependency audit                                            | 7.12.1 | Three runtime advisories fixed (`SEC-03`), dev-only ones accepted (`SEC-04`).                                                                     |
| Whether ticket text reaches logs; whether purge and retention run | 7.12.2 | Ticket text and the confirmation token are out of the logs (`PRIV-01`, `PRIV-02`); the sweep runs on the single production process (02, check 5). |
| The Brevo sender identity (PA-7.3-05)                             | 7.12.2 | One verified Gmail sender with no DMARC alignment; stated in `docs/customer-email.md`.                                                            |
| Web and sockets when Render wakes from sleep                      | 7.12.3 | Sockets reconnect with backoff; the missing fetch timeout was `REL-06`, fixed.                                                                    |
| Neon free-tier restore options                                    | 7.12.3 | Documented: 6-hour history, restore branch, 30-day retention boundary.                                                                            |
| The Redis command budget (`PA-7.8-04`)                            | 7.12.4 | Measured: 23 commands per journey, 0 idle (04, checks 5-7).                                                                                       |
| LLM calls per ticket (`PA-7.5-03`)                                | 7.12.4 | 12 per slot, 14 on a recording failure, ~24 with a duplicate slot; `REL-01` closes the duplicate path.                                            |
| The manual steps from `PA-7.8-06` and the ElasticMQ switch        | 7.12.7 | Written into `docs/ops.md`, and the switch was executed locally (07, checks 1, 3, 6).                                                             |
| Prompt injection through ticket text                              | 7.12.8 | Audited: nonce delimiters, targeted neutralisation, an instruction hierarchy and a reply guard (`AI-01` to `AI-06`).                              |
| `brand.repoUrl` and the legal contact points after the rename     | 7.12.9 | `repoUrl` now names the relay repository; the only contact point is the GitHub issues link (`LEG-04`).                                            |

## Locked findings

| ID     | Severity | Location                                                           | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Fix or accepted-risk reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Status   |
| ------ | -------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| DEL-01 | Low      | `apps/web/src/features/tickets/components/ticket-thread.tsx:36-45` | Handed over from 7.12.10. The customer message clamped with `line-clamp-4` on a block that carries `px-4 py-3`. `-webkit-line-clamp` only clips inside a `-webkit-box`, and the browser computes `display: flow-root` for that padded block, so nothing clipped: at 390 px the fifth text line painted at 113 px in a 123 px box and the panel's `overflow: hidden` cut it through the glyphs, with no ellipsis, beside a "Show full message" button. Measured in Chrome 157 at 390 px: 5 line boxes, `clientHeight` 123, `scrollHeight` 148. | Fixed: the clamp moved to an unpadded inner span, the padding stays on the blockquote, and `block` is applied only when expanded, because `.block` would otherwise win the display cascade over `.line-clamp-4`. Re-measured: 4 line boxes, ellipsis shown, `scrollHeight` equals `clientHeight`; expanded shows all 8 lines; at 521 px and above the clamp is off as before. Regression test `apps/web/src/features/tickets/components/ticket-thread.delivery.test.tsx` (red: `reports/logs/red-delivery-clamp.log`, 2 failed of 6; green: `reports/logs/green-delivery-clamp.log`, 17 passed across both thread files). | fixed    |
| DEL-02 | Medium   | `render.yaml`; `docs/deployment.md` "Free plan behavior"           | The deployment can be kept awake by a pinger only at a cost the free plan cannot carry: Render's `/health/ready` keeps querying Neon, so 0.25 CU would run 744 h = 186 CU-hours against a 100 CU-hour allowance (`COST-04`). The repository default (no pinger) stays inside the allowance.                                                                                                                                                                                                                                                   | Accepted: no keep-awake pinger is enabled, which is the documented default; if uptime monitoring is required, both the health check and the pinger must target `/health/live`, which touches no database, or Neon must be upgraded. Recorded as the launch condition in `docs/deployment.md` and `04-cost-limits.md`.                                                                                                                                                                                                                                                                                                     | accepted |

No Critical or High finding is open.

## Method and limits

- Every local command ran through `run-check.sh` from the worktree, one at a time, with
  `apps/web/dist` absent before and after the gate run. The database is
  `ticket_pipe_audit_delivery_test` on the compose Postgres; LocalStack supplied the queues.
- The browser measurement of `DEL-01` used the repository's own built stylesheet and Chrome 157,
  at 390, 520, 521 and 1280 CSS px. The probe lived outside the repository and wrote no repository
  file.
- The live probes were read-only and low volume: health, the SPA shell, the public pages, the
  session read, and 401 checks on protected routes. No ticket was submitted, no sign-in attempted,
  no load or fuzz test run, and nothing on Neon, Redis Cloud, AWS or Render was mutated.
- No secret is printed in this document. The pre-audit and the per-area audits it rolls up are the
  record of the code-level work; this document does not restate their logs.
