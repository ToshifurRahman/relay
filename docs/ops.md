# Ops

Staff-only features: live feed, sign-in, email alerts and ticket recovery.

## Ops Live Feed

Ops staff can watch every ticket event across the organization over Socket.io. The feed carries
status information only. It never includes the subject, description, AI output or an event's error text.

```js
const socket = io('http://localhost:3000');
socket.on('ops:ticket_event', (e) => console.log(e));
await socket.emitWithAck('ops:subscribe'); // resolves to { ok: true } once subscribed
```

Each `ops:ticket_event` payload is `{ ticketId, referenceNumber, event, occurredAt }`, where `event`
is one of `ticket.submitted`, `triage.started`, `triage.completed`, `triage.failed`, `triage.invalid`,
`draft.started`, `draft.completed`, `draft.failed`, `draft.invalid`, `ticket.completed`, `ticket.failed`, `ticket.needs_attention`,
`ticket.requeued` or `ticket.requeue_failed`.

When a ticket runs out of retries, ops also receives `ticket:needs_attention` with
`{ ticketId, referenceNumber, reason, occurredAt }`. `reason` is one of `triage_retries_exhausted`,
`draft_retries_exhausted`, `incomplete_output` or `processing_result_missing`. It is a fixed code, never the
error message, because error messages can quote AI output or customer content. The full text stays in the
ticket's event history (`GET /api/ops/tickets/:id`).

When ops replays a ticket, the room also receives `ticket:requeued` with
`{ ticketId, referenceNumber, previousStatus, occurredAt }`, where `previousStatus` is `failed` or `needs_attention`.

**Privacy boundary.** The ops room is visible to every ops subscriber, so only
`apps/api/src/services/ops-feed.ts` may publish to it, and only identifiers, codes and timestamps. The ticket's own
room, which only that customer joins, gets `ticket:update` with `{ event, ticketId, occurredAt }` and no AI
output either: the page reads the reply from the public lookup.
`apps/api/tests/guards/ops-feed.test.ts` fails if any other file publishes to the ops room.

Every event goes through `recordTicketEvent()` (`apps/api/src/services/ticket-events.ts`), which writes the
`ticket_events` row and publishes to the feed, so the two cannot drift apart. Publishing is best-effort
and never affects ticket processing. Customers join only their own ticket room (`join` accepts a
ticket UUID and nothing else), so they cannot subscribe to the feed.

## Ops sign-in

Everything staff-only sits behind a session: the ticket list (`GET /api/tickets`), replay, all of
`/api/ops/*` and the `ops:subscribe` socket room. Customers need nothing: submitting a ticket, reading it by id or
reference, and its live updates stay public.

| Endpoint                                   | Behaviour                                                                                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/ops/session` `{ "token": "…" }` | `200` and a session cookie when the token matches `OPS_TOKEN`. `401` for a wrong one, `429` after 5 wrong tries from one address in 15 minutes, `503` when `OPS_TOKEN` is not set. |
| `GET /api/ops/session`                     | `{ "signedIn": true, "expiresAt": "…" }` or `{ "signedIn": false }`. Never `401`.                                                                                                  |
| `DELETE /api/ops/session`                  | `204`. Ends the session on the server and disconnects its live ops sockets (`ops:revoked`).                                                                                        |

The cookie is `HttpOnly; Secure; SameSite=Strict` and holds a random 256-bit id. The server keeps only its SHA-256
in Redis (`ops:session:<hash>`) with a fixed 12 hour life, so signing out really ends the session, and a copied
cookie is useless afterwards. `SameSite=Strict` on one origin is the CSRF protection; the token never reaches
browser storage. `ops:subscribe` reads the same cookie from the socket handshake and acks
`{ ok: false, error: 'unauthorized' }` without one; a subscribed socket is removed from the room when its session
is signed out or expires.

`OPS_TOKEN` is required in production and must be at least 32 characters (`openssl rand -base64 32`). The
brute-force counter uses `CF-Connecting-IP`, the address Cloudflare sets at its edge, and falls back to the last
`X-Forwarded-For` hop when that header is absent.

## Ops Email Alerts

The live feed only helps while someone has it open. When a ticket enters `needs_attention`, the worker also
publishes one alert to an AWS SNS topic, and SNS emails it to the ops address subscribed to that topic.

```
Subject: [Ticket Pipe] TICK-1791462896000-9F2A1C07 needs attention (incomplete_output)

Ticket TICK-1791462896000-9F2A1C07 needs attention.

Reference: TICK-1791462896000-9F2A1C07
Ticket ID: 3f6c…
Reason:    incomplete_output
Time:      2026-10-08T12:34:56.000Z

Replay it from the ops console (or POST /api/tickets/3f6c…/replay with an ops session) once the cause is fixed.
```

**What SNS is used for, and what it isn't.** SNS fans a message out to servers and people (email, SMS,
queues), which makes it the right tool for "tell ops by email". It can't push to a browser, so live updates
stay on Redis + Socket.io. It can't email customers either: only confirmed subscribers receive SNS email.
If several independent consumers ever need every ticket event, the same topic can fan out to one SQS queue
per consumer. That is the scaling direction, not something built here.

**Same privacy boundary as the ops feed.** The alert is built field by field from `OpsNeedsAttention`, so it
holds the reference number, ticket id, reason code and time, and never the subject, description, AI output or
error text. Only `apps/api/src/services/ops-alerts.ts` may publish to SNS (`apps/api/tests/guards/ops-alerts.test.ts`).

**Behaviour**

- One alert per ticket that actually moves into `needs_attention`. A redelivered message that finds the
  ticket already moved sends nothing.
- Best-effort: the worker doesn't wait for SNS. A failed or slow call (5s timeout, one retry) is logged and
  never fails or delays processing.
- Capped at `SNS_ALERT_MAX_PER_HOUR` (default 20) so a bad AI provider day can't flood the inbox or use up
  SNS's free 1,000 emails a month. Past the cap, alerts are dropped and one warning is logged per hour. The
  ticket and the live feed still have the event. The count is kept in memory, so the cap is per worker process
  and restarts with it.

**Configuration**

| Variable                 | Purpose                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `SNS_TOPIC_ARN`          | Turns alerts on. Unset (local dev, CI, or after the AWS free plan ends) means no alerts; everything else works unchanged. |
| `SNS_ENDPOINT`           | LocalStack URL for local runs. Leave unset in production to use AWS.                                                      |
| `SNS_ALERT_MAX_PER_HOUR` | Hourly cap, default 20.                                                                                                   |

To try it locally, `bun --filter @relay/api setup` creates the `ticket-needs-attention` topic in LocalStack and prints its ARN.
Set `SNS_TOPIC_ARN` to it. LocalStack doesn't send email, so subscribe a queue to the topic to see the alerts
(as `apps/api/tests/integration/services/ops-alerts-localstack.test.ts` does). In production the topic, the email subscription (the recipient
must click the confirmation link) and `sns:Publish` on that topic for the app's IAM user are set up by hand.

## Ticket Recovery

Ops can send a ticket that ended `failed` or `needs_attention` back through processing. The customer does
nothing: their open ticket page gets a `ticket:update` with `ticket.requeued` and then follows the new
attempt live.

Replay is staff-only: sign in first (see [Ops sign-in](#ops-sign-in)).

```bash
curl -c jar -H 'content-type: application/json' -d '{"token":"<OPS_TOKEN>"}' http://localhost:3000/api/ops/session
curl -b jar -X POST http://localhost:3000/api/tickets/<ticket-id>/replay
# 200 { "success": true, "status": "queued", "previousStatus": "failed" }
```

The ticket goes back to `queued`, its `failure_reason` and `failed_at` are cleared, and `ticket.requeued` is
recorded. Each replay is a new attempt with a fresh set of retries per stage.

A replay continues from where the ticket stopped. A stage that already completed successfully never runs
again: its saved output is reused.

- **Draft failed or its output was unusable** → only the draft runs again, using the saved triage.
- **Triage failed or its output was unusable** → triage runs again, and so does the draft, because it is
  written from the triage.
- **Finalizing failed** (both stages done) → no stage runs again; the ticket is only finalized.

Each stage's output is checked as soon as the stage runs. Unusable output is recorded as `triage.invalid` or
`draft.invalid`, and the ticket goes to `needs_attention` (`incomplete_output`). An invalid triage stops the
ticket before the draft is written. The marker tells a replay which stage to start from. Older
`needs_attention` tickets without a marker re-run any stage whose saved output is missing or unusable.

A drafted reply also passes the customer-reply output guard before it is saved. When the guard blocks it,
the ticket goes to `needs_attention` with the reason `unsafe_output` and records `draft.invalid` with the
detail `Unsafe customer reply blocked: <rule>`, where `<rule>` is a fixed code: `empty`, `too_long`,
`control_chars`, `prompt_leak`, `internal_fields`, `unauthorized_promise`, `secret`, `stack_trace` or
`markup`. Nothing is stored or sent: the blocked reply is not written to the ticket, so no customer sees
it and no unsafe text enters the database. Treat it like any other `draft.invalid`: read the reason on the
ticket, then replay it with `POST /api/tickets/:id/replay`. The replay re-runs only the draft (the triage
output is reused), so a fixed or model-different retry gets a fresh chance. If the same ticket keeps
returning `unsafe_output`, leave it in `needs_attention` and handle the customer by hand rather than
replaying it repeatedly, since the guard is doing its job.

The worker skips a stage based on its **saved output**, not the event history. If a worker crashes after
saving a stage's output but before recording `*.completed`, the next attempt reuses that output and
records `*.completed` with the detail `reused stored output`. If the history says a stage completed but
its output is missing, the stage runs again.

| Response | When                                                                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200`    | The ticket was requeued.                                                                                                                                 |
| `404`    | No ticket with that id.                                                                                                                                  |
| `409`    | The ticket is not `failed` or `needs_attention` (its current `status` is in the body). Two replays at the same moment: one wins, the other gets `409`.   |
| `503`    | The message could not be sent to the queue. The ticket is put back exactly as it was, `ticket.requeue_failed` is recorded, and it can be replayed again. |

There is no limit on how many times a ticket can be replayed; every replay is in its history.

## Neon restore (free tier)

Story 7.12.3 parked item. Neon keeps a **6-hour** change-history window on the Free plan; paid plans
extend it (up to 7 days on Launch, 30 days on Scale). Within that window you can roll a branch back to
any point in time (instant restore) or create a restore branch from a past state. Beyond 6 hours there
is no recovery point: a bad migration or a mistaken delete older than that cannot be undone from Neon
alone. This is the practical recovery boundary for the free tier.

The dry run below is read-only until the last step; run it against a throwaway branch, never the
production branch, and never as part of a live incident without a second person watching.

1. List the project's branches and their current state:
   `neonctl branches list --project-id <project-id>`
2. Find the point to restore to (the 6-hour window is the hard limit):
   `neonctl branches list --project-id <project-id> --output json` shows each branch's `created_at`
   and `updated_at`; the console's **Restore** view shows the exact timeline.
3. Create a restore branch from that point (does not touch the live branch):
   `neonctl branches create --project-id <project-id> --name restore-<date> --parent <branch> --parent-timestamp <ISO-8601>`
4. Verify the restored copy before anything else. Point `DATABASE_URL` at the restore branch, use
   the **direct** endpoint (`DATABASE_DIRECT_URL`, `PA-7.8-05`), never the pooled one, and run:

   ```sh
   # Schema: the migration ledger must match what the code expects.
   psql "$DATABASE_URL" -c "SELECT filename FROM schema_migrations ORDER BY filename"
   # Data: a row count per table is the fastest "does this look like the moment I want" check.
   psql "$DATABASE_URL" -c "SELECT 'tickets' t, count(*) FROM tickets
     UNION ALL SELECT 'ticket_events', count(*) FROM ticket_events
     UNION ALL SELECT 'ticket_processing', count(*) FROM ticket_processing
     UNION ALL SELECT 'ai_interactions', count(*) FROM ai_interactions
     UNION ALL SELECT 'ticket_notifications', count(*) FROM ticket_notifications ORDER BY t"
   # Integrity: the append-only trigger and the unique ticket_processing index must be present.
   psql "$DATABASE_URL" -c "SELECT tgname FROM pg_trigger WHERE tgname = 'ticket_events_no_update_delete'"
   psql "$DATABASE_URL" -c "SELECT indexname FROM pg_indexes WHERE indexname = 'ticket_processing_ticket_id_unique'"
   ```

   A restore branch is a full copy, so the trigger and index come with it. If the two queries
   return nothing, the copy is incomplete: stop and do not roll the live branch back to it.

5. Only after that, and with the incident owner's approval, roll the live branch back:
   `neonctl branches restore <branch> --source-branch-id <branch-id> --timestamp <ISO-8601>`.

The app's own retention sweep hard-deletes tickets older than 30 days (`services/ticket-retention.ts`),
so a restore older than the retention window brings back rows the sweep will delete again on its next
hourly run. Restore is for recent mistakes, not for long-term history.

**Direct vs pooled URL (`PA-7.8-05`).** Neon gives two hosts for one database: a direct endpoint and a
pooled one (PgBouncer). Migrations and `pg_dump`/`pg_restore` need the direct endpoint, because the
pooler does not keep the session-level state DDL and dump tooling rely on. The app itself may use the
pooled endpoint. In this repository `apps/api/scripts/migrate.ts` reads `DATABASE_DIRECT_URL` first and
falls back to `DATABASE_URL`, so a restore verification runs with `DATABASE_URL` set to the direct host.

**Client and server versions.** Take the dump with a client whose major version matches the server
(`pg_dump` 18 against a PostgreSQL 16 server writes `SET transaction_timeout = 0`, which 16 rejects and
`pg_restore --exit-on-error` then aborts with no tables created). Check with `psql "$URL" -c 'show
server_version'` and use `/usr/lib/postgresql/<major>/bin/pg_dump`. The full sequence was proved on the
local stack: see `docs/audit/launch/07-ops-runbook.md`.

## Rotating a secret

Every secret arrives through one place: `apps/api/src/lib/config.ts` is the only module that reads
`process.env` (`tests/guards/env-access.test.ts` fails if another file does). That makes the set of
secrets closed and each rotation a variable change in the Render dashboard plus a redeploy, with no
code path that reads a key from anywhere else. Render restarts the service on a variable change, and
`apps/api/scripts/start.sh` re-runs the migration before the server starts, so a rotation is one
restart, not a deploy.

**Order.** Rotate outwards from the provider that receives the secret, so the new value exists before
the app is told about it:

1. Create the new value at the provider (keep the old one valid while you switch).
2. Set the new value in the Render dashboard for the service.
3. Wait for the redeploy to finish (`/health/live` returns `200`).
4. Verify the app works with the new value (the per-secret check below).
5. Revoke the old value at the provider.

Do not edit `.env.example`; it holds placeholders only.

### The complete list

Every variable the config schema reads, with the rotation and the check that proves it. The ones not
marked **secret** are ordinary settings that a rotation may still change; they need no revocation
step.

| Variable                                                              | Provider / where it lives             | Verification after rotation                                                                                                                                             | Rollback                                                                  |
| --------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `DATABASE_URL`                                                        | Neon (pooled)                         | `GET /health/ready` returns `200`; submit nothing                                                                                                                       | put the old string back and redeploy                                      |
| `DATABASE_DIRECT_URL` **secret**                                      | Neon (direct)                         | next deploy's `start.sh` logs `nothing to migrate` and the server starts                                                                                                | put the old string back                                                   |
| `REDIS_URL` **secret**                                                | Redis Cloud                           | sign in at `/ops` returns `200`; `GET /api/ops/session` returns `200`                                                                                                   | put the old string back and redeploy                                      |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` **secret**              | AWS IAM (runtime user)                | `bun --filter @relay/api smoke:infra` prints `sqs-round-trip ok`; one ticket processes end to end                                                                       | put the old pair back; the old key stays valid until you delete it in IAM |
| `SQS_ENDPOINT`                                                        | unset in production                   | with the value changed, submit one ticket and watch it reach `completed` (the worker polls the new endpoint); `bun --filter @relay/api smoke:infra` passes              | put the old value back and redeploy                                       |
| `PORTKEY_API_KEY` **secret**                                          | Portkey                               | submit one ticket; `GET /api/ops/ai-interactions` shows a `success` row                                                                                                 | put the old key back                                                      |
| `GOOGLE_API_KEY` **secret**                                           | Google (Gemini, via Portkey)          | same as Portkey, with `PRIMARY_GATEWAY=google`                                                                                                                          | put the old key back                                                      |
| `GROQ_API_KEY` / `BACKUP_API_KEY` **secret**                          | Groq                                  | same, with `PRIMARY_GATEWAY=groq` or `BACKUP_GATEWAY` set                                                                                                               | put the old key back                                                      |
| `OPS_TOKEN` **secret**                                                | generated here                        | see the dedicated dry run below                                                                                                                                         | restart with the old token                                                |
| `SNS_TOPIC_ARN`                                                       | AWS SNS                               | `bun --filter @relay/api smoke:infra` and one `needs_attention` ticket sends one email                                                                                  | put the old ARN back                                                      |
| `BREVO_API_KEY` **secret**                                            | Brevo                                 | opt in one ticket by email and confirm the confirmation email arrives                                                                                                   | put the old key back                                                      |
| `SMTP_URL`                                                            | Mailpit (local) / unset in production | with `MAIL_DRIVER=smtp`, the Mailpit inbox shows the mail                                                                                                               | put the old URL back                                                      |
| `TURNSTILE_SECRET_KEY` **secret**                                     | Cloudflare Turnstile                  | submit one ticket through the real form; it is accepted, not 403                                                                                                        | put the old secret back                                                   |
| `PUBLIC_SITE_URL`                                                     | this site                             | an email link opens the deployed origin, and the ops socket handshake is accepted                                                                                       | put the old value back                                                    |
| `VITE_TURNSTILE_SITE_KEY`, `VITE_CF_ANALYTICS_TOKEN`, `VITE_SITE_URL` | web build args                        | **not rotatable by a variable change**: they are baked into the bundle at build time, so change them and trigger a new deploy (a Render "Clear build cache and deploy") | rebuild with the old value                                                |

The non-secret settings (`PORT`, `SQS_QUEUE_NAME`, `SQS_DLQ_NAME`, `SQS_ENDPOINT`, `WORKER_CONCURRENCY`,
`AWS_REGION`, `PRIMARY_GATEWAY`, `PRIMARY_MODEL`, `BACKUP_GATEWAY`, `BACKUP_MODEL`, `AI_TIMEOUT_MS`,
`LLM_DAILY_CAP`, `LLM_MODE`, `LLM_FAKE_DELAY_MS`, `SNS_ENDPOINT`, `SNS_ALERT_MAX_PER_HOUR`, `MAIL_DRIVER`,
`MAIL_FROM`, `MAIL_FROM_NAME`, `MAIL_DAILY_CAP`, `TICKET_IP_HOURLY_LIMIT`, `TICKET_DAILY_CAP`, `NODE_ENV`)
rotate the same way, with the per-setting check being the behaviour it controls.

### `OPS_TOKEN`: zero-downtime rotation

`OPS_TOKEN` is the only secret whose rotation the application itself can invalidate: signing in mints a
session in Redis, and a session issued under the old token is not tied to that token, so it stays valid
until its 12-hour TTL (`OPS_SESSION_TIMEOUT_MS` bounds a Redis call, not the session life). The runbook
therefore ends the sessions itself.

1. Sign in with the old token, to have a session to end.
2. Set a new `OPS_TOKEN` (`openssl rand -base64 32`, at least 32 characters, `config.ts` refuses a
   shorter one in production) in the Render dashboard and wait for the redeploy.
3. Verify on the deployed host:
   - `POST /api/ops/session` with the **old** token returns `401`.
   - `POST /api/ops/session` with the **new** token returns `200`.
4. End every session issued under the old token. The server keys them by `ops:session:<sha256(cookie)>`,
   so a Redis `SCAN` and `DEL` ends all of them:

   ```sh
   redis-cli -u "$REDIS_URL" --scan --pattern 'ops:session:*' | xargs -r -n 100 redis-cli -u "$REDIS_URL" DEL
   ```

   Every ops user is signed out and must sign in again with the new token. Do this as part of the
   rotation, not optionally.

5. Rollback: set the old token back and redeploy. The sessions the previous step deleted do not come
   back, so users sign in again; that is the only cost of a rollback.

The sign-in endpoint is also rate-limited (5 wrong tries per address per 15 minutes,
`lib/ops-session.ts`), so a rotation verification that tries both tokens is two attempts, well under
the limit.

## Draining and redriving the dead-letter queue

A message reaches the dead-letter queue when the worker has failed it more times than the queue's
`maxReceiveCount` (10, set by `apps/api/scripts/setup-infra.ts`). The worker's own cap,
`MAX_RECEIVES = 6`, fires first: at receive 6 the ticket is marked `failed`, an event is recorded and
the message is deleted, so the DLQ normally holds only the messages a crash or a restart left behind,
never a ticket that is still `processing`. A message in the DLQ is therefore either a ticket that is
already `failed` (redrive it after a fix and replay it) or one whose deletion failed (redrive and
inspect).

**Inspect before redriving.** Never drain the DLQ blindly; the message body holds the ticket id and
reference number, and the ticket's own history is the real record. Working with the live queue:

```sh
# Queue URLs (names follow SQS_QUEUE_NAME and SQS_DLQ_NAME).
MAIN=$(aws sqs get-queue-url --queue-name "$SQS_QUEUE_NAME" --query QueueUrl --output text)
DLQ=$(aws sqs get-queue-url --queue-name "$SQS_DLQ_NAME" --query QueueUrl --output text)
MAIN_ARN=$(aws sqs get-queue-attributes --queue-url "$MAIN" --attribute-names QueueArn --query Attributes.QueueArn --output text)
DLQ_ARN=$(aws sqs get-queue-attributes --queue-url "$DLQ" --attribute-names QueueArn --query Attributes.QueueArn --output text)

# How many are waiting, and one body (read-only: this does not delete).
aws sqs get-queue-attributes --queue-url "$DLQ" --attribute-names ApproximateNumberOfMessages
aws sqs receive-message --queue-url "$DLQ" --max-number-of-messages 1 --attribute-names All
```

Then choose the path:

- **Preferred, one call for the whole queue:** `start-message-move-task` moves every message from the
  DLQ back to the main queue and is idempotent (running it twice on an empty DLQ moves nothing):

  ```sh
  aws sqs start-message-move-task --source-arn "$DLQ_ARN" --destination-arn "$MAIN_ARN"
  aws sqs list-message-move-tasks --source-arn "$DLQ_ARN"   # Status: RUNNING -> COMPLETED
  ```

  This needs `sqs:StartMessageMoveTask` on the runtime identity, and that action is **not** in
  `infra/iam/runtime-policy.json` (which grants only `GetQueueUrl`, `SendMessage`, `ReceiveMessage` and
  `DeleteMessage`), so the one-call move is `AccessDenied` until an operator adds the action to that
  policy and redeploys. A hand-managed account can add it; on the current policy the fallback below is
  the expected production path. Use the fallback whenever the grant is not there.

- **Fallback, no extra permission: receive + send + delete, one message at a time.** Do this only
  after inspecting the body, and never while `ApproximateNumberOfMessagesNotVisible` is above 0 (a
  message still in flight will reappear and be moved twice):

  ```sh
  MSG=$(aws sqs receive-message --queue-url "$DLQ" --max-number-of-messages 1 --wait-time-seconds 5)
  aws sqs send-message --queue-url "$MAIN" --message-body "$(echo "$MSG" | jq -r '.Messages[0].Body')"
  aws sqs delete-message --queue-url "$DLQ" --receipt-handle "$(echo "$MSG" | jq -r '.Messages[0].ReceiptHandle')"
  ```

**Idempotency after a redrive.** Redriving does not re-run a completed ticket: the worker skips a
ticket in a terminal state and deletes its message (`worker.ts`, "Skipping terminal-state ticket"), and
a `failed` ticket is only reprocessed by an ops replay. A redelivered message for a `queued` or
`processing` ticket is claimed once by `claimTicketForProcessing` (a conditional
`UPDATE … WHERE status='queued'`), so a second copy is dropped. Redrive is safe to repeat.

**Redrive from the ops console instead.** A `failed` or `needs_attention` ticket is replayable from
`/ops` or with `POST /api/tickets/:id/replay` (see [Ticket Recovery](#ticket-recovery)). A redrive moves
the queued message; a replay re-runs a finished ticket. Use the redrive for a message whose ticket is
still `queued`/`processing` (a crash left it behind), and a replay for a ticket that ended `failed`.

## Rolling back a Render deploy

The full procedure is in [deployment.md](deployment.md#rollback). The parts that matter in an incident:

1. Render dashboard → the service → **Deploys** → pick the last successful deploy → **Rollback**. This
   deploys that build with the **current** environment and turns auto-deploy off for the service.
2. Re-enable auto-deploy (Settings → Auto-Deploy) once the fix is on `main`. Until then a merge to
   `main` will not deploy.
3. Verify: `GET /health/live` → `200`, `GET /health/ready` → `200`, `GET /api/ops/session` →
   `{"signedIn":false}`, and an ops sign-in returns `200`. A rollback restores the image only, not the
   environment variables, so a variable changed with the bad deploy must be put back by hand.

**Migration guardrails.** The repository's migrations are additive and the rollback plan assumes the old
image can run against the new schema. Each rule comes from the migrations in `apps/api/migrations/`:

- A rollback needs no down script: the previous image ignores tables and columns it does not know.
- **Never** drop or rename a column or table in a deploy you might roll back. No migration on `main`
  does; keep it that way. `008_ticket_events_append_only.sql` adds a trigger that rejects an `UPDATE`
  or `DELETE` on `ticket_events` unless the transaction opts in (`app.allow_event_purge`); keep the
  trigger, and keep the opt-in transaction-local.
- A migration runs in `start.sh` before the server starts, under `set -e`, so a migration that fails
  stops the deploy instead of serving against a half-migrated schema. That protects a forward deploy;
  the reverse (a new schema with an old image) is the case the additive rule covers.
- One migration in this repository is **not** additive: `004_unique_ticket_processing_ticket_id.sql`
  deletes duplicate `ticket_processing` rows before adding a unique index. It is already applied on
  `main`; a rollback past it would need the index, but not the dedupe (the data is already clean). Do
  not write another migration of this shape without a backup first.
- `DATABASE_DIRECT_URL` (Neon direct) is used for the migration when set; the pooled endpoint is not
  suitable for DDL (`PA-7.8-05`).

The Render rollback was proved read-only: `GET /health/live` and `/health/ready` both return `200` on the
live host (evidence in `docs/audit/launch/07-ops-runbook.md`). The dashboard steps themselves are not
exercised in the audit because they mutate the live service.

## LLM spend kill switch and daily ceiling

`LLM_DAILY_CAP` is the one control over LLM spend. It has three states (`lib/spend-guard.ts`):

| Value   | Behaviour                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------- |
| unset   | No ceiling. A local run and CI never touch Redis for this.                                              |
| `0`     | **Kill switch.** Every provider call, primary and backup, in both stages, is refused before it is made. |
| `N` > 0 | At most `N` provider calls in the UTC day; the next one is refused.                                     |

Every provider call passes `assertLlmSpendAllowed()` first, so one ticket can spend at most 12 calls
(two stages × three attempts × primary + backup, `docs/abuse-protection.md`), and the day's budget is
counted in `llm:day:<UTC date>` in Redis, with a TTL past the day boundary. A refusal is a fixed code,
never a message that quotes ticket text, and it fails closed: a Redis that cannot answer refuses the
call rather than letting spend through. Set `1200` to match the default 100-ticket day.

**Engaging the kill switch.** During an incident where spend is running away:

1. Set `LLM_DAILY_CAP=0` in the Render dashboard and wait for the redeploy (a variable change restarts
   the service).
2. Tickets keep being accepted; each reaches `triage.started` then `triage.failed` with the detail
   `LLM spend is switched off (LLM_DAILY_CAP=0)` and, after the retries, ends `failed` with that reason.
   Nothing crashes, and `ai_interactions` gets no row (no provider call was made).
3. `GET /health/live` stays `200`; the ticket pages and the public lookup keep working.
4. **Recover:** set `LLM_DAILY_CAP` back to its normal value (or unset), redeploy, then replay the
   tickets the switch failed from `/ops` (see [Ticket Recovery](#ticket-recovery)). Each replay is a
   fresh attempt and completes normally.

The switch was proved end to end on the local stack: see `docs/audit/launch/07-ops-runbook.md`. The test
is `apps/api/tests/unit/lib/spend-guard.ops.test.ts`.

## Manual steps: AWS free-tier expiry (PA-7.8-06)

The free AWS usage the project relies on ends on **2027-04-03**. Two steps are manual and live outside
the repository; they are repeated here so this runbook is the one checklist:

1. **Calendar reminder.** Add a reminder **before 2027-04-03** to review AWS spend and decide whether to
   switch queues to ElasticMQ (below). No code change is needed to switch; the reminder is the action.
2. **$1 budget alert.** In the AWS Console, Billing → Budgets, create one **monthly $1 budget** with an
   email alert at 100% (and optionally 80%), and confirm the recipient address receives it. Budgets is
   free for the first two. The repository cannot show the live console state, so this check is "the
   budget exists and its recipient is reachable", done by a maintainer.
3. **SNS / email verification.** In the AWS Console, SNS → the alert topic → Subscriptions, confirm the
   ops address shows **Confirmed** (an unconfirmed subscription receives nothing). Then trigger one
   real `needs_attention` alert (a ticket with `[fake:invalid-draft]` under `LLM_MODE=fake` is the safe
   way in a non-production stack) and check the email arrives. `docs/production-infra.md` §5-6 records
   the setup; this is its recurring check.

The free-tier ceilings the budget catches are SQS 1,000,000 requests/month, SNS 1,000 email
deliveries/month, Neon 100 CU-hours/project/month and Brevo 300 emails/day. The full budget is in
`docs/audit/launch/04-cost-limits.md`.

## Switching the queue to ElasticMQ (PA-7.8-03)

ElasticMQ is a local SQS implementation. The app talks to it through the same SDK and the same four
calls (`SendMessage`, `ReceiveMessage`, `DeleteMessage`, `GetQueueUrl`, `lib/queue.ts`), so the switch is
one endpoint variable. `docker-compose.yml` already carries an `elasticmq` profile for the local proof;
it is not part of the default `up`, so adding it never recreates the other services.

**What changes vs what stays identical.**

|                                         | AWS SQS                   | ElasticMQ                                                            |
| --------------------------------------- | ------------------------- | -------------------------------------------------------------------- |
| `SQS_ENDPOINT`                          | unset (regional endpoint) | the ElasticMQ host, e.g. `http://localhost:9324`                     |
| `SNS_ENDPOINT`                          | unset                     | **must be empty**: ElasticMQ has no SNS, so ops email alerts are off |
| Credentials                             | real IAM keys             | any value; ElasticMQ ignores them                                    |
| Visibility timeout, DLQ, redrive policy | set by `setup-infra.ts`   | the same, applied by the same script                                 |
| The app's queue code                    | unchanged                 | unchanged                                                            |

**Local proof (executed, `reports/logs/ops-elasticmq-dryrun.log`).** The three steps below were run
against the repository's own `elasticmq` compose profile on 2026-11-24 and the container was stopped and
removed afterwards; the log holds the full output.

```sh
docker compose --profile elasticmq up -d elasticmq
SQS_ENDPOINT=http://localhost:9324 SNS_ENDPOINT= bun --env-file=.env apps/api/scripts/setup-infra.ts
# one send, receive and delete through the app's own queue module, with the same overrides
docker compose --profile elasticmq stop elasticmq && docker compose --profile elasticmq rm -f elasticmq
```

What the run showed, quoting the log:

- `setup-infra.ts` created the pair and applied the policy: `DLQ ARN: arn:aws:sqs:elasticmq:000000000000:<queue>-dlq`,
  `redrive policy applied (visibility timeout 300s for AI_TIMEOUT_MS 30000)`, and
  `SNS_ENDPOINT not set, skipping the ops alert topic`.
- Read back through the app's queue module, the main queue reported
  `VisibilityTimeout=300 maxReceiveCount=10 deadLetterTarget=<queue>-dlq`, so the same script and the same
  SDK calls set the same attributes as against AWS.
- The round trip passed: `sent ticket OPS-ELASTICMQ-1`, `received ticketId=… reference=OPS-ELASTICMQ-1
attempt=1`, `deleted the message`, `queue empty after delete: true`, exit `0`.
- Teardown removed the container: `elasticmq containers left in this compose project (any state): 0`.

No code change was needed for the switch: the only difference between the two runs was the endpoint.

**Caveats versus AWS SQS.** The first was observed in the local proof; the rest are properties of
ElasticMQ itself and are recorded here so a switch is not planned on the assumption they match AWS:

- **No SNS**, so ops email alerts stop. Observed: the setup run printed `SNS_ENDPOINT not set, skipping
the ops alert topic`. The live feed and ticket processing are unaffected; alerts are best-effort and
  never block a ticket (`services/ops-alerts.ts`).
- **Redrive timing differs.** AWS moves a message to the DLQ on a timer once `maxReceiveCount` is
  exceeded; ElasticMQ and LocalStack move it on the receive that exceeds the count (the same behaviour
  the LocalStack DLQ dry run recorded). The worker's own `MAX_RECEIVES` cap still fires first, so a
  ticket still fails cleanly; only the exact moment the message leaves the main queue differs.
- **`start-message-move-task` is an AWS feature.** Draining the DLQ on ElasticMQ uses the receive + send
  - delete fallback above, not the one-call move task.
- **No managed multi-AZ or durability guarantees.** ElasticMQ is a single process; run it as a real
  service with a persistent volume, and keep a backup, or accept that a queue loss loses only unprocessed
  messages (the tickets themselves are in Postgres and replayable).

Switching production is: run ElasticMQ on a host that does not sleep (the reason `PA-7.8-03` is still
open on the free Render plan), create the queues with the script, set `SQS_ENDPOINT` and clear
`SNS_ENDPOINT` in the Render dashboard, redeploy, and run `bun --filter @relay/api smoke:infra`.
