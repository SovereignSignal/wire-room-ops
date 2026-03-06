# Wire Room Ops

Backend pipeline and admin dashboard for The Wire Room editorial workflow.

This service discovers opportunities (X/web/forum), runs intake (parse -> dedup -> quality score), queues items for review, and marks approved entries in `scan_entries` so the public site can publish them.

## Current Scope (March 2026)

- Includes: scan execution, intake pipeline, queue review, schedule management, summary sync bridge, multi-channel distribution (Telegram/X/newsletter), model listing, email alerts.

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
- Dynamic feeds (`crypto`, `ai`, `oss`, plus custom)
- Prompt CRUD + test execution
- Automated scan runs with SSE progress updates
- Forum scanning via discuss.watch
- Intake scoring + dedup stats + prompt effectiveness stats
- Scheduler with per-schedule health and retry-on-failure behavior
- Summary sync bridge (`summaries` -> approved `scan_entries`)
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
src/
├── index.ts
├── server.ts
├── config/index.ts
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
│   ├── job-queue.ts
│   ├── models.ts
│   ├── post-generator.ts
│   ├── processor.ts
│   ├── quality-scorer.ts
│   ├── scan-stats.ts
│   ├── scheduler.ts
│   ├── scraper.ts
│   ├── storage.ts
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
    ├── login.ts
    ├── queue.ts
    ├── settings.ts
    └── shared.ts
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
- `TELEGRAM_BOT_TOKEN`
- `DB_SSL_REJECT_UNAUTHORIZED`
- `FORUM_SCAN_ENABLED`
- `DISCUSS_WATCH_API_URL`

## Development Notes

- TypeScript strict mode, CommonJS output.
- In-memory stores are used for sessions/tokens/job-progress and are reset on restart.
- The queue/status model is the publication contract with the frontend site.
