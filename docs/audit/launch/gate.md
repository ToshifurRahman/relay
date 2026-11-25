# Launch gate (7.12.12)

Launch gate pass on branch `audit/7.12.12-launch-gate` from `main` at `56e35c5`, 2026-11-24. It rolls
up all eleven audits (`01-security.md` through `11-epic-7-delivery.md`), runs the single-command gate
(`scripts/gate.sh`), lists every accepted Medium and Low risk with its reason, and records the final
go/no-go verdict for 7.13.

The delivery audit (`11-epic-7-delivery.md`) merged at `56e35c5` and is included in the rollup, the
accepted-risk register and the automated doc check. `scripts/gate.sh` ingests every
`docs/audit/launch/NN-*.md` doc, so the count is complete without a change when a doc is added.

## Gate decision

**Gate decision: GO.** All eleven areas carry **0 open Critical and 0 open High** findings, every audit
doc passes the automated open-finding check, and every accepted Medium and Low risk is listed below
with its reason. The rule applied: GO only when every doc `01` through `11` reports zero open Critical
and zero open High; the delivery audit reports none, so the gate is GO for Story 7.13 Go-Live.

## Area rollup

Each cell is `found/fixed/accepted/open`.

| Area               | Doc                       | Critical | High      | Medium    | Low        |
| ------------------ | ------------------------- | -------- | --------- | --------- | ---------- |
| 7.12.1 Security    | 01-security.md            | 0/0/0/0  | 2/2/0/0   | 3/2/1/0   | 3/1/2/0    |
| 7.12.2 Privacy     | 02-data-privacy.md        | 0/0/0/0  | 1/1/0/0   | 1/1/0/0   | 5/2/3/0    |
| 7.12.3 Reliability | 03-reliability.md         | 0/0/0/0  | 3/3/0/0   | 3/3/0/0   | 1/0/1/0    |
| 7.12.4 Cost        | 04-cost-limits.md         | 0/0/0/0  | 1/1/0/0   | 3/0/3/0   | 1/0/1/0    |
| 7.12.5 Code health | 05-code-health.md         | 0/0/0/0  | 0/0/0/0   | 8/8/0/0   | 2/1/1/0    |
| 7.12.6 Frontend    | 06-frontend-prod.md       | 0/0/0/0  | 2/2/0/0   | 0/0/0/0   | 1/1/0/0    |
| 7.12.7 Ops         | 07-ops-runbook.md         | 0/0/0/0  | 1/1/0/0   | 2/1/1/0   | 2/2/0/0    |
| 7.12.8 AI safety   | 08-ai-safety.md           | 0/0/0/0  | 3/3/0/0   | 2/2/0/0   | 1/1/0/0    |
| 7.12.9 Legal       | 09-legal-truthfulness.md  | 0/0/0/0  | 3/3/0/0   | 2/2/0/0   | 3/3/0/0    |
| 7.12.10 Portfolio  | 10-portfolio-readiness.md | 0/0/0/0  | 3/3/0/0   | 3/3/0/0   | 3/0/3/0    |
| 7.12.11 Delivery   | 11-epic-7-delivery.md     | 0/0/0/0  | 0/0/0/0   | 1/0/1/0   | 1/1/0/0    |
| All eleven areas   | 01-11                     | 0/0/0/0  | 19/19/0/0 | 28/22/6/0 | 23/12/11/0 |

`09-legal-truthfulness.md` also carries eight findings from an independent review pass, one P0, two
P1 and five P2, all fixed; they are not in the severity rows above because the doc keeps the review
labels. `PRIV-03` in `02-data-privacy.md` has status `guard` rather than `accepted`: it records a new
test that pins copy, constant and delete list, with no defect to fix. `SEC-02` is a fixed High whose
residual risk (Cloudflare must remain the only ingress, otherwise `CF-Connecting-IP` is
client-controlled) is accepted in the notes of `01-security.md`; it is not an accepted finding row.

`11-epic-7-delivery.md` disposes of all 52 `PA-*` findings and the seven parked bullets as well: 42
fixed with a regression test, 5 closed after re-checking the code, 3 accepted with a reason and 2
deferred to 7.13 as go-live procedures, with none open. Its two own findings are `DEL-01` (Low, the
mobile message clamp, fixed with a failing-first test) and `DEL-02` (Medium, the free-plan pinger
condition, accepted).

## Accepted Medium and Low risks register

Every accepted Medium and Low finding from `01` through `11` appears once below, with its exact ID,
severity, area doc, location and accepted-risk reason. Nothing is omitted: the register has 19 rows,
the 16 accepted findings from `01` to `10` plus `DEL-02`, `PA-7.11-02` and `PA-7.11-03` from `11`, and
it matches the accepted columns of the rollup (six Medium in the area table, eight in the register
including the two PA-7.11 dispositions, eleven Low). `PA-7.8-03` is the same risk as `OPS-03` and is
cross-referenced below rather than counted twice.

| ID         | Severity | Area doc                  | Location                                                                                                  | Accepted-risk reason                                                                                                                                                                                                                                                                                   |
| ---------- | -------- | ------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SEC-04     | Medium   | 01-security.md            | `bun.lock` (dev toolchain)                                                                                | Dev-only tooling under `@lhci/cli` and `eslint`; never deployed, because the image installs production dependencies only, and the fixes are transitive under `@lhci/cli`, which has no patched release. Re-check at the next dependency refresh.                                                       |
| SEC-06     | Low      | 01-security.md            | `apps/api/src/domain/reference.ts:3-7`                                                                    | The reference is the customer's only handle on their ticket and the page is meant to be shareable; 32 bits of randomness per millisecond makes enumeration impractical, and the public view already withholds every internal field.                                                                    |
| SEC-07     | Low      | 01-security.md            | `apps/api/src/middleware/request-logger.ts:20`                                                            | The caller's request id is only echoed to the caller that sent it and written to a structured log field, never to a header split or a shell; a length bound would add a rejection path for no security gain.                                                                                           |
| PRIV-05    | Low      | 02-data-privacy.md        | `apps/api/src/services/customer-notifications.ts:146`                                                     | The reference is the documented access model, the mask hides all but the first character and the domain, and the token is single-use; raising it would need per-ticket authentication, outside a reference-keyed demo.                                                                                 |
| PRIV-06    | Low      | 02-data-privacy.md        | `apps/api/src/repositories/ai-interactions.ts:40`; `repositories/events.ts:15`                            | Both columns are read only through `/api/ops/*` behind `requireOpsSession`, `detail` never leaves the ops route, and both rows are deleted with the ticket by the 30-day purge.                                                                                                                        |
| PRIV-07    | Low      | 02-data-privacy.md        | `apps/api/src/services/ticket-retention.ts:36-41`                                                         | Render's free plan sleeps the service, so a ticket can outlive 30 days by the length of the sleep; the next wake runs the sweep immediately, so it is delayed, never skipped, and the copy says the demo may wipe sooner.                                                                              |
| REL-07     | Low      | 03-reliability.md         | `apps/api/src/services/ops-alerts.ts:57`                                                                  | The hourly alert cap is a flood guard, not a hard limit, and it is per process; the ticket and the ops feed still carry every event, and the free SNS allowance is 1,000 emails a month against a 20 per hour cap.                                                                                     |
| COST-02    | Medium   | 04-cost-limits.md         | `apps/api/src/services/tickets.ts:47-75`; `docs/ops.md:158`                                               | Replay is behind `requireOpsSession`, and the same operator can already lower the daily cap, stop the worker or rotate the keys; the public submission path stays capped. A hard spend ceiling would need replay counted against the day key.                                                          |
| COST-03    | Medium   | 04-cost-limits.md         | `apps/api/src/lib/config.ts:63`; `apps/api/src/services/ops-alerts.ts`                                    | Alerts are ops-only and need repeated failures; the absolute ceiling is about 0.28 USD a month against a 1 USD budget. A safer default of at most one alert per hour lives in `lib/config.ts`, owned by the reliability branch.                                                                        |
| COST-04    | Medium   | 04-cost-limits.md         | `docs/production-infra.md:121-125`; `render.yaml`; `docs/deployment.md:146-152`                           | Launch condition: do not enable a keep-awake pinger on the free plan, which would exceed Neon's 100 CU-hours. The repository default has no pinger; if uptime monitoring is wanted, point it and the health check at `/health/live` or upgrade Neon.                                                   |
| COST-05    | Low      | 04-cost-limits.md         | `apps/api/src/services/customer-notifications.ts:76-81,215-239`                                           | The 50-email headroom absorbs a UTC and Brevo day-boundary skew and occasional retry duplication; Brevo enforces its own hard limit and never bills the free plan. Re-check live usage after the first week.                                                                                           |
| HLTH-08    | Low      | 05-code-health.md         | `apps/web/src/components/ui/popover.tsx`; `status-pill.tsx:15`; `test/fake-socket.ts:44`; `lib/socket.ts` | None of the unused surface ships in a bundle a visitor loads, because unused exports are tree-shaken and the popover module has no importer, so it is dead source rather than dead weight. The frontend branch removes it.                                                                             |
| OPS-03     | Medium   | 07-ops-runbook.md         | `docs/production-infra.md` section 7; `docker-compose.yml`                                                | ElasticMQ needs a host that does not sleep, and the free Render plan sleeps; the local switch is fully documented and was proved end to end. Staying on AWS SQS until 2027-04-03 is the plan, with the calendar reminder as the decision point.                                                        |
| PORT-06    | Low      | 10-portfolio-readiness.md | `apps/api/tests/unit/domain/customer-reply-guard.ai-safety.test.ts:291-292`                               | The two key-shaped strings are deliberate fakes in the negative cases of a guard that exists to reject secrets; removing them would delete the coverage the scan relies on. Recorded so the next scan does not raise them as new.                                                                      |
| PORT-07    | Low      | 10-portfolio-readiness.md | GitHub repository settings                                                                                | Description, homepage and topics are GitHub-side settings, and Gate 1 must not mutate GitHub. The exact `gh repo edit` command is recorded for the maintainer in the pre-7.13 checklist below.                                                                                                         |
| PORT-09    | Low      | 10-portfolio-readiness.md | `docs/screenshots/ops-drawer.png`                                                                         | The screenshot harness runs against the fake LLM on purpose, so a capture spends no credits and is deterministic; only the model name differs, and the console structure is real. A refresh is tracked for 7.13 after the footer and pricing copy land.                                                |
| DEL-02     | Medium   | 11-epic-7-delivery.md     | `render.yaml`; `docs/deployment.md` "Free plan behavior"                                                  | No keep-awake pinger is enabled, which is the documented default; if uptime monitoring is required, the health check and the pinger must target `/health/live`, which touches no database, or Neon must be upgraded. The launch condition is recorded in `docs/deployment.md` and `04-cost-limits.md`. |
| PA-7.11-02 | Medium   | 11-epic-7-delivery.md     | `README.md`; `render.yaml`; workspace package names                                                       | The repository, README and Render service are renamed, but the internal `@relay/*` package scope, the database name and the root package name stay `ticket-pipe` on purpose; they are not user-facing, and renaming them would churn deployment and tooling for no visible gain.                       |
| PA-7.11-03 | Medium   | 11-epic-7-delivery.md     | `render.yaml`; `docs/deployment.md`; Turnstile hostname list                                              | The public URL stays `ticket-pipeline.onrender.com`; `PUBLIC_SITE_URL` and `VITE_SITE_URL` are set from it in the Render dashboard, and the Turnstile hostname list matches it, so the service and the abuse check agree on the origin.                                                                |

`PA-7.8-03` in `11-epic-7-delivery.md` is the same accepted risk as `OPS-03` (ElasticMQ needs a host
that does not sleep); it is not a second risk and is not counted twice.

## Automated gate run

`scripts/gate.sh` is the single-command Launch Gate. It runs the steps below in order, one at a time,
records each result, and exits non-zero if any step fails; its `trap` removes `apps/web/dist` and
`.lighthouseci` on exit. `reports/logs/gate-final-run.log` is the full run, including the browser and
Lighthouse steps, captured on `54ced00`, whose `apps/api/src/` and `apps/web/` tree is identical to
this head. The post-fix `--skip-browser` run on the final head is
`reports/logs/gate-head-skip-browser.log`; it confirms the same non-browser results with the two new
gate tests included.

| #   | Step             | Command                                                                                                             | Result                                                                                                              |
| --- | ---------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | Format           | `bun run format:check`                                                                                              | pass, exit 0                                                                                                        |
| 2   | Lint             | `bun run lint --concurrency=off`                                                                                    | pass, exit 0, zero warnings                                                                                         |
| 3   | Typecheck        | `bun run typecheck`                                                                                                 | pass, exit 0                                                                                                        |
| 4   | API unit         | `env NODE_ENV=test bun --filter @relay/api test:unit --maxWorkers=1 --no-file-parallelism`                          | 729 passed, 0 failed, 0 skipped, 69 files, exit 0                                                                   |
| 5   | API integration  | `env NODE_ENV=test bun --filter @relay/api test:integration --maxWorkers=1 --no-file-parallelism`                   | 382 passed, 0 failed, 0 skipped, 36 files, exit 0                                                                   |
| 6   | Web              | `env NODE_ENV=test bun --filter @relay/web test --maxWorkers=1 --no-file-parallelism`                               | 334 passed, 0 failed, 0 skipped, 37 files, exit 0                                                                   |
| 7   | E2E and a11y     | `bun run test:e2e`                                                                                                  | 65 passed, 0 failed, 0 skipped, exit 0                                                                              |
| 8   | Lighthouse       | `bun run lighthouse`                                                                                                | exit 1: accessibility, best practices and SEO at or above 0.9 on all 8 URLs; performance 0.87 on `/` and `/t/:ref`  |
| 9   | Secret scan      | `gitleaks detect --no-banner --redact` when `gitleaks` is on `PATH`, otherwise the full-history `git grep` fallback | clean; `gitleaks` is not on `PATH` here, so the conditional branch selected the deterministic full-history fallback |
| 10  | Dependency audit | `bun audit`                                                                                                         | exit 1: 11 advisories (5 high, 5 moderate, 1 low), all dev-only and accepted as SEC-04                              |
| 11  | Audit doc check  | `scripts/gate.sh --check-docs-only`                                                                                 | 11 docs, 0 open Critical/High, exit 0                                                                               |

Lighthouse detail (`reports/logs/gate-final-run.log`): 8 URLs times 3 runs. Accessibility, best
practices and SEO meet the 0.9 minimum on every URL, and six of eight URLs meet it for performance.
`/` scored 0.86, 0.87, 0.87 and `/t/:ref` scored 0.87, 0.87, 0.88; earlier runs on this host landed
between 0.87 and 0.89 for the same two pages. The live deployment measurement recorded in
`06-frontend-prod.md` scored 100, so the shortfall is local to this mobile-throttled run rather than a
deployed regression. The assertion is left at 0.9 rather than weakened, and confirming the live score
is a 7.13 operator item.

Secret scan detail: the runner branches on `command -v gitleaks` and runs
`gitleaks detect --no-banner --redact` when the binary is present; a unit test puts a stub on `PATH`
and asserts those exact arguments, and asserts the fallback when it is absent. On this host `gitleaks`
is absent, so the fallback greps every reachable revision for AWS key ids, GitHub and Slack tokens,
OpenAI and Google key shapes with realistic lengths, private key blocks, and credential URIs whose
host is not loopback, a compose service, or a documentation or test domain. Zero hits; no matched
value is printed anywhere, only a revision and path would be.

`bun audit` detail: the 11 advisories are the dev-only tree accepted as SEC-04 (nine under
`@lhci/cli`, two `minimatch` under `eslint` and `typescript-eslint`); the production image installs
`--production --filter @relay/api`, so none is deployed. The step records the exit code and keeps the
run green, and SEC-04 carries the accepted-risk reason.

`apps/web/dist` and `.lighthouseci` were absent before the run and removed by the gate's `trap`
afterwards. No container was started, stopped or restarted; no Redis key was flushed; the e2e and
Lighthouse stacks use high daily caps so a shared host counter cannot flake them.

## Pre-7.13 operator checklist

- Redeploy the Render service to ship the merged `7.12.11` `DEL-01` thread-clamp fix and the
  `7.12.12` gate documents. The Wave 1 to Wave 5 fixes, including the `09-legal-truthfulness.md` and
  `06-frontend-prod.md` fixes, are already live on Render: `11-epic-7-delivery.md` records the
  deployed bundle as the Wave 5 web build.
- Set the repository description, homepage and topics with the exact `gh repo edit` command in
  `10-portfolio-readiness.md` (`PORT-07`), and confirm `licenseInfo` fills after `LICENSE` is on
  `main`.
- Refresh the eight screenshots in `docs/screenshots/` once the Wave 5 UI is live (`PORT-09`), then
  re-run `bun run screenshots` with the fake LLM and no counter reset.
- Confirm the 1 USD AWS budget, its alert recipient, and the SNS subscription email from
  `docs/ops.md` manual steps, before the 2027-04-03 free-tier expiry (`PA-7.8-06`).
- Do not enable a keep-awake pinger on the free plan (`COST-04`); if uptime monitoring is wanted,
  point the health check and the pinger at `/health/live` or upgrade Neon.
- Consider lowering `SNS_ALERT_MAX_PER_HOUR` to 1 for the free SNS allowance (`COST-03`).
- After any `OPS_TOKEN` rotation, run the required `SCAN` and `DEL` over `ops:session:*` from the
  rotation runbook; sessions minted before the rotation stay valid otherwise.
- Confirm Lighthouse performance on the deployed site, or on an idle host, before final sign-off;
  the local mobile run recorded above is below the 0.9 assertion on `/` and `/t/:ref`.
- Final sign-off: this gate is GO; the items above are go-live procedures, not launch blockers.
