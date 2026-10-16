# Wire Room Ops

Backend pipeline and admin dashboard for an intelligence-to-distribution system. Discovers, ingests, deduplicates, scores, and queues entries for operator review, then distributes approved entries across multiple channels.

Deployed as the Sovereign Signal Grant Wires (crypto/AI/OSS grants) but designed to be deployment-agnostic — swap brand config and prompts to run any vertical (consulting leads, research intel, etc.).

## Current Scope (July 2026)

- Scan execution (X search, web search, Perplexity deep web, Parallel.ai retrieval)
- Discovery lanes folded into one daily cycle: source-feeds registry (aggregator APIs, RSS, own-site funder scrapes), governance-forum lane (discuss.watch + LLM judge), X account monitor, X list watcher (Watchtower Phase 0, env-gated)
- Multi-channel ingestion (Telegram bot, manual paste, agent API submits)
- Intake pipeline (parse -> dedup -> LLM classify + score -> decided-recheck -> queue)
- Queue review + approval workflow with pre-approval validation and curator stamps
- Distribution: Telegram channels (live) + Friday weekly Substack draft; Discord/Slack/X/newsletter built but unused
- React dashboard (Lovable design) + server-rendered login
- DB-backed API key management with env var fallback
- Org/contacts CRM layer (extraction, BD-lens enrichment with per-org `operator_read`, merge, Notion sync, people monitor)
- BD leads loop (Wednesdays): relationship signals + a 17-source senior-roles registry -> SOV_SHAPE qualifier -> Parallel verification -> Notion Paid Work Leads (find + qualify only, never contacts)
- Schedule management, tele-sum summary-sync bridge, model listing, decisions-first daily digest email
- Deployment-agnostic brand/audience configuration

## Core Workflow

1. Prompts are stored in `scan_prompts` with a `tool_type` (x_search, web_search, perplexity, parallel) and `intent` (discovery, canonical, signal).
2. `scan-execution` (or manual trigger) routes to the correct provider per tool_type.
3. Results are parsed into structured entries via 4 parser strategies.
4. Intake pipeline inserts raw rows, deduplicates primarily by normalized URL, classifies + scores via LLM (Grok), and moves entries to `queued` or `archived` according to the active intake path.
5. Operator reviews queue in dashboard and sets action:
   - `approve` -> `status = 'approved'`
   - `decline` -> `status = 'declined'`
   - `reviewlater` -> `status = 'skipped'`
6. Dashboard Approve to Wires publishes to configured channels immediately (Telegram is the live path). Use Approve to Programs or `quiet` to store without sending. Internal agent approvals are always quiet. Manual batch distribute remains available for approved-but-undistributed entries. The retired thewireroom.xyz frontend is not in this flow.

## Features

- Privy-authenticated dashboard (email allowlist support)
- React/Vite/Tailwind frontend (Lovable satellite array design) for authenticated routes
- Server-rendered login/error pages with deep space theme and starfield animation
- Deployment-agnostic brand config (audience, content type, scoring keywords — all env-var driven)
- Dynamic feeds (DB-driven wire list, not hardcoded)
- Telegram intake bot for URL/article submissions via webhook
- Channel-agnostic intake core with adapter pattern
- Prompt CRUD + test execution + run + review + prompt lab
- Automated scan runs with SSE progress updates
- Forum scanning via discuss.watch (search terms overrideable via env var)
- Intake scoring + dedup stats + prompt effectiveness stats
- LLM classifier (Grok) with quality scoring, entity tags, and operator signal feedback loop
- DB-backed API key management with env var fallback (api_providers table)
- Org profile management (auto-extraction, LLM enrichment, merge, Notion CRM sync)
- Scheduler with per-schedule health and retry-on-failure behavior
- Summary sync bridge (`summaries` -> `scan_entries` as **queued review candidates** with `operator_route='source_check'` — not auto-approved; DB-driven wire list)
- Multi-channel distribution (Telegram, Discord, Slack, X/Twitter, newsletter markdown)
- AI-generated posts via Ollama Cloud with template fallback
- Postgres-backed generated file storage and email notifications

## Quick Start

### 1. Install

```bash
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Required env vars (server will not start without these):

- `DATABASE_URL`
- `NOTIFICATION_EMAIL`
- `PRIVY_APP_ID`
- `PRIVY_APP_SECRET`

Optional API keys (warn on startup if missing; can also be set via Settings > API Providers):

- `GROK_API_KEY`
- `OLLAMA_API_KEY`
- `FIRECRAWL_API_KEY`
- `RESEND_API_KEY`

### 3. Run

Apply the schema once with the database owner connection before starting a new
schema version. The command defaults to a dry run:

```bash
npm run db:migrate
npm run db:migrate -- --apply
```

Then run the application with its runtime database connection:

```bash
npm run dev
```

Production on Railway runs the migration itself, before the new process starts.
`railway.json` sets:

```text
node dist/scripts/migrate-database.js --apply
```

That command is the compiled script, so it runs in the built image without
`ts-node`. It connects as the schema owner from `MIGRATION_DATABASE_URL` when
that variable is set and falls back to `DATABASE_URL` otherwise. The running
app only ever uses the restricted `DATABASE_URL`. The command applies only
schema steps newer than the recorded version, then re-applies and verifies the
runtime role's grants (`src/db/runtime-grants.ts`, the executable copy of
`scripts/database-runtime-grants.sql`) and exits 0. A database already at that
version is a no-op. Any failure exits 1: Railway marks the deployment failed
and keeps the previous deployment serving. The pre-deploy timeout is 300
seconds. The log names the login and its source, never the connection string.

The same command is what to run by hand against a non-Railway host, after
`npm run build`, with the owner connection in `MIGRATION_DATABASE_URL` and the
app's connection in `DATABASE_URL`. The runtime role defaults to the login in
`DATABASE_URL`; set `RUNTIME_DATABASE_ROLE` to override it. The running app
checks `wro_schema_migrations` on startup and does not apply DDL. Existing
legacy distribution tables are preserved and require an explicit migration if
their shape is incompatible. Railway setup, verification queries and the
pre-2026-12-01 dashboard steps are in `docs/railway-deploy.md`.

### 4. Verify

- Open `http://localhost:3000`
- Login via Privy
- Hit `GET /health`
- Create at least one prompt (`/api/scan/prompts`)
- Trigger `POST /api/scan/run`

## Scripts

- `npm run dev` - run with `ts-node`
- `npm run build` - compile TypeScript
- `npm start` - run compiled server
- `npm run db:migrate` - preview schema steps with ts-node; add `-- --apply` to apply locally
- Railway pre-deploy - `node dist/scripts/migrate-database.js --apply` (see `railway.json` and `docs/railway-deploy.md`)
- `npm run typecheck` - TS typecheck
- `npm run lint` - alias for typecheck
- `npm run test` - parser/intake tests
- `npm run check` - lint + test

## Project Structure

```text
client/          # React/Vite/Tailwind dashboard SPA (Lovable design)
src/
├── index.ts     # Entry point
├── server.ts    # Express setup, route mounting, startup, background timers
├── config/      # Env config + deployment-agnostic brand config
├── db/          # Postgres queries + startup ensure*/DDL
├── middleware/  # Privy session auth, internal API key auth, rate limiting
├── routes/      # 18 Express route modules
├── jobs/        # Pipeline + discovery + digest/weekly jobs
├── services/    # Providers, intake, dedup, classify, distribution, CRM
├── scripts/     # Manual CLI tools (dry-runs, one-offs)
├── views/       # Server-rendered login/error pages
├── utils/       # Shared helpers
└── types/       # TypeScript interfaces
```

The **complete annotated file tree** lives in `CLAUDE.md` (File Structure Quick Reference) — kept current there, not duplicated here.

## Main Endpoints

Public:

- `GET /health`
- `GET /ready`
- `GET /`
- `POST /api/auth/callback`
- `POST /resend-link`
- `GET /download`
- `GET /download/:token`
- `POST /api/telegram/intake-webhook` (validated by secret header, not session auth)

Authenticated UI:

- `GET /feeds/:key`
- `GET /dashboard`
- `GET /queue`
- `GET /schedules`
- `GET /settings`

Authenticated API (partial list -- see CLAUDE.md for complete reference):

- `GET /api/models` -- list available AI models
- `GET /api/wires` -- active wire list
- `GET/POST /api/feeds`, `PUT/DELETE /api/feeds/:key`
- `GET/POST/PUT/DELETE /api/schedules(/:id)`, `GET /api/scheduler-status`
- `GET/POST /api/scan/prompts`, `PUT/DELETE /api/scan/prompts/:id`
- `POST /api/scan/prompts/:id/test` -- test a prompt
- `POST /api/scan/prompts/:id/run` -- run a prompt through full intake
- `POST /api/scan/prompts/test` -- test draft prompt text
- `POST /api/scan/prompts/review` -- Ollama prompt review
- `POST /api/scan/run` -- trigger scan execution
- `POST /api/forum/run` -- trigger forum scan
- `POST /api/scan/submit`, `POST /api/scan/submit-batch`, `POST /api/scan/telegram-batch`
- `GET /api/scan/queue`, `GET /api/scan/entries`
- `POST /api/scan/entries/:id/action` -- approve/decline/archive
- `POST /api/scan/entries/bulk-action` -- bulk approve/decline
- `GET /api/scan/stats`, `GET /api/scan/status-counts`, `GET /api/scan/prompt-stats`
- `POST /api/summary-sync`
- `POST /api/process-raw`, `POST /api/enrich`, `POST /api/classify-queue`
- `GET /api/distribution/config`, `PUT /api/distribution/config/:wire/:channel`
- `POST /api/distribution/run/:wire`, `GET /api/distribution/newsletter/:wire`
- `GET /api/distribution/status/:wire`
- `GET /api/scan/entries/:id/distribution`, `POST /api/scan/entries/:id/redistribute`
- `GET/PUT /api/api-providers(/:provider)` -- API key management
- `GET /api/api-usage` -- usage logs
- `GET /api/orgs`, `PUT /api/orgs/:id`, `POST /api/orgs/merge`
- `POST /api/admin/run-migration`, `POST /api/admin/classify-backfill`, etc.
- `GET /api/job/:jobId/progress` -- SSE job progress

## Scheduler Types

Supported schedule types (5):

- `daily-digest` — **the anchor cron**: one cycle runs forum scan + source feeds + (Wednesdays) the BD leads run + digest email + CSV export + the daily CRM cycle (org enrichment, contact discovery, Notion sync — after the email). The digest email's "Closing soon" section is the deadline digest folded in — the standalone `deadline-digest` email was retired 2026-07-09. Fold new periodic work into this cycle instead of adding crons
- `scan-execution`
- `forum-scan`
- `source-feeds`
- `account-monitor`

Notes:

- `frequencyHours` enables sub-daily runs (`1..23`).
- Failed jobs send notification email and retry once after 5 minutes.
- Schedules persist in Postgres and are reloaded on startup.
- Saving a daily-digest schedule auto-derives per-wire AM/PM scan-execution schedules.

## Quality Scoring

Quality scoring is done by the Grok LLM classifier (`src/services/classifier.ts`) in a single API call that classifies entries (GRANT/NEWS/EXPIRED/NOISE), assigns a 0-100 quality score, extracts metadata, and returns an `operator_route`. Current queue/archive behavior is source-specific: scan execution archives `NOISE`, raw background processing queues complete non-duplicates, and Telegram/manual intake uses `operator_route`. The score is a review and ranking signal, not a universal queue threshold.

## Distribution

Per-feed multi-channel distribution of approved entries. Dashboard approvals trigger per-entry distribution by default; `quiet` approvals and internal agent approvals skip distribution. Operators can also run manual batch distribution from the feed dashboard.

Five channel types: **Telegram**, **Discord**, **Slack**, **X/Twitter**, **Newsletter** (copyable markdown).

Channel credentials are managed via the `distribution_channels` table (Settings > Distribution tab in dashboard). Post content is AI-generated by Ollama Cloud (tweet + Telegram HTML), with template fallback on failure. Distribution logs track per-entry send status, and a unique partial index prevents double-posts. Failed sends can be retried individually from the queue page.

## Database Tables (Owned Here)

- `schedules`
- `feeds`
- `scan_entries`
- `seen_urls`
- `seen_names`
- `intake_runs`
- `scan_prompts`
- `generated_files`
- `distribution_channels`
- `distribution_logs`
- `distribution_config` (legacy compatibility path; still read by distribution service)
- `api_providers`
- `api_usage_log`
- `model_pricing`
- `org_profiles`
- `integration_config`

Also read by summary sync bridge:

- `summaries`
- `messages`

## Environment Variables

Required (server will not start without these):

- `DATABASE_URL`
- `NOTIFICATION_EMAIL`
- `PRIVY_APP_ID`
- `PRIVY_APP_SECRET`

Optional API keys (warn on startup; can be set via Settings > API Providers):

- `GROK_API_KEY`
- `OLLAMA_API_KEY`
- `FIRECRAWL_API_KEY`
- `RESEND_API_KEY`

Optional:

- `APP_URL`
- `PORT`
- `STARTUP_LLM_RESCORE_ENABLED` -- opt in to queue-only LLM score repair at startup (default false; may spend API credits)
- `FROM_EMAIL`
- `DIGEST_EMAIL_ENABLED` -- daily WireOps digest email (default on). Set to `false` to skip only that send. The daily-digest schedule still runs scans, feeds, the cohort bridge, CSV export, the CRM cycle, and failure alerts. Unset or any other value keeps the email. A skip is not a failed run and does not send a failure alert.
- `ALLOWED_EMAILS`
- `GROK_SEARCH_MODEL` -- x_search/web_search fallback when the provider model is not a Grok id (default `grok-4.7`). Stored scan-prompt models are unchanged
- `OLLAMA_DEFAULT_MODEL` -- summary primary model (default `deepseek-v4.1-flash`). Used instead of the Ollama provider row's `default_model`
- `OLLAMA_FALLBACK_MODEL` -- summary fallback model (default `glm-5.3-flash`)
- `POST_GEN_MODEL` -- Telegram post draft model (default: `OLLAMA_DEFAULT_MODEL`)
- `POST_VERIFY_MODEL` -- post faithfulness verifier model (default: `OLLAMA_DEFAULT_MODEL`)
- `REPEAT_FUNDER_WINDOW_DAYS` -- hold a funder off Telegram after a successful post (default 30)
- `TELEGRAM_BOT_TOKEN` -- bot token for channel distribution posting
- `DB_SSL_REJECT_UNAUTHORIZED`
- `FORUM_SCAN_ENABLED`
- `FORUM_GRANTS_FEED_ENABLED` -- pre-classified discuss.watch /grants pull in the forum lane (default true)
- `FORUM_GRANTS_MIN_CONFIDENCE` -- min classifier confidence for grants-feed items (default 60)
- `BD_LEADS_DATABASE_ID` -- Notion Paid Work Leads db for the Wednesday BD loop
- `COHORT_BRIDGE_ENABLED` -- in-process Notion cohort bridge in the daily-digest fold (default true; set false to disable)
- `COHORT_NOTION_DATABASE_ID` -- Notion database id of the Cowork + Codex Daily Grant Scans table
- `COHORT_NOTION_TOKEN` -- optional Notion token override; otherwise uses the enabled Notion integration token. That integration must be granted access to the scans table.
- `DISCUSS_WATCH_API_URL`
- `PERPLEXITY_API_KEY` -- for deep web research scans (variant P prompts)

Telegram Intake Bot:

- `TELEGRAM_INTAKE_BOT_TOKEN` -- bot token for the intake bot
- `TELEGRAM_INTAKE_WEBHOOK_SECRET` -- random string for webhook validation
- `TELEGRAM_INTAKE_ALLOWED_USER_ID` -- Telegram user ID of the one sender allowed to submit

Ingestion / Wire Detection:

- `INTAKE_WIRES` -- comma-separated fallback wire list if DB has no active feeds
- `INTAKE_WIRE_KEYWORDS_{WIRE}` -- per-wire keyword overrides (e.g. `INTAKE_WIRE_KEYWORDS_CRYPTO`)

Brand / Deployment Config:

- `BRAND_NAME` -- display name (default: "The Wire Room")
- `BRAND_TAGLINE` -- short descriptor (default: "Intelligence Pipeline")
- `BRAND_COLOR` -- primary accent hex (default: "#2563eb")
- `BRAND_URL` -- base URL of the ops dashboard
- `BRAND_FROM_NAME` -- sender display name for outbound email
- `BRAND_AUDIENCE` -- who reads the content (default: "grant seekers")
- `BRAND_CONTENT_TYPE` -- what is scanned for (default: "grant funding opportunities")
- `BRAND_CONTENT_VERB` -- action word (default: "apply for")

Scoring Overrides:

- `QUALITY_FUNDING_TYPES` -- JSON array override for funding type keywords
- `QUALITY_ACTIONABLE_TYPES` -- JSON array override for actionable type keywords
- `FORUM_SEARCH_TERMS` -- comma-separated search terms override

Watchtower Discovery Layer (Phase 0) -- all default-safe:

- `WATCHTOWER_BUDGET_MONTHLY_USD` -- monthly discovery spend cap in USD (default: 20)
- `X_LISTS_ENABLED` -- enable the X list watcher lane (default: false)
- `X_LISTS_DRY_RUN` -- log without submitting to intake (default: true)
- `X_LIST_IDS` -- comma-separated wire:listId pairs, e.g. "crypto:123,ai:456,oss:789"

Watchtower Registry Watch (Phase 1) -- all default-safe:

- `REGISTRY_WATCH_ENABLED` -- enable the registry watch lane (default: false). Before enabling in a new environment, seed baselines first: `railway run -- npx ts-node src/scripts/registry-watch-dryrun.ts` writes hashes/watermarks (state-writing, intake-free) so the first real pass doesn't treat an org's whole existing backlog as "fresh"
- `REGISTRY_WATCH_DRY_RUN` -- log without submitting to intake (default: true). A dry run still stores the page hash and the seen-URL watermark, and writes the would-submit list for `GET /api/registry-watch/pending`. The first check of a page does not extract. A later change extracts once, then the stored hash skips that page until it changes again.
- `REGISTRY_WATCH_LIVE_SINCE` -- optional ISO timestamp. The first live run uses it as the cutoff and then remembers it. Unset: that run stamps the current time.
- `REGISTRY_WATCH_SUBMIT_BACKLOG` -- set to `true` only for the first live run if that run should submit the backlog anyway. It does not replay URLs a dry run already marked seen. Leave it unset after that run.
- `REGISTRY_WATCH_RSS_CAP` -- max rss-lane surfaces polled per run (default: 60)
- `REGISTRY_WATCH_DIFF_CAP` -- max html_diff-lane surfaces polled per run (default: 80). Tier-1/2 diff-eligible surfaces can exceed one run's cap; the scheduler calls this job from both the `source-feeds` and `daily-digest` branches, so a normal day's two runs still clear the backlog. Dead/blocked source URLs increment a surface's `failure_streak` instead of erroring out the run -- that's the registry's health signal working as designed, not a bug to chase
- `REGISTRY_WATCH_EXTRACT_CAP` -- max LLM extractions per run, budget-gated (default: 10)

### How to take registry watch live

The lane can stay in dry run while the pending list is reviewed. `REGISTRY_WATCH_DRY_RUN` stays `true` until the steps below. Nothing here turns on the account monitor or sends a Telegram post.

1. Deploy this code with `REGISTRY_WATCH_ENABLED=true` and `REGISTRY_WATCH_DRY_RUN=true` (the default). The migration retargets Gitcoin to `https://gitcoin.co/campaigns` and Octant to `https://octant.substack.com/feed`. `fil.org` is scraped once per check and is not plain-fetched.
2. After the next dry run, read `GET /api/registry-watch/pending` with a curator token (`read_queue`). Each item has `title`, `url`, `org`, `wire`, and `reason`. Edit a bad page with `PUT /api/registry-watch/surfaces/:id`.
3. Dry runs mark those URLs seen and store page hashes. The same unchanged page is not extracted again. The pending list is a review copy. A later quiet run keeps it (`lastRunItemCount` 0). It is not a queue that drains on go-live.
4. To go live, set `REGISTRY_WATCH_DRY_RUN=false` and redeploy. The first live run records `registry-watch:live-since` (or `REGISTRY_WATCH_LIVE_SINCE` if you set that first) and submits only items published at or after that time. Undated items on that first run are marked seen and not submitted.
5. To submit that backlog instead, set `REGISTRY_WATCH_SUBMIT_BACKLOG=true` before the first live run, then remove it. URLs a dry run already stored under `ws:seen:*` stay seen either way.

The budget meter covers Grok discovery purposes and X reads; Firecrawl and Perplexity spend are outside it.

## Multi-Channel Ingestion

Entries can be submitted through multiple channels using the adapter pattern:

- **Telegram bot**: Send a URL or text to the intake bot. Wire is auto-detected from keywords (defaults to crypto if ambiguous). Supports single URLs and batch messages. Requires `TELEGRAM_INTAKE_BOT_TOKEN`. Only the allowed user ID can submit.

  Setup: (1) create a bot via @BotFather, (2) set `TELEGRAM_INTAKE_BOT_TOKEN`, `TELEGRAM_INTAKE_WEBHOOK_SECRET` (any random string), and `TELEGRAM_INTAKE_ALLOWED_USER_ID`, (3) deploy — the bot auto-registers its webhook at `{APP_URL}/api/telegram/intake-webhook` on startup. Optional: if the token is not set, the webhook route is a no-op.
- **Manual paste**: Submit via the dashboard (existing `/api/scan/submit` and `/api/scan/submit-batch` endpoints).
- **Future adapters**: Slack, Discord, email inbound -- same `intake-core.ts` interface for ingestion (distribution to Slack/Discord channels already works).

The intake core (`src/services/intake-core.ts`) is channel-agnostic: it accepts an `IntakeMessage`, extracts URLs, detects the target wire via per-wire keyword scoring, and inserts a raw `scan_entry`. Channel adapters (like `telegram-adapter.ts`) handle protocol-specific concerns (webhook validation, reply formatting) and delegate to the core.

## Architecture

The `client/` directory contains a React/Vite/Tailwind frontend (Lovable wireops-dashboard design). For authenticated routes, the server serves `dist/client/index.html` as a SPA. Only login and error pages are server-rendered (views in `src/views/`).

## Deploying for a New Vertical

To run this engine for a different vertical (e.g. consulting leads, research intel):

1. Set brand env vars (`BRAND_NAME`, `BRAND_AUDIENCE`, `BRAND_CONTENT_TYPE`, `BRAND_CONTENT_VERB`, …)
2. Create feeds for your verticals via `POST /api/feeds` (e.g. "enterprise", "startup", "government")
3. Set per-wire keyword overrides if the defaults don't fit (`INTAKE_WIRE_KEYWORDS_{WIRE}`)
4. Optionally override scoring keywords (`QUALITY_FUNDING_TYPES`, `QUALITY_ACTIONABLE_TYPES`)
5. Write scan prompts for the new domain and load via `/api/scan/prompts`
6. Configure distribution channels per wire — same engine, different config

## Development Notes

- TypeScript strict mode, CommonJS output.
- Sessions are DB-backed and survive deploys. Magic links, download tokens, rate-limit state, and job progress are in-memory and reset on restart.
- Wire list is DB-driven (from `feeds` table), not hardcoded. Fallback via `INTAKE_WIRES` env var.
- Brand/audience config is env-var driven via `src/config/brand.ts` — AI prompts, emails, and scoring use `getBrand()` instead of hardcoded values.
- The queue/status model is the publication contract with distribution channels (Telegram, X, newsletter, email).

### Repair missing program organization links

The runtime fills a missing `programs.org_id` only when its organization name exactly
matches one profile, an approved nonduplicate member already links that profile, and
no member has a conflicting organization or curator hold. Existing links are preserved.
This carries forward recorded editorial relationships; it does not merge organizations
or turn the operational program table into a vetted public registry.

The operator can review the same rules across historical records with
`npx ts-node src/scripts/program-org-links.ts`. After reviewing that dry run, apply its
exact plan with `--apply --expect-plan-hash=<reviewed hash>`. The repair locks the relevant
tables briefly and aborts if the plan has changed. Use an owner connection for that repair;
normal runtime reconciliation uses the restricted application's existing grants.
