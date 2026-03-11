# CLAUDE.md - AI Context for Wire Room Ops

This file provides context for AI assistants working with this codebase.

## Project Overview

**Wire Room Ops** is a Node.js/TypeScript application that powers the backend pipeline and admin dashboard for an intelligence-to-distribution system. It discovers entries from multiple sources (X, web, forums, Telegram intake), runs them through an intake pipeline (parse, dedup, quality score), queues them for operator review, and distributes approved entries across configured channels.

The system is deployment-agnostic: brand, audience, content type, and scoring keywords are all env-var driven via `src/config/brand.ts`. The default deployment is The Wire Room (grants across crypto, AI, OSS beats), but the same engine can run any vertical by swapping config.

Wire lists are DB-driven (from the `feeds` table), not hardcoded.

## Multi-Repo Architecture

This backend is one half of a two-repo system:

| Repo | Role | Location |
|------|------|----------|
| `wire-room-ops` (this repo) | Backend pipeline + admin dashboard | `~/GitHub/wire-room-ops` |
| `the-wire-room` | Public-facing Next.js website | `~/GitHub/the-wire-room` |

Both repos share the **same PostgreSQL database**. This repo writes to it; the Wire Room reads from it.

### Approve = Publish Flow

When an operator clicks "Approve" on a queued scan entry (via the dashboard), the entry's status changes to `approved`. The Wire Room frontend queries `scan_entries WHERE status = 'approved'` to display entries on thewireroom.xyz. There is no separate publish step.

The Wire Room reads these columns from `scan_entries`: `id`, `name`, `description`, `source_url`, `amount`, `deadline`, `wire`, `quality_score`, `scan_source`, `created_at`.

The Wire Room queries with `WHERE status = 'approved'` (optionally `AND wire = $1` for beat filtering), ordered by `created_at DESC` with `LIMIT/OFFSET` pagination. A partial index `idx_scan_entries_approved` on `(wire, created_at DESC) WHERE status = 'approved'` optimizes both filtered and unfiltered query paths.

## Key Architecture Decisions

### Deployment-Agnostic Brand Config
- `src/config/brand.ts` exports `getBrand()` with audience, contentType, contentVerb, and UI settings
- All AI prompts (Grok, Claude, Perplexity), quality scorer keywords, and email templates use `getBrand()` instead of hardcoded values
- Override per deployment via `BRAND_AUDIENCE`, `BRAND_CONTENT_TYPE`, `BRAND_CONTENT_VERB`, etc.

### Dual AI Processing
- **Grok API** handles X.com/Twitter URLs because it has native access to tweet content
- **Claude API** handles all other URLs, using Firecrawl for web scraping
- This routing happens in `src/services/processor.ts` which imports `isXcomUrl()` from `src/services/grok.ts`

### Storage Strategy
- **Generated files** and **schedule configs** are persisted to Postgres (survive restarts)
- **Sessions, tokens, and job queues** are stored in-memory (reset on restart)
- Single-instance deployment only

### Privy Authentication
Dashboard login is handled via Privy (social/email auth). On successful Privy login, the server verifies the JWT, fetches the user's email from Privy, and checks it against an allowlist: `NOTIFICATION_EMAIL` (always allowed) plus an optional `ALLOWED_EMAILS` env var (comma-separated). Sessions last 24 hours via HttpOnly cookies.

## File Structure Quick Reference

```
client/                       # React/Vite/Tailwind frontend (Lovable wireops-dashboard design)
├── src/                      # Served at dist/client/ for all authenticated routes
├── vite.config.ts
└── ...
src/
├── index.ts              # Entry point - validates config, starts server
├── server.ts             # Express routes (includes scan, distribution, feed, schedule, intake APIs)
├── config/
│   ├── index.ts          # Environment variables and validation
│   └── brand.ts          # Deployment-agnostic brand config (audience, contentType, contentVerb)
├── db/index.ts           # Postgres queries, schedules, feeds, scan tables, scan prompts, distribution tables
├── jobs/
│   ├── daily-intake.ts     # Scan intake pipeline orchestrator (parse -> dedup -> classify -> queue)
│   ├── scan-execution.ts   # Automated scan execution (prompt fetch -> Grok -> intake)
│   ├── forum-scan.ts       # Forum scan orchestrator (discuss.watch -> intake, DB-driven wire list)
│   └── summary-sync.ts     # Sync tele-sum summaries into scan_entries as approved (7-day lookback)
├── migrations/
│   └── cleanup-approved-data.ts  # One-time data cleanup for existing bad entries
├── services/
│   ├── anthropic.ts      # Claude API calls with scraping integration (uses getBrand())
│   ├── approval-guard.ts   # Pre-approval validation (blocks bad data from reaching website)
│   ├── auth.ts           # Session tokens, download tokens, cleanup timers
│   ├── dedup.ts            # URL exact-match and fuzzy name deduplication
│   ├── distribution.ts     # Distribution orchestrator: send entries to channels, retry, newsletter
│   ├── email.ts            # Resend email templates (5 types)
│   ├── forum.ts            # discuss.watch API client (search terms overrideable via FORUM_SEARCH_TERMS)
│   ├── grok.ts             # Grok Chat + Responses API for X.com content and scans (uses getBrand())
│   ├── intake.ts           # Scan result parser, URL/name normalization
│   ├── intake-core.ts      # Channel-agnostic intake logic (URL extraction, wire detection, DB insert)
│   ├── job-queue.ts        # SSE-based job progress tracking
│   ├── models.ts           # Dynamic model fetching from both APIs
│   ├── post-generator.ts   # Claude Sonnet AI generates tweet + Telegram HTML per entry
│   ├── processor.ts        # Entry processing with retry logic
│   ├── quality-scorer.ts   # 0-100 quality scoring (FUNDING_TYPES/ACTIONABLE_TYPES overrideable via env)
│   ├── scan-stats.ts       # Prompt effectiveness and overlap metrics
│   ├── scheduler.ts        # node-cron scheduling with health tracking (DB-driven wire list)
│   ├── scraper.ts          # Firecrawl integration, URL resolution
│   ├── storage.ts          # Postgres-backed file storage with in-memory cache (keeps last 10)
│   ├── telegram-adapter.ts # Telegram intake bot adapter (webhook handler, inline keyboard)
│   ├── telegram-channel.ts # Telegram Bot API posting to channels (distribution)
│   └── x-client.ts         # Twitter/X posting via twitter-api-v2
├── views/                    # Server-rendered pages (login + error only; dashboard is React SPA)
│   ├── shared.ts         # Page shell, deep space palette, Orbitron headings, signal cyan accent
│   ├── login.ts          # Privy login page with starfield canvas animation
│   └── error.ts          # Error/download/expired link pages
├── utils/
│   ├── async.ts          # Shared sleep() utility
│   ├── html.ts           # Shared escapeHtml() utility
│   └── url.ts            # Shared normalizeUrl() for URL deduplication
└── types/
    ├── index.ts          # Core TypeScript interfaces
    └── intake.ts         # Scan pipeline + distribution types (ScanEntry, DistributionConfig, etc.)
```

## Common Tasks

### Adding a New API Endpoint
1. Add route in `src/server.ts`
2. For authenticated routes, use the `requireAuth` middleware (validates HttpOnly session cookie)
3. Return JSON for `/api/*` routes

### Modifying the Dashboard UI
The dashboard uses a **dual architecture**:
- **Login and error pages** are server-rendered via view functions in `src/views/` (deep space theme, Orbitron font, starfield animation)
- **All authenticated routes** serve the React SPA from `client/` (Lovable wireops-dashboard design, Vite/Tailwind)
- Server serves `dist/client/index.html` for authenticated routes; React handles client-side routing

Server-rendered views (login/error only):
- `renderLoginPage()` - Login form (Privy-based, starfield canvas animation, signal cyan #00eaff accent)
- `renderErrorPage()` - Error display
- All server-rendered views use `renderPageShell()` from `shared.ts` for consistent layout

### Changing AI Prompts
- Grok newsletter prompt: `src/services/grok.ts` - `GROK_PROMPT`
- Claude prompts: `src/services/anthropic.ts` - `SCRAPED_CONTENT_PROMPT` and `FALLBACK_PROMPT`
- Scan prompts: Stored in `scan_prompts` table, managed via `/api/scan/prompts` CRUD API. Each prompt has `prompt_text` and optional `response_format`.

### Adding Environment Variables
1. Add to `src/config/index.ts` in the `config` object
2. Add validation in `validateConfig()` if required
3. Update `.env.example`
4. Update README.md environment variables table

## Database Architecture

### Shared PostgreSQL Database

All services (`wire-room-ops`, `the-wire-room`, `tele-sum`) share one PostgreSQL database hosted on Railway (`wire-room-db`). This repo is the primary writer; `the-wire-room` reads approved entries for the public website.

### Table Groups

| Group | Tables | Purpose |
|-------|--------|---------|
| **Scan pipeline** | `scan_entries`, `seen_urls`, `seen_names`, `intake_runs`, `scan_prompts` | Core intake/dedup/queue pipeline |
| **tele-sum legacy** | `messages`, `summaries`, `categories`, `users`, `telegram_bots`, `channel_configs` | Telegram ingestion (bridged via `summary-sync.ts`) |
| **Distribution** | `distribution_channels`, `distribution_logs`, `distribution_config` (legacy) | Channel output tracking |
| **Config** | `feeds`, `schedules`, `schedule_config`, `integration_config` | Wire/schedule/integration config |
| **Identity** | `org_profiles`, `sessions` | Organization tracking + auth sessions |
| **Legacy** | `grant_entries`, `grok_usage`, `review_queue`, `alembic_version`, `sync_status` | Historical/dormant tables |

### scan_entries — The Central Table

All pipeline data flows through `scan_entries`. Key columns:

| Column | Type | Purpose |
|--------|------|---------|
| `status` | text | Pipeline stage: `raw` → `deduped` → `queued` → `approved`/`declined`/`archived`/`duplicate` |
| `classification` | varchar | Gate 2 label: `GRANT`, `NEWS`, `EXPIRED`, `NOISE`, `UNCHECKED` |
| `quality_score` | integer | 0-100 score from LLM classifier |
| `wire` | text | Feed vertical (crypto/ai/oss) |
| `scan_source` | text | Ingestion channel: `x-scan`, `web-search`, `forum`, `telegram` |
| `source_url` | text | Original source link |
| `metadata` | jsonb | LLM-extracted structured data (amount, deadline, eligibility, summary) |
| `org_id` | integer | FK to `org_profiles` (auto-linked on approve) |

Status distribution (typical): ~46% duplicate, ~22% archived, ~17% queued, ~12% approved, ~3% declined.

### Data Flow: Ingestion → Refinery → Publishing

```
INGESTION (raw data)                    THE REFINERY (processing)               PUBLISHING
┌─────────────────┐                     ┌───────────────────┐                   ┌──────────────┐
│ X/Grok Scans    │──┐                  │ Gate 1: Complete  │──incomplete──→ archived
│ Web Search      │  ├──→ scan_entries ──│ Gate 2: Classify  │──NOISE──────→ archived
│ Forum Scan      │  │    (status=raw)   │ Deduplication     │──duplicate──→ duplicate
│ Telegram Bridge │──┘                  │ Quality Score     │──low score──→ archived
│ Manual Paste    │                     └───────┬───────────┘
└─────────────────┘                             │ score >= 40
                                                ▼
                                         queued (editorial queue)
                                                │ operator review
                                                ▼
                                         approved ──→ thewireroom.xyz
                                                  ──→ distribution channels (TG, X, newsletter)
```

### Dedup Tables

- **`seen_urls`**: Exact URL match. Composite unique on `(normalized_url, wire)`. Handles aggregate URLs (same URL, different entries) via name similarity check.
- **`seen_names`**: Fuzzy token overlap. GIN index on `name_tokens`. Unique on `(entry_id)`. Requires anchor token (non-generic) overlap to prevent false positives.

### Approval Validation Guard

Pre-approval validation (`src/services/approval-guard.ts`) prevents bad data from reaching the public website:
- **Blocks**: empty description, empty source_url, EXPIRED classification
- **Warns**: oversized names (>120 chars), junk deadline data, UNCHECKED classification, missing quality score
- Applied to both single and bulk approve endpoints. Operator can override with `?force=true`.

### The Telegram Bridge

`summary-sync.ts` bridges `tele-sum`'s `summaries` table → `scan_entries` (as `status=approved`):
- Runs every 15 minutes, 7-day lookback window
- Idempotent: skips entries where `source_url` already exists in `scan_entries`
- Infers wire from content keywords (AI/OSS detection, defaults to crypto)
- Historical backfill available via `POST /api/admin/summary-sync-backfill`

### Admin Endpoints

| Method | Path | Purpose | Rate Limit |
|--------|------|---------|------------|
| POST | `/api/admin/run-migration` | One-time data cleanup (fix junk fields, expired approvals) | 1 / 30 min |
| POST | `/api/admin/classify-backfill` | Batch-classify UNCHECKED queued/approved entries | 1 / 10 min |
| POST | `/api/admin/summary-sync-backfill` | Historical Telegram summary import | 1 / 30 min |

### Other Tables

Schedule configuration uses a `schedules` table with UUID primary keys, supporting multiple named schedules with a `schedule_type` field (`scan-execution` or `forum-scan`). Cron expressions are computed dynamically from `hour`/`minute`/`frequencyHours` columns via `buildCronExpression()`.

The `feeds` table manages dynamic wire/feed types, seeded from `SEED_FEEDS` and auto-discovered from `channel_configs`. Scan prompts are stored in `scan_prompts` with CRUD support.

Distribution uses `distribution_channels` (managed channels with UUID PK, per-channel credentials in JSONB) and `distribution_logs` (tracks per-entry, per-channel send status with a unique partial index to prevent double-posts). Legacy `distribution_config` table exists but is unused.

## API Integration Details

### Grok API (X.ai)
- **Chat Completions** (`/v1/chat/completions`): Used for newsletter summaries. Default model: `grok-4-1-fast-reasoning`
- **Responses API** (`/v1/responses`): Used for scan execution with `x_search` or `web_search` tools. Default model: `grok-4-1-fast`
- Each scan prompt has a `tool_type` column (`x_search` or `web_search`) controlling which tool is used
- Has native X.com/Twitter access via `x_search`; open web results via `web_search`

### Claude API (Anthropic)
- Uses official SDK `@anthropic-ai/sdk`
- Default model: `claude-opus-4-1-20250805`

### Firecrawl API
- Endpoint: `https://api.firecrawl.dev/v1/scrape`
- Returns markdown content from web pages
- Used only for non-X.com URLs

### Resend API
- Email service for all notifications
- 5 email types: login, notification, test alert, failure alert, resend download link

## Error Handling Patterns

### Retry Logic
`src/services/processor.ts` uses `withRetry()`:
- Newsletter processing: 3 attempts with jittered exponential backoff (applies to both Grok and Claude calls)
- Scan execution: 2 attempts (1 retry) — these are expensive Grok Responses API calls
- Batch concurrency: entries processed 3 at a time via `Promise.all` chunks

### Scrape Fallback
If Firecrawl fails, Claude uses only the cached summary from the database. Output includes note: `*[Summary based on cached data...]*`

### Job Failure Notifications
Scheduled jobs that fail send email via `sendScheduledJobFailureEmail()` with error details, then retry once after 5 minutes.

### Concurrent Job Guard
- `src/server.ts` prevents duplicate manual job execution -- if a scan execution is already running, subsequent requests return 409 with the existing job ID.
- `src/server.ts` also guards distribution runs per wire -- if distribution for a wire is already running, subsequent requests return 409.
- `src/services/scheduler.ts` prevents overlapping cron runs via an `executingJobs` set -- if a scheduled job is still running when the next cron tick fires, it is skipped.

### Database Reliability
- Pool has `on('error')` handler to prevent crash on idle connection drops
- `ensureScanTables()` DDL wrapped in a transaction for atomicity
- Scheduler `initScheduler()` properly resets on failure so it can retry

### Security Layers
- CSRF origin checking on all state-changing requests (POST/PUT/DELETE)
- Session auth via HttpOnly cookies only (no body fallback)
- XSS prevention via shared `escapeHtml()` utility and event delegation (no inline handlers)
- SSE keepalive (30s) prevents proxy timeouts on long-running jobs
- Open redirect protection via strict path validation on `returnTo` parameter

### Memory Management
- Job queue, auth tokens, and sessions all have periodic cleanup timers (15-minute intervals)
- Timers use `.unref()` to not prevent process exit
- Graceful shutdown stops all timers (scheduler, auth cleanup, job queue cleanup, summary sync)

## Testing Locally

1. Copy `.env.example` to `.env` and fill in all API keys
2. `npm install`
3. `npm run dev` (uses ts-node)
4. Access http://localhost:3000
5. Login with the email matching `NOTIFICATION_EMAIL`

## Common Issues

### "Missing required environment variables"
Check that all 8 required env vars are set: DATABASE_URL, ANTHROPIC_API_KEY, GROK_API_KEY, FIRECRAWL_API_KEY, RESEND_API_KEY, NOTIFICATION_EMAIL, PRIVY_APP_ID, PRIVY_APP_SECRET.

### "No entries found for this date range"
The database query found no `summaries` with `processing_status = 'SUCCESS'` in the date range.

### Scheduler not running after config change
Scheduler restarts automatically when you save schedule config via the dashboard API.

### Files disappear after restart
Generated files are persisted to Postgres, but sessions and job queues are in-memory and reset on restart. Re-login after a restart to access files.

## Environment Variables

### Required
- `DATABASE_URL` - PostgreSQL connection string
- `ANTHROPIC_API_KEY` - Claude API key
- `GROK_API_KEY` - X.ai Grok API key
- `FIRECRAWL_API_KEY` - Firecrawl scraping API key
- `RESEND_API_KEY` - Resend email API key
- `NOTIFICATION_EMAIL` - Primary operator email (always allowed dashboard access)
- `PRIVY_APP_ID` - Privy authentication app ID
- `PRIVY_APP_SECRET` - Privy authentication app secret

### Optional
- `PORT` - Server port (default: 3000)
- `APP_URL` - Base URL (auto-detected on Railway from `RAILWAY_PUBLIC_DOMAIN`)
- `ALLOWED_EMAILS` - Comma-separated additional emails for dashboard access
- `TELEGRAM_BOT_TOKEN` - Telegram Bot API token for channel distribution posting
- `FORUM_SCAN_ENABLED` - Set to `true` to enable forum scanning
- `DISCUSS_WATCH_API_URL` - Base URL for discuss.watch API
- `FROM_EMAIL` - Sender email address for notifications
- `DB_SSL_REJECT_UNAUTHORIZED` - Set to `false` for local dev without SSL
- `PERPLEXITY_API_KEY` - Perplexity API key for deep web research scans (variant P prompts)
- `TELEGRAM_INTAKE_BOT_TOKEN` - Bot token for Telegram intake bot (gracefully disabled if not set)
- `TELEGRAM_INTAKE_WEBHOOK_SECRET` - Random string for webhook validation
- `TELEGRAM_INTAKE_ALLOWED_USER_ID` - Telegram user ID of allowed sender (default: 394395765)
- `INTAKE_WIRES` - Comma-separated fallback wire list if DB has no active feeds
- `INTAKE_WIRE_KEYWORDS_{WIRE}` - Per-wire keyword overrides (e.g. `INTAKE_WIRE_KEYWORDS_CRYPTO`)
- `BRAND_AUDIENCE` - Who reads the content (default: "grant seekers")
- `BRAND_CONTENT_TYPE` - What is scanned for (default: "grant funding opportunities")
- `BRAND_CONTENT_VERB` - Action word (default: "apply for")
- `BRAND_NAME` - Display name (default: "The Wire Room")
- `BRAND_TAGLINE` - Short descriptor (default: "Intelligence Pipeline")
- `BRAND_COLOR` - Primary accent hex (default: "#2563eb")
- `BRAND_URL` - Base URL of the ops dashboard
- `BRAND_FROM_NAME` - Sender display name for outbound email
- `FORUM_SEARCH_TERMS` - Comma-separated search terms override for forum scanning
- `QUALITY_FUNDING_TYPES` - JSON array override for funding type keywords
- `QUALITY_ACTIONABLE_TYPES` - JSON array override for actionable type keywords

## Feeds System

Dynamic wire/feed management via the `feeds` table.

### How Feeds Work
- Seeded from `SEED_FEEDS` in `src/db/index.ts` (crypto, ai, oss)
- Auto-discovered from `channel_configs` table if it exists
- CRUD API at `/api/feeds` (GET, POST) and `/api/feeds/:key` (PUT, DELETE)
- `archived` flag soft-deletes feeds; use `?includeArchived=true` to list all
- Used throughout the app to filter summaries, schedules, and scan prompts by wire

## Scan Pipeline System

### Overview
Automated discovery of grant opportunities via X.com scanning, web search, and forum scanning. Intake processing eliminates duplicates and surfaces high-quality entries.

### Ingestion Channels
- **X.com scan** (`x-scan`): Grok Responses API with `x_search` tool, runs on schedule
- **Web search** (`web-search`): Grok Responses API with `web_search` tool, same prompt system as X scan
- **Forum scan** (`forum`): discuss.watch API searches across 150+ Discourse forums (search terms overrideable via `FORUM_SEARCH_TERMS`)
- **Telegram intake** (`telegram-intake`): Bot-based URL/article submission via webhook. Uses adapter pattern (`telegram-adapter.ts` -> `intake-core.ts`)
- **Manual paste** (`x-scan`/`web-search`): Dashboard paste-in flow

### Data Flow
1. **Execute**: `scan-execution.ts` fetches active prompts from `scan_prompts`, calls Grok Responses API with `x_search` or `web_search` tool (per prompt's `tool_type`)
2. **Parse**: `intake.ts` extracts structured results via 4 parser strategies (structured text, JSON, X-post format, lenient numbered list)
3. **Sanitize**: Post-parse `sanitizeResult()` cleans all parsed output — truncates names >120 chars, rejects junk deadlines (>50 chars, contains URLs/semicolons), discards suspicious small amounts (<$100 bare), moves excess name text into description
4. **Insert**: Raw results written to `scan_entries` with `status: raw`
5. **Gate 1 — Completeness**: Entries with empty `source_url` or missing critical fields are flagged/archived before dedup
6. **Dedup**: `dedup.ts` checks against `seen_urls` (exact URL match) and `seen_names` (fuzzy token overlap)
7. **Gate 2 — LLM Classify + Score**: `classifier.ts` calls Grok to classify (GRANT/NEWS/EXPIRED/NOISE) and score (0-100) in one call. Failed classifications retry once with 2-second delay.
8. **Queue**: Classified entries get `status: queued`; NOISE -> `status: archived`
9. **Approve Guard**: Pre-approval validation blocks entries with empty descriptions, empty URLs, or EXPIRED classification from being published

### Key Files
- `src/jobs/scan-execution.ts` - Orchestrates prompt execution and feeds results to intake
- `src/jobs/daily-intake.ts` - Main intake pipeline (dedup -> classify -> queue, with classification retry)
- `src/services/intake.ts` - Parser with 4 strategies + `sanitizeResult()` post-parse cleanup
- `src/services/intake-core.ts` - Channel-agnostic intake logic (URL extraction, wire detection, DB insert)
- `src/services/approval-guard.ts` - Pre-approval validation (blocks empty desc/URL, EXPIRED entries)
- `src/services/classifier.ts` - Gate 2 LLM classifier (GRANT/NEWS/EXPIRED/NOISE + quality score)
- `src/services/telegram-adapter.ts` - Telegram intake bot adapter (webhook, inline keyboard, setWebhook)
- `src/services/dedup.ts` - Two-layer dedup (URL exact + name fuzzy)
- `src/services/quality-scorer.ts` - Scoring engine with type classification (keywords overrideable via env)
- `src/services/scan-stats.ts` - Prompt effectiveness metrics (dup rate, avg quality, overlap)
- `src/services/forum.ts` - discuss.watch API client for forum scanning
- `src/jobs/forum-scan.ts` - Forum scan orchestrator (search -> intake pipeline, DB-driven default wire)
- `src/migrations/cleanup-approved-data.ts` - One-time data cleanup for existing bad entries

### Schedule Types
- **`scan-execution`**: Daily cron, runs `runScanExecution()` which executes all active prompts for a wire
- **`forum-scan`**: Daily cron, runs `runForumScan()` which searches discuss.watch forums

### Prompt Management
- Prompts stored in `scan_prompts` table with `wire`, `label`, `prompt_text`, `response_format`, `variant`, `tool_type`
- CRUD API: `/api/scan/prompts` (GET/POST), `/api/scan/prompts/:id` (PUT/DELETE)
- Test endpoint: `/api/scan/prompts/:id/test` -- executes a prompt and returns parsed results without intake processing
- Effectiveness stats: `/api/scan/prompt-stats` -- per-prompt metrics and cross-prompt overlap rate

### Gate 2: LLM Classification + Scoring

Quality scoring is done by the Grok LLM classifier (`src/services/classifier.ts`) in a single API call that:
1. Classifies entries as GRANT/NEWS/EXPIRED/NOISE
2. Assigns a 0-100 quality score based on information value
3. Extracts structured data (amount, deadline, eligibility, summary) into `metadata` JSONB

Failed classifications retry once with a 2-second delay. If both attempts fail, entries are queued with score 0 and classification UNCHECKED. A backfill endpoint (`POST /api/admin/classify-backfill`) can batch-classify UNCHECKED entries later.

The legacy rule-based scorer (`src/services/quality-scorer.ts`) is still in the codebase but is no longer used in the main pipeline.

### Common Tasks for Scan Pipeline
- **Adjusting quality scoring weights**: `src/services/quality-scorer.ts` -- modify point values in `scoreEntry()`
- **Adding a new feed/wire type**: Via `/api/feeds` POST or add to `SEED_FEEDS` in `src/db/index.ts`
- **Testing a scan prompt**: `POST /api/scan/prompts/:id/test` -- executes against Grok and returns parsed results
- **Viewing prompt effectiveness**: `GET /api/scan/prompt-stats?days=7`
- **Creating a web search prompt**: Set `toolType: 'web_search'` in POST `/api/scan/prompts` (or select "Web Search" in dashboard)
- **Running a forum scan**: `POST /api/forum/run` with optional `{ "wire": "crypto" }` (requires `FORUM_SCAN_ENABLED=true`)
- **Adding forum search keywords**: Set `FORUM_SEARCH_TERMS` env var (comma-separated) or edit defaults in `src/services/forum.ts`

## Distribution System

### Overview
Per-feed multi-channel distribution of approved scan entries. Distribution is a **manual action** triggered from the feed dashboard -- it is NOT auto-triggered on approval. Three channels are supported: Telegram, X/Twitter, and newsletter (copyable markdown).

### Architecture
- **Orchestrator**: `src/services/distribution.ts` -- coordinates sending approved-but-undistributed entries to all enabled channels for a wire, with retry support and newsletter markdown generation
- **Post generator**: `src/services/post-generator.ts` -- uses Claude Sonnet to generate a tweet (280 chars) and Telegram HTML post per entry. Falls back to a template if AI generation fails
- **Telegram client**: `src/services/telegram-channel.ts` -- sends HTML-formatted posts to Telegram channels via Bot API. Bot token from `TELEGRAM_BOT_TOKEN` env var; channel ID from `distribution_config` per wire
- **X/Twitter client**: `src/services/x-client.ts` -- posts tweets via `twitter-api-v2`. All 4 OAuth credentials (API key, API secret, access token, access secret) stored in `distribution_config` JSONB per wire
- **Types**: `src/types/intake.ts` -- `DistributionChannel`, `DistributionStatus`, `DistributionConfig`, `DistributionLog`, `GeneratedPosts`

### Database Tables
- **`distribution_channels`**: Managed channels with UUID PK. Columns: `id`, `wire`, `channel` (telegram/x), `name`, `enabled`, `target_id`, `credentials` JSONB (bot tokens, OAuth creds), `created_at`, `updated_at`. CRUD via Settings > Distribution tab.
- **`distribution_logs`**: Tracks each send attempt. Columns: `id` (UUID), `entry_id` FK to `scan_entries`, `channel`, `wire`, `status` (pending/success/failed), `post_text`, `external_id` (platform post ID), `error_message`, `created_at`. Has unique partial index on `(entry_id, channel) WHERE status IN ('pending','success')` to prevent double-posts.
- **`distribution_config`**: Legacy table (unused). Replaced by `distribution_channels`.

### API Routes
| Method | Path | Purpose | Rate Limit |
|--------|------|---------|------------|
| GET | `/api/distribution/config` | List all configs (credentials masked) | -- |
| PUT | `/api/distribution/config/:wire/:channel` | Update channel config (merge, not replace) | -- |
| POST | `/api/distribution/run/:wire` | Trigger distribution for a wire | 3 per wire / 5 min |
| GET | `/api/distribution/newsletter/:wire` | Generate newsletter markdown | 5 global / 5 min |
| GET | `/api/distribution/status/:wire` | Bulk distribution status for approved entries | -- |
| GET | `/api/scan/entries/:id/distribution` | Distribution logs for a single entry | -- |
| POST | `/api/scan/entries/:id/redistribute` | Retry failed distribution for an entry | 5 global / 5 min |

### User Flow
1. Approve entries in the queue (status changes to `approved` -- this already existed)
2. Go to the feed page for a wire -- the Distribution section shows channel config cards
3. Click Configure on a channel card to set credentials/channel ID and enable it
4. Click "Distribute to Channels" to send approved-but-undistributed entries to Telegram + X
5. Click "Generate Newsletter" to get copyable markdown of undistributed entries
6. Distribution status is visible as colored pills (TG/X/NL) on the approved tab in the queue page
7. Failed pills are clickable to retry distribution for that entry and channel

### Key Design Decisions
- **Manual trigger, not auto-on-approve**: Distribution is a separate deliberate action so operators can batch-review before sending
- **Claude Sonnet for post generation**: Uses a smaller model (not Opus) for cost efficiency when generating tweets and Telegram posts
- **Template fallback**: If AI post generation fails, a structured template is used instead
- **3-second inter-entry delay**: Respects X/Twitter rate limits during batch distribution
- **Concurrent execution guard**: Prevents double-posting if distribution is triggered while already running (returns 409 with existing job ID)
- **Config merge on partial update**: PUT to config endpoint merges new fields into existing JSONB, preventing accidental credential loss
- **Retry sends only to failed channels**: Redistribution skips channels that already have a `success` or `pending` log entry

### Dashboard UI
- **Dashboard** (`client/`): React SPA with Settings > Distribution tab showing managed channel cards (TEST/EDIT/DEL actions), Queue tab with approve/decline actions and distribution status, Published tab with distribution pills

### Common Tasks for Distribution
- **Configuring Telegram for a wire**: PUT `/api/distribution/config/:wire/telegram` with `{ "enabled": true, "config": { "channelId": "@yourchannel" } }`. Requires `TELEGRAM_BOT_TOKEN` env var.
- **Configuring X/Twitter for a wire**: PUT `/api/distribution/config/:wire/x` with `{ "enabled": true, "config": { "apiKey": "...", "apiSecret": "...", "accessToken": "...", "accessSecret": "..." } }`
- **Triggering distribution**: POST `/api/distribution/run/:wire` -- sends to all enabled channels
- **Generating newsletter**: GET `/api/distribution/newsletter/:wire` -- returns markdown of undistributed approved entries
- **Retrying a failed send**: POST `/api/scan/entries/:id/redistribute` -- retries only failed channels
- **Checking distribution status**: GET `/api/distribution/status/:wire` -- bulk status for all approved entries in a wire
- **Viewing logs for an entry**: GET `/api/scan/entries/:id/distribution` -- full log history

## Rate Limiting

In-memory rate limiter in `src/server.ts`:
| Endpoint | Limit | Window |
|----------|-------|--------|
| `/resend-link` | 2 per IP | 30 min |
| `/api/scan/prompts/:id/test` | 5 global | 5 min |
| `/api/scan/run` | 1 global | 15 min |
| `/api/forum/run` | 1 global | 15 min |
| `/api/summary-sync` | 3 global | 5 min |
| `/api/distribution/run/:wire` | 3 per wire | 5 min |
| `/api/distribution/newsletter/:wire` | 5 global | 5 min |
| `/api/scan/entries/:id/redistribute` | 5 global | 5 min |
| `/api/admin/run-migration` | 1 global | 30 min |
| `/api/admin/classify-backfill` | 3 global | 5 min |
| `/api/admin/summary-sync-backfill` | 1 global | 30 min |

## Code Style Notes

- TypeScript strict mode
- Express for HTTP server
- Login page uses React (via ESM) with Privy + starfield canvas animation; dashboard is a React/Vite/Tailwind SPA (`client/`)
- Server-rendered views (login/error only) are in `src/views/` with a shared page shell pattern (deep space palette, Orbitron headings)
- Client-side `escapeHtml()` is defined once in `shared.ts` via `CLIENT_ESCAPE_HTML` constant
- Validation helpers (`isValidUuid()`, `isValidFeedKey()`) are defined in `server.ts`
- Minimal dependencies
- Error messages include context for debugging

## Planned / Not Yet Implemented

The following features are planned but not yet built:
- **CRM sync** (Notion organization tracking)
- **Slack/Discord intake adapters** (same `intake-core.ts` interface, new channel adapters)
- **Email inbound ingestion** (URL extraction from forwarded emails)
- **Automated scheduled distribution** (currently manual trigger only)

Previously planned and now implemented:
- ~~Multi-channel distribution~~ -- Implemented: Telegram, X/Twitter, and newsletter channels (see Distribution System section)
- ~~Weekly newsletter generation~~ -- Implemented: on-demand newsletter markdown generation via `/api/distribution/newsletter/:wire`
- ~~Telegram bot ingestion~~ -- Implemented: `telegram-adapter.ts` + `intake-core.ts` with webhook at `/api/telegram/intake-webhook`
- ~~Deployment-agnostic config~~ -- Implemented: `brand.ts` + env-var driven wire lists, scoring keywords, and AI prompts
- ~~Data quality gates~~ -- Implemented: parser sanitization, approval guard, classification retry, admin backfill endpoints
