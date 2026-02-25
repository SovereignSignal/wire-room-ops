# Wire Room Ops — Operations Guide

## Where You Are Now

You manually find grant opportunities and post them to t.me/cryptograntwire. TeleSum picks those up, summarizes them, and drops them into the Railway Postgres database. The automated scan pipeline exists in the codebase but hasn't been activated yet.

This guide walks you from that manual flow to a system that discovers, scores, queues, and distributes grant opportunities on its own, with you reviewing and approving the good stuff.

## What the System Does (When Running)

The automated pipeline has three stages:

**Discovery**: Grok searches X and the open web on a schedule using prompts you define. Forum scanning hits 150+ Discourse forums for grant keywords. Results flow into the intake pipeline.

**Intake**: Raw results get deduplicated (URL exact match + fuzzy name overlap), quality scored (0 to 100), and either queued for your review (score >= 40) or auto archived (below threshold).

**Distribution**: When you approve an entry, it publishes to the Wire Room website immediately. If distribution is enabled, it also fires off AI generated posts to your Telegram channel and X account.

---

## Phase 1: Verify the Deployment

Your app is deployed on Railway with the database. Before anything else, confirm the basics work.

**Check the dashboard loads:**
Open your APP_URL in a browser. You should see a login page. If you get an error about missing environment variables, you need to set them in Railway.

**Required environment variables (check Railway settings):**

```
DATABASE_URL          → your Railway Postgres connection string
ANTHROPIC_API_KEY     → sk-ant-... (for Claude, used in enrichment and distribution)
GROK_API_KEY          → xai-... (for scanning X and web)
FIRECRAWL_API_KEY     → from firecrawl.dev (for scraping non-X URLs)
RESEND_API_KEY        → from resend.com (for email notifications)
NOTIFICATION_EMAIL    → your email address
PRIVY_APP_ID          → your Privy app ID (for auth)
PRIVY_APP_SECRET      → your Privy app secret
```

**Verify you can log in:**
The system uses Privy for authentication. Log in and confirm you see the dashboard.

**Send a test alert:**
From the dashboard (or hit `POST /api/test-alert`), send a test email. This confirms Resend is configured and you'll actually get failure notifications.

---

## Phase 2: Create Your First Scan Prompts

The scan system is driven by prompts stored in the `scan_prompts` table. Each prompt tells Grok what to search for. No prompts = no automated discovery.

**Go to the Scan Prompts section of the dashboard** (or use the API).

**Create a prompt for X search:**

```
POST /api/scan/prompts
{
  "wire": "crypto",
  "label": "Crypto Grants X Search",
  "promptText": "Search for recent cryptocurrency grant programs, blockchain funding opportunities, and Web3 grants that are currently open for applications. Focus on grants with specific dollar amounts and deadlines. Include grants from foundations like Ethereum Foundation, Solana Foundation, Polygon, Arbitrum, Optimism, and similar. Return results as structured data with: name, description, link, amount, deadline.",
  "responseFormat": "",
  "toolType": "x_search",
  "isActive": true,
  "sortOrder": 0
}
```

**Create a prompt for web search:**

```
POST /api/scan/prompts
{
  "wire": "crypto",
  "label": "Crypto Grants Web Search",
  "promptText": "Search the web for currently open cryptocurrency and blockchain grant programs. Look for grant opportunities from major protocols, foundations, and DAOs. Focus on programs where individuals or teams can apply for funding. Return structured results with: name, description, link, amount, deadline.",
  "responseFormat": "",
  "toolType": "web_search",
  "isActive": true,
  "sortOrder": 1
}
```

These are starting points. You'll tune them based on what comes back.

**Test before committing:**

```
POST /api/scan/prompts/:id/test
```

This executes the prompt against Grok and returns parsed results without writing anything to the database. Look at what comes back. If it's garbage, adjust the prompt text. If it's decent, move on.

Rate limit: 5 test calls per 5 minutes.

---

## Phase 3: Run a Manual Scan

Before setting up schedules, run the scan pipeline manually to see the full flow.

```
POST /api/scan/run
{ "wire": "crypto" }
```

This executes all active prompts for the "crypto" wire, parses results, deduplicates, scores, and queues entries. It takes 9 to 14 minutes if you have multiple prompts (each Grok call is 60 to 90 seconds).

The endpoint returns a job ID. Track progress via SSE:

```
GET /api/job/:jobId/progress
```

After it completes, check the queue:

```
GET /api/scan/queue?wire=crypto&status=queued
```

You should see entries with quality scores. Look at what made it through and what got archived. This tells you if your prompts and scoring are calibrated right.

---

## Phase 4: Review the Queue

The dashboard shows queued entries. For each one you can:

- **Approve**: Sets status to `approved`. The entry appears on thewireroom.xyz immediately (the Wire Room queries `scan_entries WHERE status = 'approved'`). If distribution is enabled, it also posts to Telegram and X.
- **Archive**: Sets status to `archived`. Entry is hidden from the queue.
- **Edit**: You can modify name, description, amount, deadline before approving.

This is your daily touchpoint once everything is automated. Open the dashboard, scan the queue, approve the good ones, archive the noise.

---

## Phase 5: Set Up Schedules

Once you're happy with what the manual scans produce, automate them.

**Create a scan execution schedule:**

From the dashboard's Schedule section (or via API):

```
POST /api/schedules
{
  "name": "Daily Crypto Scan",
  "enabled": true,
  "scheduleType": "scan-execution",
  "hour": 8,
  "minute": 0,
  "timezone": "America/Los_Angeles",
  "wire": "crypto",
  "notifyEmails": "your@email.com"
}
```

This runs every day at 8 AM Pacific. After each run, it sends you a digest email with what was found, how many were unique, and how many hit the quality threshold.

**Optional: Forum scan schedule:**

If you want to scan Discourse forums too, set `FORUM_SCAN_ENABLED=true` in your Railway env vars, then:

```
POST /api/schedules
{
  "name": "Daily Forum Scan",
  "enabled": true,
  "scheduleType": "forum-scan",
  "hour": 10,
  "minute": 0,
  "timezone": "America/Los_Angeles",
  "wire": "crypto"
}
```

**Optional: Sub daily scanning:**

For more frequent scans, set `frequencyHours`:

```
{
  "name": "Crypto Scan Every 6h",
  "enabled": true,
  "scheduleType": "scan-execution",
  "frequencyHours": 6,
  "minute": 0,
  "timezone": "America/Los_Angeles",
  "wire": "crypto"
}
```

**Check scheduler status:**

```
GET /api/scheduler-status
```

Returns which schedules are active, when they last ran, success/failure status, and next run time.

---

## Phase 6: Enable Distribution

Once you trust the pipeline and want approved entries to auto post to your channels:

**Set up distribution config via the dashboard** (or API):

```
PUT /api/distribution-config/crypto
{
  "enabled": true,
  "telegramChannelId": "@cryptograntwire",
  "xApiKey": "...",
  "xApiSecret": "...",
  "xAccessToken": "...",
  "xAccessTokenSecret": "...",
  "xHandle": "@CryptoGrantWire"
}
```

Distribution config is stored in the database (not env vars), managed per wire through the dashboard.

Now when you approve an entry, it generates an AI crafted tweet (via Claude, under 270 chars) and a Telegram HTML message, then posts both in parallel. Failures are logged but never block the approval.

**Test distribution:**

```
POST /api/distribution-config/crypto/test
```

This sends a test message to your configured channels to verify credentials work.

**Monitor distribution:**

Each approved entry in the queue shows Telegram/X status pills (success, failed, pending, skipped). Failed entries have a retry button.

```
GET /api/scan/entries/:id/distribution
POST /api/scan/entries/:id/redistribute
```

---

## Phase 7: Transition Away from Manual Posting

At this point the system is:
1. Scanning X and web automatically on schedule
2. Deduplicating and scoring results
3. Queuing entries for your review
4. Emailing you a daily digest
5. Publishing and distributing when you approve

Your Telegram channel shifts from being the input (you manually posting) to being an output (the system posting approved entries). You can keep posting manually too. The Telegram bot ingestion path (`/webhook/telegram`) means anything you send to the bot also gets run through the intake pipeline.

**Your daily routine becomes:**
1. Check the digest email (or open the dashboard)
2. Approve good entries, archive noise
3. Optionally tweak prompts if you notice gaps in coverage

---

## Ongoing Tuning

**Prompt effectiveness:**

```
GET /api/scan/prompt-stats?days=7
```

Shows per prompt metrics: how many results, duplicate rate, average quality score, overlap between prompts. Use this to identify prompts that aren't pulling their weight.

**Quality scoring adjustments:**

The scoring weights are in `src/services/quality-scorer.ts`. Current weights:

| Signal | Points |
|--------|--------|
| Has dollar amount | +25 |
| Amount over $5K | +15 |
| Has specific deadline | +15 |
| Deadline within 60 days | +10 |
| Is a funding opportunity | +20 |
| Is actionable (can apply) | +15 |
| Governance/DAO noise | -15 |
| Already awarded | -10 |

The queue threshold is 40 (entries below this auto archive). If too much noise is getting through, raise the threshold. If good stuff is getting filtered out, lower it or adjust the weights.

**Dedup tuning:**

URL exact match catches most duplicates. Fuzzy name overlap (token based) catches rephrased versions of the same opportunity. Stats at `GET /api/scan/seen-urls`.

---

## Key Endpoints Reference

| Endpoint | What it does |
|----------|-------------|
| `GET /api/scheduler-status` | Health check for all schedules |
| `GET /api/scan/queue?status=queued` | View entries waiting for review |
| `GET /api/scan/status-counts` | Counts by status (raw, queued, approved, archived) |
| `GET /api/scan/prompt-stats?days=7` | Prompt effectiveness metrics |
| `POST /api/scan/run` | Trigger manual scan execution |
| `POST /api/scan/prompts/:id/test` | Test a prompt without writing to DB |
| `POST /api/scan/entries/:id/action` | Approve or archive an entry |
| `GET /api/distribution-config` | View distribution settings per wire |
| `POST /api/test-alert` | Verify email notifications work |

---

## Failure Handling

The system handles failures without your intervention in most cases:

- **Scheduled job fails**: Sends you a failure email, then retries once after 5 minutes
- **Individual prompt fails during scan**: Logs the error, continues with remaining prompts
- **Distribution fails**: Logs as failed, shows retry button in dashboard. Never blocks the approval.
- **Scraping fails**: Falls back to cached summary data
- **Duplicate job triggered**: Returns 409, prevents running two scans simultaneously

Check Railway logs if something seems stuck. The scheduler status endpoint (`GET /api/scheduler-status`) is your first diagnostic tool.

---

## What TeleSum Still Does

TeleSum continues to work alongside the automated pipeline. Anything it drops into the database via the existing flow still gets processed. The two systems don't conflict because deduplication catches overlap. Over time, as the automated scans cover more ground, TeleSum becomes redundant and you can sunset it when ready.
