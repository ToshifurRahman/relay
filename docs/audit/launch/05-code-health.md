# Launch audit: Code Health (7.12.5)

Audit date: 2026-11-23, against `audit/7.12.5-code-health` from `main` at `859a692`. It covers the
7.12.5 checks (dead code, unused exports, leftover `TODO(6.x/7.x)`, flaky tests run 5x, and
critical-path coverage) and the three minor P2 items carried from the Wave 1 security review
(`reports/review-pr19-2-ds.md`). Everything ran against the real codebase on the local stack; no
live production request was made, because every check here is a property of the source and the
test suites.

Severity uses the same scale as the pre-audit: Critical and High block go-live, and a Medium or Low
may ship only as an accepted risk with a reason. Finding IDs are `HLTH-NN`.

## Summary

| Severity | Found | Fixed | Accepted | Open |
| -------- | ----- | ----- | -------- | ---- |
| Critical | 0     | 0     | 0        | 0    |
| High     | 0     | 0     | 0        | 0    |
| Medium   | 8     | 8     | 0        | 0    |
| Low      | 2     | 1     | 1        | 0    |

No Critical or High finding is open. The eight Mediums are the three carried Wave 1 P2s
(HLTH-05, HLTH-06, HLTH-07), the three e2e timing flakes (HLTH-02, HLTH-03, HLTH-04), the
test-isolation flake the 5x run surfaced (HLTH-09) and the shared-Redis mail cap that broke the
a11y email tests locally and in review (HLTH-10), all fixed on this branch. The one fixed Low is the
dead code removed in check 1 (HLTH-01); the accepted Low is the unused `apps/web/src` surface
(HLTH-08) handed to the sibling frontend audit.

## Checks run

All commands ran from the worktree through `run-check.sh`, one at a time, with `apps/web/dist`
absent before and after.

| #   | Check                                                                          | Command / location                                                                                                                                                                                                                         | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Dead code, unused exports, orphan files                                        | A whole-tree scan of `apps/api/src`, `apps/api/scripts`, `e2e` and `scripts` (every `export` name matched against every other file, tests included), plus `tsc --noEmit -p apps/api` and `eslint` with `@typescript-eslint/no-unused-vars` | Two exports were referenced nowhere: `getTriageOutputByTicketId` (`apps/api/src/repositories/processing.ts`) and the `MigrateConfig` type (`apps/api/scripts/migrate.ts`). Both removed; the scan then reported `0 candidate unused exports of 374 exports in 189 files`. No orphan source file: every file under `apps/api/src` is reachable from `index.ts`, `main.ts`, `worker.ts` or `server.ts`, and the `apps/api/scripts` and `e2e` files are entry points. **HLTH-01 fixed.** Pass. |
| 2   | Leftover `TODO` / `FIXME` / `XXX` / `HACK` from earlier phases                 | `grep -rn 'TODO\|FIXME\|XXX\|HACK\|@deprecated'` over `apps/api/src`, `apps/api/scripts`, `apps/api/tests`, `e2e`, `scripts`                                                                                                               | No match. The only `XXXX` strings are Cloudflare's documented dummy Turnstile token (`XXXX.DUMMY.TOKEN.XXXX`) in the e2e helpers and scripts, which is a test value, not a marker. The one `TODO(7.6)` the pre-audit recorded in `lib/socket.ts` is already gone (`docs/audit/pre-audit.md:83`). Pass.                                                                                                                                                                                      |
| 3   | `noUnusedLocals` / `noUnusedParameters`                                        | `tsconfig.base.json`, `apps/api/tsconfig.json`, `eslint.config.js`                                                                                                                                                                         | Neither compiler flag is set, but `@typescript-eslint/no-unused-vars` runs as an error with `argsIgnorePattern: '^_'` across the whole tree, and `bun run lint --max-warnings 0` passes, so an unused local or parameter fails the gate. The flags are left off deliberately: the lint rule covers the same ground and also understands the `_`-prefixed intentional-unused convention. Pass.                                                                                               |
| 4   | Flaky tests: 5x sequential unit, integration and web                           | `run-check.sh env NODE_ENV=test bun --filter @relay/api test:unit --maxWorkers=1 --no-file-parallelism` (and the integration and web equivalents), five times each, logs `reports/logs/health-5x-{unit,int,web}.log`                       | See the stability table below. The first integration pass failed one test (`1 failed \| 368 passed`), which the audit traced to a test-isolation defect rather than a product bug: **HLTH-09**, fixed, and the five passes then ran clean. Every run passed with the same counts and `0` skipped. Pass.                                                                                                                                                                                     |
| 5   | Known e2e timing flakes under `0` retries                                      | `e2e/csp.spec.ts`, `e2e/a11y.spec.ts`, `e2e/ticket-thread.spec.ts`; `playwright.config.ts` (`LLM_FAKE_DELAY_MS: '400'`, no `retries`)                                                                                                      | Three real synchronization races found and fixed; see the e2e section. The three touched specs pass together (`39 passed`, `reports/logs/health-e2e-touched.log`). **HLTH-02, HLTH-03, HLTH-04 fixed.** Pass.                                                                                                                                                                                                                                                                               |
| 6   | Critical-path coverage: submit, worker stages, replay, ops auth, notifications | `@vitest/coverage-v8@5.0.3` over the `@relay/api` unit and integration suites (94 files, 893 tests, exit `0`); per-file table and branch audit below; summary table `reports/logs/health-coverage-summary.log`                             | Every critical-path module is exercised. The uncovered lines are process-boundary branches (the worker's poll loop and shutdown, covered by the entry-point and shutdown integration tests) and log-only `.catch` handlers; the one behavioral gap is the `mail_off` early return, whose effect matches the covered "mailer absent" path. Three worker branches the audit originally credited to other tests have since gained their own tests (see the branch audit). Pass.                |
| 7   | Carried Wave 1 P2: stale line pointer                                          | `docs/audit/launch/01-security.md:40`                                                                                                                                                                                                      | The pointer read `apps/api/src/app.ts:77-84`; `app.onError` is at `apps/api/src/app.ts:82-89` on `859a692` (the 500 body is line 88). Updated. **HLTH-05 fixed.** Pass.                                                                                                                                                                                                                                                                                                                     |
| 8   | Carried Wave 1 P2: API-root import not rejected                                | `apps/web/tests/guards/bundle-secrets.test.ts`                                                                                                                                                                                             | `reachesServerCode` skipped the API directory itself (`relative !== ''`), so `import … from '../../api'` was not rejected. The guard is dropped and a rejected case pins the root import. Failing-first: `reports/logs/red-health-bundle-root.log` (`1 failed \| 7 passed`); green: `reports/logs/green-health-bundle-root.log` (`8 passed`). **HLTH-06 fixed.** Pass.                                                                                                                      |
| 9   | Carried Wave 1 P2: regex-literal comment                                       | `apps/web/tests/guards/bundle-secrets.test.ts:73-77`                                                                                                                                                                                       | The comment named only `//` and `/*` as regex-literal hazards. It now names the quote too, with the `/don't/` example that leaves the scanner inside a string. **HLTH-07 fixed.** Pass.                                                                                                                                                                                                                                                                                                     |

## 5x stability

Five sequential runs of each suite, one command at a time through `run-check.sh`, `apps/web/dist`
absent. Every run exited `0` with the same counts and `0` skipped.

| Suite               | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 | Skipped |
| ------------------- | ----- | ----- | ----- | ----- | ----- | ------- |
| `@relay/api` unit   | 524   | 524   | 524   | 524   | 524   | 0       |
| `@relay/api` integ. | 369   | 369   | 369   | 369   | 369   | 0       |
| `@relay/web`        | 300   | 300   | 300   | 300   | 300   | 0       |

## e2e flake hardening

The three specs the Wave 1 review saw fail on different CI attempts, each a timing race rather than
a product defect. Each fix replaces a timing guess with a condition, and none weakens a guard. The
original failures are CI-only: they happened on three separate attempts of workflow run
`45026845233` (job `End-to-end`, PR #19), and the failing lines are captured in
`reports/logs/red-health-e2e-ci.log`.

- **`e2e/csp.spec.ts` (was line 98, `expect(socket.isClosed()).toBe(false)`).** The ticket was a
  normal one, so the worker completed it in about 800ms and the page disconnected its socket on
  `completed`; a slow browser read `isClosed()` after that and failed. The ticket now carries
  `[fake:invalid-triage]`, so it settles in `needs_attention`, a state that keeps the page
  listening (a replay can revive it). The test waits for the on-hold copy before checking the
  socket, so the liveness claim is a condition, not a race. **HLTH-02.**
- **`e2e/a11y.spec.ts` (was line 290, `/ops` keyboard focus).** The readiness wait was
  `page.locator('#main').waitFor()`, which the layout renders while the lazy page is still in
  Suspense; a page that mounted after the first `Tab` could move focus off the skip link. Each path
  now waits for its own ready marker (the landing `h1`, the `/new` Subject field, and on `/ops` the
  console tab list or the signed-out token field) before the first `Tab`. **HLTH-03.**
- **`e2e/ticket-thread.spec.ts` (was lines 55-66, the status element).** The test asserted the
  transient `role="status"` ("Reading your request..." / "Writing a reply...") was on screen, but
  the fake LLM answers in about 800ms, so a slow CI browser could load the page after the ticket
  already completed and the element was gone. The working state is pinned deterministically by the
  component and page tests (`apps/web/src/pages/ticket.test.tsx`); the e2e test's claim is the
  end-to-end outcome, so it now awaits the reply and counts document loads in the test process
  (`page.on('load')`, attached before the first navigation). The submit page is load 1 and the
  thread is a same-document route change, so a reply that arrives with the counter still at `1`
  came over the open page's socket; a real reload would make it `2` and fail. **HLTH-04.**

## Critical-path coverage

Measured with `@vitest/coverage-v8@5.0.3` (the version matching the pinned `vitest@5.0.3`) over the
`@relay/api` unit and integration suites together: 94 files, 893 tests, exit `0`. The provider is
**not** a declared dependency in `package.json`; it was placed in `node_modules` for this one
measurement and removed afterwards, so `package.json` and `bun.lock` are unchanged. The summary
table is in `reports/logs/health-coverage-summary.log`; it is a hand-assembled table of the
numbered figures, not captured tool stdout.

| Module                                        | Lines % | Functions % | Branches % | Lines   |
| --------------------------------------------- | ------- | ----------- | ---------- | ------- |
| `services/submission-guard.ts` (submit)       | 100.00  | 100.00      | 100.00     | 28/28   |
| `services/tickets.ts` (submit, replay)        | 86.95   | 40.00       | 100.00     | 20/23   |
| `worker.ts` (worker stages)                   | 77.02   | 60.00       | 69.90      | 171/222 |
| `repositories/processing.ts` (worker stages)  | 100.00  | 100.00      | 100.00     | 8/8     |
| `repositories/tickets.ts` (replay)            | 100.00  | 100.00      | 96.15      | 46/46   |
| `middleware/ops-auth.ts` (ops auth)           | 100.00  | 100.00      | 100.00     | 5/5     |
| `lib/ops-session.ts` (ops auth)               | 98.11   | 90.00       | 91.30      | 52/53   |
| `services/customer-notifications.ts` (notify) | 96.00   | 93.75       | 85.10      | 96/100  |
| `services/notification-emails.ts` (notify)    | 100.00  | 100.00      | 87.50      | 23/23   |
| `services/ops-alerts.ts` (notify)             | 100.00  | 100.00      | 100.00     | 36/36   |
| **Total**                                     | 89.15   | 86.20       | 81.97      | 485/544 |

Per-file branch audit of the uncovered lines, to decide whether any is a meaningful gap a test
should close:

- **`worker.ts` (77% lines, 60% functions).** Some uncovered lines are process-level paths that
  only a spawned process reaches, and those are covered by the entry-point and shutdown
  integration tests instead of in-process: the poll loop's abort and drain branches (`421`, `455`,
  `501`), the `startupConfig()` call and the `postgres` shutdown step (`507`, `531`), the
  `FinalizeError` throw (`395`), and the `setFailed`/`setNeedsAttention` early returns (`330`,
  `336`, `371`, `377`, `382`, `388`). The figure was measured before the three tests below
  existed, so it understates the current coverage.
  Three branches that an earlier draft of this audit wrongly credited to other tests now have
  their own deterministic tests, and each was proved to fail when its branch is broken
  (`reports/logs/health-worker-branches.log`):
  - the invalid-`ticketId` skip (`192`): `tests/integration/worker/worker.test.ts` passes
    `not-a-uuid` to `processMessage` and asserts the message is deleted and the LLM is never
    called. Disabling the guard turns it red.
  - the duplicate-message skip (`254`): the same file moves a ticket to `processing` first, then
    calls `processMessage` at attempt 1 and asserts the delete and the untouched status. Disabling
    the guard turns it red.
  - the `resolveWorkerConcurrency` fallback (`80`): `tests/integration/worker/concurrency.test.ts`
    calls `run({ concurrency: 0 })` and asserts the ticket still completes on the configured
    concurrency. Dropping the positivity check makes `run` hang, which the test reports as a
    timeout inside its own 15s bound.
- **`services/tickets.ts` (87% lines, 40% functions).** The three uncovered lines are the
  fire-and-forget `.catch` log handlers on `recordTicketEvent` and `enqueueTicket` (`22`, `25`) and
  the `ticket.requeue_failed` log handler (`65`). Each is a log-only branch reached when a
  background write fails after the response is sent; the failure path itself is covered by the
  replay tests, and the handler only logs. No behavior is untested.
- **`lib/ops-session.ts` (98% lines).** The uncovered lines are the Redis client's `error` and
  `connect` failure log handlers (`46`, `50`) and the `if (!expected) return false` guard in
  `checkOpsToken` (`92`), which is the "no OPS_TOKEN configured" case that the sign-in 503 test
  covers at the route level. Log-only and a route-covered guard.
- **`services/customer-notifications.ts` (96% lines).** The uncovered lines are the `!mailer` 503
  guard (`90`, covered at the route level by the opt-in 503 test), the `!isMailEnabled()` early
  return (`192`), the `mail_off` code (`225`), and three log-only `.catch` handlers (`209`, `253`,
  `262`). The mail-off path is the one behavioral gap; it is a single early return whose effect
  (no email sent) is the same as the covered "mailer absent" path.

No uncovered line is a meaningful untested error path that a new test would close without
duplicating a route-level or process-level test that already exists. The two lowest figures
(`worker.ts`, `services/tickets.ts`) are process-boundary and log-only branches, not logic, apart
from the three worker branches above, which now have tests of their own.

## Findings

| ID      | Severity | Location                                                                                                                              | Evidence                                                                                                                                                                                                                                                                                                                                                                                                   | Fix or accepted-risk reason                                                                                                                                                                                                                                                                                                                                                                                                          | Status   |
| ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| HLTH-01 | Low      | `apps/api/src/repositories/processing.ts:38`, `apps/api/scripts/migrate.ts:10`                                                        | A whole-tree export scan found `getTriageOutputByTicketId` and the `MigrateConfig` type referenced nowhere, tests included. `getTriageOutputByTicketId` duplicated the triage half of `getProcessingResultByTicketId`, which the worker uses.                                                                                                                                                              | Fixed: both removed. The scan then reported `0 candidate unused exports of 374 exports in 189 files`, and `tsc --noEmit -p apps/api` and `lint` pass.                                                                                                                                                                                                                                                                                | fixed    |
| HLTH-02 | Medium   | `e2e/csp.spec.ts:98`                                                                                                                  | `expect(socket.isClosed()).toBe(false)` raced the worker: a normal ticket completes in about 800ms and the page disconnects on `completed`, so a slow browser read the socket after it closed. Seen red on CI attempt 2 of run `45026845233` (`reports/logs/red-health-e2e-ci.log`).                                                                                                                       | Fixed: the ticket carries `[fake:invalid-triage]` and settles in `needs_attention`, which keeps the page listening; the test waits for the on-hold copy before checking the socket. Green in `reports/logs/health-e2e-touched.log`.                                                                                                                                                                                                  | fixed    |
| HLTH-03 | Medium   | `e2e/a11y.spec.ts:290`                                                                                                                | The `/ops` keyboard test waited only for `#main`, which the layout renders while the lazy page is still in Suspense; a page mounting after the first `Tab` could move focus off the skip link. Seen red on CI attempt 1 of run `45026845233` (`reports/logs/red-health-e2e-ci.log`).                                                                                                                       | Fixed: each path waits for its own ready marker before the first `Tab` (landing `h1`, `/new` Subject field, `/ops` tab list or token field). Green in `reports/logs/health-e2e-touched.log`.                                                                                                                                                                                                                                         | fixed    |
| HLTH-04 | Medium   | `e2e/ticket-thread.spec.ts:55-66`                                                                                                     | The test asserted the transient `role="status"` was on screen, but the fake LLM answers in about 800ms, so a slow browser could load the page after completion and the element was gone. Seen red on CI attempt 3 of run `45026845233` (`reports/logs/red-health-e2e-ci.log`).                                                                                                                             | Fixed: the working state stays pinned by the component and page tests; the e2e test awaits the reply and counts document loads in the test process (`page.on('load')` before the first navigation), so a reload makes the count `2` and fails. Green in `reports/logs/health-e2e-touched.log`.                                                                                                                                       | fixed    |
| HLTH-05 | Medium   | `docs/audit/launch/01-security.md:40`                                                                                                 | Check 12 cited `apps/api/src/app.ts:77-84` for the error/startup paths, but `app.onError` is at `82-89` on `859a692` (the 500 body is line 88). The claim was true; the pointer was stale. Carried from `reports/review-pr19-2-ds.md`.                                                                                                                                                                     | Fixed: the pointer now reads `apps/api/src/app.ts:82-89`, verified against the file.                                                                                                                                                                                                                                                                                                                                                 | fixed    |
| HLTH-06 | Medium   | `apps/web/tests/guards/bundle-secrets.test.ts:132`                                                                                    | `reachesServerCode` returned false for the API directory itself (`relative !== ''`), so `import … from '../../api'` was not rejected. Nothing resolves there today (no `apps/api/index.ts`, no `exports`/`main`), so it could not ship, but the guard had a hole. Carried from `reports/review-pr19-2-ds.md`.                                                                                              | Fixed: the `!== ''` guard is dropped and a rejected case pins the root import. Failing-first `reports/logs/red-health-bundle-root.log` (`1 failed \| 7 passed`); green `reports/logs/green-health-bundle-root.log` (`8 passed`).                                                                                                                                                                                                     | fixed    |
| HLTH-07 | Medium   | `apps/web/tests/guards/bundle-secrets.test.ts:73-77`                                                                                  | The comment named only `//` and `/*` as regex-literal hazards; a quote also breaks the scanner (`/don't/` leaves it inside a string, so a following commented-out import is reported). No such regex exists in `apps/web/src`, and the failure is a loud false positive. Carried from `reports/review-pr19-2-ds.md`.                                                                                       | Fixed: the comment now names the quote hazard with the `/don't/` example.                                                                                                                                                                                                                                                                                                                                                            | fixed    |
| HLTH-08 | Low      | `apps/web/src/components/ui/popover.tsx`, `features/tickets/components/status-pill.tsx:15`, `test/fake-socket.ts:44`, `lib/socket.ts` | A read-only scan of `apps/web/src` found `Popover`/`PopoverTrigger`/`PopoverContent` (no importer), `statusLabel` (unused), the `FakeSocket` type (only `createFakeSocket` is imported) and `resetSocketForTests` (unused). `apps/web/src` is owned by the sibling frontend audit.                                                                                                                         | Accepted risk, handed off: none of these ships in a bundle a visitor loads (an unused export is tree-shaken, and the popover module is never imported), so it is dead source, not dead weight. Recorded under `handoff:` for `7.12.6`.                                                                                                                                                                                               | accepted |
| HLTH-09 | Medium   | `apps/api/tests/api/ops/ai-interactions.test.ts:94`                                                                                   | The summary test asserted an absolute `count: 1` over the whole `ai_interactions` table for the default 24h window. Any row already in the window — a crashed suite, a manual probe, an e2e ticket — made it read `2` and fail. The 5x run surfaced it: run 1 failed `1 failed \| 368 passed` with `count: 2` after an earlier e2e run left one row. Red: `reports/logs/red-health-summary-isolation.log`. | Fixed: the test reads the totals before its own insert and asserts the delta is exactly one. It also no longer asserts a hardcoded `successRate: 1`: the ratio is checked against the response's own `successCount / count`, so a stray failure row shifts both sides together. Red with a seeded `http_error` row: `reports/logs/red-health-ai-rate.log`; green with the same row present: `reports/logs/green-health-ai-rate.log`. | fixed    |
| HLTH-10 | Medium   | `playwright.config.ts:webServer.env`                                                                                                  | The e2e stack shares the host Redis `notify:sent:<UTC day>` counter with every other local run, against a 250/day default. Once it crossed 250 the a11y email tests got a 502 from the confirmation path; the review hit it at 572 and all four passed with `MAIL_DAILY_CAP=100000`.                                                                                                                       | Fixed: `MAIL_DAILY_CAP: '100000'` now sits next to `TICKET_DAILY_CAP` in the webServer env, so a local stack cannot inherit a production-shaped daily budget. Verified by the touched e2e run with no `MAIL_DAILY_CAP` in the outer shell.                                                                                                                                                                                           | fixed    |

## Handoff to 7.12.6 (frontend production)

`apps/web/src` is out of scope for this branch. The read-only scan found this dead surface, for the
sibling audit to remove or justify:

- `apps/web/src/components/ui/popover.tsx` — `Popover`, `PopoverTrigger`, `PopoverContent` have no
  importer anywhere in `apps/web/src`.
- `apps/web/src/features/tickets/components/status-pill.tsx:15` — `statusLabel` is exported and
  unused (`StatusPill` uses the `PILLS` table directly).
- `apps/web/src/test/fake-socket.ts:44` — the `FakeSocket` type is exported and unused; the tests
  import `createFakeSocket` and derive the type with `ReturnType`.
- `apps/web/src/lib/socket.ts` — `resetSocketForTests` is exported and unused.
