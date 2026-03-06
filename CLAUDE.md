# CLAUDE.md - AI Context for Wire Room Ops

This file provides context for AI assistants working with this codebase.

## Project Overview

**Wire Room Ops** is a Node.js/TypeScript application that powers the backend pipeline and admin dashboard for The Wire Room. It automates grant discovery, intake processing, and approval across crypto, AI, and OSS beats. It pulls categorized entries from a Postgres database, enriches them using AI (Grok for X.com content, Claude for other URLs), and surfaces high-quality grant opportunities for operator review.

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
├── server.ts             # Express routes (1400+ lines — candidate for splitting)
├── config/index.ts       # Environment variables and validation
├── db/index.ts           # Postgres queries, schedules, feeds, scan tables, scan prompts
├── jobs/
│   ├── daily-intake.ts     # Scan intake pipeline orchestrator (parse -> dedup -> score -> queue)
│   ├── scan-execution.ts   # Automated scan execution (prompt fetch -> Grok -> intake)
│   ├── forum-scan.ts       # Forum scan orchestrator (discuss.watch -> intake)
│   └── summary-sync.ts     # Sync tele-sum summaries into scan_entries as approved
├── services/
│   ├── anthropic.ts      # Claude API calls with scraping integration
│   ├── auth.ts           # Session tokens, download tokens, cleanup timers
│   ├── dedup.ts          # URL exact-match and fuzzy name deduplication
│   ├── email.ts          # Resend email templates (5 types)
│   ├── forum.ts          # discuss.watch API client for forum scanning
│   ├── grok.ts           # Grok Chat + Responses API for X.com content and scans
│   ├── intake.ts         # Scan result parser, URL/name normalization
│   ├── job-queue.ts      # SSE-based job progress tracking
│   ├── models.ts         # Dynamic model fetching from both APIs
│   ├── processor.ts      # Entry processing with retry logic
│   ├── quality-scorer.ts # 0-100 quality scoring engine for scan entries
│   ├── scan-stats.ts     # Prompt effectiveness and overlap metrics
│   ├── scheduler.ts      # node-cron scheduling with health tracking
│   ├── scraper.ts        # Firecrawl integration, URL resolution
│   └── storage.ts        # Postgres-backed file storage with in-memory cache (keeps last 10)
├── views/
│   ├── shared.ts         # Page shell, nav, shared styles, client-side escapeHtml
│   ├── feed.ts           # Per-wire feed dashboard page
│   ├── queue.ts          # Scan queue review page
│   ├── settings.ts       # Schedules/settings page
│   ├── login.ts          # Privy login page
│   └── error.ts          # Error/download/expired link pages
├── utils/
│   ├── async.ts          # Shared sleep() utility
│   ├── html.ts           # Shared escapeHtml() utility
│   └── url.ts            # Shared normalizeUrl() for URL deduplication
└── types/
    ├── index.ts          # Core TypeScript interfaces
    └── intake.ts         # Scan pipeline types (ScanEntry, etc.)
```

## Common Tasks

### Adding a New API Endpoint
1. Add route in `src/server.ts`
2. For authenticated routes, use the `requireAuth` middleware (validates HttpOnly session cookie)
3. Return JSON for `/api/*` routes

### Modifying the Dashboard UI
The dashboard is rendered via view functions in `src/views/`:
- `renderLoginPage()` - Login form (Privy-based)
- `renderFeedPage()` - Per-wire feed dashboard
- `renderQueuePage()` - Scan queue review interface
- `renderSettingsPage()` - Schedules and settings
- `renderErrorPage()` - Error display
- All views use `renderPageShell()` from `shared.ts` for consistent layout

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

Schedule configuration uses a `schedules` table with UUID primary keys, supporting multiple named schedules with a `schedule_type` field (`scan-execution` or `forum-scan`). Legacy `schedule_config` data is auto-migrated on startup.

The `feeds` table manages dynamic wire/feed types, seeded from `SEED_FEEDS` and auto-discovered from `channel_configs`. Scan pipeline uses 4 tables: `scan_entries`, `seen_urls`, `seen_names`, `intake_runs`. Scan prompts are stored in `scan_prompts` with CRUD support.

Note: `distribution_config` and `distribution_logs` tables exist in the DB but are no longer managed by this codebase.

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
- `src/server.ts` prevents duplicate manual job execution — if a scan execution is already running, subsequent requests return 409 with the existing job ID.
- `src/services/scheduler.ts` prevents overlapping cron runs via an `executingJobs` set — if a scheduled job is still running when the next cron tick fires, it is skipped.

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
- `FORUM_SCAN_ENABLED` - Set to `true` to enable forum scanning
- `DISCUSS_WATCH_API_URL` - Base URL for discuss.watch API
- `FROM_EMAIL` - Sender email address for notifications
- `DB_SSL_REJECT_UNAUTHORIZED` - Set to `false` for local dev without SSL

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
- **Forum scan** (`forum`): discuss.watch API searches across 150+ Discourse forums for grant keywords
- **Manual paste** (`x-scan`/`web-search`): Dashboard paste-in flow

### Data Flow
1. **Execute**: `scan-execution.ts` fetches active prompts from `scan_prompts`, calls Grok Responses API with `x_search` or `web_search` tool (per prompt's `tool_type`)
2. **Parse**: `intake.ts` extracts structured results (name, description, deadline, link, amount) from Grok output
3. **Insert**: Raw results written to `scan_entries` with `status: raw`
4. **Dedup**: `dedup.ts` checks against `seen_urls` (exact URL match) and `seen_names` (fuzzy token overlap)
5. **Score**: `quality-scorer.ts` assigns 0-100 quality score based on amount, deadline, actionability
6. **Queue**: Entries with score >= 40 get `status: queued`; below threshold -> `status: archived`

### Key Files
- `src/jobs/scan-execution.ts` - Orchestrates prompt execution and feeds results to intake
- `src/jobs/daily-intake.ts` - Main intake pipeline (dedup -> score -> queue)
- `src/services/intake.ts` - Parser, URL/name normalization
- `src/services/dedup.ts` - Two-layer dedup (URL exact + name fuzzy)
- `src/services/quality-scorer.ts` - Scoring engine with type classification
- `src/services/scan-stats.ts` - Prompt effectiveness metrics (dup rate, avg quality, overlap)
- `src/services/forum.ts` - discuss.watch API client for forum scanning
- `src/jobs/forum-scan.ts` - Forum scan orchestrator (search -> intake pipeline)

### Schedule Types
- **`scan-execution`**: Daily cron, runs `runScanExecution()` which executes all active prompts for a wire
- **`forum-scan`**: Daily cron, runs `runForumScan()` which searches discuss.watch forums

### Prompt Management
- Prompts stored in `scan_prompts` table with `wire`, `label`, `prompt_text`, `response_format`, `variant`, `tool_type`
- CRUD API: `/api/scan/prompts` (GET/POST), `/api/scan/prompts/:id` (PUT/DELETE)
- Test endpoint: `/api/scan/prompts/:id/test` -- executes a prompt and returns parsed results without intake processing
- Effectiveness stats: `/api/scan/prompt-stats` -- per-prompt metrics and cross-prompt overlap rate

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
- **Adjusting quality scoring weights**: `src/services/quality-scorer.ts` -- modify point values in `scoreEntry()`
- **Adding a new feed/wire type**: Via `/api/feeds` POST or add to `SEED_FEEDS` in `src/db/index.ts`
- **Testing a scan prompt**: `POST /api/scan/prompts/:id/test` -- executes against Grok and returns parsed results
- **Viewing prompt effectiveness**: `GET /api/scan/prompt-stats?days=7`
- **Creating a web search prompt**: Set `toolType: 'web_search'` in POST `/api/scan/prompts` (or select "Web Search" in dashboard)
- **Running a forum scan**: `POST /api/forum/run` with optional `{ "wire": "crypto" }` (requires `FORUM_SCAN_ENABLED=true`)
- **Adding forum search keywords**: Edit `GRANT_KEYWORDS` array in `src/services/forum.ts`

## Rate Limiting

In-memory rate limiter in `src/server.ts`:
| Endpoint | Limit | Window |
|----------|-------|--------|
| `/resend-link` | 2 per IP | 30 min |
| `/api/scan/prompts/:id/test` | 5 global | 5 min |
| `/api/scan/run` | 1 global | 15 min |
| `/api/forum/run` | 1 global | 15 min |
| `/api/summary-sync` | 3 global | 5 min |

## Code Style Notes

- TypeScript strict mode
- Express for HTTP server
- Login page uses React (via ESM) with Privy; dashboard uses vanilla JS in embedded HTML
- Views are in `src/views/` with a shared page shell pattern
- Client-side `escapeHtml()` is defined once in `shared.ts` via `CLIENT_ESCAPE_HTML` constant
- Validation helpers (`isValidUuid()`, `isValidFeedKey()`) are defined in `server.ts`
- Minimal dependencies
- Error messages include context for debugging

## Planned / Not Yet Implemented

The following features are planned but not yet built:
- **Multi-channel distribution** (Telegram + X posting on approval)
- **CRM sync** (Notion organization tracking)
- **Telegram bot ingestion** (URL submission via Telegram)
- **Email inbound ingestion** (URL extraction from forwarded emails)
- **Weekly newsletter generation** (weekly-summary job)

The database tables `distribution_config` and `distribution_logs` exist but are not managed by the current codebase.
