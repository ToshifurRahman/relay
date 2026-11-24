[![CI](https://github.com/ToshifurRahman/relay/actions/workflows/ci.yml/badge.svg)](https://github.com/ToshifurRahman/relay/actions/workflows/ci.yml)

# Relay

Relay is a support-ticket pipeline. A customer submits a ticket, a background worker triages it with an LLM and drafts a reply, and the customer watches it happen live. Staff get an ops console with live updates, alerts and replay for failures.

Built with Bun, Hono, PostgreSQL, Redis, AWS SQS, Socket.io and React.

**Live demo:** <https://ticket-pipeline.onrender.com> — open [the home page](https://ticket-pipeline.onrender.com/) or [submit a ticket](https://ticket-pipeline.onrender.com/new) and watch it move.

The demo runs on Render's free tier, which sleeps after 15 minutes without traffic. **The first request after a cold start can take about a minute** while the service and the Neon database wake up; later requests are fast. The demo exists to show the flow, so **do not submit real personal data**: anyone can read a ticket if they have its reference, and the retention sweep deletes tickets after 30 days.

![The customer flow: submit a ticket, watch it triaged, read the reply](docs/screenshots/customer-flow.gif)

## What it shows

- **LLMs in a real pipeline.** Two stages (triage, then draft), each returning schema-validated JSON, with timeouts, retries and a backup provider.
- **Async work done properly.** An SQS queue and a worker with per-stage retries, replay from the stage that failed, and escalation to ops when retries run out.
- **Observability.** Every provider call is recorded (outcome, latency, tokens) and summarised in the ops console.
- **Privacy by construction.** Public views, the ops feed and alerts are built field by field, and guard tests fail if anything else publishes to them.
- **Tests at every layer.** Vitest, Playwright end to end, and accessibility checks.

## Architecture

```
Customer / Ops (React app)
        │  HTTP + Socket.io
        ▼
Hono API (Bun) ──► PostgreSQL ◄──┐
        │                        │
        ▼                        │
   AWS SQS queue ──► Worker ─────┘
                       │
                       ▼
                 ai-service ──► llm-client ──► Portkey ──► primary LLM
                                                    └────► backup LLM (on failure)
```

1. `POST /api/tickets` stores the ticket as `queued` and sends a message to SQS.
2. The worker picks it up and runs **triage** (category, priority, sentiment, escalation, team), then **draft** (customer reply, internal note, next steps).
3. Each step and outcome is written to `ticket_events` and pushed live to the customer's page and the ops feed.
4. A stage that fails is retried up to 3 times. After that the ticket goes to `needs_attention`, ops is alerted, and staff can replay it.

## How the AI works

All model calls go through `apps/api/src/lib/llm-client.ts`.

- **Structured output.** Each call forces a named function schema, and the result is validated with Zod (`TriageOutputSchema`, `DraftOutputSchema`). Malformed output is recorded as `invalid_response` and treated as a failure. It is one forced call per stage, not an agent loop.
- **Providers.** Requests go through the Portkey gateway to Google (Gemini, primary) and Groq (backup), set by `PRIMARY_GATEWAY` and `BACKUP_GATEWAY`. If the primary fails or times out (`AI_TIMEOUT_MS`, default 30s), the backup answers.
- **Recording.** Every call is written to `ai_interactions`, and a failed write never blocks the ticket. See [AI observability](docs/ai-observability.md).
- **No provider needed to try it.** `LLM_MODE=fake` returns canned output at the provider boundary. Everything above it (validation, retries, events) still runs. See [Testing without an AI provider](docs/web-app.md#testing-without-an-ai-provider).

## Quick start

**Needs:** Bun 1.3+, Node 24.22.1+ (Vitest only), Docker.

```bash
bun install
cp .env.example .env     # fill in the values below
docker compose up -d     # Postgres, Redis, LocalStack (SQS/SNS), Mailpit; its setup step creates the queues
bun --filter @relay/api migrate
bun --filter @relay/api setup            # idempotent; re-creates the local queues and SNS topic if needed
bun --filter @relay/api dev              # API on http://localhost:3000
bun --filter @relay/api worker           # in a second terminal
```

Each API script loads the repository root `.env` itself (`--env-file=../../.env`), so the commands above work from anywhere in the repository. The values must be filled in first: with the `.env.example` placeholders still empty, `migrate` stops with `Invalid environment: DATABASE_URL: required` and names every missing variable.

In `.env`, set `DATABASE_URL`, `REDIS_URL` and `SQS_QUEUE_NAME` at the least, plus `PORTKEY_API_KEY`, `GOOGLE_API_KEY` (primary, Gemini) and `BACKUP_API_KEY` (Groq) for real model calls. `.env.example` gives a local value for each in its comment. To skip providers entirely, set `LLM_MODE=fake`. The API, the worker and each script validate the environment once at startup (`apps/api/src/lib/config.ts`): a missing or invalid variable stops the process at once and the message names it. AWS keys are not needed when `SQS_ENDPOINT` is set, because LocalStack accepts the placeholder `test` credentials.

### Queue options: AWS SQS or ElasticMQ

The queue is the AWS SQS API, so it talks to any implementation of it. Locally `docker compose up -d` starts LocalStack on `:4566` and `SQS_ENDPOINT` points at it. In production the same variable chooses the backend:

| Backend                                                                                 | `SQS_ENDPOINT`                                   | `SNS_ENDPOINT`    | Notes                                                                                        |
| --------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------- | -------------------------------------------------------------------------------------------- |
| AWS SQS (default)                                                                       | unset                                            | unset             | Real IAM keys and a real SNS topic for ops email.                                            |
| LocalStack (local dev, e2e, CI)                                                         | `http://localhost:4566`                          | same              | The placeholder `test` credentials are enough; `bun --filter @relay/api setup` makes queues. |
| [ElasticMQ](docs/production-infra.md#7-switch-to-elasticmq-hosting-is-an-open-decision) | the ElasticMQ host, e.g. `http://localhost:9324` | **must be empty** | No SNS, so ops email alerts are off; queue behaviour is otherwise the same.                  |

The switch is one variable: nothing in the app changes. `docs/production-infra.md` records the local proof and the caveats (no SNS, different DLQ redrive timing, no managed multi-AZ).

For a production-style local run, build once and start the API and worker together:

```bash
bun run build          # type-checks the API and builds apps/web/dist
bun --env-file=.env run start
# or run each service on its own:
bun --env-file=.env run start:api
bun --env-file=.env run start:worker
```

Bun runs the API TypeScript directly, so there is no API `dist/`; `apps/web/dist` is the only build output. Start scripts read the process environment only, which is why the local commands above pass `--env-file`.

Try it:

```bash
curl -X POST http://localhost:3000/api/tickets \
  -H "Content-Type: application/json" \
  -d '{"subject": "Login not working", "description": "I cannot log in with my password"}'
# { "ticketId": "…", "referenceNumber": "TKT-001", "status": "queued", … }

curl http://localhost:3000/api/tickets/<ticketId>
```

`POST /api/tickets` also verifies a Cloudflare Turnstile token. Add `"turnstileToken": "XXXX.DUMMY.TOKEN.XXXX"` (Cloudflare's always-pass test token, accepted by the test secret in `.env.example`) to the body, or the API answers 403.

For the web UI, run `bun run build` once and open http://localhost:3000, or run `bun --filter @relay/web dev` for the Vite dev server on :5173. Staff sign in at `/ops` with `OPS_TOKEN` (`dev-ops-token` locally).

## Tests and checks

```bash
bun run check           # format check, lint, typecheck and tests
bun run test            # API, worker, repository and web tests (Vitest on Node)
bun run test:e2e        # Playwright against the built app (needs the Docker services up)
```

Use `bun run test`, not `bun test`: Vitest has to run on Node because `vi.mock` does not work under Bun. Stop any dev worker before `test:e2e`, since it reads the same queue.

## More detail

| Doc                                              | Covers                                                       |
| ------------------------------------------------ | ------------------------------------------------------------ |
| [Architecture](docs/ARCHITECTURE.md)             | Folder map, import rules, test layout, naming                |
| [Contributing](CONTRIBUTING.md)                  | Setup, scripts, branch and commit rules                      |
| [Web app](docs/web-app.md)                       | Pages, public vs ops views, ops console, fake LLM mode       |
| [Ops](docs/ops.md)                               | Live feed, sign-in, email alerts, ticket recovery and replay |
| [Customer email](docs/customer-email.md)         | Opt-in notifications and mail drivers                        |
| [Ticket history](docs/ticket-history.md)         | Append-only event log and paging                             |
| [AI observability](docs/ai-observability.md)     | `ai_interactions`, ops endpoints, example queries            |
| [DESIGN.md](DESIGN.md), [PRODUCT.md](PRODUCT.md) | Design system and product intent                             |

## Project structure

The repo is `apps/api`, `apps/web`, `e2e/`, `scripts/` and `docs/`. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the folder map, import rules, test layout and naming.

## Deployment

The app runs at <https://ticket-pipeline.onrender.com> on Render's free tier, described by the [`render.yaml`](render.yaml) blueprint: one Docker web service, `healthCheckPath: /health/ready`, and `autoDeployTrigger: checksPass` so a deploy waits for CI. The start command runs the migration before the server.

Read-only health endpoints, no auth and no data:

```bash
curl -sS https://ticket-pipeline.onrender.com/health/live    # {"status":"ok"}
curl -sS https://ticket-pipeline.onrender.com/health/ready   # {"status":"ok"}
```

`/health/live` only proves the process is up. `/health/ready` also queries Postgres, so it is the one that reports a cold or suspended database truthfully. The free tier spins the service down after 15 minutes without traffic and Neon suspends its compute after 5 minutes idle, so the first request after a quiet period is slow (about a minute) while both wake. There is no uptime monitor: keeping the service awake would exhaust Neon's free compute allowance (the maths is in [deployment.md](docs/deployment.md#free-plan-behavior)). See [Deploying to Render](docs/deployment.md) for the variable list, the free-plan behavior and rollback.

The demo has no login for customers, so treat any ticket as public and do not submit real personal data. Tickets are deleted 30 days after creation by the retention sweep.

The `Dockerfile` builds the web app and runs the API and the worker together on `oven/bun` (`src/main.ts`). To split them later, override the command: `docker run <image> bun src/index.ts` for the API or `bun src/worker.ts` for the worker.

The image is built the same way everywhere (pinned `oven/bun:1.3.14`, frozen lockfile, non-root `bun` user, no `.env`, tests or dev dependencies) and has a `HEALTHCHECK` on `/health/live`. The web app reads three public values at build time, so pass them as build args: `VITE_TURNSTILE_SITE_KEY` (required: the build fails without it), `VITE_CF_ANALYTICS_TOKEN` and `VITE_SITE_URL`.

```bash
docker build --build-arg VITE_TURNSTILE_SITE_KEY=<site key> -t relay .
bun run test:image   # builds the image and runs it against the compose stack (no .env, no LLM call)
```

A worker-only container (`bun src/worker.ts`) has no HTTP server, so add `--no-healthcheck` to `docker run`.
