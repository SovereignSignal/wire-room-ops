# CLAUDE.md - AI Context for Wire Room Ops

This file provides context for AI assistants working with this codebase.

## Project Overview

**Wire Room Ops** is a Node.js/TypeScript application that powers the backend pipeline and admin dashboard for The Wire Room. It automates grant discovery, intake processing, and multi-channel distribution across crypto, AI, and OSS beats. It pulls categorized entries from a Postgres database, enriches them using AI (Grok for X.com content, Claude for other URLs), and generates formatted markdown files.

> Current-code note (March 2026): parts of this file describe historical modules that were extracted from this repo (notably distribution/CRM/Telegram inbound services). When in doubt, trust `src/` and `README.md` for the implemented scope.

## Multi-Repo Architecture

This backend is one half of a two-repo system:

| Repo | Role | Location |
|------|------|----------|
| `wire-room-ops` (this repo) | Backend pipeline + admin dashboard | `~/GitHub/wire-room-ops` |
| `the-wire-room` | Public-facing Next.js website | `~/GitHub/the-wire-room` |

Both repos share the **same PostgreSQL database**. This repo writes to it; the Wire Room reads from it.

### Approve = Publish + Distribute Flow

When an operator clicks "Approve" on a queued scan entry (via the dashboard), the entry's status changes to `approved`. Two things happen:

1. **Website publish**: The Wire Room frontend queries `scan_entries WHERE status = 'approved'` to display entries on thewireroom.xyz. There is no separate publish step.
2. **Multi-channel distribution**: If `DISTRIBUTION_ENABLED=true`, the approve handler fires a background `distributeEntry()` call that generates AI-crafted posts (via Claude) and publishes them to the wire's Telegram channel and X account in parallel. Failures never block the approval.

The Wire Room reads these columns from `scan_entries`: `id`, `name`, `description`, `source_url`, `amount`, `deadline`, `wire`, `quality_score`, `scan_source`, `created_at`.

The Wire Room queries with `WHERE status = 'approved'` (optionally `AND wire = $1` for beat filtering), ordered by `created_at DESC` with `LIMIT/OFFSET` pagination. A partial index `idx_scan_entries_approved` on `(wire, created_at DESC) WHERE status = 'approved'` optimizes both filtered and unfiltered query paths.

## Key Architecture Decisions

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
src/
├── index.ts              # Entry point - validates config, starts server
├── server.ts             # Express routes + embedded HTML templates for dashboard
├── config/index.ts       # Environment variables and validation
├── db/index.ts           # Postgres queries, schedules, feeds, scan tables, scan prompts
├── jobs/
│   ├── weekly-summary.ts   # Weekly newsletter job orchestration
│   ├── daily-intake.ts     # Scan intake pipeline orchestrator (parse → dedup → score → queue)
│   ├── scan-execution.ts   # Automated scan execution (prompt fetch → Grok → intake)
│   └── forum-scan.ts       # Forum scan orchestrator (discuss.watch → intake)
├── services/
│   ├── anthropic.ts      # Claude API calls with scraping integration
│   ├── auth.ts           # Session tokens, download tokens, cleanup timers
│   ├── crm-sync.ts       # Notion CRM sync - org matching and auto-creation
│   ├── dedup.ts          # URL exact-match and fuzzy name deduplication
│   ├── distribution.ts   # Distribution orchestrator (approve → Telegram + X)
│   ├── email.ts          # Resend email templates (5 types)
│   ├── email-inbound.ts  # Resend Inbound webhook handler (URL extraction → intake)
│   ├── forum.ts          # discuss.watch API client for forum scanning
│   ├── grok.ts           # Grok Chat + Responses API for X.com content and scans
│   ├── intake.ts         # Scan result parser, URL/name normalization
│   ├── job-queue.ts      # SSE-based job progress tracking
│   ├── markdown.ts       # Output generation with category grouping
│   ├── models.ts         # Dynamic model fetching from both APIs
│   ├── notion.ts         # Notion API client with rate limiting
│   ├── org-cache.ts      # Local alias cache for org name matching
│   ├── post-generator.ts # AI post generation for distribution (Claude-powered)
│   ├── processor.ts      # Entry processing with retry logic
│   ├── quality-scorer.ts # 0-100 quality scoring engine for scan entries
│   ├── scan-stats.ts     # Prompt effectiveness and overlap metrics
│   ├── scheduler.ts      # node-cron scheduling with health tracking
│   ├── scraper.ts        # Firecrawl integration, URL resolution
│   ├── storage.ts        # Postgres-backed file storage with in-memory cache (keeps last 10)
│   ├── telegram.ts       # Telegram Bot webhook + channel posting for distribution
│   ├── url-processor.ts  # Shared URL scrape + AI extraction → RawScanResult
│   └── x-client.ts       # X (Twitter) API v2 posting client (OAuth 1.0a)
├── utils/
│   ├── async.ts          # Shared sleep() utility
│   ├── html.ts           # Shared escapeHtml() utility
│   └── url.ts            # Shared normalizeUrl() for URL deduplication
└── types/
    ├── index.ts          # Core TypeScript interfaces
    └── intake.ts         # Scan pipeline + distribution types (ScanEntry, DistributionLog, etc.)
```

## Common Tasks

### Adding a New API Endpoint
1. Add route in `src/server.ts`
2. For authenticated routes, use the `requireAuth` middleware (validates HttpOnly session cookie)
3. Return JSON for `/api/*` routes

### Modifying the Dashboard UI
The dashboard is rendered as inline HTML in `src/server.ts`:
- `renderLoginPage()` - Login form (Privy-based)
- `renderDashboard()` - Main dashboard with embedded JavaScript
- `renderQueuePage()` - Scan queue review interface
- `renderErrorPage()` - Error display

### Changing AI Prompts
- Grok newsletter prompt: `src/services/grok.ts` - `GROK_PROMPT`
- Claude prompts: `src/services/anthropic.ts` - `SCRAPED_CONTENT_PROMPT` and `FALLBACK_PROMPT`
- Scan prompts: Stored in `scan_prompts` table, managed via `/api/scan/prompts` CRUD API. Each prompt has `prompt_text` and optional `response_format`.

### Adding Environment Variables
1. Add to `src/config/index.ts` in the `config` object
2. Add validation in `validateConfig()` if required
3. Update `.env.example`
4. Update README.md environment variables table

## Database Queries

The main query is in `src/db/index.ts` - `getEntriesForDateRange()`:
- Joins `summaries`, `messages`, and `categories` tables
- Filters by `processing_status = 'SUCCESS'`
- Orders by category then date descending
- Extracts first URL from `extracted_urls` JSON array

Schedule configuration uses a `schedules` table with UUID primary keys, supporting multiple named schedules with a `schedule_type` field (`weekly-summary`, `scan-execution`, or `forum-scan`). Legacy `schedule_config` data is auto-migrated on startup.

The `feeds` table manages dynamic wire/feed types, seeded from `SEED_FEEDS` and auto-discovered from `channel_configs`. Scan pipeline uses 4 tables: `scan_entries`, `seen_urls`, `seen_names`, `intake_runs`. Scan prompts are stored in `scan_prompts` with CRUD support. Distribution tracking uses `distribution_logs` and per-wire channel settings use `distribution_config` (both auto-created on startup via `ensureDistributionTable()`).

## API Integration Details

### Grok API (X.ai)
- **Chat Completions** (`/v1/chat/completions`): Used for newsletter summaries. Default model: `grok-4-1-fast-reasoning`
- **Responses API** (`/v1/responses`): Used for scan execution with `x_search` or `web_search` tools. Default model: `grok-4-1-fast`
- Each scan prompt has a `tool_type` column (`x_search` or `web_search`) controlling which tool is used
- Has native X.com/Twitter access via `x_search`; open web results via `web_search`

### Claude API (Anthropic)
- Uses official SDK `@anthropic-ai/sdk`
- Default model: `claude-opus-4-5-20251101`

### Firecrawl API
- Endpoint: `https://api.firecrawl.dev/v1/scrape`
- Returns markdown content from web pages
- Used only for non-X.com URLs

### X (Twitter) API v2
- Uses `twitter-api-v2` npm package with OAuth 1.0a (User Context)
- One set of credentials per wire (crypto, ai, oss)
- Used only by the distribution system for posting tweets on entry approval

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
`src/server.ts` prevents duplicate job execution — if a weekly summary or scan execution is already running, subsequent requests return 409 with the existing job ID.

### Database Reliability
- Pool has `on('error')` handler to prevent crash on idle connection drops
- `ensureScanTables()` DDL wrapped in a transaction for atomicity
- Scheduler `initScheduler()` properly resets on failure so it can retry

### Security Layers
- CSRF origin checking on all state-changing requests (POST/PUT/DELETE)
- Session auth via HttpOnly cookies only (no body fallback)
- XSS prevention via shared `escapeHtml()` utility and event delegation (no inline handlers)
- SSE keepalive (30s) prevents proxy timeouts on long-running jobs

### Memory Management
- Job queue, auth tokens, and sessions all have periodic cleanup timers (15-minute intervals)
- Timers use `.unref()` to not prevent process exit

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

## CRM Sync System

### Overview
The CRM sync identifies organizations mentioned in entries and tracks them in Notion:
- **Main Orgs DB**: Known organizations with aliases for matching
- **Staging DB**: New organizations pending review

### Sync Flow (`src/services/crm-sync.ts`)
1. `runCrmSyncJob()` fetches entries for date range
2. Extracts org names from `entities.orgs` field
3. `syncOrgFromEntry()` checks local cache, then Notion search
4. If no match found, creates org in staging DB via `createStagingOrg()`

### Org Cache (`src/services/org-cache.ts`)
- In-memory cache of org names and aliases from main CRM
- Refreshed before each sync run
- Supports fuzzy matching via normalized names

### Notion Integration (`src/services/notion.ts`)
- Rate-limited API calls (350ms delay)
- `isStagingConfigured()` checks if staging DB ID is set
- `checkStagingOrgExists()` prevents duplicates in staging

### Environment Variables for CRM
- `NOTION_API_KEY` - Notion integration token
- `NOTION_ORGS_DB_ID` - Main organizations database
- `NOTION_STAGING_ORGS_DB_ID` - Staging database for new orgs
- `NOTION_OPPS_DB_ID` - Opportunities database
- `NOTION_CRM_PAGE_ID` - CRM page ID

### Environment Variables for Telegram Bot (optional)
- `TELEGRAM_BOT_TOKEN` - Bot token from @BotFather
- `TELEGRAM_WEBHOOK_SECRET` - Secret for webhook verification
- `TELEGRAM_ALLOWED_USER_IDS` - Comma-separated allowlist of Telegram user IDs
- `TELEGRAM_DEFAULT_WIRE` - Default wire for submissions (default: `crypto`)

### Environment Variables for Email Ingestion (optional)
- `INBOUND_EMAIL_ADDRESS` - Resend inbound email address
- `INBOUND_EMAIL_ALLOWED_SENDERS` - Comma-separated allowlist of email addresses
- `RESEND_WEBHOOK_SECRET` - Resend webhook signing secret for HMAC verification

### Environment Variables for Forum Scanning (optional)
- `FORUM_SCAN_ENABLED` - Set to `true` to enable forum scanning (default: disabled)
- `DISCUSS_WATCH_API_URL` - Base URL for discuss.watch API (default: `https://discuss-dot-watch-production.up.railway.app/api/v1`)

### Environment Variables for Auth (optional)
- `ALLOWED_EMAILS` - Comma-separated list of additional emails allowed to access the dashboard (beyond `NOTIFICATION_EMAIL`)

### Distribution Configuration (DB-managed)
Distribution channels are configured per-wire via the `distribution_config` table, managed through the dashboard UI or API:
- `GET /api/distribution-config` - View all wire configs
- `PUT /api/distribution-config/:wire` - Update a wire's config (enabled, telegramChannelId, xApiKey, xApiSecret, xAccessToken, xAccessTokenSecret, xHandle)
- `POST /api/distribution-config/:wire/test` - Send test messages to configured channels

On first run, the `distribution_config` table is seeded from env vars (`DISTRIBUTION_ENABLED`, `X_{WIRE}_*`, `TELEGRAM_CHANNEL_{WIRE}`) if the table is empty. After that, all config is managed via DB/API.

## Distribution System

### Overview
Multi-channel distribution automatically publishes AI-crafted posts to Telegram channels and X (Twitter) accounts when a scan entry is approved. The system is fire-and-forget: distribution failures never block the approval.

### Distribution Flow (`src/services/distribution.ts`)
1. Entry is approved via `/api/scan/entries/:id/action` with `{ action: 'approve' }`
2. `distributeEntry()` is called in a fire-and-forget handler
3. Loads per-wire config from `distribution_config` DB table; skips if wire is disabled
4. Calls `generatePosts()` once (single Claude call) to create both a tweet and Telegram message
5. Dispatches to both channels in parallel via `Promise.allSettled`
6. Each attempt is logged in `distribution_logs` with status tracking

### Post Generation (`src/services/post-generator.ts`)
- Single Claude API call (model: `claude-sonnet-4-20250514`) generates both a tweet (<= 270 chars) and a Telegram HTML message
- Prompt is wire-context-aware (crypto/ai/oss grants)
- Falls back to template-based formatting if the AI response is malformed or the API call fails
- Tweet text has the source URL appended by the distribution orchestrator (not by the generator)

### X Client (`src/services/x-client.ts`)
- Uses `twitter-api-v2` npm package with OAuth 1.0a (User Context)
- Receives credentials as parameters from the distribution orchestrator (sourced from `distribution_config` DB table)
- Lazy client instantiation per wire, cached in memory; `clearClientCache(wire)` called when creds update via API
- Returns `null` (skip) if credentials are missing for a wire

### Telegram Channel Publishing
- Reuses the existing `sendMessage()` from `src/services/telegram.ts` (exported with `string | number` chatId)
- Channel ID read from `distribution_config` DB table per wire

### Idempotency & Retry
- `distributeEntry()` checks `distribution_logs` for existing `success` rows before dispatching
- A unique partial index `(entry_id, channel) WHERE status IN ('pending', 'success')` prevents double-posting at the DB level
- `retryDistribution()` deletes `failed` logs then re-runs `distributeEntry()`

### Database Tables
Both auto-created on startup via `ensureDistributionTable()` (called in `initScheduler()`):

**`distribution_logs`**: Per-entry dispatch tracking
- Columns: `id`, `entry_id` (FK), `channel` (telegram/x), `wire`, `status` (pending/success/failed/skipped), `post_text`, `external_id`, `external_url`, `error_message`, `created_at`, `updated_at`

**`distribution_config`**: Per-wire channel settings
- Columns: `wire` (PK), `enabled`, `telegram_channel_id`, `x_api_key`, `x_api_secret`, `x_access_token`, `x_access_token_secret`, `x_handle`, `created_at`, `updated_at`
- Seeded from env vars on first run if table is empty

### API Endpoints
- `GET /api/distribution-config` - Get per-wire config (credentials masked)
- `PUT /api/distribution-config/:wire` - Update wire config (enable, set channels/creds)
- `POST /api/distribution-config/:wire/test` - Test channels (rate-limited: 5 per 5 min)
- `GET /api/scan/entries/:id/distribution` - Get distribution logs for an entry
- `POST /api/scan/entries/:id/redistribute` - Retry failed distribution (rate-limited: 5 per 5 min)
- Distribution logs are also attached to approved entries in the `GET /api/scan/queue` response as `distribution_logs`

### Dashboard UI
- Approved entries display distribution status pills (Telegram/X) showing success/failed/pending/skipped
- Failed entries show a retry button that calls the `/redistribute` endpoint

### Common Tasks for Distribution
- **Enabling distribution**: Via dashboard or `PUT /api/distribution-config/:wire` with `{ "enabled": true }`
- **Adding X credentials for a wire**: Via dashboard or `PUT /api/distribution-config/:wire` with all 4 credential fields
- **Adding a Telegram channel**: Via dashboard or `PUT /api/distribution-config/:wire` with `{ "telegramChannelId": "@handle" }`
- **Testing channels**: `POST /api/distribution-config/:wire/test` sends test messages to configured channels
- **Changing the post generation model**: Edit `model` in `src/services/post-generator.ts` `generatePosts()`
- **Customizing post style**: Edit `buildPrompt()` in `src/services/post-generator.ts`
- **Adding a new distribution channel**: Add channel logic in `src/services/distribution.ts`, add types in `src/types/intake.ts`

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
Automated discovery of grant opportunities via X.com scanning, web search, forum scanning, Telegram bot, and email ingestion. Intake processing eliminates duplicates and surfaces high-quality entries.

### Ingestion Channels
- **X.com scan** (`x-scan`): Grok Responses API with `x_search` tool, runs on schedule
- **Web search** (`web-search`): Grok Responses API with `web_search` tool, same prompt system as X scan
- **Forum scan** (`forum`): discuss.watch API searches across 150+ Discourse forums for grant keywords
- **Manual paste** (`x-scan`/`web-search`): Dashboard paste-in flow
- **Telegram bot** (`telegram`): Send a URL → bot scrapes + extracts → intake pipeline
- **Email inbound** (`email`): Send email with URLs → Resend webhook → scrape + extract → intake

### Data Flow
1. **Execute**: `scan-execution.ts` fetches active prompts from `scan_prompts`, calls Grok Responses API with `x_search` or `web_search` tool (per prompt's `tool_type`)
2. **Parse**: `intake.ts` extracts structured results (name, description, deadline, link, amount) from Grok output
3. **Insert**: Raw results written to `scan_entries` with `status: raw`
4. **Dedup**: `dedup.ts` checks against `seen_urls` (exact URL match) and `seen_names` (fuzzy token overlap)
5. **Score**: `quality-scorer.ts` assigns 0-100 quality score based on amount, deadline, actionability
6. **Queue**: Entries with score >= 40 get `status: queued`; below threshold → `status: archived`

### Key Files
- `src/jobs/scan-execution.ts` - Orchestrates prompt execution and feeds results to intake
- `src/jobs/daily-intake.ts` - Main intake pipeline (dedup → score → queue)
- `src/services/intake.ts` - Parser, URL/name normalization
- `src/services/dedup.ts` - Two-layer dedup (URL exact + name fuzzy)
- `src/services/quality-scorer.ts` - Scoring engine with type classification
- `src/services/scan-stats.ts` - Prompt effectiveness metrics (dup rate, avg quality, overlap)
- `src/services/url-processor.ts` - Shared URL scrape + AI extraction (used by Telegram & email)
- `src/services/telegram.ts` - Telegram Bot API webhook handler
- `src/services/email-inbound.ts` - Resend Inbound webhook handler
- `src/services/forum.ts` - discuss.watch API client for forum scanning
- `src/jobs/forum-scan.ts` - Forum scan orchestrator (search → intake pipeline)
- `src/services/distribution.ts` - Distribution orchestrator (approve → Telegram + X)
- `src/services/post-generator.ts` - AI post generation (Claude-powered, tweet + Telegram)
- `src/services/x-client.ts` - X (Twitter) API v2 posting client

### Schedule Types
- **`weekly-summary`**: Weekly cron, runs `runWeeklySummaryJob()` for newsletter generation
- **`scan-execution`**: Daily cron, runs `runScanExecution()` which executes all active prompts for a wire
- **`forum-scan`**: Daily cron, runs `runForumScan()` which searches discuss.watch forums

### Prompt Management
- Prompts stored in `scan_prompts` table with `wire`, `label`, `prompt_text`, `response_format`, `variant`, `tool_type`
- CRUD API: `/api/scan/prompts` (GET/POST), `/api/scan/prompts/:id` (PUT/DELETE)
- Test endpoint: `/api/scan/prompts/:id/test` — executes a prompt and returns parsed results without intake processing
- Effectiveness stats: `/api/scan/prompt-stats` — per-prompt metrics and cross-prompt overlap rate

### Quality Score Breakdown
| Signal | Points | Condition |
|--------|--------|-----------|
| Has amount | +25 | Non-empty amount field |
| Amount > $5K | +15 | Parsed numeric >= 5000 |
| Small amount | -5 | Parsed numeric < 1000 |
| Has deadline | +15 | Specific date (not "Rolling" or empty) |
| Rolling deadline | +5 | Deadline is exactly "Rolling" |
| Deadline upcoming | +10 | Within 60 days |
| Expired deadline | -10 | Deadline has passed |
| Funding opportunity | +20 | Grant, fellowship, accelerator, etc. (FUNDING_TYPES) |
| Is actionable | +15 | Hackathon, bounty, competition, or has opportunity keywords |
| Governance noise | -15 | DAO proposals, treasury votes |
| Already awarded | -10 | Past-tense grant language (when not also actionable/funding) |
| Vague description | -5 | Description shorter than 30 characters |

### Common Tasks for Scan Pipeline
- **Adjusting quality scoring weights**: `src/services/quality-scorer.ts` — modify point values in `scoreEntry()`
- **Adding a new feed/wire type**: Via `/api/feeds` POST or add to `SEED_FEEDS` in `src/db/index.ts`
- **Testing a scan prompt**: `POST /api/scan/prompts/:id/test` — executes against Grok and returns parsed results
- **Viewing prompt effectiveness**: `GET /api/scan/prompt-stats?days=7`
- **Creating a web search prompt**: Set `toolType: 'web_search'` in POST `/api/scan/prompts` (or select "Web Search" in dashboard)
- **Running a forum scan**: `POST /api/forum/run` with optional `{ "wire": "crypto" }` (requires `FORUM_SCAN_ENABLED=true`)
- **Adding forum search keywords**: Edit `GRANT_KEYWORDS` array in `src/services/forum.ts`

## Rate Limiting

In-memory rate limiter in `src/server.ts`:
| Endpoint | Limit | Window |
|----------|-------|--------|
| `/resend-link` | 2 per IP | 30 min |
| `/api/run-job` | 3 global | 5 min |
| `/api/scan/prompts/:id/test` | 5 global | 5 min |
| `/api/scan/run` | 1 global | 15 min |
| `/api/forum/run` | 1 global | 15 min |
| `/api/scan/entries/:id/redistribute` | 5 global | 5 min |
| `/api/distribution-config/:wire/test` | 5 global | 5 min |
| `/webhook/telegram` | 10 per chat | 1 min |
| `/webhook/email` | 5 per sender | 15 min |

## Code Style Notes

- TypeScript strict mode
- Express for HTTP server
- Login page uses React (via ESM) with Privy; dashboard uses vanilla JS in embedded HTML
- Minimal dependencies
- Error messages include context for debugging
