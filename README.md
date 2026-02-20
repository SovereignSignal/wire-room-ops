# Crypto Grant Wire Summarizer

Automated weekly newsletter preparation for Crypto Grant Wire. Pulls pre-categorized entries from Postgres, enriches content via Grok (for X.com/Twitter) and Anthropic Claude (for other URLs with web scraping), and delivers a formatted markdown file ready for final publication.

## Features

- **Multi-AI Processing**: Routes X.com/Twitter URLs to Grok API (with live tweet access) and other URLs to Claude (with Firecrawl web scraping)
- **Web Dashboard**: Modern dark-themed UI with magic link authentication
- **Multi-Feed Support**: Filter by wire/feed (crypto, ai, oss) for targeted summaries
- **Scheduled Jobs**: Multiple configurable schedules with cron-based scheduling, persisted to database
- **CRM Integration**: Notion-based org tracking with staging database workflow for new organizations
- **Health Monitoring**: Real-time scheduler status, job history, and failure notifications
- **Model Selection**: Dynamic model loading from Grok and Anthropic APIs with UI selection
- **Email Notifications**: Branded emails for login, job completion, test alerts, and failure notifications

## Architecture

```
[Postgres DB] --> [Web Dashboard / Scheduler] --> [AI Processing] --> [Markdown File]
                         |                              |
                         v                              v
                  [Magic Link Auth]            [Grok for X.com]
                  [Email via Resend]           [Claude + Firecrawl for other URLs]
```

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Required variables:
- `DATABASE_URL` - Postgres connection string
- `ANTHROPIC_API_KEY` - For summarizing non-X.com URLs via Claude
- `GROK_API_KEY` - For summarizing X.com/Twitter URLs via Grok
- `FIRECRAWL_API_KEY` - For web scraping non-X.com content
- `RESEND_API_KEY` - For sending notification emails
- `NOTIFICATION_EMAIL` - Email to receive notifications and for dashboard login
- `MAGIC_LINK_SECRET` - Random secret for token generation

### 3. Build

```bash
npm run build
```

### 4. Run

**Start the web server** (includes scheduler):
```bash
npm start
```

**Run the weekly summary job via CLI** (with email notification):
```bash
npm run job:weekly
```

**Development mode**:
```bash
npm run dev
```

## Database Schema

The application expects a `summaries` table with related tables for messages and categories:

```sql
-- Main summaries table
CREATE TABLE summaries (
  id SERIAL PRIMARY KEY,
  message_id INTEGER REFERENCES messages(id),
  category_id INTEGER REFERENCES categories(id),
  title TEXT,
  summary TEXT,
  processing_status TEXT DEFAULT 'SUCCESS',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Messages table (contains extracted URLs)
CREATE TABLE messages (
  id SERIAL PRIMARY KEY,
  extracted_urls JSONB,  -- Array of URLs extracted from message
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Categories table
CREATE TABLE categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);

-- Multiple schedule configurations (auto-created by app)
CREATE TABLE schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL DEFAULT 'Untitled Schedule',
  enabled BOOLEAN NOT NULL DEFAULT false,
  day_of_week INTEGER NOT NULL DEFAULT 3,  -- 0=Sunday, 6=Saturday
  hour INTEGER NOT NULL DEFAULT 9,
  minute INTEGER NOT NULL DEFAULT 0,
  lookback_days INTEGER NOT NULL DEFAULT 7,
  grok_model TEXT,
  anthropic_model TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  wire TEXT,
  schedule_type TEXT DEFAULT 'weekly-summary',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Generated files (auto-created by app)
CREATE TABLE generated_files (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  date_range_start TIMESTAMP WITH TIME ZONE,
  date_range_end TIMESTAMP WITH TIME ZONE
);

-- Dynamic wire/feed management (auto-created by app)
CREATE TABLE feeds (
  key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  title_template TEXT,
  sort_order INTEGER DEFAULT 0,
  archived BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Scan pipeline tables (auto-created by app)
CREATE TABLE scan_entries (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  source_url TEXT NOT NULL,
  amount TEXT,
  amount_numeric NUMERIC,
  amount_currency TEXT,
  deadline TEXT,
  deadline_parsed DATE,
  wire TEXT NOT NULL,
  prompt_variant TEXT NOT NULL CHECK (prompt_variant IN ('A', 'B', 'C')),
  scan_source TEXT NOT NULL DEFAULT 'x-scan',
  scan_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'raw',
  quality_score INTEGER,
  quality_breakdown JSONB,
  duplicate_of_id INTEGER REFERENCES scan_entries(id),
  duplicate_reason TEXT,
  prompt_id UUID REFERENCES scan_prompts(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE seen_urls (
  id SERIAL PRIMARY KEY,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  first_seen_entry_id INTEGER NOT NULL REFERENCES scan_entries(id),
  first_seen_date DATE NOT NULL,
  wire TEXT NOT NULL,
  UNIQUE(normalized_url, wire)
);

CREATE TABLE seen_names (
  id SERIAL PRIMARY KEY,
  name_original TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  name_tokens TEXT[],
  entry_id INTEGER NOT NULL REFERENCES scan_entries(id),
  wire TEXT NOT NULL,
  first_seen DATE NOT NULL
);

CREATE TABLE intake_runs (
  id SERIAL PRIMARY KEY,
  run_date DATE NOT NULL,
  wire TEXT,
  total_ingested INTEGER DEFAULT 0,
  duplicates_found INTEGER DEFAULT 0,
  new_unique INTEGER DEFAULT 0,
  avg_quality_score NUMERIC,
  high_quality_count INTEGER DEFAULT 0,
  summary JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Managed scan prompts (auto-created by app)
CREATE TABLE scan_prompts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wire TEXT NOT NULL,
  label TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  response_format TEXT,
  variant TEXT CHECK (variant IN ('A', 'B', 'C')),
  is_active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
```

## Railway Deployment

The app is configured for Railway deployment via `railway.json`:

1. Connect your GitHub repo to Railway
2. Set environment variables in Railway dashboard
3. Railway will auto-detect and deploy
4. Health check endpoint: `/health`

The scheduler runs within the main web service process - no separate cron service needed.

## Project Structure

```
src/
├── config/
│   └── index.ts           # Environment configuration and validation
├── db/
│   └── index.ts           # Postgres queries, schedules, feeds, scan tables, scan prompts
├── jobs/
│   ├── weekly-summary.ts  # Weekly newsletter job orchestration
│   ├── daily-intake.ts    # Scan intake pipeline orchestrator (parse → dedup → score → queue)
│   └── scan-execution.ts  # Automated scan execution (prompt fetch → Grok → intake)
├── services/
│   ├── anthropic.ts       # Claude API integration with scraping
│   ├── auth.ts            # Magic link and session management
│   ├── crm-sync.ts        # Notion CRM sync - org matching and auto-creation
│   ├── dedup.ts           # URL exact-match and fuzzy name deduplication
│   ├── email.ts           # Resend email service (login, notifications, alerts)
│   ├── grok.ts            # Grok Chat + Responses API for X.com content and scans
│   ├── intake.ts          # Scan result parser, URL/name normalization
│   ├── job-queue.ts       # In-memory job queue with SSE support
│   ├── markdown.ts        # Output formatting with linked org names
│   ├── models.ts          # Dynamic model fetching from AI providers
│   ├── notion.ts          # Notion API client with rate limiting
│   ├── org-cache.ts       # Local alias cache for org name matching
│   ├── processor.ts       # Entry processing with retry logic
│   ├── quality-scorer.ts  # 0-100 quality scoring engine for scan entries
│   ├── scan-stats.ts      # Prompt effectiveness and overlap metrics
│   ├── scheduler.ts       # Cron-based job scheduling with health tracking
│   ├── scraper.ts         # Firecrawl web scraping, URL resolution
│   └── storage.ts         # Postgres-backed file storage with in-memory cache
├── types/
│   ├── index.ts           # Core TypeScript interfaces
│   └── intake.ts          # Scan pipeline types (ScanEntry, DedupResult, QualityBreakdown)
├── index.ts               # Application entry point
└── server.ts              # Express server with all routes and dashboard UI
```

## API Endpoints

### Public Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check (returns `{ status: 'ok', timestamp }`) |
| `/` | GET | Login page |
| `/login` | POST | Request magic link email |
| `/auth` | GET | Magic link authentication |
| `/download` | GET | Legacy download landing (from email links) |
| `/download/:token` | GET | Legacy file download |
| `/resend-link` | POST | Resend file download link via email |

### Authenticated Endpoints (require HttpOnly session cookie)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/dashboard` | GET | Main dashboard UI |
| `/file/:fileId` | GET | Download generated markdown file |
| **Models & Files** | | |
| `/api/models` | GET | Get available AI models from Grok and Anthropic |
| `/api/files` | GET | List recent generated files |
| `/api/run-job` | POST | Trigger summary job manually |
| `/api/job/:jobId/progress` | GET | SSE endpoint for job progress updates |
| **Feeds** | | |
| `/api/wires` | GET | Get active feeds with entry counts |
| `/api/feeds` | GET | List all feeds (pass `?includeArchived=true` for archived) |
| `/api/feeds` | POST | Create a new feed |
| `/api/feeds/:key` | PUT | Update feed display name, title template, or sort order |
| `/api/feeds/:key` | DELETE | Archive a feed |
| **Schedules** | | |
| `/api/schedules` | GET | List all schedule configurations |
| `/api/schedules` | POST | Create new schedule |
| `/api/schedules/:id` | PUT | Update schedule configuration |
| `/api/schedules/:id` | DELETE | Delete a schedule |
| `/api/schedule` | GET/POST | Legacy single-schedule endpoints |
| `/api/scheduler-status` | GET | Get scheduler health and job history |
| `/api/test-alert` | POST | Send test email to verify configuration |
| **CRM Sync** | | |
| `/api/crm-sync` | POST | Run CRM org sync job |
| `/api/crm-sync/status` | GET | Get CRM sync status (staging config, pending count) |
| `/api/crm-sync/staging-orgs` | GET | List organizations in staging database |
| **Scan Pipeline** | | |
| `/api/scan/submit` | POST | Submit single scan results for intake processing |
| `/api/scan/submit-batch` | POST | Submit batch scan results (multiple prompts at once) |
| `/api/scan/queue` | GET | Get daily queue of quality entries (filter by wire, date, minScore) |
| `/api/scan/stats` | GET | Get intake stats for dashboard (entries by day/wire) |
| `/api/scan/run` | POST | Trigger automated scan execution (all active prompts) |
| `/api/scan/entries/:id/action` | POST | Take action on a scan entry (skip, archive, queue) |
| `/api/scan/prompt-stats` | GET | Get prompt effectiveness metrics and overlap stats |
| **Scan Prompts** | | |
| `/api/scan/prompts` | GET | List all scan prompts (filter by wire, active only) |
| `/api/scan/prompts` | POST | Create a new scan prompt |
| `/api/scan/prompts/:id` | PUT | Update a scan prompt |
| `/api/scan/prompts/:id` | DELETE | Delete a scan prompt |
| `/api/scan/prompts/:id/test` | POST | Test-execute a prompt against Grok and return results |

## Dashboard Features

The web dashboard provides:

### Generate Weekly Summary
- Select custom date range
- Choose Grok model for X.com content
- Choose Claude model for other content
- Real-time progress tracking via SSE
- Elapsed time display

### Generated Files
- List of recent generated markdown files
- Direct download links

### Scheduled Runs
- Enable/disable automatic scheduling
- Configure day of week and time
- Set timezone
- Set lookback period (days)
- Select default models for scheduled runs
- View next scheduled run time

### Scheduler Health
- Scheduler status (Active/Disabled/Not Running)
- Server start time
- Last job run time
- Last job result (Success/Failed with error details)

### CRM Org Sync
- View staging database configuration status
- Set lookback period (days) for sync
- Run manual sync to identify new organizations
- View pending org count awaiting review

## CRM Integration

The app integrates with Notion for organization tracking:

1. **Main Orgs Database**: Your existing CRM with known organizations
2. **Staging Database**: New organizations discovered from entries, pending review

### Sync Workflow
1. Entries are scanned for organization names (from `entities.orgs` field)
2. Each org is checked against the main CRM via local cache and Notion search
3. New orgs are created in the staging database with status "Pending"
4. Review pending orgs in Notion and set status to "Approved" or "Rejected"
5. Use Notion automation to copy approved orgs to main CRM

### Staging Database Schema
| Property | Type | Description |
|----------|------|-------------|
| Name | title | Organization name |
| Wire | select | crypto / ai / oss |
| Source Type | select | Social / Blog / Forum / etc. |
| First Seen | date | When first encountered |
| Entry Title | text | Title of entry where org appeared |
| Entry URL | url | Link to original source |
| Status | select | Pending / Approved / Rejected |

## Scan Pipeline

The scan pipeline discovers new grant opportunities via automated X.com scanning and surfaces high-quality entries for review.

### Pipeline Flow

```
Grok Responses API (/v1/responses with x_search tool)
        │
        ▼
  Parse Structured Output (name, description, deadline, link, amount)
        │
        ▼
  Insert as scan_entries (status: raw)
        │
        ▼
  Dedup Check
  ├─ Layer 1: URL exact match (seen_urls table)
  └─ Layer 2: Fuzzy name match (seen_names + token overlap)
  │
  ├─ Duplicate? → status: duplicate, link to original
  └─ Unique? → status: deduped, register in seen tables
        │
        ▼
  Quality Score (0-100)
  ├─ Has amount: +25
  ├─ Amount > $5K: +15
  ├─ Has deadline: +15
  ├─ Deadline within 60 days: +10
  ├─ Is funding opportunity: +20
  ├─ Is actionable: +15
  ├─ Governance noise: -15
  └─ Already awarded: -10
  │
  ├─ Score >= 40? → status: queued
  └─ Score < 40? → status: archived
        │
        ▼
  Daily Queue (dashboard view)
```

### Quality Score Thresholds

- **80-100**: Top tier — real grant with dollar amount, deadline, and clear application path
- **60-79**: Strong find — has most signals of a real opportunity
- **40-59**: Moderate — worth reviewing but may be lower signal
- **Below 40**: Archived — governance proposals, already-awarded items, vague mentions

### Schedule Types

- **`weekly-summary`**: Traditional weekly cron job for newsletter generation
- **`scan-execution`**: Daily cron job that executes all active scan prompts and feeds results through the intake pipeline

### Prompt Management

Scan prompts are stored in the `scan_prompts` table and managed via the `/api/scan/prompts` CRUD API. Each prompt targets a specific wire, has a response format template, and can be tested individually before activation. Prompt effectiveness metrics (duplicate rate, avg quality score, overlap) are available via `/api/scan/prompt-stats`.

## How It Works

1. **Query**: Pulls entries from Postgres for the configured date range, deduplicates by URL
2. **Route**: X.com/Twitter URLs go to Grok API, other URLs go to Claude
3. **Scrape**: For non-X.com URLs, Firecrawl scrapes the page content
4. **Process**: Each URL is summarized with retry logic (3 attempts with exponential backoff)
5. **Generate**: Markdown file organized by category with hyperlinked organization names
6. **Store**: File saved to Postgres with unique ID (keeps last 10 files)
7. **Notify**: Optional email sent with magic link to download

## Scheduled Jobs

The scheduler:
- Uses node-cron for precise scheduling
- Persists configuration to database (survives restarts)
- Sends success emails with download links
- Sends failure notification emails with error details
- Tracks last run status for dashboard display

Default schedule: Wednesday at 9:00 AM Pacific, looking back 7 days.

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | Postgres connection string | Yes |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude | Yes |
| `GROK_API_KEY` | X.ai Grok API key | Yes |
| `FIRECRAWL_API_KEY` | Firecrawl API key for web scraping | Yes |
| `RESEND_API_KEY` | Resend email API key | Yes |
| `NOTIFICATION_EMAIL` | Email for notifications and login | Yes |
| `MAGIC_LINK_SECRET` | Secret for token hashing | Yes |
| `APP_URL` | Public URL of the app (default: `http://localhost:3000`) | No |
| `FROM_EMAIL` | Sender email (default: `noreply@cryptograntwire.com`) | No |
| `PORT` | Server port (default: 3000) | No |
| `START_DATE` | Override start date for CLI job (ISO format) | No |
| `END_DATE` | Override end date for CLI job (ISO format) | No |
| `NOTION_API_KEY` | Notion integration API key | No* |
| `NOTION_ORGS_DB_ID` | Main organizations database ID | No* |
| `NOTION_STAGING_ORGS_DB_ID` | Staging database for new orgs | No* |
| `NOTION_OPPS_DB_ID` | Opportunities database ID | No* |
| `NOTION_CRM_PAGE_ID` | CRM page ID for Notion | No* |

*Required for CRM integration features

## Authentication

The app uses magic link authentication:

1. User enters email at `/` (must match `NOTIFICATION_EMAIL`)
2. Magic link sent via Resend (expires in 15 minutes)
3. Clicking link creates a 24-hour session stored as an HttpOnly cookie
4. All authenticated endpoints use the `requireAuth` middleware to validate the session cookie

Sessions and tokens are stored in-memory (reset on server restart). Generated files are persisted to Postgres.

## AI Models

### Grok (X.com content)
- Newsletter summaries: `grok-4-1-fast-reasoning` (Chat Completions API at `/v1/chat/completions`)
- Scan execution: `grok-4-1-fast` (Responses API at `/v1/responses` with `x_search` tool)
- Has access to live X.com/Twitter posts
- Models fetched dynamically from X.ai API

### Claude (other content)
- Default: `claude-opus-4-5-20251101`
- Uses Firecrawl for web scraping
- Falls back to cached summary if scraping fails
- Models fetched dynamically from Anthropic API

## Error Handling

- **Retry Logic**: 3 attempts with 1s, 2s, 4s delays for newsletter processing; 2 attempts for scan execution (expensive Grok calls)
- **Rate Limiting**: 500ms delay between processing entries
- **Scrape Fallback**: Uses cached summary if web scraping fails
- **Failure Notifications**: Email sent on scheduled job failures
- **URL Deduplication**: Removes duplicate URLs within date range

### API Rate Limits

| Endpoint | Limit | Window |
|----------|-------|--------|
| `/login` | 5 requests per IP | 15 minutes |
| `/resend-link` | 3 requests per IP | 15 minutes |
| `/api/run-job` | 3 requests | 5 minutes |
| `/api/scan/prompts/:id/test` | 5 requests | 5 minutes |
| `/api/scan/run` | 1 request | 15 minutes |

## License

MIT
