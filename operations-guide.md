# Wire Room Ops - Operations Guide

This guide is for running the **current** `wire-room-ops` service in production.

## What This Service Is For

- Discover grant/opportunity leads from X, web search, and forums.
- Normalize, deduplicate, and quality-score leads.
- Give operators a review queue.
- Publish to the website by setting `scan_entries.status = 'approved'`.

## What It Is Not (in this repo)

- No built-in Telegram/X distribution posting flow.
- Historical docs may reference distribution and CRM modules that are not in the current codebase.

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

- `DATABASE_URL`
- `ANTHROPIC_API_KEY`
- `GROK_API_KEY`
- `FIRECRAWL_API_KEY`
- `RESEND_API_KEY`
- `NOTIFICATION_EMAIL`
- `PRIVY_APP_ID`
- `PRIVY_APP_SECRET`

Common optional settings:

- `APP_URL`
- `ALLOWED_EMAILS`
- `FORUM_SCAN_ENABLED=true`
- `DISCUSS_WATCH_API_URL`

## 2) First Validation

- `GET /health` returns `{ status: "ok" }`.
- You can log in at `/` and load `/queue` + `/settings`.
- `POST /api/test-alert` sends a test email.

If any of those fail, do not proceed to scheduling.

## 3) Create Prompts

Create prompts with `wire`, `label`, `promptText`, `toolType`, `isActive`, `sortOrder`, optional `responseFormat`, optional `variant`.

Tool types:

- `x_search` for X-native discovery
- `web_search` for broader web discovery

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
