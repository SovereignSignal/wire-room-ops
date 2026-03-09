# Wire Room Ops

Backend pipeline and admin dashboard for an intelligence-to-distribution system. Discovers, ingests, deduplicates, scores, and queues entries for operator review, then distributes approved entries across multiple channels.

Deployed as The Wire Room (grants wire) but designed to be deployment-agnostic — swap brand config and prompts to run any vertical (consulting leads, research intel, etc.).

## Current Scope (March 2026)

- Scan execution (X search, web search, forum scanning)
- Multi-channel ingestion (Telegram bot, manual paste, API)
- Intake pipeline (parse -> dedup -> quality score -> queue)
- Queue review + approval workflow
- Multi-channel distribution (Telegram, X/Twitter, newsletter)
- React dashboard (Lovable design) + server-rendered login
- Schedule management, summary sync bridge, model listing, email alerts
- Deployment-agnostic brand/audience configuration

## Core Workflow

1. Prompts are stored in `scan_prompts`.
2. `scan-execution` (or manual trigger) calls Grok Responses API (`x_search` / `web_search`).
3. Results are parsed into structured entries.
4. Intake pipeline inserts raw rows, deduplicates against `seen_urls` + `seen_names`, scores quality, and moves entries to `queued` or `archived`.
5. Operator reviews queue in dashboard and sets action:
   - `approve` -> `status = 'approved'`
   - `decline` -> `status = 'declined'`
   - `reviewlater` -> `status = 'skipped'`
6. Operator triggers distribution from the feed page -- approved entries are sent to configured channels (Telegram, X/Twitter, newsletter).
7. The Wire Room frontend reads approved rows directly from `scan_entries`.

## Features

- Privy-authenticated dashboard (email allowlist support)
- React/Vite/Tailwind frontend (Lovable satellite array design) for authenticated routes
- Server-rendered login/error pages with deep space theme and starfield animation
- Deployment-agnostic brand config (audience, content type, scoring keywords — all env-var driven)
- Dynamic feeds (DB-driven wire list, not hardcoded)
- Telegram intake bot for URL/article submissions via webhook
- Channel-agnostic intake core with adapter pattern (Telegram today, Slack/Discord future)
- Prompt CRUD + test execution + prompt lab
- Automated scan runs with SSE progress updates
- Forum scanning via discuss.watch (search terms overrideable via env var)
- Intake scoring + dedup stats + prompt effectiveness stats
- Quality scorer with overrideable funding/actionable type keywords
- Scheduler with per-schedule health and retry-on-failure behavior
- Summary sync bridge (`summaries` -> approved `scan_entries`, DB-driven wire list)
- Multi-channel distribution (Telegram, X/Twitter, newsletter markdown)
- AI-generated posts via Claude Sonnet with template fallback
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

Required env vars:

- `DATABASE_URL`
- `ANTHROPIC_API_KEY`
- `GROK_API_KEY`
- `FIRECRAWL_API_KEY`
- `RESEND_API_KEY`
- `NOTIFICATION_EMAIL`
- `PRIVY_APP_ID`
- `PRIVY_APP_SECRET`

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
│   ├── daily-intake.ts
│   ├── forum-scan.ts
│   ├── scan-execution.ts
│   └── summary-sync.ts
├── services/
│   ├── anthropic.ts
│   ├── auth.ts
│   ├── dedup.ts
│   ├── distribution.ts
│   ├── email.ts
│   ├── forum.ts
│   ├── grok.ts
│   ├── intake.ts
│   ├── intake-core.ts      # Channel-agnostic intake logic (URL extraction, wire detection, DB insert)
│   ├── job-queue.ts
│   ├── models.ts
│   ├── post-generator.ts
│   ├── processor.ts
│   ├── quality-scorer.ts
│   ├── scan-stats.ts
│   ├── scheduler.ts
│   ├── scraper.ts
│   ├── storage.ts
│   ├── telegram-adapter.ts  # Telegram intake bot adapter (webhook handler, inline keyboard)
│   ├── telegram-channel.ts
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
    ├── feed.ts
    ├── login.ts            # Server-rendered (Privy + starfield animation)
    ├── queue.ts
    ├── settings.ts
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

Authenticated API:

- `GET /api/models`
- `GET /api/wires`
- `GET /api/feeds`
- `POST /api/feeds`
- `PUT /api/feeds/:key`
- `DELETE /api/feeds/:key`
- `GET /api/files`
- `GET /api/schedules`
- `POST /api/schedules`
- `PUT /api/schedules/:id`
- `DELETE /api/schedules/:id`
- `GET /api/scheduler-status`
- `POST /api/test-alert`
- `GET /api/scan/prompts`
- `POST /api/scan/prompts`
- `PUT /api/scan/prompts/:id`
- `DELETE /api/scan/prompts/:id`
- `POST /api/scan/prompts/:id/test`
- `POST /api/scan/run`
- `POST /api/forum/run`
- `POST /api/scan/submit`
- `POST /api/scan/submit-batch`
- `GET /api/scan/queue`
- `GET /api/scan/entries`
- `POST /api/scan/entries/:id/action`
- `GET /api/scan/stats`
- `GET /api/scan/status-counts`
- `GET /api/scan/seen-urls`
- `GET /api/scan/prompt-stats`
- `POST /api/summary-sync`
- `GET /api/distribution/config`
- `PUT /api/distribution/config/:wire/:channel`
- `POST /api/distribution/run/:wire`
- `GET /api/distribution/newsletter/:wire`
- `GET /api/distribution/status/:wire`
- `GET /api/scan/entries/:id/distribution`
- `POST /api/scan/entries/:id/redistribute`
- `GET /api/job/:jobId/progress`

## Scheduler Types

Supported schedule types:

- `scan-execution`
- `forum-scan`

Notes:

- `frequencyHours` enables sub-daily runs (`1..23`).
- Failed jobs send notification email and retry once after 5 minutes.
- Schedules persist in Postgres and are reloaded on startup.

## Scan Quality Scoring

`src/services/quality-scorer.ts` scores entries 0-100 using signals like:

- amount presence/size
- deadline quality (rolling/upcoming/expired)
- funding/actionability keywords
- governance-noise and stale-award penalties

Default intake threshold is `40` (`queued` if >= 40, else `archived`).

## Distribution

Per-feed multi-channel distribution of approved entries. Triggered manually from the feed dashboard (not auto-on-approve).

Channels:

- **Telegram** -- Posts HTML to a channel via Bot API. Requires `TELEGRAM_BOT_TOKEN` env var; channel ID configured per wire.
- **X/Twitter** -- Tweets via `twitter-api-v2`. OAuth credentials stored per wire in `distribution_config`.
- **Newsletter** -- Generates copyable markdown digest of undistributed approved entries.

Post content is AI-generated by Claude Sonnet (tweet + Telegram HTML), with template fallback on failure. Distribution logs track per-entry send status, and a unique partial index prevents double-posts. Failed sends can be retried individually from the queue page.

## Database Tables (Owned Here)

- `schedules`
- `feeds`
- `scan_entries`
- `seen_urls`
- `seen_names`
- `intake_runs`
- `scan_prompts`
- `generated_files`
- `distribution_config`
- `distribution_logs`

Also read by summary sync bridge:

- `summaries`
- `messages`

## Environment Variables

Required:

- `DATABASE_URL`
- `ANTHROPIC_API_KEY`
- `GROK_API_KEY`
- `FIRECRAWL_API_KEY`
- `RESEND_API_KEY`
- `NOTIFICATION_EMAIL`
- `PRIVY_APP_ID`
- `PRIVY_APP_SECRET`

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
- **Future adapters**: Slack, Discord, email — same `intake-core.ts` interface.

The intake core (`src/services/intake-core.ts`) is channel-agnostic: it accepts an `IntakeMessage`, extracts URLs, detects the target wire via per-wire keyword scoring, and inserts a raw `scan_entry`. Channel adapters (like `telegram-adapter.ts`) handle protocol-specific concerns (webhook validation, inline keyboards, etc.) and delegate to the core.

## Architecture

The `client/` directory contains a React/Vite/Tailwind frontend (Lovable wireops-dashboard design). For authenticated routes, the server serves `dist/client/index.html` as a SPA. Only login and error pages are server-rendered (views in `src/views/`).

## Development Notes

- TypeScript strict mode, CommonJS output.
- In-memory stores are used for sessions/tokens/job-progress and are reset on restart.
- Wire list is DB-driven (from `feeds` table), not hardcoded. Fallback via `INTAKE_WIRES` env var.
- Brand/audience config is env-var driven via `src/config/brand.ts` — AI prompts, emails, and scoring use `getBrand()` instead of hardcoded values.
- The queue/status model is the publication contract with the frontend site.
