# Launch audit: Legal truthfulness (7.12.9)

Audit date: 2026-11-24, against `audit/7.12.9-legal-truthfulness` from `main` at `2dfbd56`. It
covers the 7.12.9 checks: Privacy and Terms name every real processor, no claim the site cannot
back up, pricing is clearly cosmetic, nothing suggests a real company, and the parked pre-audit item
from `docs/audit/pre-audit.md:590` (`brand.repoUrl` and the legal pages' contact points after the
rename).

Every finding ran against the real codebase on this branch, and the live checks ran against
`https://ticket-pipeline.onrender.com` with read-only, low-volume GETs only: page HTML and headers,
`/health/live` and `/health/ready`, and the public JS assets the pages load. No form was submitted,
no sign-in attempted, no ticket created, nothing mutated. Live output is in
`reports/logs/legal-live-pages.log`.

Severity uses the pre-audit scale: Critical and High block go-live; a Medium or Low may ship only
as an accepted risk with a reason. Finding IDs are `LEG-NN`.

## Summary

| Severity | Found | Fixed | Accepted | Open |
| -------- | ----- | ----- | -------- | ---- |
| Critical | 0     | 0     | 0        | 0    |
| High     | 3     | 3     | 0        | 0    |
| Medium   | 2     | 2     | 0        | 0    |
| Low      | 3     | 3     | 0        | 0    |

An independent review of that first pass raised eight more findings, each fixed on the same branch
and recorded under LEG-09 to LEG-16. They keep the review's own severity labels, which do not map
one to one onto the scale above:

| Review severity | Found | Fixed | Open |
| --------------- | ----- | ----- | ---- |
| P0              | 1     | 1     | 0    |
| P1              | 2     | 2     | 0    |
| P2              | 5     | 5     | 0    |

No Critical or High finding is open. Every fix has a failing-first regression test whose red output
is in `reports/logs/red-legal-truthfulness.log` (web copy guards, 7 failed / 2 passed of 9, the
first pass), `reports/logs/red-legal-copy.log` (API sender copy guards, 3 failed of 3) or
`reports/logs/red-legal-fix1.log` (web copy guards, 5 failed / 7 passed of 12, the second pass: the
processor-name, phantom-name, IP-bound, `/new` lead and ops-toast assertions). Three assertions in
the suite are companions rather than separately proven: the pricing-note render assertion sits
beside the "labels the pricing" assertion that did fail, "names no processor the deployment does not
use" fails on the same copy as "names each processor", and the ops-toast assertion fails on the
same string as the team-collection assertion.

## Checks run

All gates ran from the worktree through `run-check.sh`, one at a time, with `apps/web/dist` absent.

### 1. Privacy and Terms name every real processor

Processor list taken from the code that actually calls each service, then matched against what
`apps/web/src/content/legal.ts` states and what the live client bundle renders.

| Processor     | Where the code uses it                                                                                                                                                  | Named on /privacy | Purpose stated there                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------- |
| Render        | `render.yaml` (web service), `x-render-origin-server` header on every live response                                                                                     | yes               | "The site runs on Render"                                                 |
| Neon          | `apps/api/src/lib/db.ts` (`DATABASE_URL` pool)                                                                                                                          | yes               | database                                                                  |
| Redis Cloud   | `apps/api/src/lib/socket.ts`, `lib/counters.ts`, `lib/ops-session.ts` (the generic `redis` client on the cache URL; provider recorded in `docs/production-infra.md:34`) | yes               | cache                                                                     |
| AWS           | `apps/api/src/lib/queue.ts` (SQS), `lib/sns.ts` and `services/ops-alerts.ts` (SNS)                                                                                      | yes               | queue and staff alerts; the alert's contents are now described            |
| Brevo         | `apps/api/src/lib/mailer.ts:39` `https://api.brevo.com/v3/smtp/email`                                                                                                   | yes               | address, subject and reference, never the description or reply            |
| Cloudflare    | `components/turnstile.tsx`, `lib/turnstile.ts` (Turnstile), `app/analytics.tsx` (Web Analytics), and the CDN in front of Render                                         | yes               | delivers the site, bot check (sees the IP on form submit), visit counting |
| Portkey       | `apps/api/src/lib/llm-client.ts:3,158` (`PORTKEY_GATEWAY_URL`)                                                                                                          | yes               | the route to the AI providers                                             |
| Groq / Google | `llm-client.ts:42,91-95` (`PRIMARY_GATEWAY`/`BACKUP_GATEWAY` both resolve to one of these; default primary `groq`)                                                      | yes               | sorts the ticket and drafts the reply                                     |

No phantom processor: every name on the page maps to live code, and a grep of
`apps/api/src` and `apps/web/src` for third-party hosts returns six hosts:
`api.brevo.com`, `challenges.cloudflare.com`, `static.cloudflareinsights.com`,
`cloudflareinsights.com`, `https://github.com` (the legal contact link in `config/brand.ts:18`, which
receives no ticket data; it is a link a reader follows, not a call the app makes) and `localhost`
(the health probe in the test harness). The first four are named or covered by the Cloudflare and
Brevo entries. The cache row names Redis Cloud as `docs/production-infra.md:34` records it: the code
reaches the cache through the generic `redis` client, so the runbook, not the import, carries the
company name. Corrected in review; the page had named Upstash, which no part of the deployment uses
(see LEG-09).

### 2. No claim the site cannot back up

Every factual, security, retention and data-handling claim on `/privacy`, `/terms`, the landing
page, the pricing section, the FAQ, the footer and the ticket form was checked against
`01-security.md`, `02-data-privacy.md`, `03-reliability.md`, `04-cost-limits.md`, `07-ops-runbook.md`
and `08-ai-safety.md`, and against the code.

| Claim                                                       | Backed by                                                                                                                                                            | Result                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| subject + description only, plus progress and the AI answer | `tickets`, `ticket_processing`, `ticket_events`                                                                                                                      | holds                                                          |
| email used for confirm, reply-ready and one snag notice     | `services/customer-notifications.ts`, `notification-emails.ts`                                                                                                       | holds                                                          |
| deleted 30 days after send, email deleted with the ticket   | `RETENTION_DAYS = 30`, purge delete list (`02-data-privacy.md` §5)                                                                                                   | holds; guard `privacy-retention.test.ts` pins it               |
| Brevo sees address + subject + reference only               | `notification-emails.ts` `EmailContext`                                                                                                                              | holds                                                          |
| last few references in the browser, clearable               | `features/tickets/lib/recent-tickets.ts` (`localStorage`)                                                                                                            | holds                                                          |
| IP kept "an hour or less", as a counter only                | `submission-guard.ts` `tickets:ip:*` 3600 s, `customer-notifications.ts` `notify:optin:*` 3600 s, `ops-session.ts` lockout 900 s; all IP-keyed keys expire in <= 1 h | holds; guard `legal-truthfulness.legal.test.ts` pins the bound |
| no advertising or tracking cookies                          | no third-party cookies; 0 `Set-Cookie` on `/`, `/legal/privacy`, `/legal/terms`, `/new` (live)                                                                       | holds                                                          |
| "counts visits without cookies (Web Analytics)"             | `app/analytics.tsx` loads the beacon only when `VITE_CF_ANALYTICS_TOKEN` is set; the live bundle ships **no** beacon                                                 | **did not hold**; fixed, see LEG-03                            |
| "no paid plan behind the pricing page"                      | the page said this, but the tier buttons said "Start free", "Start with Team", "Ask us" with a $49 plan and no demo label                                            | **did not hold**; fixed, see LEG-01                            |
| "no support team"                                           | landing, ticket page, status pill and the snag email all said "the team" / "With our team" / "flagged for the team"                                                  | **did not hold**; fixed, see LEG-02                            |
| "a reply usually arrives within a minute"                   | nothing measures stage latency; `03-reliability.md` records a 22.5s cold start against a 30s client timeout                                                          | **did not hold**; fixed on both `/new` lines, see LEG-06       |
| no SOC 2 / ISO / GDPR badge, no uptime SLA                  | no such copy exists in `apps/web/src`                                                                                                                                | holds (nothing to remove)                                      |
| "It's a portfolio demo, not a real service"                 | stated in the legal notice, the Terms and (now) the footer                                                                                                           | holds; reinforced, see LEG-07                                  |

### 3. Pricing is clearly cosmetic

Before this branch the Rates section showed three tiers with a `$49 / month` plan, a "Popular"
stamp and the buttons "Start free", "Start with Team" and "Ask us". Nothing on the page said the
plans were not real, so the only demo signal lived on `/legal/terms`, one link away. The buttons
went to the demo form (no checkout, no billing code anywhere), so the defect is the commercial
framing, not a real purchase path. Fixed: the section now carries a visible note ("Illustrative
rates from a demo build. These are not real plans: there is nothing to buy, no checkout and no
billing.") and every button reads "Try the demo". There is no checkout, payment or card field in the
codebase: a grep for `checkout`, `stripe`, `payment` and `card number` in `apps/web/src` returns no
code, and the only "billing" hits are the ticket's category vocabulary and the fictional sample
ticket's charge.

### 4. Nothing suggests a real company

- No `Inc`, `LLC`, `Ltd` or `GmbH` anywhere in `apps/web/src` or `apps/web/index.html`; the footer
  reads `© Relay · AI help desk`, a brand mark, not a legal entity.
- No street address, phone number, jurisdiction or registered-office claim.
- The demo's sample ticket in `features/landing/lib/demo-script.ts` is labelled "Sample copy" and
  announced to screen readers as an example. Its reply mentions a refund for a fictional duplicate
  charge; that is the sample conversation, not a promise the site issues refunds, and it carries
  no customer's name. It is not presented as a testimonial.
- No testimonial, logo wall, team page, founder story or "trusted by" claim exists.
- Meta tags (`title`, `description`, `og:*`, `twitter:*`) describe a product, name no entity.
- The retired working title "Ticket Pipe" was still the ops alert email subject
  (`services/ops-alerts.ts:25`); fixed to `[Relay]`, see LEG-08.

### 5. Parked item: `brand.repoUrl` and legal contact points after the rename

- `apps/web/src/config/brand.ts` still pointed at `https://github.com/ToshifurRahman/ticket-pipe`.
  The live bundle carried that literal (`legal-live-pages.log`), and the URL redirects to
  `ToshifurRahman/relay` (200), so the link worked but named the old repository. Fixed to
  `https://github.com/ToshifurRahman/relay`, see LEG-04.
- The only legal contact point is the "GitHub page" link on `/privacy` (the repo's `/issues`, and
  the repository has issues enabled: `has_issues: true` from the GitHub API). There is no
  `support@`, `privacy@`, `legal@` or `@relay.example` / `@relay.dev` address anywhere in the
  source, so there is no dead placeholder to replace. The footer links Privacy and Terms on every
  public page.

### Live evidence (read-only)

From `reports/logs/legal-live-pages.log`:

- `GET /privacy` and `GET /legal/privacy` → 200, SPA shell, `content-security-policy`,
  `strict-transport-security`, `x-frame-options: SAMEORIGIN`, `server: cloudflare`,
  `x-render-origin-server: Render`, 0 `Set-Cookie`.
- `GET /terms` and `GET /legal/terms` → 200, same headers, 0 `Set-Cookie`.
- `GET /`, `/new` → 200, 0 `Set-Cookie`.
- `GET /health/live`, `/health/ready` → 200.
- The live entry bundle `/assets/index-C79oLhze.js` (361305 bytes) and the lazy chunks contain
  every processor name, "30 days", "deleted with the ticket", "No advertising or tracking cookies",
  "portfolio demo" and "October 2026", matching the source before this branch.
- The live `/new` chunk (`new-ticket-DEhtoY70.js`) still contains the pre-fix "within a minute"
  copy and "With our team" (2 occurrences each), and the live bundle carries **no**
  `static.cloudflareinsights` beacon: the deployed build predates this branch and shows the defects
  LEG-03 and LEG-06 as they stand in production today.
- `https://github.com/ToshifurRahman/ticket-pipe` → 200 at `ToshifurRahman/relay`.

## Findings

| ID     | Severity | Location                                                                                                                                                             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                  | Fix or accepted-risk reason                                                                                                                                                                                                                                                                                                                                                               | Status |
| ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| LEG-01 | High     | `apps/web/src/features/landing/content.ts:42-72`, `components/pricing.tsx`                                                                                           | The Rates section sold three tiers ($49/month, "Popular" stamp) with "Start free", "Start with Team" and "Ask us", and nothing on the page said the plans were not real. The demo signal lived only on `/legal/terms`.                                                                                                                                                                                                                    | Fixed: a visible note under the heading states the rates are illustrative, not real plans, with nothing to buy, no checkout and no billing; every button reads "Try the demo". Failing-first guard `tests/guards/legal-truthfulness.legal.test.ts` "labels the pricing as illustrative and sells nothing" (red: `reports/logs/red-legal-truthfulness.log`).                               | fixed  |
| LEG-02 | High     | `features/landing/content.ts:33-91`, `features/tickets/components/ticket-thread.tsx:13`, `status-pill.tsx:11-12`, `apps/api/src/services/notification-emails.ts:135` | The Terms say the demo has "no support team", but the landing page, ticket page, status pill and snag email all said "the team" / "With our team" / "flagged for the team", contradicting the page one link away and presenting a staffed support desk that does not exist.                                                                                                                                                               | Fixed: customer copy names the ops console instead ("flagged on the ops console", "Needs review", "the operator of the demo"). Failing-first guards `legal-truthfulness.legal.test.ts` "does not claim a team that the demo does not have" and `apps/api/tests/guards/legal-copy.legal.test.ts` "never claims a support team…" (red: `red-legal-truthfulness.log`, `red-legal-copy.log`). | fixed  |
| LEG-03 | High     | `apps/web/src/content/legal.ts:44-47,65-70`                                                                                                                          | `/privacy` stated Cloudflare "counts visits without cookies (Web Analytics)" as a fact, but `app/analytics.tsx` loads the beacon only when `VITE_CF_ANALYTICS_TOKEN` is set, and the live bundle ships no beacon at all. The page claimed a processor and a data flow that the deployed site does not perform.                                                                                                                            | Fixed: the copy now says counting happens "when visit counting is switched on" and that a switched-off site "sets no analytics cookie or beacon at all", so the statement is true in both deployments. Guard `legal-truthfulness.legal.test.ts` "does not claim analytics that the built site may not ship" (red: `red-legal-truthfulness.log`).                                          | fixed  |
| LEG-04 | Medium   | `apps/web/src/config/brand.ts:17`                                                                                                                                    | `brand.repoUrl` was `https://github.com/ToshifurRahman/ticket-pipe` (the pre-rename name). It redirects, but the legal contact named the old repository. The parked `pre-audit.md:590` item.                                                                                                                                                                                                                                              | Fixed to `https://github.com/ToshifurRahman/relay`; live check confirms both resolve to the relay repo. Guard `legal-truthfulness.legal.test.ts` "points the legal contact at the renamed repository".                                                                                                                                                                                    | fixed  |
| LEG-05 | Medium   | `apps/web/src/content/legal.ts:21`                                                                                                                                   | `DEMO_NOTICE` called the legal pages "a plain-language mock of what a real one would say", which undercuts the pages as the record of what the demo actually does with data, and reads as a disclaimer that nothing on them is binding.                                                                                                                                                                                                   | Fixed: the notice now says the pages describe, in plain language, how the demo works and what it does with the user's data. Guard `legal-truthfulness.legal.test.ts` "keeps the legal notice truthful rather than calling the pages a mock".                                                                                                                                              | fixed  |
| LEG-06 | Low      | `apps/web/src/features/tickets/components/ticket-success.tsx:44`, `apps/web/src/pages/new-ticket.tsx:18`                                                             | "A reply usually arrives within a minute" (success panel) and "Most replies arrive within a minute" (`/new` lead) are latency promises nothing measures; `03-reliability.md` records a 22.5s cold start against a 30s client timeout, so a cold deployment can exceed it.                                                                                                                                                                 | Fixed on both lines: the success panel says "The page updates itself as the ticket moves" and the lead says "The page follows the ticket through each stage", which is what the live socket actually does. Guard `legal-truthfulness.legal.test.ts` "makes no unmeasured delivery promise".                                                                                               | fixed  |
| LEG-07 | Low      | `apps/web/src/app/layout/site-footer.tsx:11-13`                                                                                                                      | The demo label appeared only on the two legal pages; a visitor on the landing page or a shared `/t/:ref` link saw an ordinary product site with no sign it is a portfolio demo.                                                                                                                                                                                                                                                           | Fixed: the footer of every public page now reads `© Relay · AI help desk · Portfolio demo, not a real service`. Guard `legal-truthfulness.legal.test.ts` "prints the demo label in the footer of every public page".                                                                                                                                                                      | fixed  |
| LEG-08 | Low      | `apps/api/src/services/ops-alerts.ts:25`                                                                                                                             | The ops alert email subject was `[Ticket Pipe] …`, the retired working title, while every other surface is "Relay"; the operator inbox named a product that no longer exists.                                                                                                                                                                                                                                                             | Fixed to `[Relay] …`; the unit, worker and LocalStack integration expectations updated. Guard `apps/api/tests/guards/legal-copy.legal.test.ts` "names Relay, not the retired working title" (red: `red-legal-copy.log`).                                                                                                                                                                  | fixed  |
| LEG-09 | P0       | `apps/web/src/content/legal.ts:48`                                                                                                                                   | `/privacy` named Upstash as the cache processor. The deployment uses Redis Cloud (`docs/production-infra.md:34`, `docs/deployment.md:52`, `docs/audit/launch/04-cost-limits.md:38`), the code reaches the cache through the generic `redis` client on the configured URL, and there is no Upstash dependency or host anywhere in `apps/api/src`. A phantom company named, the real one omitted, on the one page that exists to name them. | Fixed: the sentence and the matrix row read "Redis Cloud (cache)", re-verified against the runbooks rather than against the page. Guard `legal-truthfulness.legal.test.ts` "names each processor the deployment actually uses" and "names no processor the deployment does not use" (red: `red-legal-fix1.log`).                                                                          | fixed  |
| LEG-10 | P1       | `apps/web/tests/guards/legal-truthfulness.legal.test.ts:36`                                                                                                          | The check-1 guard hardcoded `'Upstash'` and asserted the copy contained it, so it passed in the red run and could never fail while the wrong name stayed: the test pinned the defect instead of guarding it.                                                                                                                                                                                                                              | Fixed: the guard asserts the processor set the deployment uses (Redis Cloud, per the runbook) and a separate assertion rejects Upstash, so both a wrong name and a missing one fail. Proof is the red run above, where both assertions fail against the old copy.                                                                                                                         | fixed  |
| LEG-11 | P1       | `apps/web/src/pages/new-ticket.tsx:18`                                                                                                                               | The `/new` lead still said "Most replies arrive within a minute", the twin of the latency promise LEG-06 removed from the success panel on the same page, and the guard read only `ticket-success.tsx`, so it passed while the claim survived.                                                                                                                                                                                            | Fixed: the lead now reads "The page follows the ticket through each stage", which is what the socket does. The guard reads both files and flattens the JSX before matching (red: `red-legal-fix1.log`, where the first version of the guard silently passed on the wrapped line and was corrected).                                                                                       | fixed  |
| LEG-12 | P2       | `DESIGN.md:216,244,273`                                                                                                                                              | DESIGN.md still documented the customer pill as folding failures into "With our team" and listed the two "within a minute" lines as kept by decision, all of which this branch replaced.                                                                                                                                                                                                                                                  | Fixed in this branch: the pill row says "Needs review", the voice rule names "Needs review", and the kept-lines entry is gone.                                                                                                                                                                                                                                                            | fixed  |
| LEG-13 | P2       | `docs/audit/launch/09-legal-truthfulness.md:51-54`                                                                                                                   | The host sweep said the grep "returned only" four third-party hosts, but `config/brand.ts:18` also yields `https://github.com`, so the word "only" was literally false even though GitHub receives no ticket data.                                                                                                                                                                                                                        | Fixed: the sweep now lists all six hosts and says which of them the app calls and which it only links to.                                                                                                                                                                                                                                                                                 | fixed  |
| LEG-14 | P2       | `apps/web/src/content/legal.ts:34`                                                                                                                                   | The IP disclosure said "for a little over a day at most". Every IP-keyed key expires in an hour or less (`tickets:ip` 3600 s, `notify:optin` 3600 s, the ops sign-in lockout 900 s); the 25 h window belongs to `tickets:day`, which holds no address.                                                                                                                                                                                    | Fixed: "for an hour or less". Guard `legal-truthfulness.legal.test.ts` "bounds the IP rate-limit counter to an hour or less" (red: `red-legal-fix1.log`).                                                                                                                                                                                                                                 | fixed  |
| LEG-15 | P2       | `apps/web/src/features/ops/components/replay-button.tsx:27`                                                                                                          | The replay toast read "The team re-queued it", the phrase LEG-02 set out to retire. Staff-facing only, so it did not contradict the Terms, and no guard read the file.                                                                                                                                                                                                                                                                    | Fixed: "Re-queued from the ops console", with the drawer and e2e expectations updated. Guard `legal-truthfulness.legal.test.ts` "points the ops console at the console, not a team" (red: `red-legal-fix1.log`).                                                                                                                                                                          | fixed  |
| LEG-16 | P2       | `docs/audit/launch/09-legal-truthfulness.md` (red-log claim)                                                                                                         | The audit stated the red-log evidence for the suite as a whole while one assertion in it had never failed, so the claim was broader than the proof.                                                                                                                                                                                                                                                                                       | Fixed: the summary names which assertions carry their own red proof and which are companions to a failing one, and records the second red run that covers the assertions added in this pass.                                                                                                                                                                                              | fixed  |

## Notes on processor coverage

- **Cloudflare** covers Turnstile, Web Analytics and the CDN in one entry; the purpose of each is
  stated. No separate "Cloudflare CDN" row is needed, since the processor is the same company.
- **Portkey** is the gateway; the two model providers behind it (Groq, Google) are named. This
  matches the code (`llm-client.ts`), where Portkey is the HTTP endpoint and the gateway chooses
  the provider.

## Handoff

- `docs/ops.md:70` quotes the ops alert subject as `[Ticket Pipe] …` in the "needs attention" alert
  example. It is `audit-portfolio` territory (`docs/*.md`) and not edited here; it should read
  `[Relay] …` to match LEG-08. This is a doc example, not a customer-facing surface.
- `docs/design-deviations.md:51-52` still records the two "within a minute" `/new` lines as "kept by
  decision" (ruled keep on 2026-10-22). Both lines are gone (LEG-06, LEG-11), so that entry is now
  stale and its heading, "Copy kept by decision", is empty. The file is owned by `audit-portfolio`,
  so it is corrected there rather than here.

## Gates (single-threaded `run-check.sh`, `apps/web/dist` absent before and after)

| Gate                     | Result                 | Exit |
| ------------------------ | ---------------------- | ---- |
| `format:check`           | all files match        | 0    |
| `lint --concurrency=off` | 0 warnings             | 0    |
| `typecheck`              | clean                  | 0    |
| `@relay/api` unit        | 693 passed / 0 skipped | 0    |
| `@relay/api` integration | 382 passed / 0 skipped | 0    |
| `@relay/web` test        | 328 passed / 0 skipped | 0    |
