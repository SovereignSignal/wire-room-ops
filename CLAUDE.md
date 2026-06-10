# CLAUDE.md - AI Context for Wire Room Ops

This file provides context for AI assistants working with this codebase.

## Project Overview

**Wire Room Ops** is a Node.js/TypeScript application that powers the backend pipeline and admin dashboard for an intelligence-to-distribution system. It discovers entries from multiple sources (X, web, forums, Telegram intake), runs them through an intake pipeline (parse, dedup, quality score), queues them for operator review, and distributes approved entries across configured channels.

The system is deployment-agnostic: brand, audience, content type, and scoring keywords are all env-var driven via `src/config/brand.ts`. The default deployment is The Wire Room (grants across crypto, AI, OSS beats), but the same engine can run any vertical by swapping config.

Wire lists are DB-driven (from the `feeds` table), not hardcoded.

## Multi-Repo Architecture

This backend is one half of a two-repo system:

| Repo | Role | Location |
|------|------|----------|
| `wire-room-ops` (this repo) | Backend pipeline + admin dashboard | `~/GitHub/wire-room-ops` |
| `the-wire-room` | Next.js website (DEPRECATED) | `~/GitHub/the-wire-room` |

> **Note:** The `the-wire-room` frontend (thewireroom.xyz) is deprecated. The system now operates under the **Sovereign Signal** brand and distributes approved entries to Telegram channels, X/Twitter, newsletter, and email. The Wire Room website is no longer the primary output.

Both repos share the **same PostgreSQL database**. This repo is the primary writer.

### Approve = Publish Flow

When an operator clicks "Approve" on a queued scan entry (via the dashboard), the entry's status changes to `approved`, the entry is written through to `summaries` when available, and per-entry distribution is triggered unless the approval is quiet. Internal API-key agent approvals are forced quiet. Operators can also run manual batch distribution.

A partial index `idx_scan_entries_approved` on `(wire, created_at DESC) WHERE status = 'approved'` optimizes queries against approved entries.

## Key Architecture Decisions

### Deployment-Agnostic Brand Config
- `src/config/brand.ts` exports `getBrand()` with audience, contentType, contentVerb, and UI settings
- All AI prompts (Grok, Claude, Perplexity), quality scorer keywords, and email templates use `getBrand()` instead of hardcoded values
- Override per deployment via `BRAND_AUDIENCE`, `BRAND_CONTENT_TYPE`, `BRAND_CONTENT_VERB`, etc.

### Multi-Provider AI Processing
- **Grok API** handles X.com/Twitter URLs (native access to tweet content) and all scan execution (x_search, web_search tools)
- **Claude API** handles all other URL summarization, using Firecrawl for web scraping. Also powers prompt review and distribution post generation
- **Perplexity API** handles deep web research scans (sonar-pro model, natively searches web with citations)
- URL routing for summarization happens in `src/services/processor.ts` which imports `isXcomUrl()` from `src/services/grok.ts`

### API Provider System
- All API keys can be stored in the `api_providers` DB table with env var fallback (`src/services/api-provider.ts`)
- Resolution order: explicit param > DB provider default_model > hardcoded default
- Providers are cached in-memory and refreshed on upsert
- Dashboard Settings > API Providers tab manages keys, base URLs, default models, and connection testing
- Known providers: grok, anthropic, firecrawl, perplexity, resend, telegram, telegram-intake

### Storage Strategy
- **Generated files** and **schedule configs** are persisted to Postgres (survive restarts)
- **Sessions** are DB-backed (`sessions` table, 7-day expiry, survive deploys; in-memory read-through cache)
- **Magic link tokens, download tokens, and job queues** are in-memory (reset on restart)
- Single-instance deployment only

### Privy Authentication
Dashboard login is handled via Privy (social/email auth). On successful Privy login, the server verifies the JWT, fetches the user's email from Privy, and checks it against an allowlist: `NOTIFICATION_EMAIL` (always allowed) plus an optional `ALLOWED_EMAILS` env var (comma-separated). Sessions last 7 days via HttpOnly cookies (DB-backed, survive deploys).

## File Structure Quick Reference

```
client/                       # React/Vite/Tailwind frontend (Lovable wireops-dashboard design)
├── src/                      # Served at dist/client/ for all authenticated routes
├── vite.config.ts
└── ...
src/
├── index.ts              # Entry point - validates config, starts server
├── server.ts             # Express setup, route mounting, startup sequence
├── config/
│   ├── index.ts          # Environment variables and validation
│   ├── brand.ts          # Deployment-agnostic brand config (audience, contentType, contentVerb)
│   └── db-config.ts      # Persistent DB config file storage
├── db/index.ts           # Postgres queries, schedules, feeds, scan tables, scan prompts, distribution tables
├── middleware/
│   ├── auth.ts           # Privy session auth (requireAuth middleware)
│   ├── internal-auth.ts  # Internal API key auth for agent access (requireAuthOrInternalKey)
│   └── rate-limit.ts     # Shared rate limit helpers
├── routes/               # Express route modules (mounted in server.ts)
│   ├── admin.ts          # Admin operations (migrations, backfills, purges)
│   ├── auth.ts           # Login, logout, session, file download
│   ├── dashboard.ts      # Overview stats
│   ├── database.ts       # DB introspection, paginated queries, schema info
│   ├── distribution.ts   # Distribution config, channels CRUD, run, newsletter
│   ├── experiments.ts    # Scoring experiments API
│   ├── export.ts         # CSV export
│   ├── feeds.ts          # Feed CRUD
│   ├── integrations.ts   # Notion CRM sync
│   ├── jobs.ts           # Background job triggers, SSE progress, Telegram webhook
│   ├── models.ts         # Model & wire lookup
│   ├── orgs.ts           # Org profiles
│   ├── providers.ts      # API providers, usage tracking, pricing
│   ├── scan-entries.ts   # Scan entry queries, submit, queue, actions, distribution per-entry
│   ├── scan-execution.ts # Scan execution + forum scan triggers
│   ├── scan-prompts.ts   # Scan prompts CRUD, test, review, run
│   └── schedules.ts      # Schedule CRUD, scheduler status
├── scripts/
│   ├── collect-engagement.ts  # Fetch X/Twitter public_metrics for distributed posts
│   └── run-experiment-loop.ts # Evaluate and create scoring parameter experiments
├── jobs/
│   ├── daily-digest.ts     # Daily digest email aggregation (all scan activity across wires)
│   ├── csv-export.ts       # Approved entries CSV export (cross-wire, for newsletter composition)
│   ├── daily-intake.ts     # Scan intake pipeline orchestrator (parse -> dedup -> classify -> queue)
│   ├── drip-distribution.ts # Drip-feed one approved entry per wire per run
│   ├── enrichment.ts       # Enriches thin entries by scraping source URLs and regenerating summaries
│   ├── forum-scan.ts       # Forum scan orchestrator (discuss.watch -> intake, DB-driven wire list)
│   ├── process-raw.ts      # Background job to process raw entries through Gate 1 -> dedup -> classify
│   ├── scan-execution.ts   # Automated scan execution (prompt fetch -> Grok/Perplexity -> intake)
│   └── summary-sync.ts     # Sync tele-sum summaries into scan_entries as approved (7-day lookback)
├── migrations/
│   ├── cleanup-approved-data.ts  # One-time data cleanup for existing bad entries
│   ├── cleanup-org-profiles.ts   # Org profile data cleanup
│   ├── dedup-org-profiles.ts     # Org profile deduplication
│   └── scoring-experiments.ts    # Scoring experiments tables migration
├── services/
│   ├── anthropic.ts      # Claude API calls with scraping integration (uses getBrand())
│   ├── api-provider.ts     # DB-backed API key management with env var fallback (api_providers table)
│   ├── api-usage.ts        # Fire-and-forget API usage logging + cost estimation (api_usage_log table)
│   ├── approval-guard.ts   # Pre-approval validation (blocks bad data from reaching website)
│   ├── auto-summarize.ts   # Auto-generate newsletter summary on approve (fire-and-forget)
│   ├── classifier.ts       # Gate 2 LLM classifier (GRANT/NEWS/EXPIRED/NOISE + quality score + tags)
│   ├── dedup.ts            # URL exact-match and fuzzy name deduplication
│   ├── discord-channel.ts  # Discord channel posting via REST API (distribution)
│   ├── distribution.ts     # Distribution orchestrator: send entries to channels, retry, newsletter
│   ├── email.ts            # Resend email templates (5 types)
│   ├── entry-actions.ts    # Approve/decline/restore business logic with audit trail (actor/reason/dryRun)
│   ├── experiment-engine.ts # Scoring parameter experiment lifecycle (create, evaluate, keep/rollback)
│   ├── forum.ts            # discuss.watch API client (search terms overrideable via FORUM_SEARCH_TERMS)
│   ├── grok.ts             # Grok Chat + Responses API for X.com content and scans (uses getBrand())
│   ├── intake.ts           # Scan result parser, URL/name normalization
│   ├── intake-core.ts      # Channel-agnostic intake logic (URL extraction, wire detection, DB insert)
│   ├── job-queue.ts        # SSE-based job progress tracking
│   ├── models.ts           # Dynamic model fetching from Grok, Anthropic, Perplexity APIs
│   ├── notion-sync.ts      # Notion CRM sync (org_profiles -> Notion database, DB-backed config)
│   ├── operator-signals.ts # Feedback loop: mines approve/decline decisions to calibrate classifier
│   ├── org-enricher.ts     # LLM-based org profile enrichment (type, source_type, website, tier)
│   ├── org-extractor.ts    # Extract canonical org names from entries (pattern matching + LLM)
│   ├── org-merge.ts        # Org profile dedup: merge source into target, relink entries
│   ├── perplexity.ts       # Perplexity API for deep web research scans (sonar-pro model)
│   ├── post-generator.ts   # Claude Sonnet 4.6 generates tweet + Telegram HTML per entry
│   ├── processor.ts        # Entry processing with retry logic
│   ├── quality-scorer.ts   # Legacy rule-based scorer (replaced by LLM classifier in pipeline)
│   ├── scan-stats.ts       # Prompt effectiveness and overlap metrics
│   ├── scheduler.ts        # node-cron scheduling with health tracking (DB-driven wire list)
│   ├── scraper.ts          # Firecrawl integration, URL resolution
│   ├── storage.ts          # Postgres-backed file storage with in-memory cache (keeps last 10)
│   ├── telegram-adapter.ts # Telegram intake bot adapter (webhook handler, inline keyboard)
│   ├── telegram-channel.ts # Telegram Bot API posting to channels (distribution)
│   └── x-client.ts         # Twitter/X posting via twitter-api-v2
├── views/                    # Server-rendered pages (login + error only; dashboard is React SPA)
│   ├── shared.ts         # Page shell, deep space palette, Orbitron headings, signal cyan accent
│   ├── login.ts          # Privy login page with starfield canvas animation
│   └── error.ts          # Error/download/expired link pages
├── utils/
│   ├── async.ts          # Shared sleep() utility
│   ├── html.ts           # Shared escapeHtml() utility
│   ├── masking.ts        # Credential masking helpers
│   ├── url.ts            # Shared normalizeUrl() for URL deduplication
│   └── validation.ts     # Shared validation helpers (isValidUuid, isValidFeedKey, slugifyFeedKey)
└── types/
    ├── index.ts          # Core TypeScript interfaces
    └── intake.ts         # Scan pipeline + distribution types (ScanEntry, DistributionConfig, etc.)
```

## Common Tasks

### Adding a New API Endpoint
1. Add route handler in the appropriate `src/routes/*.ts` module (or create a new module and mount it in `src/server.ts`)
2. For authenticated routes, use `requireAuth` (session) or `requireAuthOrInternalKey` (session + agent API key)
3. Return JSON for `/api/*` routes

### Modifying the Dashboard UI
The dashboard uses a **dual architecture**:
- **Login and error pages** are server-rendered via view functions in `src/views/` (deep space theme, Orbitron font, starfield animation)
- **All authenticated routes** serve the React SPA from `client/` (Lovable wireops-dashboard design, Vite/Tailwind)
- Server serves `dist/client/index.html` for authenticated routes; React handles client-side routing

Server-rendered views (login/error only):
- `renderLoginPage()` - Login form (Privy-based, starfield canvas animation, signal cyan #00eaff accent)
- `renderErrorPage()` - Error display
- All server-rendered views use `renderPageShell()` from `shared.ts` for consistent layout

### Changing AI Prompts
- Grok newsletter prompt: `src/services/grok.ts` - `buildGrokPrompt()` function
- Claude prompts: `src/services/anthropic.ts` - `buildScrapedContentPrompt()` and `buildFallbackPrompt()` functions
- Classifier prompt: `src/services/classifier.ts` - `buildClassificationPrompt()` function
- Scan prompts: Stored in `scan_prompts` table, managed via `/api/scan/prompts` CRUD API. Each prompt has `prompt_text` and optional `response_format`.

### Adding Environment Variables
1. Add to `src/config/index.ts` in the `config` object
2. Add validation in `validateConfig()` if required
3. Update `.env.example`
4. Update README.md environment variables table

## Database Architecture

### Shared PostgreSQL Database

All services (`wire-room-ops`, `the-wire-room`, `tele-sum`) share one PostgreSQL database hosted on Railway (`wire-room-db`). This repo is the primary writer; `the-wire-room` is deprecated (see Multi-Repo Architecture).

### Table Groups

| Group | Tables | Purpose |
|-------|--------|---------|
| **Scan pipeline** | `scan_entries`, `seen_urls`, `seen_names`, `intake_runs`, `scan_prompts` | Core intake/dedup/queue pipeline |
| **tele-sum legacy** | `messages`, `summaries`, `categories`, `users`, `telegram_bots`, `channel_configs` | Telegram ingestion (bridged via `summary-sync.ts`) |
| **Distribution** | `distribution_channels`, `distribution_logs`, `distribution_config` (legacy) | Channel output tracking |
| **Config** | `feeds`, `schedules`, `integration_config` | Wire/schedule/integration config |
| **API management** | `api_providers`, `api_usage_log`, `model_pricing` | DB-backed API keys, usage tracking, cost estimation |
| **Identity** | `org_profiles`, `sessions` | Organization tracking + auth sessions |
| **Legacy** | `grant_entries`, `grok_usage`, `review_queue`, `alembic_version`, `sync_status` | Historical/dormant tables |

### scan_entries — The Central Table

All pipeline data flows through `scan_entries`. Key columns:

| Column | Type | Purpose |
|--------|------|---------|
| `status` | text | Pipeline stage: `raw` → `deduped` → `queued` → `approved`/`declined`/`archived`/`duplicate`/`skipped` |
| `classification` | varchar | Gate 2 label: `GRANT`, `NEWS`, `EXPIRED`, `NOISE`, `UNCHECKED` |
| `quality_score` | integer | 0-100 score from LLM classifier |
| `wire` | text | Feed vertical (crypto/ai/oss) |
| `scan_source` | text | Ingestion channel: `x-scan`, `web-search`, `forum`, `telegram` |
| `source_url` | text | Original source link |
| `metadata` | jsonb | LLM-extracted structured data (amount, deadline, eligibility, summary) |
| `org_id` | integer | FK to `org_profiles` (auto-linked on approve) |

Status distribution (typical): ~46% duplicate, ~22% archived, ~17% queued, ~12% approved, ~3% declined.

### Data Flow: Ingestion → Refinery → Publishing

```
INGESTION (raw data)                    THE REFINERY (processing)               PUBLISHING
┌─────────────────┐                     ┌───────────────────┐                   ┌──────────────┐
│ X/Grok Scans    │──┐                  │ Gate 1: Complete  │──incomplete──→ archived
│ Web Search      │  ├──→ scan_entries ──│ Gate 2: Classify  │──NOISE/park*→ archived
│ Forum Scan      │  │    (status=raw)   │ Deduplication     │──duplicate──→ duplicate
│ Telegram Bridge │──┘                  │ Quality Score     │──path rules→ queued/archived
│ Manual Paste    │                     └───────┬───────────┘
└─────────────────┘                             │ source-specific routing
                                                ▼
                                         queued (editorial queue)
                                                │ operator review
                                                ▼
                                         approved ──→ distribution channels (TG, X, newsletter, email)
```

`*` Queue/archive rules are not identical for every intake path. Scan execution archives `NOISE`; raw background processing queues complete non-duplicates even when classification is weak; Telegram/manual intake uses `operator_route`, keeping Telegram `park` and `relationship_signal` items visible for review. `quality_score` ranks and explains items but is no longer a universal queue threshold.

### Dedup Tables

- **`seen_urls`**: Exact URL match. Composite unique on `(normalized_url, wire)`. Handles aggregate URLs (same URL, different entries) via name similarity check.
- **`seen_names`**: Stores normalized names and tokens for review intelligence and alternate-source detection. Hard duplicate blocking currently relies on URL exact match; fuzzy name blocking is intentionally disabled after false positives.

### Approval Validation Guard

Pre-approval validation (`src/services/approval-guard.ts`) prevents bad data from reaching the public website:
- **Blocks**: empty description, empty source_url
- **Warns**: EXPIRED classification, oversized names (>120 chars), junk deadline data, UNCHECKED classification, missing quality score
- Applied to both single and bulk approve endpoints. Operator can override with `?force=true`.

### The Telegram Bridge

`summary-sync.ts` bridges `tele-sum`'s `summaries` table → `scan_entries` (as `status=approved`):
- Runs every 15 minutes, 7-day lookback window
- Idempotent: skips entries where `source_url` already exists in `scan_entries`
- Infers wire from content keywords (AI/OSS detection, defaults to crypto)
- Historical backfill available via `POST /api/admin/summary-sync-backfill`

### Admin Endpoints
All `POST /api/admin/*` — rate-limited maintenance operations: `run-migration`, `classify-backfill`, `tag-backfill`, `summary-sync-backfill`, `recover-self-dupes`, `clean-stale-seen`, `clean-orgs`, `dedup-orgs`, `enrich-orgs`, `purge-source`. See `src/routes/admin.ts` for details.

### Other Tables

Schedule configuration uses a `schedules` table with UUID primary keys, supporting multiple named schedules with a `schedule_type` field (`scan-execution`, `forum-scan`, or `daily-digest`). Cron expressions are computed dynamically from `hour`/`minute`/`frequencyHours` columns via `buildCronExpression()`.

The `feeds` table manages dynamic wire/feed types, seeded from `SEED_FEEDS` and auto-discovered from `channel_configs`. Scan prompts are stored in `scan_prompts` with CRUD support.

Distribution uses `distribution_channels` (managed channels with UUID PK, per-channel credentials in JSONB) and `distribution_logs` (tracks per-entry, per-channel send status with a unique partial index to prevent double-posts). Legacy `distribution_config` remains a compatibility path and is still read by the distribution service.

## API Integration Details

All providers support DB-backed credentials (`api_providers` table) with env var fallback. Model resolution: explicit param > provider.default_model > hardcoded default.

- **Grok** (`src/services/grok.ts`): Chat Completions for classification/summaries + Responses API for scan execution (`x_search`/`web_search` tools). Has native X.com access.
- **Claude** (`src/services/anthropic.ts`): Summarization (Opus) + post generation (Sonnet for cost efficiency). Uses `@anthropic-ai/sdk`.
- **Perplexity** (`src/services/perplexity.ts`): `sonar-pro` model, natively searches web with citations. For `tool_type: 'perplexity'` prompts.
- **Firecrawl** (`src/services/scraper.ts`): Web scraping for non-X.com URLs.
- **Resend** (`src/services/email.ts`): 5 email types (login, notification, test alert, failure alert, resend download link).

## Error Handling & Security

- **Retry**: `withRetry()` in `processor.ts` (3 attempts newsletter, 2 for scans). Batch concurrency: 3 at a time.
- **Concurrent job guard**: Duplicate manual jobs return 409. Scheduler skips overlapping cron runs.
- **Scrape fallback**: If Firecrawl fails, Claude uses cached summary.
- **Security**: CSRF origin checking, HttpOnly session cookies, `escapeHtml()` XSS prevention, open redirect protection, SSE keepalive (30s).
- **Memory**: Cleanup timers (15-min) for job queue, one-time tokens, and pending intake selections. Sessions are DB-backed with an in-memory read-through cache. Timers use `.unref()` and graceful shutdown hooks.

## Testing Locally

1. Copy `.env.example` to `.env` and fill in all API keys
2. `npm install`
3. `npm run dev` (uses ts-node)
4. Access http://localhost:3000
5. Login with the email matching `NOTIFICATION_EMAIL`

## Common Issues

### "Missing required environment variables"
Check that all 4 required env vars are set: DATABASE_URL, NOTIFICATION_EMAIL, PRIVY_APP_ID, PRIVY_APP_SECRET. API keys (ANTHROPIC_API_KEY, GROK_API_KEY, FIRECRAWL_API_KEY, RESEND_API_KEY) are optional at startup and produce warnings -- they can also be configured via Settings > API Providers in the dashboard.

### "No entries found for this date range"
The database query found no `summaries` with `processing_status = 'SUCCESS'` in the date range.

### Scheduler not running after config change
Scheduler restarts automatically when you save schedule config via the dashboard API.

### Files disappear after restart
Generated files are persisted to Postgres. Sessions are DB-backed and survive restarts. Job queues and magic link tokens are in-memory and reset on restart.

## Environment Variables

### Required (server will not start without these)
- `DATABASE_URL` - PostgreSQL connection string
- `NOTIFICATION_EMAIL` - Primary operator email (always allowed dashboard access)
- `PRIVY_APP_ID` - Privy authentication app ID
- `PRIVY_APP_SECRET` - Privy authentication app secret

### Optional API Keys (warn on startup if missing; can also be set via Settings > API Providers in dashboard)
- `ANTHROPIC_API_KEY` - Claude API key
- `GROK_API_KEY` - X.ai Grok API key
- `FIRECRAWL_API_KEY` - Firecrawl scraping API key
- `RESEND_API_KEY` - Resend email API key

### Optional
See `.env.example` for full list. Key optional vars: `PORT`, `APP_URL`, `ALLOWED_EMAILS`, `TELEGRAM_BOT_TOKEN`, `PERPLEXITY_API_KEY`, `FORUM_SCAN_ENABLED`, `BRAND_*` (deployment-agnostic config overrides), `INTERNAL_API_KEY` (agent API access), `X_BEARER_TOKEN` (engagement metrics), `DEV_MODE` (skip auth in dev), `DATA_DIR` (local data storage).

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
- **Perplexity scan** (`web-search` or `perplexity`): Perplexity sonar-pro with native web search and citations (prompts with `tool_type: 'perplexity'`)
- **Forum scan** (`forum`): discuss.watch API searches across 160+ Discourse forums (search terms overrideable via `FORUM_SEARCH_TERMS`). Pre-filters results with keyword relevance matching on discussion titles and a 30-day createdAt age filter (rejects old posts that were merely bumped)
- **Telegram intake** (`telegram`): Bot-based URL/article submission via webhook. Supports single URLs and batch messages (numbered lists, bold-name format, or structured `Link:` format). Uses adapter pattern (`telegram-adapter.ts` -> `intake-core.ts`)
- **Manual paste** (`x-scan`/`web-search`): Dashboard paste-in flow

### Data Flow
1. **Execute**: `scan-execution.ts` fetches active prompts from `scan_prompts`, routes to the correct provider per `tool_type`: Grok Responses API (`x_search`/`web_search`) or Perplexity (`perplexity`)
2. **Parse**: `intake.ts` extracts structured results via 4 parser strategies (structured text, JSON, X-post format, lenient numbered list). All strategies extract `sourcePublishedAt` when available (Published/Announced/Updated dates)
3. **Sanitize**: Post-parse `sanitizeResult()` cleans all parsed output — strips leading/trailing brackets from names, truncates names >120 chars, rejects junk deadlines (>50 chars, contains URLs/semicolons), discards suspicious small amounts (<$100 bare), moves excess name text into description
4. **Insert**: Raw results written to `scan_entries` with `status: raw`
5. **Gate 1 — Completeness**: Entries with empty/garbage `source_url` or missing critical fields are archived or marked incomplete before dedup, depending on intake path
6. **Dedup**: `dedup.ts` blocks exact URL repeats via `seen_urls`. `seen_names` remains useful for related-opportunity/alternate-source signals, but fuzzy name blocking is disabled.
7. **Gate 2 — LLM Classify + Score**: `classifier.ts` calls Grok to classify (GRANT/NEWS/EXPIRED/NOISE) and score (0-100) in one call. Failed classifications retry once with 2-second delay.
8. **Queue/archive**: Source-specific behavior: scan execution archives `NOISE`; raw background processing queues complete non-duplicates; Telegram/manual intake uses `operator_route`.
9. **Approve Guard**: Pre-approval validation blocks entries with empty descriptions or empty URLs from being published; warns on EXPIRED classification

### Schedule Types
- **`scan-execution`**: Runs `runScanExecution()` — executes all active prompts for a wire
- **`forum-scan`**: Runs `runForumScan()` — searches discuss.watch forums
- **`daily-digest`**: Runs `runDailyDigest()` — aggregates 24h scan activity, sends summary email. Auto-derives scan schedules to run before it
- **`collect-engagement`**: Runs `collectXEngagement()` — fetches X/Twitter public_metrics for recent distributed posts
- **`experiment-loop`**: Runs `runExperimentLoop()` — evaluates and creates scoring parameter experiments
- **`drip-distribution`**: Runs `runDripDistribution()` — distributes one approved entry per wire per run
- **`deadline-digest`**: Runs `runDeadlineDigest()` — finds entries closing soon
- **`account-monitor`**: Runs `runAccountMonitor()` — polls monitored X accounts for new URLs

### Prompt Management
- Prompts stored in `scan_prompts` table with `wire`, `label`, `prompt_text`, `response_format`, `variant`, `tool_type`, `intent`
- `tool_type` values: `x_search` (Grok X.com), `web_search` (Grok web), `perplexity` (Perplexity sonar-pro)
- `intent` values: `discovery` (find newly announced opportunities), `canonical` (find currently-open known programs), `signal` (catch news, funding rounds, signals) — influences classifier behavior via prompt guidance
- `variant` values: `A`/`B`/`C` (legacy X-scan), `W` (web search), `P` (Perplexity), `N` (neutral/Telegram sync), `S` (signal)
- `response_format` is the single source of truth for output format instructions -- inline format instructions were removed from prompt texts
- CRUD API: `/api/scan/prompts` (GET/POST), `/api/scan/prompts/:id` (PUT/DELETE)
- Test endpoint: `/api/scan/prompts/:id/test` -- executes a prompt and returns parsed results without intake processing
- Run endpoint: `/api/scan/prompts/:id/run` -- executes a prompt and runs results through the full intake pipeline
- Draft test: `/api/scan/prompts/test` -- tests unsaved prompt text without DB lookup
- Prompt review: `/api/scan/prompts/review` -- Claude-based prompt review with suggestions and revised text
- Effectiveness stats: `/api/scan/prompt-stats` -- per-prompt metrics and cross-prompt overlap rate

### Gate 2: LLM Classification + Scoring

Quality scoring is done by the Grok LLM classifier (`src/services/classifier.ts`) in a single API call that:
1. Classifies entries as GRANT/NEWS/EXPIRED/NOISE
2. Assigns a 0-100 quality score based on information value
3. Extracts structured data (amount, deadline, eligibility, summary) into `metadata` JSONB

Failed classifications retry once with a 2-second delay in scan execution. If classification still fails, entries generally remain visible with score 0 and classification UNCHECKED. A backfill endpoint (`POST /api/admin/classify-backfill`) can batch-classify UNCHECKED entries later.

The legacy rule-based scorer (`src/services/quality-scorer.ts`) is still in the codebase but is no longer used in the main pipeline.

## Distribution System

### Overview
Per-feed multi-channel distribution of approved scan entries. Distribution is a **manual action** triggered from the feed dashboard -- it is NOT auto-triggered on approval. Five channel types are supported: Telegram, Discord, Slack, X/Twitter, and newsletter (copyable markdown).

### Architecture
- **Orchestrator**: `src/services/distribution.ts` -- coordinates sending approved-but-undistributed entries to all enabled channels for a wire, with retry support and newsletter markdown generation
- **Post generator**: `src/services/post-generator.ts` -- uses Claude Sonnet 4.6 (`claude-sonnet-4-6`) to generate a tweet (280 chars) and Telegram HTML post per entry. Falls back to a template if AI generation fails
- **Telegram client**: `src/services/telegram-channel.ts` -- sends HTML-formatted posts to Telegram channels via Bot API. Bot token from `TELEGRAM_BOT_TOKEN` env var or `api_providers` DB table
- **Discord client**: `src/services/discord-channel.ts` -- sends messages to Discord channels via REST API (webhook URL or bot token in `distribution_channels` credentials)
- **X/Twitter client**: `src/services/x-client.ts` -- posts tweets via `twitter-api-v2`. OAuth credentials stored in `distribution_channels` JSONB per wire
- **Slack**: Supported as a channel type in the distribution orchestrator (credentials in `distribution_channels`)
- **Types**: `src/types/intake.ts` -- `DistributionChannel` (telegram/discord/slack/x/newsletter), `DistributionStatus`, `DistributionConfig`, `DistributionLog`, `GeneratedPosts`

### Database Tables
- **`distribution_channels`**: Managed channels (UUID PK, per-channel credentials in JSONB). CRUD via Settings > Distribution tab.
- **`distribution_logs`**: Per-entry, per-channel send status. Unique partial index on `(entry_id, channel) WHERE status IN ('pending','success')` prevents double-posts.

### User Flow
Approve entries → configure channels in Settings > Distribution → click "Distribute to Channels" for a wire → distribution status shown as colored pills (TG/X/NL) on the approved tab. Failed pills are clickable for retry.

### Key Design Decisions
- **Approve distribution**: Normal dashboard approvals trigger per-entry distribution. Quiet approvals and internal agent approvals skip distribution. Manual batch distribution remains available for approved-but-undistributed entries.
- **Claude Sonnet for post generation**: Uses a smaller model (not Opus) for cost efficiency when generating tweets and Telegram posts
- **Template fallback**: If AI post generation fails, a structured template is used instead
- **3-second inter-entry delay**: Respects X/Twitter rate limits during batch distribution
- **Concurrent execution guard**: Prevents double-posting if distribution is triggered while already running (returns 409 with existing job ID)
- **Config merge on partial update**: PUT to config endpoint merges new fields into existing JSONB, preventing accidental credential loss
- **Retry sends only to failed channels**: Redistribution skips channels that already have a `success` or `pending` log entry
- **Drip mode**: `src/jobs/drip-distribution.ts` distributes one entry per wire per run on a schedule, creating a natural stream instead of batch distribution

### Key Endpoints
- `POST /api/distribution/run/:wire` — trigger distribution for a wire
- `GET /api/distribution/newsletter/:wire` — generate newsletter markdown
- `POST /api/scan/entries/:id/redistribute` — retry failed sends
- Channel CRUD + config via `/api/distribution/config` routes (see `src/routes/distribution.ts`)

## Operator Signals (Feedback Loop)

The classifier is calibrated by operator approve/decline decisions (`src/services/operator-signals.ts`):
- Queries 30-day history of approve/decline actions per wire
- Computes per-entity approval rates, score thresholds for approved vs declined entries, and common decline reasons
- Formats guidance as a prompt addendum injected into the classifier prompt
- Results cached for 6 hours to avoid repeated DB queries
- The classifier (`src/services/classifier.ts`) calls `computeOperatorSignals()` and `formatSignalsForPrompt()` before each classification

## Scoring Experiments

Automated parameter tuning for the quality scorer (`src/services/experiment-engine.ts`):
- Creates experiments with mutated scoring parameters (random walk, gradient estimate, explore strategies)
- Evaluates running experiments against baselines (approval rate, engagement, editorial efficiency)
- Safety triggers auto-rollback experiments that degrade quality
- Database tables: `scoring_experiments`, `scoring_param_log`, `engagement_metrics`
- Run via `experiment-loop` schedule type or `npx ts-node src/scripts/run-experiment-loop.ts`
- Engagement data collected via `collect-engagement` schedule type or `npx ts-node src/scripts/collect-engagement.ts`
- Dashboard API at `/api/experiments` for viewing history and results

## Entry Actions Service

`src/services/entry-actions.ts` extracts approve/decline/restore logic from HTTP handlers into a reusable service layer. Supports `ActionOptions`: `quiet` (skip distribution), `force` (override validation), `actor` (audit trail — who), `reason` (audit trail — why), `dryRun` (validate without committing). Both `singleEntryAction()` and `bulkEntryAction()` are used by REST API routes and agent integrations. Audit columns: `actioned_by`, `action_reason` on `scan_entries`.

## Internal API Key Auth

`src/middleware/internal-auth.ts` provides `requireAuthOrInternalKey` middleware. Accepts either a valid `INTERNAL_API_KEY` bearer token (for agent/programmatic access) or falls through to standard Privy session auth. Agent requests get a synthetic `agentSession` identity attached to the request. Mounted on `/api/scan` routes to enable The Stringer agent to take entry actions.

## API Usage Tracking

All LLM API calls are logged for cost monitoring (`src/services/api-usage.ts`):
- **`api_usage_log`** table: provider, model, purpose, wire, duration_ms, tokens_in/out, success, error_message
- **`model_pricing`** table: per-model cost rates (input/output per million tokens)
- `logApiUsage()` is fire-and-forget (never blocks the caller)
- Dashboard API exposes usage aggregation and pricing CRUD
- Cost estimation computed from usage logs joined with model pricing

## Organization Management

Org profiles track organizations mentioned in entries (`org_profiles` table):
- **Extractor** (`src/services/org-extractor.ts`): Pattern matching + LLM-based extraction of canonical org names from entry text. Auto-links entries to `org_profiles` on approve.
- **Enricher** (`src/services/org-enricher.ts`): LLM-based enrichment of org profiles (type, source_type, website, tier). Admin endpoint for batch enrichment.
- **Merge** (`src/services/org-merge.ts`): Merge duplicate org profiles (source -> target), relink all entries. Admin endpoint for manual dedup.
- **Notion sync** (`src/services/notion-sync.ts`): Sync org profiles to a Notion database. Config stored in `integration_config` table (DB-backed, not env vars).
- Admin endpoints: `/api/admin/clean-orgs`, `/api/admin/dedup-orgs`, `/api/admin/enrich-orgs`

## Approved Entries Export

Cross-wire CSV export via `src/jobs/csv-export.ts`. `GET /api/export/csv?hoursBack=24` for direct download, `POST /api/export/csv` to generate + email. Runs automatically after daily-digest (skipped if 0 entries).

## Rate Limiting

In-memory rate limiter in `src/server.ts`. All expensive/admin endpoints are rate-limited (search code for `checkRateLimit` to see specific limits).

## Code Style Notes

- TypeScript strict mode
- Express for HTTP server
- Login page uses React (via ESM) with Privy + starfield canvas animation; dashboard is a React/Vite/Tailwind SPA (`client/`)
- Server-rendered views (login/error only) are in `src/views/` with a shared page shell pattern (deep space palette, Orbitron headings)
- Client-side `escapeHtml()` is defined once in `shared.ts` via `CLIENT_ESCAPE_HTML` constant
- Validation helpers (`isValidUuid()`, `isValidFeedKey()`, `slugifyFeedKey()`) are defined in `src/utils/validation.ts`
- Minimal dependencies
- Error messages include context for debugging

## Planned / Not Yet Implemented

- **Slack/Discord intake adapters** (same `intake-core.ts` interface, new inbound channel adapters -- distribution already works)
- **Email inbound ingestion** (URL extraction from forwarded emails)
