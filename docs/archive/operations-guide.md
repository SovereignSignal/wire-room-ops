# Wire Room Ops - Operations Guide

This guide is for running the **current** `wire-room-ops` service in production.

## What This Service Is For

- Discover leads from X, web search, forums, and Telegram intake.
- Normalize, deduplicate, and quality-score leads.
- Give operators a review queue.
- Distribute approved entries to Telegram channels, X/Twitter, and newsletter.
- Write approved entries through to the shared `summaries` table for downstream readers.

The system is deployment-agnostic: swap brand config and prompts to run any vertical (grants, consulting leads, research intel, etc.).

## What It Is Not (in this repo)

- Notion CRM sync is partially built (`notion-sync.ts`, `org_profiles` table) but not fully production-hardened.
- Distribution can run per-entry on approval, manually in batches, or by drip schedule when configured.
- No inbound email ingestion (planned).

## Production Checklist

1. Set required environment variables.
2. Confirm login + email alert + health endpoint.
3. Create scan prompts for each wire.
4. Run a manual scan and validate queue quality.
5. Configure schedules.
6. Establish daily review routine.
7. Monitor failures and tune prompts/scoring.

## 1) Required Environment Variables

Set these in Railway (or your host):

Required (server will not start without these):

- `DATABASE_URL`
- `NOTIFICATION_EMAIL`
- `PRIVY_APP_ID`
- `PRIVY_APP_SECRET`

Optional API keys (warn on startup; can also be set via Settings > API Providers in dashboard):

- `ANTHROPIC_API_KEY`
- `GROK_API_KEY`
- `FIRECRAWL_API_KEY`
- `RESEND_API_KEY`

Common optional settings:

- `APP_URL`
- `ALLOWED_EMAILS`
- `FORUM_SCAN_ENABLED=true`
- `DISCUSS_WATCH_API_URL`
- `TELEGRAM_BOT_TOKEN` (for channel distribution posting)
- `PERPLEXITY_API_KEY` (for deep web research scans)

Telegram Intake Bot (optional — gracefully disabled if not set):

- `TELEGRAM_INTAKE_BOT_TOKEN` — bot token
- `TELEGRAM_INTAKE_WEBHOOK_SECRET` — random string for webhook validation
- `TELEGRAM_INTAKE_ALLOWED_USER_ID` — Telegram user ID of allowed sender (default: 394395765)

Brand / Deployment Config (all optional, defaults to Wire Room values):

- `BRAND_AUDIENCE` — who reads the content (default: "grant seekers")
- `BRAND_CONTENT_TYPE` — what is scanned for (default: "grant funding opportunities")
- `BRAND_CONTENT_VERB` — action word (default: "apply for")
- `BRAND_NAME`, `BRAND_TAGLINE`, `BRAND_COLOR`, `BRAND_URL`, `BRAND_FROM_NAME`

Scoring / Search Overrides (all optional):

- `QUALITY_FUNDING_TYPES` — JSON array override for funding type keywords
- `QUALITY_ACTIONABLE_TYPES` — JSON array override for actionable type keywords
- `FORUM_SEARCH_TERMS` — comma-separated search terms override
- `INTAKE_WIRES` — comma-separated fallback wire list if DB has no active feeds
- `INTAKE_WIRE_KEYWORDS_{WIRE}` — per-wire keyword overrides

## 2) First Validation

- `GET /health` returns `{ status: "ok" }`.
- `GET /ready` returns `{ status: "ready" }` with `checks.db=true`.
- You can log in at `/` and load `/queue` + `/settings`.
- `POST /api/test-alert` sends a test email.

If any of those fail, do not proceed to scheduling.

## 3) Create Prompts

Create prompts with `wire`, `label`, `promptText`, `toolType`, `isActive`, `sortOrder`, optional `responseFormat`, optional `variant`.

Tool types:

- `x_search` for X-native discovery (Grok Responses API)
- `web_search` for broader web discovery (Grok Responses API)
- `perplexity` for deep web research (Perplexity sonar-pro, requires PERPLEXITY_API_KEY)

The database has legacy allowance for `community`, but current prompt APIs accept `x_search`, `web_search`, and `perplexity`.

Start with 2-3 prompts per wire and test each prompt:

- `POST /api/scan/prompts/:id/test`

## 4) Manual End-to-End Run

Trigger a scan:

- `POST /api/scan/run` (optionally `{ "wire": "crypto" }`)

Track progress:

- `GET /api/job/:jobId/progress`

Review outputs:

- `GET /api/scan/queue`
- `GET /api/scan/status-counts`
- `GET /api/scan/prompt-stats`

## 5) Review and Publish

Queue actions:

- `approve` -> `approved`
- `decline` -> `declined`
- `reviewlater` -> `skipped`
- `restore` -> `queued`

The public site publishes rows with `status = 'approved'`.

## 6) Scheduling

Supported schedule types:

- `scan-execution`
- `forum-scan`
- `daily-digest`
- `collect-engagement`
- `experiment-loop`
- `drip-distribution`
- `deadline-digest`
- `account-monitor`

Example schedule:

```json
{
  "name": "Daily Crypto Scan",
  "enabled": true,
  "scheduleType": "scan-execution",
  "hour": 8,
  "minute": 0,
  "timezone": "America/Los_Angeles",
  "wire": "crypto"
}
```

Sub-daily runs:

- set `frequencyHours` to `1..23`

## 7) Ongoing Ops Routine

Daily:

1. Check `GET /api/scheduler-status`.
2. Open queue and process `queued` items.
3. Spot-check `prompt-stats` for rising duplicate rate or weak quality.

Weekly:

1. Prune/adjust weak prompts.
2. Tighten response formats for brittle parsers.
3. Rebalance scoring weights if queue quality drifts.

## Failure Handling

- Scheduled failures send notification email.
- Scheduler retries once after 5 minutes.
- Manual rerun via `POST /api/scan/run`.

Common causes:

- missing API key/invalid credentials
- Grok/Firecrawl transient failures
- prompt output format drift (parser mismatch)

## Operational Expectations

- You should expect a human-in-the-loop editorial queue, not fully autonomous publishing.
- Prompt quality determines downstream queue quality.
- The most reliable production signal is: stable scheduled runs + manageable queue volume + high approve rate.

## Telegram Intake Bot Setup

The Telegram intake bot lets an authorized user submit URLs and articles to the pipeline by messaging a bot.

1. Create a bot via @BotFather and get the token.
2. Set env vars:
   - `TELEGRAM_INTAKE_BOT_TOKEN` — the bot token
   - `TELEGRAM_INTAKE_WEBHOOK_SECRET` — any random string (used to validate incoming webhooks)
   - `TELEGRAM_INTAKE_ALLOWED_USER_ID` — your Telegram user ID (default: 394395765)
3. Deploy. On startup, the bot auto-registers its webhook at `{APP_URL}/api/telegram/intake-webhook`.
4. Send a URL or text to the bot. If the wire is auto-detected, it's inserted immediately. If ambiguous, the bot presents inline keyboard buttons for wire selection.

The bot is optional — if `TELEGRAM_INTAKE_BOT_TOKEN` is not set, the webhook route still exists but is a no-op.

## Deployment for a New Community

To deploy Wire Room Ops for a different vertical (e.g. consulting leads, research intel):

1. Set brand env vars:
   ```
   BRAND_NAME=Claw Consulting
   BRAND_AUDIENCE=consulting clients
   BRAND_CONTENT_TYPE=AI consulting leads
   BRAND_CONTENT_VERB=pursue
   ```
2. Create feeds for your verticals via `POST /api/feeds` (e.g. "enterprise", "startup", "government").
3. Set per-wire keyword overrides if the defaults don't fit:
   ```
   INTAKE_WIRE_KEYWORDS_ENTERPRISE=enterprise,fortune 500,procurement
   INTAKE_WIRE_KEYWORDS_STARTUP=seed,series a,accelerator,startup
   ```
4. Optionally override scoring keywords:
   ```
   QUALITY_FUNDING_TYPES=["rfp","contract","procurement","consulting engagement"]
   QUALITY_ACTIONABLE_TYPES=["deadline","open bid","submission window"]
   ```
5. Write scan prompts for the new domain and load via `/api/scan/prompts`.
6. Configure distribution channels per wire.
7. The pipeline is now running for your vertical — same engine, different config.

## Useful Endpoints (Quick Reference)

- `GET /api/scheduler-status`
- `GET /api/scan/prompts`
- `POST /api/scan/prompts`
- `POST /api/scan/run`
- `POST /api/forum/run`
- `GET /api/scan/queue`
- `POST /api/scan/entries/:id/action`
- `GET /api/scan/prompt-stats`
- `GET /api/scan/status-counts`
- `POST /api/summary-sync`
- `GET /api/distribution/config`
- `POST /api/distribution/run/:wire`
- `GET /api/distribution/newsletter/:wire`

## Session Persistence

Sessions are stored in Postgres with a 7-day expiry and survive deploys. Magic links, download tokens, pending intake selections, rate-limit state, and job progress are in-memory and reset on restart.
