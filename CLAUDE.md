# CLAUDE.md - AI Context for CryptoGrantWire

This file provides context for AI assistants working with this codebase.

## Project Overview

**CryptoGrantWire Summarizer** is a Node.js/TypeScript application that automates weekly newsletter preparation for a cryptocurrency grants-focused newsletter. It pulls categorized entries from a Postgres database, enriches them using AI (Grok for X.com content, Claude for other URLs), and generates formatted markdown files.

## Key Architecture Decisions

### Dual AI Processing
- **Grok API** handles X.com/Twitter URLs because it has native access to tweet content
- **Claude API** handles all other URLs, using Firecrawl for web scraping
- This routing happens in `src/services/processor.ts` via `isXcomUrl()` check

### In-Memory Storage
Sessions, tokens, files, and job queues are stored in-memory. This is intentional for simplicity but means:
- Data resets on server restart
- Single-instance deployment only
- Schedule config is the exception - persisted to Postgres

### Magic Link Authentication
Single-user authentication where only `NOTIFICATION_EMAIL` can log in. Magic links expire in 15 minutes, sessions last 24 hours.

## File Structure Quick Reference

```
src/
├── index.ts           # Entry point - validates config, starts server
├── server.ts          # Express routes + embedded HTML templates for dashboard
├── config/index.ts    # Environment variables and validation
├── db/index.ts        # Postgres queries + schedule_config table management
├── jobs/weekly-summary.ts  # Main job orchestration
└── services/
    ├── anthropic.ts   # Claude API calls with scraping integration
    ├── auth.ts        # Magic links, sessions, tokens
    ├── crm-sync.ts    # Notion CRM sync - org matching and auto-creation
    ├── email.ts       # Resend email templates (4 types)
    ├── grok.ts        # Grok API calls for X.com
    ├── job-queue.ts   # SSE-based job progress tracking
    ├── markdown.ts    # Output generation with category grouping
    ├── models.ts      # Dynamic model fetching from both APIs
    ├── notion.ts      # Notion API client with rate limiting
    ├── org-cache.ts   # Local alias cache for org name matching
    ├── processor.ts   # Entry processing with retry logic
    ├── scheduler.ts   # node-cron scheduling with health tracking
    ├── scraper.ts     # Firecrawl integration, URL resolution
    └── storage.ts     # In-memory file storage (keeps last 10)
```

## Common Tasks

### Adding a New API Endpoint
1. Add route in `src/server.ts`
2. For authenticated routes, check `validateSession(session)` first
3. Return JSON for `/api/*` routes

### Modifying the Dashboard UI
The dashboard is rendered as inline HTML in `src/server.ts`:
- `renderLoginPage()` - Login form
- `renderDashboard()` - Main dashboard with embedded JavaScript
- `renderErrorPage()` - Error display

### Changing AI Prompts
- Grok prompt: `src/services/grok.ts` - `GROK_PROMPT`
- Claude prompts: `src/services/anthropic.ts` - `SCRAPED_CONTENT_PROMPT` and `FALLBACK_PROMPT`

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

Schedule configuration uses a single-row table `schedule_config` with `id = 1` constraint.

## API Integration Details

### Grok API (X.ai)
- Endpoint: `https://api.x.ai/v1/chat/completions`
- Has native X.com/Twitter access
- Default model: `grok-4-1-fast-reasoning`

### Claude API (Anthropic)
- Uses official SDK `@anthropic-ai/sdk`
- Default model: `claude-opus-4-5-20251101`

### Firecrawl API
- Endpoint: `https://api.firecrawl.dev/v1/scrape`
- Returns markdown content from web pages
- Used only for non-X.com URLs

### Resend API
- Email service for all notifications
- 4 email types: login, notification, test alert, failure alert

## Error Handling Patterns

### Retry Logic
`src/services/processor.ts` uses `withRetry()`:
- 3 attempts with 1s, 2s, 4s delays
- Applies to both Grok and Claude calls

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
Check that all 8 required env vars are set (see README).

### "No entries found for this date range"
The database query found no `summaries` with `processing_status = 'SUCCESS'` in the date range.

### Scheduler not running after config change
Scheduler restarts automatically when you save schedule config via the dashboard API.

### Files disappear after restart
Files are stored in-memory. This is by design for simplicity.

## Code Style Notes

- TypeScript strict mode
- Express for HTTP server
- No frontend framework - vanilla JS in embedded HTML
- Minimal dependencies
- Error messages include context for debugging
