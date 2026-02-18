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
- `APP_URL` - Public URL of the deployed app

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
│   └── index.ts        # Environment configuration and validation
├── db/
│   └── index.ts        # Postgres connection, queries, schedule persistence
├── jobs/
│   └── weekly-summary.ts  # Main job execution logic
├── services/
│   ├── anthropic.ts    # Claude API integration with scraping
│   ├── auth.ts         # Magic link and session management
│   ├── email.ts        # Resend email service (login, notifications, alerts)
│   ├── grok.ts         # Grok API integration for X.com
│   ├── job-queue.ts    # In-memory job queue with SSE support
│   ├── markdown.ts     # Output formatting with linked org names
│   ├── models.ts       # Dynamic model fetching from AI providers
│   ├── processor.ts    # Entry processing with retry logic
│   ├── scheduler.ts    # Cron-based job scheduling with health tracking
│   ├── scraper.ts      # Firecrawl web scraping, URL resolution
│   └── storage.ts      # Postgres-backed file storage with in-memory cache
├── types/
│   └── index.ts        # TypeScript interfaces
├── index.ts            # Application entry point
└── server.ts           # Express server with all routes and dashboard UI
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

### Authenticated Endpoints (require `?session=` query param)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/dashboard` | GET | Main dashboard UI |
| `/file/:fileId` | GET | Download generated markdown file |
| `/api/models` | GET | Get available AI models from Grok and Anthropic |
| `/api/files` | GET | List recent generated files |
| `/api/run-job` | POST | Trigger summary job manually |
| `/api/job/:jobId/progress` | GET | SSE endpoint for job progress updates |
| `/api/schedules` | GET | List all schedule configurations |
| `/api/schedules` | POST | Create new schedule |
| `/api/schedules/:id` | PUT | Update schedule configuration |
| `/api/schedules/:id` | DELETE | Delete a schedule |
| `/api/schedule` | GET/POST | Legacy single-schedule endpoints |
| `/api/scheduler-status` | GET | Get scheduler health and job history |
| `/api/test-alert` | POST | Send test email to verify configuration |
| `/api/crm-sync` | POST | Run CRM org sync job |
| `/api/crm-sync/status` | GET | Get CRM sync status (staging config, pending count) |
| `/api/crm-sync/staging-orgs` | GET | List organizations in staging database |

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

*Required for CRM integration features

## Authentication

The app uses magic link authentication:

1. User enters email at `/` (must match `NOTIFICATION_EMAIL`)
2. Magic link sent via Resend (expires in 15 minutes)
3. Clicking link creates a 24-hour session
4. Session token passed via query parameter

Sessions and tokens are stored in-memory (reset on server restart). Generated files are persisted to Postgres.

## AI Models

### Grok (X.com content)
- Default: `grok-4-1-fast-reasoning`
- Has access to live X.com/Twitter posts
- Models fetched dynamically from X.ai API

### Claude (other content)
- Default: `claude-opus-4-5-20251101`
- Uses Firecrawl for web scraping
- Falls back to cached summary if scraping fails
- Models fetched dynamically from Anthropic API

## Error Handling

- **Retry Logic**: 3 attempts with 1s, 2s, 4s delays
- **Rate Limiting**: 500ms delay between processing entries
- **Scrape Fallback**: Uses cached summary if web scraping fails
- **Failure Notifications**: Email sent on scheduled job failures
- **URL Deduplication**: Removes duplicate URLs within date range

## License

MIT
