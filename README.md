# Crypto Grant Wire Summarizer

Automated weekly newsletter preparation for Crypto Grant Wire. Pulls pre-categorized links from Postgres, enriches content via Grok (for X.com) and Anthropic Claude (for other URLs), and delivers a formatted markdown file ready for final publication.

## Architecture

```
[Postgres DB] → [Weekly Job] → [Grok/Opus Processing] → [Markdown File] → [Email Notification] → [Magic Link Download]
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
- `ANTHROPIC_API_KEY` - For summarizing non-X.com URLs
- `GROK_API_KEY` - For summarizing X.com/Twitter URLs
- `RESEND_API_KEY` - For sending notification emails
- `NOTIFICATION_EMAIL` - Email to receive weekly notifications
- `MAGIC_LINK_SECRET` - Random secret for token generation
- `APP_URL` - Public URL of the deployed app

### 3. Build

```bash
npm run build
```

### 4. Run

**Start the web server** (for download endpoints):
```bash
npm start
```

**Run the weekly summary job manually**:
```bash
npm run job:weekly
```

## Database Schema

The automation expects an `entries` table with these columns:

```sql
CREATE TABLE entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url TEXT NOT NULL,
  quick_summary TEXT,
  category TEXT,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  source TEXT
);
```

## Railway Deployment

### Web Service

1. Connect your GitHub repo to Railway
2. Set environment variables in Railway dashboard
3. Railway will auto-detect and deploy

### Cron Job (Weekly Summary)

Set up a Railway cron service with:
- **Schedule**: `0 8 * * 5` (Fridays at 8 AM UTC)
- **Command**: `npm run job:weekly`

Or use Railway's one-off jobs feature to trigger manually.

## Project Structure

```
src/
├── config/         # Environment configuration
├── db/             # Postgres connection and queries
├── jobs/           # Scheduled jobs (weekly summary)
├── services/
│   ├── anthropic.ts  # Claude API integration
│   ├── auth.ts       # Magic link authentication
│   ├── email.ts      # Resend email service
│   ├── grok.ts       # Grok API integration
│   ├── markdown.ts   # Output formatting
│   ├── processor.ts  # Entry processing logic
│   └── storage.ts    # File storage
├── types/          # TypeScript interfaces
├── index.ts        # Server entry point
└── server.ts       # Express web server
```

## API Endpoints

- `GET /health` - Health check
- `GET /download?token=...` - Magic link landing page
- `GET /download/:token` - File download (one-time use)
- `GET /api/files` - List recent generated files

## How It Works

1. **Query**: Pulls entries from Postgres for the past 7 days
2. **Route**: X.com URLs → Grok API, other URLs → Claude
3. **Process**: Each URL is summarized with retry logic
4. **Generate**: Markdown file organized by category
5. **Store**: File saved with unique ID
6. **Notify**: Email sent with magic link
7. **Download**: User clicks link, authenticates, downloads

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | Postgres connection string | Yes |
| `ANTHROPIC_API_KEY` | Anthropic API key | Yes |
| `GROK_API_KEY` | X.ai Grok API key | Yes |
| `RESEND_API_KEY` | Resend email API key | Yes |
| `NOTIFICATION_EMAIL` | Email for notifications | Yes |
| `FROM_EMAIL` | Sender email address | No |
| `MAGIC_LINK_SECRET` | Secret for token hashing | Yes |
| `APP_URL` | Public URL of the app | Yes |
| `PORT` | Server port (default: 3000) | No |
| `START_DATE` | Override start date (ISO) | No |
| `END_DATE` | Override end date (ISO) | No |

## License

MIT