# Launch Audit — 7.12.2 Data & Privacy

Audited 2026-11-22 on branch `audit/7.12.2-data-privacy` from `origin/main` (`bc56483`), against
the codebase and the live deployment `https://ticket-pipeline.onrender.com` (read-only, low volume).
Scope from story 7.12.2: PII (email, ticket text) absent from Pino logs, `ticket_events.detail`
public views, `ai_interactions` and SNS alerts; masked email everywhere; retention/purge runs on
production; data in Neon matches what `/privacy` says. Parked 7.12.2 items from
`docs/audit/pre-audit.md:580-590` are included.

## Method

Every check below was run against this worktree with the local compose stack (Postgres `5433`,
LocalStack `4566`, Redis `6379`, Mailpit `1025`) and, where scoped, against the live deployment
with read-only probes only. No ticket was submitted, no sign-in attempted and no mutation was sent
to production. Exact commands are shown per check.

## Checks

### 1. Pino logs carry no email or ticket text (parked: "whether ticket text reaches logs")

Command: `grep -rE 'logger\.(trace|debug|info|warn|error|fatal)\(' apps/api/src` → 88 call sites
in 19 files. Every entry/exit boundary was
traced: HTTP request logger (`middleware/request-logger.ts`), global `app.onError`
(`app.ts:82`), worker error paths (`worker.ts`, 23 sites), deferred/teardown callbacks
(`services/tickets.ts:21-25`, `services/ops-alerts.ts:100-107`, `services/customer-notifications.ts:200,235,244`),
Socket.IO handlers (`lib/socket.ts`, 8 sites), Redis/queue clients (`lib/counters.ts`,
`lib/queue.ts`, `lib/socket.ts`), shutdown (`lifecycle.ts`, 6 sites) and startup (`index.ts`,
`main.ts`, `worker.ts`).

Findings: no logger call passes an email address; `tests/guards/notifications.test.ts:26` already
enforces that statically. The request line logged the raw URL, which put the confirmation token and
ticket reference in the log (PRIV-02, fixed). The AI error path logged provider/AI text (PRIV-01,
fixed). A new static guard (`tests/guards/privacy-logs.test.ts`) fails on the two shapes that
smuggled text in: a message built by interpolation and a logger object that spreads a record
(rechecked with the app shell mounted, the way the image runs — see PRIV-02). `app.ts` exposes
`createApp({ webDistDir })` so the registration order the image ships can be tested with a
temporary build; the exported `app` is unchanged for every other caller.

### 2. `ticket_events.detail` never reaches a public view

Read entry points: `services/ticket-views.ts` (`toPublicTicketView`, `toPublicEvent`,
`isPublicEvent`, `toPublicPhases`), `controllers/tickets.ts` (`getById`, `getByRef`, `listEvents`)
and `controllers/ops.ts` (`listTicketEventsHandler`).

The public view is built field by field from the full view (`toPublicTicketView`,
`ticket-views.ts:146-158`), so a field added later stays private until it is added on purpose.
`toPublicEvent` (`ticket-views.ts:126-128`) returns `{ event, occurredAt }` only; `detail` is
dropped. `isPublicEvent` (`ticket-views.ts:124`) also hides `notification.*` bookkeeping. Only
`/api/ops/tickets/:id/events` maps events with `detail` (`controllers/ops.ts`, guarded by
`requireOpsSession` in `routes/ops.ts:14`).

Evidence: `apps/api/tests/api/tickets/redaction.test.ts` (public view key allowlist, no
`detail`/`internalNote`/`issueSummary`/`recommendedTeam`, no failure reason) and
`apps/api/tests/api/tickets/history.test.ts` pass. Socket.IO public emission is event names only
(`services/ticket-updates.ts`), and the ops room is restricted to ids/codes/timestamps
(`services/ops-feed.ts` header contract, enforced by
`apps/api/tests/integration/worker/worker.test.ts:220-333`).

### 3. `ai_interactions` and SNS alerts carry no PII or raw ticket text

`repositories/ai-interactions.ts` stores `ticket_id, operation, provider, model, outcome,
http_status, duration_ms, error_message, prompt_tokens, completion_tokens` (`migrations/006`). No
prompt, no ticket subject/description and no AI output column exists.

`GET /api/ops/ai-interactions` returns those columns to an ops session only
(`routes/ops.ts:14`, `routes/ops.ts:16-17`). `error_message` was the one text column, and before the
fix it held the provider's raw error body (PRIV-01). After the fix it holds a fixed code
(`llm-client.ts:183-252`, `ai-service.ts:62-96`).

SNS: `services/ops-alerts.ts:22` builds the alert field by field from `OpsNeedsAttention` —
reference number, ticket id, closed-set reason, time. `buildAlertMessage` ignores any extra field a
caller passes (`tests/unit/services/ops-alerts.test.ts:58`). Only this module may import
`PublishCommand` (`tests/guards/ops-alerts.test.ts`).

### 4. Masked email on every surface

`domain/mask-email.ts` → `t•••@gmail.com`. Call sites: `services/ticket-views.ts:118` (ops ticket
view), `services/customer-notifications.ts:72,133,146,164` (status, opt-in, preview, confirm).
The web app renders only `maskedEmail` (`apps/web/src/pages/confirm.tsx`, `features/tickets/components/notify-card.tsx`).
`repositories/notifications.ts` hands the raw address only to the mailer through an atomic claim
(`claimCompleted`/`claimSnag`). Error messages never echo the address: `recordNotificationError`
stores a fixed code, and `mailer.ts:64-65` keeps only the Brevo status. Guard tests:
`tests/guards/notifications.test.ts:26`, `tests/api/notifications/opt-in.test.ts`,
`apps/web/src/pages/confirm.test.tsx`, `notify-card.test.tsx`.

### 5. Retention and purge run in production (parked: "whether `purge.ts` and the retention service run")

Production starts one process: `render.yaml:18` → `apps/api/scripts/start.sh` → `exec bun src/main.ts`.
`main.ts:34` calls `startRetentionSweep()`, which runs `purgeExpiredTickets()` immediately and then
hourly (`services/ticket-retention.ts:36-41`); the timer is `unref`'d and stopped as a shutdown step
(`main.ts:79`). `render.yaml` declares exactly one `type: web` service, so the single process owns
the sweep.

`purgeExpiredTickets` hard-deletes every ticket older than `RETENTION_DAYS = 30`
(`services/ticket-retention.ts:5`) and, per batch inside one transaction, `ticket_notifications`,
`ticket_events`, `ai_interactions`, `ticket_processing` and `tickets`
(`repositories/ticket-retention.ts:9-28`). It opts into the append-only bypass per transaction
only, and `tests/guards/ticket-events.test.ts` keeps every other path out of `ticket_events`.

Failures are safe: `sweep()` catches and logs, so a bad night never crashes the process, and the
next hourly run retries. Evidence: `tests/integration/repositories/ticket-retention.test.ts`
(deletes aged ticket with events/AI rows/email opt-in, keeps fresh ones, append-only protection
returns) and the new `tests/guards/privacy-retention.test.ts` (copy ↔ constant ↔ delete list ↔
entry point; it has no red→green history — the code was already correct when it was added, so it
is a guard, not a defect fix, and its bite is shown by mutation: raising `RETENTION_DAYS` to 45
turns it red, `red-privacy-retention-mutation.log`). Live: `/health/ready` → 200, so the process
that owns the sweep is the one serving.

### 6. Brevo sender identity (PA-7.3-05) and `/privacy` truthfulness

`mailer.ts:39-68` sends through `https://api.brevo.com/v3/smtp/email` with `sender` from
`MAIL_FROM`/`MAIL_FROM_NAME`; `assertMailConfigured` requires `MAIL_DRIVER=brevo` and a sender in
production (`lib/config.ts` RULES). With no custom domain the sender is one Brevo-verified Gmail
address, which fails DMARC alignment; `docs/customer-email.md:30-32` states this plainly.

`/privacy` claims checked against the code (`apps/web/src/content/legal.ts`):

| Claim                                                                                | Backed by                                                                                               |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| subject + description only, plus progress and the AI answer                          | `tickets`, `ticket_processing`, `ticket_events`                                                         |
| email used for confirm, reply-ready, one snag; never logs/events                     | `services/customer-notifications.ts`, `services/notification-emails.ts`                                 |
| processors: Groq + Google via Portkey, Cloudflare, Render, Neon, Upstash, AWS, Brevo | `llm-client.ts`, `turnstile.ts`, `render.yaml`, `lib/db.ts`, `lib/socket.ts`, `lib/sns.ts`, `mailer.ts` |
| deleted 30 days after send, email deleted with the ticket                            | `RETENTION_DAYS = 30`, purge delete list                                                                |
| no advertising/tracking cookies; last few references in the browser                  | no third-party cookies in `apps/web/src`; `features/tickets/lib/recent-tickets.ts` uses `localStorage`  |
| Brevo sees address + subject + reference, never description or reply                 | `notification-emails.ts` (`EmailContext`)                                                               |

Live evidence (read-only): `curl -sS https://ticket-pipeline.onrender.com/privacy` → 200 (SPA
shell, 2092 bytes); the client-rendered copy in the live bundle
(`/assets/index-2fPXOEZL.js`, 359524 bytes) contains every processor name, "30 days", "deleted with
the ticket", "No advertising or tracking cookies" and "October 2026", matching the source.

## Findings

| ID      | Severity | Location                                                                          | Evidence                                                                                                                                                                                                                                                                                                                                                               | Fix or accepted-risk reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Status   |
| ------- | -------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| PRIV-01 | High     | `apps/api/src/lib/llm-client.ts:183-252`; `apps/api/src/lib/ai-service.ts:62-96`  | A provider error body and the model's own arguments were formatted into `LlmCallError.message`, which is logged (`logger.warn(..., 'AI call failed')` and two interpolated fallback messages), stored in `ai_interactions.error_message` and written to `ticket_events.detail` (ops view). A model echoing the prompt therefore put ticket text in the log and the DB. | `LlmCallError` now carries fixed codes only (outcome, HTTP status, field names, transport code); the response body is read and dropped; non-`LlmCallError` errors record/`log` only their name. Red→green: `tests/unit/lib/llm-client.privacy.test.ts`, `tests/unit/lib/ai-service.privacy.test.ts`, `tests/guards/privacy-logs.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | fixed    |
| PRIV-02 | Medium   | `apps/api/src/middleware/request-logger.ts:24-36`                                 | Every request logged `c.req.path`: `/api/notifications/confirm/<token>` put a bearer credential in the log, and `/api/tickets/ref/<ref>` / `/api/tickets/<id>` put the reference or id there (the reference alone opens a ticket).                                                                                                                                     | The line now records the last non-wildcard matched route pattern (`/api/notifications/confirm/:token`, `/api/tickets/ref/:referenceNumber`, ...) or `unmatched`; the concrete token, reference and id never reach the log. The wildcard skip is required because the image mounts `app.use('*', staticFiles)` after every route. Red→green against the deployed order with a temp `web/dist`: `tests/unit/middleware/request-logger.privacy.test.ts` (`red-privacy-dist-route.log`, from the pre-fix draft of the test — 3 path failures where the line logged `unmatched` instead of the route, plus a status failure that asserted a 404 on a route returning 500), plus updated `tests/unit/middleware/request-logger.test.ts`. Re-verified end to end against the real `app.ts` with dist present (`verify-privacy-dist-route.log`): ref → `/api/tickets/ref/:referenceNumber`, token → `/api/notifications/confirm/:token`, id → `/api/tickets/:id`, unknown API path and `/t/<ref>` → `unmatched`. | fixed    |
| PRIV-03 | Low      | `apps/web/src/content/legal.ts:19`; `apps/api/src/services/ticket-retention.ts:5` | The 30-day promise, the purge constant and the purge's delete list are three separate literals with nothing keeping them in step; one edit to any of them makes `/privacy` untrue silently.                                                                                                                                                                            | **Accepted/guard** — no defect existed, so there is no red→green. New guard `tests/guards/privacy-retention.test.ts` pins copy ↔ constant ↔ delete list ↔ production entry point and was never red against `origin/main`. Its bite is shown by mutation (`RETENTION_DAYS` → 45 fails the first case, `red-privacy-retention-mutation.log`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | guard    |
| PRIV-04 | Low      | `apps/api/src/services/ops-feed.ts:65`                                            | The ops-feed failure log built its message by interpolating `name`; harmless today (a fixed event name) but the exact shape that leaked text elsewhere.                                                                                                                                                                                                                | Structured `{ event: name }` field instead; `tests/guards/privacy-logs.test.ts` now rejects the interpolation shape across `apps/api/src` (and a spread anywhere in the logger object argument).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | fixed    |
| PRIV-05 | Low      | `apps/api/src/services/customer-notifications.ts:146`                             | `GET /api/tickets/:id/notification` and the confirm preview return `maskedEmail` to anyone holding the ticket reference or confirmation token.                                                                                                                                                                                                                         | Accepted: the reference is the documented access model ("Anyone with a ticket's reference can open it, so keep the reference to yourself", `legal.ts:39`), the mask hides all but the first character and the domain, and the token is single-use. Raising it would need per-ticket auth, which is out of scope for a reference-keyed demo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | accepted |
| PRIV-06 | Low      | `apps/api/src/repositories/ai-interactions.ts:40`; `repositories/events.ts:15`    | `ai_interactions.error_message` and `ticket_events.detail` store the provider/DB error text (after PRIV-01, fixed codes only for LLM calls). DB driver text could still name a column or value.                                                                                                                                                                        | Accepted: both are read only through `/api/ops/*` behind `requireOpsSession`, `detail` never leaves the ops route, and both rows are deleted with the ticket by the 30-day purge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | accepted |
| PRIV-07 | Low      | `apps/api/src/services/ticket-retention.ts:36-41`                                 | The sweep runs hourly in-process; Render's free plan sleeps the service when idle, so a ticket can outlive the 30-day window by the length of the sleep.                                                                                                                                                                                                               | Accepted: the next wake (any request or `/health/live` ping) runs the sweep immediately, so it is delayed, never skipped; the demo states "We may also wipe the demo sooner" and the free plan has no cron.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | accepted |

No Critical findings. No High findings remain open.

## Gates

See the subtask report for the exact pass/skip counts and exit codes of every
`run-check.sh` gate on the reported commit.
