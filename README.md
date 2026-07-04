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
6. Operator triggers distribution from the feed page -- approved entries are sent to configured channels (Telegram, Discord, Slack, X/Twitter, newsletter).
7. Approved entries can be distributed to configured channels (Telegram, Discord, Slack, X, newsletter/email). Dashboard approvals auto-distribute unless `quiet` is used; internal agent approvals are quiet by default. Note: the-wire-room frontend (thewireroom.xyz) is deprecated; distribution now goes directly to channels under the Sovereign Signal brand.

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
- AI-generated posts via Claude Sonnet 4.6 with template fallback
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

- `ANTHROPIC_API_KEY`
- `GROK_API_KEY`
- `FIRECRAWL_API_KEY`
- `RESEND_API_KEY`

### 3. Run

```bash
npm run dev
```

Production:

```bash
npm run build
npm start
```

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
- `POST /api/scan/prompts/review` -- Claude-based prompt review
- `POST /api/scan/run` -- trigger scan execution
- `POST /api/forum/run` -- trigger forum scan
- `POST /api/scan/submit`, `POST /api/scan/submit-batch`
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

Supported schedule types (6):

- `daily-digest` — **the anchor cron**: one cycle runs forum scan + source feeds + (Wednesdays) the BD leads run + (Fridays) the weekly issue + digest email + CSV export + the daily CRM cycle (org enrichment, contact discovery, Notion sync — after the email). Fold new periodic work into this cycle instead of adding crons
- `scan-execution`
- `forum-scan`
- `source-feeds`
- `deadline-digest`
- `account-monitor`

Notes:

- `frequencyHours` enables sub-daily runs (`1..23`).
- Failed jobs send notification email and retry once after 5 minutes.
- Schedules persist in Postgres and are reloaded on startup.
- Saving a daily-digest schedule auto-derives per-wire AM/PM scan-execution schedules.

## Quality Scoring

Quality scoring is done by the Grok LLM classifier (`src/services/classifier.ts`) in a single API call that classifies entries (GRANT/NEWS/EXPIRED/NOISE), assigns a 0-100 quality score, extracts metadata, and returns an `operator_route`. Current queue/archive behavior is source-specific: scan execution archives `NOISE`, raw background processing queues complete non-duplicates, and Telegram/manual intake uses `operator_route`. The score is a review and ranking signal, not a universal queue threshold.

The legacy rule-based scorer (`src/services/quality-scorer.ts`) is still in the codebase but is no longer used in the main pipeline.

## Distribution

Per-feed multi-channel distribution of approved entries. Dashboard approvals trigger per-entry distribution by default; `quiet` approvals and internal agent approvals skip distribution. Operators can also run manual batch distribution from the feed dashboard.

Five channel types: **Telegram**, **Discord**, **Slack**, **X/Twitter**, **Newsletter** (copyable markdown).

Channel credentials are managed via the `distribution_channels` table (Settings > Distribution tab in dashboard). Post content is AI-generated by Claude Sonnet 4.6 (tweet + Telegram HTML), with template fallback on failure. Distribution logs track per-entry send status, and a unique partial index prevents double-posts. Failed sends can be retried individually from the queue page.

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

- `ANTHROPIC_API_KEY`
- `GROK_API_KEY`
- `FIRECRAWL_API_KEY`
- `RESEND_API_KEY`

Optional:

- `APP_URL`
- `PORT`
- `FROM_EMAIL`
- `ALLOWED_EMAILS`
- `TELEGRAM_BOT_TOKEN` -- bot token for channel distribution posting
- `DB_SSL_REJECT_UNAUTHORIZED`
- `FORUM_SCAN_ENABLED`
- `BD_LEADS_DATABASE_ID` -- Notion Paid Work Leads db for the Wednesday BD loop
- `DISCUSS_WATCH_API_URL`
- `PERPLEXITY_API_KEY` -- for deep web research scans (variant P prompts)

Telegram Intake Bot:

- `TELEGRAM_INTAKE_BOT_TOKEN` -- bot token for intake bot (@GrantWireSummarizer_bot)
- `TELEGRAM_INTAKE_WEBHOOK_SECRET` -- random string for webhook validation
- `TELEGRAM_INTAKE_ALLOWED_USER_ID` -- Telegram user ID of allowed sender (default: 394395765)

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
- `REGISTRY_WATCH_DRY_RUN` -- log without submitting to intake (default: true)
- `REGISTRY_WATCH_RSS_CAP` -- max rss-lane surfaces polled per run (default: 60)
- `REGISTRY_WATCH_DIFF_CAP` -- max html_diff-lane surfaces polled per run (default: 80). Tier-1/2 diff-eligible surfaces can exceed one run's cap; the scheduler calls this job from both the `source-feeds` and `daily-digest` branches, so a normal day's two runs still clear the backlog. Dead/blocked source URLs increment a surface's `failure_streak` instead of erroring out the run -- that's the registry's health signal working as designed, not a bug to chase
- `REGISTRY_WATCH_EXTRACT_CAP` -- max LLM extractions per run, budget-gated (default: 10)

## Multi-Channel Ingestion

Entries can be submitted through multiple channels using the adapter pattern:

- **Telegram bot** (`@GrantWireSummarizer_bot`): Send a URL or text to the bot. Wire is auto-detected from keywords (defaults to crypto if ambiguous). Supports single URLs and batch messages. Requires `TELEGRAM_INTAKE_BOT_TOKEN`. Only the allowed user ID can submit.

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
