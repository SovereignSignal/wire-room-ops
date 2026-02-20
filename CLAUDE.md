# CLAUDE.md - AI Context for CryptoGrantWire

This file provides context for AI assistants working with this codebase.

## Project Overview

**CryptoGrantWire Summarizer** is a Node.js/TypeScript application that automates weekly newsletter preparation for a cryptocurrency grants-focused newsletter. It pulls categorized entries from a Postgres database, enriches them using AI (Grok for X.com content, Claude for other URLs), and generates formatted markdown files.

## Key Architecture Decisions

### Dual AI Processing
- **Grok API** handles X.com/Twitter URLs because it has native access to tweet content
- **Claude API** handles all other URLs, using Firecrawl for web scraping
- This routing happens in `src/services/processor.ts` via `isXcomUrl()` check

### Storage Strategy
- **Generated files** and **schedule configs** are persisted to Postgres (survive restarts)
- **Sessions, tokens, and job queues** are stored in-memory (reset on restart)
- Single-instance deployment only

### Magic Link Authentication
Single-user authentication where only `NOTIFICATION_EMAIL` can log in. Magic links expire in 15 minutes, sessions last 24 hours.

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
│   └── scan-execution.ts   # Automated scan execution (prompt fetch → Grok → intake)
├── services/
│   ├── anthropic.ts      # Claude API calls with scraping integration
│   ├── auth.ts           # Magic links, sessions, tokens
│   ├── crm-sync.ts       # Notion CRM sync - org matching and auto-creation
│   ├── dedup.ts          # URL exact-match and fuzzy name deduplication
│   ├── email.ts          # Resend email templates (5 types)
│   ├── email-inbound.ts  # Resend Inbound webhook handler (URL extraction → intake)
│   ├── grok.ts           # Grok Chat + Responses API for X.com content and scans
│   ├── intake.ts         # Scan result parser, URL/name normalization
│   ├── job-queue.ts      # SSE-based job progress tracking
│   ├── markdown.ts       # Output generation with category grouping
│   ├── models.ts         # Dynamic model fetching from both APIs
│   ├── notion.ts         # Notion API client with rate limiting
│   ├── org-cache.ts      # Local alias cache for org name matching
│   ├── processor.ts      # Entry processing with retry logic
│   ├── quality-scorer.ts # 0-100 quality scoring engine for scan entries
│   ├── scan-stats.ts     # Prompt effectiveness and overlap metrics
│   ├── scheduler.ts      # node-cron scheduling with health tracking
│   ├── scraper.ts        # Firecrawl integration, URL resolution
│   ├── storage.ts        # Postgres-backed file storage with in-memory cache (keeps last 10)
│   ├── telegram.ts       # Telegram Bot webhook handler (URL → scrape → intake)
│   └── url-processor.ts  # Shared URL scrape + AI extraction → RawScanResult
└── types/
    ├── index.ts          # Core TypeScript interfaces
    └── intake.ts         # Scan pipeline types (ScanEntry, DedupResult, QualityBreakdown)
```

## Common Tasks

### Adding a New API Endpoint
1. Add route in `src/server.ts`
2. For authenticated routes, use the `requireAuth` middleware (validates HttpOnly session cookie)
3. Return JSON for `/api/*` routes

### Modifying the Dashboard UI
The dashboard is rendered as inline HTML in `src/server.ts`:
- `renderLoginPage()` - Login form
- `renderLoginSentPage()` - "Check your email" confirmation
- `renderDashboard()` - Main dashboard with embedded JavaScript
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

Schedule configuration uses a `schedules` table with UUID primary keys, supporting multiple named schedules with a `schedule_type` field (`weekly-summary` or `scan-execution`). Legacy `schedule_config` data is auto-migrated on startup.

The `feeds` table manages dynamic wire/feed types, seeded from `SEED_FEEDS` and auto-discovered from `channel_configs`. Scan pipeline uses 4 tables: `scan_entries`, `seen_urls`, `seen_names`, `intake_runs`. Scan prompts are stored in `scan_prompts` with CRUD support.

## API Integration Details

### Grok API (X.ai)
- **Chat Completions** (`/v1/chat/completions`): Used for newsletter summaries. Default model: `grok-4-1-fast-reasoning`
- **Responses API** (`/v1/responses`): Used for scan execution with `x_search` tool for real-time X.com scanning. Default model: `grok-4-1-fast`
- Has native X.com/Twitter access

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
- Newsletter processing: 3 attempts with 1s, 2s, 4s delays (applies to both Grok and Claude calls)
- Scan execution: 2 attempts (1 retry) — these are expensive Grok Responses API calls

### Scrape Fallback
If Firecrawl fails, Claude uses only the cached summary from the database. Output includes note: `*[Summary based on cached data...]*`

### Job Failure Notifications
Scheduled jobs that fail send email via `sendScheduledJobFailureEmail()` with error details.

## Testing Locally

1. Copy `.env.example` to `.env` and fill in all API keys
2. `npm install`
3. `npm run dev` (uses ts-node)
4. Access http://localhost:3000
5. Login with the email matching `NOTIFICATION_EMAIL`

## Common Issues

### "Missing required environment variables"
Check that all 7 required env vars are set (see README).

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
Automated discovery of grant opportunities via X.com scanning, Telegram bot, and email ingestion. Intake processing eliminates duplicates and surfaces high-quality entries.

### Ingestion Channels
- **Automated scan** (`x-scan`): Grok Responses API with `x_search` tool, runs on schedule
- **Manual paste** (`x-scan`/`web-search`): Dashboard paste-in flow
- **Telegram bot** (`telegram`): Send a URL → bot scrapes + extracts → intake pipeline
- **Email inbound** (`email`): Send email with URLs → Resend webhook → scrape + extract → intake

### Data Flow
1. **Execute**: `scan-execution.ts` fetches active prompts from `scan_prompts`, calls Grok Responses API with `x_search` tool
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

### Schedule Types
- **`weekly-summary`**: Weekly cron, runs `runWeeklySummaryJob()` for newsletter generation
- **`scan-execution`**: Daily cron, runs `runScanExecution()` which executes all active prompts for a wire

### Prompt Management
- Prompts stored in `scan_prompts` table with `wire`, `label`, `prompt_text`, `response_format`, `variant`
- CRUD API: `/api/scan/prompts` (GET/POST), `/api/scan/prompts/:id` (PUT/DELETE)
- Test endpoint: `/api/scan/prompts/:id/test` — executes a prompt and returns parsed results without intake processing
- Effectiveness stats: `/api/scan/prompt-stats` — per-prompt metrics and cross-prompt overlap rate

### Quality Score Breakdown
| Signal | Points | Condition |
|--------|--------|-----------|
| Has amount | +25 | Non-empty amount field |
| Amount > $5K | +15 | Parsed numeric >= 5000 |
| Has deadline | +15 | Specific date (not "Rolling" or empty) |
| Deadline upcoming | +10 | Within 60 days |
| Funding opportunity | +20 | Grant, fellowship, hackathon, etc. |
| Is actionable | +15 | Someone can apply/register |
| Governance noise | -15 | DAO proposals, treasury votes |
| Already awarded | -10 | Past-tense grant language |

### Common Tasks for Scan Pipeline
- **Adjusting quality scoring weights**: `src/services/quality-scorer.ts` — modify point values in `scoreEntry()`
- **Adding a new feed/wire type**: Via `/api/feeds` POST or add to `SEED_FEEDS` in `src/db/index.ts`
- **Testing a scan prompt**: `POST /api/scan/prompts/:id/test` — executes against Grok and returns parsed results
- **Viewing prompt effectiveness**: `GET /api/scan/prompt-stats?days=7`

## Rate Limiting

In-memory rate limiter in `src/server.ts`:
| Endpoint | Limit | Window |
|----------|-------|--------|
| `/login` | 5 per IP | 15 min |
| `/resend-link` | 3 per IP | 15 min |
| `/api/run-job` | 3 global | 5 min |
| `/api/scan/prompts/:id/test` | 5 global | 5 min |
| `/api/scan/run` | 1 global | 15 min |
| `/webhook/telegram` | 10 per chat | 1 min |
| `/webhook/email` | 5 per sender | 15 min |

## Code Style Notes

- TypeScript strict mode
- Express for HTTP server
- No frontend framework - vanilla JS in embedded HTML
- Minimal dependencies
- Error messages include context for debugging
