# Wire Room Ops

Backend pipeline and admin dashboard for an intelligence-to-distribution system. Discovers, ingests, deduplicates, scores, and queues entries for operator review, then distributes approved entries across multiple channels.

Deployed as The Wire Room (grants wire) but designed to be deployment-agnostic — swap brand config and prompts to run any vertical (consulting leads, research intel, etc.).

## Current Scope (March 2026)

- Scan execution (X search, web search, Perplexity deep web, Reddit+HN community, forum scanning)
- Multi-channel ingestion (Telegram bot, manual paste, API)
- Intake pipeline (parse -> dedup -> LLM classify + score -> queue)
- Queue review + approval workflow with pre-approval validation
- Multi-channel distribution (Telegram, Discord, Slack, X/Twitter, newsletter)
- React dashboard (Lovable design) + server-rendered login
- DB-backed API key management with env var fallback
- Org profile management (extraction, enrichment, merge, Notion sync)
- Schedule management, summary sync bridge, model listing, email alerts
- Deployment-agnostic brand/audience configuration

## Core Workflow

1. Prompts are stored in `scan_prompts` with a `tool_type` (x_search, web_search, perplexity, community).
2. `scan-execution` (or manual trigger) routes to the correct provider per tool_type.
3. Results are parsed into structured entries via 4 parser strategies.
4. Intake pipeline inserts raw rows, deduplicates against `seen_urls` + `seen_names`, classifies + scores via LLM (Grok), and moves entries to `queued` or `archived`.
5. Operator reviews queue in dashboard and sets action:
   - `approve` -> `status = 'approved'`
   - `decline` -> `status = 'declined'`
   - `reviewlater` -> `status = 'skipped'`
6. Operator triggers distribution from the feed page -- approved entries are sent to configured channels (Telegram, Discord, Slack, X/Twitter, newsletter).
7. The Wire Room frontend reads approved rows directly from `scan_entries`.

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
- Summary sync bridge (`summaries` -> approved `scan_entries`, DB-driven wire list)
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
client/                     # React/Vite/Tailwind frontend (Lovable design)
├── src/                    # Served at dist/client/ for authenticated routes
├── vite.config.ts
└── ...
src/
├── index.ts
├── server.ts
├── config/
│   ├── index.ts            # Environment variables and validation
│   └── brand.ts            # Deployment-agnostic brand config (env-var driven)
├── db/index.ts
├── jobs/
│   ├── daily-digest.ts     # Daily digest email aggregation
│   ├── daily-intake.ts     # Intake pipeline orchestrator (dedup -> classify -> queue)
│   ├── enrichment.ts       # Enriches thin entries by scraping + regenerating summaries
│   ├── forum-scan.ts       # Forum scan orchestrator (discuss.watch -> intake)
│   ├── process-raw.ts      # Background job to process raw entries through pipeline
│   ├── scan-execution.ts   # Scan execution (prompt -> Grok/Perplexity/Community -> intake)
│   └── summary-sync.ts     # Sync tele-sum summaries into scan_entries
├── services/
│   ├── anthropic.ts        # Claude API (summarization, prompt review)
│   ├── api-provider.ts     # DB-backed API key management with env var fallback
│   ├── api-usage.ts        # Fire-and-forget API usage logging + cost estimation
│   ├── approval-guard.ts   # Pre-approval validation
│   ├── auth.ts
│   ├── classifier.ts       # LLM classifier (GRANT/NEWS/EXPIRED/NOISE + quality score)
│   ├── community.ts        # Reddit + Hacker News search (no auth needed)
│   ├── dedup.ts
│   ├── discord-channel.ts  # Discord channel posting (distribution)
│   ├── distribution.ts     # Distribution orchestrator (5 channel types)
│   ├── email.ts
│   ├── forum.ts
│   ├── grok.ts             # Grok Chat + Responses API
│   ├── intake.ts           # 4-strategy parser + sanitizeResult()
│   ├── intake-core.ts      # Channel-agnostic intake logic
│   ├── job-queue.ts
│   ├── models.ts           # Dynamic model fetching (Grok, Anthropic, Perplexity)
│   ├── notion-sync.ts      # Notion CRM sync (DB-backed config)
│   ├── operator-signals.ts # Feedback loop from approve/decline decisions
│   ├── org-enricher.ts     # LLM-based org profile enrichment
│   ├── org-extractor.ts    # Extract org names from entries
│   ├── org-merge.ts        # Merge duplicate org profiles
│   ├── perplexity.ts       # Perplexity API (deep web research scans)
│   ├── post-generator.ts   # Claude Sonnet post generation (tweet + Telegram)
│   ├── processor.ts
│   ├── quality-scorer.ts   # Legacy rule-based scorer (replaced by LLM classifier)
│   ├── scan-stats.ts
│   ├── scheduler.ts
│   ├── scraper.ts
│   ├── storage.ts
│   ├── telegram-adapter.ts # Telegram intake bot adapter
│   ├── telegram-channel.ts # Telegram channel posting (distribution)
│   └── x-client.ts
├── types/
│   ├── index.ts
│   └── intake.ts
├── utils/
│   ├── async.ts
│   ├── html.ts
│   └── url.ts
└── views/
    ├── error.ts
    ├── login.ts            # Server-rendered (Privy + starfield animation)
    └── shared.ts           # Page shell (deep space palette, Orbitron headings)
```

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

Supported schedule types:

- `scan-execution`
- `forum-scan`
- `daily-digest`

Notes:

- `frequencyHours` enables sub-daily runs (`1..23`).
- Failed jobs send notification email and retry once after 5 minutes.
- Schedules persist in Postgres and are reloaded on startup.

## Quality Scoring

Quality scoring is done by the Grok LLM classifier (`src/services/classifier.ts`) in a single API call that classifies entries (GRANT/NEWS/EXPIRED/NOISE) and assigns a 0-100 quality score. NOISE entries are archived; entries scoring >= 40 are queued for review.

The legacy rule-based scorer (`src/services/quality-scorer.ts`) is still in the codebase but is no longer used in the main pipeline.

## Distribution

Per-feed multi-channel distribution of approved entries. Triggered manually from the feed dashboard (not auto-on-approve).

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
- `distribution_config` (legacy, unused)
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

## Multi-Channel Ingestion

Entries can be submitted through multiple channels using the adapter pattern:

- **Telegram bot** (`@GrantWireSummarizer_bot`): Send a URL or text to the bot. Wire is auto-detected from keywords; if ambiguous, the bot presents an inline keyboard for wire selection. Requires `TELEGRAM_INTAKE_BOT_TOKEN`. Only the allowed user ID can submit.
- **Manual paste**: Submit via the dashboard (existing `/api/scan/submit` and `/api/scan/submit-batch` endpoints).
- **Future adapters**: Slack, Discord, email inbound -- same `intake-core.ts` interface for ingestion (distribution to Slack/Discord channels already works).

The intake core (`src/services/intake-core.ts`) is channel-agnostic: it accepts an `IntakeMessage`, extracts URLs, detects the target wire via per-wire keyword scoring, and inserts a raw `scan_entry`. Channel adapters (like `telegram-adapter.ts`) handle protocol-specific concerns (webhook validation, inline keyboards, etc.) and delegate to the core.

## Architecture

The `client/` directory contains a React/Vite/Tailwind frontend (Lovable wireops-dashboard design). For authenticated routes, the server serves `dist/client/index.html` as a SPA. Only login and error pages are server-rendered (views in `src/views/`).

## Development Notes

- TypeScript strict mode, CommonJS output.
- In-memory stores are used for sessions/tokens/job-progress and are reset on restart.
- Wire list is DB-driven (from `feeds` table), not hardcoded. Fallback via `INTAKE_WIRES` env var.
- Brand/audience config is env-var driven via `src/config/brand.ts` — AI prompts, emails, and scoring use `getBrand()` instead of hardcoded values.
- The queue/status model is the publication contract with the frontend site.
