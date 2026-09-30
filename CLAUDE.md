# CLAUDE.md - AI Context for Wire Room Ops

This file provides context for AI assistants working with this codebase.

## Project Overview

**Wire Room Ops** is a Node.js/TypeScript application that powers the backend pipeline and admin dashboard for an intelligence-to-distribution system. It discovers entries from multiple sources (X, web, forums, Telegram intake), runs them through an intake pipeline (parse, dedup, quality score), queues them for operator review, and distributes approved entries across configured channels.

The system is deployment-agnostic: brand, audience, content type, and scoring keywords are all env-var driven via `src/config/brand.ts`. The default deployment is The Wire Room (grants across crypto, AI, OSS beats), but the same engine can run any vertical by swapping config.

Wire lists are DB-driven (from the `feeds` table), not hardcoded.

## Multi-Repo Architecture

This backend shares its PostgreSQL database with one sibling service:

| Repo | Role | Location |
|------|------|----------|
| `wire-room-ops` (this repo) | Backend pipeline + admin dashboard | working tree: `~/Documents/Sovereign Signal/repos/wire-room-ops` · GitHub: `SovereignSignal/wire-room-ops` · deploy: Railway `wire-room-ops` |
| `tele-sum` | Telegram channel ingestion — producer of the `summaries` table this repo bridges from | separate repo · Railway `tele-sum` |

> **History:** the original public front-end `the-wire-room` (thewireroom.xyz) is fully retired — its Railway service was **deleted 2026-07-02** (code remains at `github.com/SovereignSignal/the-wire-room`). The system operates under the **Sovereign Signal** brand; the live output channels are Telegram (active) and the Friday weekly Substack draft. X/newsletter/email distribution is built but unused.

Both services share the **same PostgreSQL database** (Railway project `wire-room-db`). This repo is the primary writer.

### Approve = Publish Flow

When an operator clicks "Approve" on a queued scan entry (via the dashboard), the entry's status changes to `approved`, the entry is written through to `summaries` when available, and per-entry distribution is triggered unless the approval is quiet. Internal API-key agent approvals are forced quiet. Operators can also run manual batch distribution.

A partial index `idx_scan_entries_approved` on `(wire, created_at DESC) WHERE status = 'approved'` optimizes queries against approved entries.

## Key Architecture Decisions

### Deployment-Agnostic Brand Config
- `src/config/brand.ts` exports `getBrand()` with audience, contentType, contentVerb, and UI settings
- All AI prompts (Grok, Claude, Perplexity), quality scorer keywords, and email templates use `getBrand()` instead of hardcoded values
- Override per deployment via `BRAND_AUDIENCE`, `BRAND_CONTENT_TYPE`, `BRAND_CONTENT_VERB`, etc.

### Multi-Provider AI Processing
- **Grok API** handles X.com/Twitter URLs (native access to tweet content), Gate-2 classification, and scan execution (x_search, web_search tools)
- **Claude API** handles non-X URL summarization (with Firecrawl scraping), prompt review, distribution post generation (`claude-sonnet-4-6`), and the Friday weekly issue synthesis (pinned to `claude-opus-4-8` in `src/jobs/weekly-issue.ts`)
- **Perplexity API** handles deep web research scans (sonar-pro model, natively searches web with citations)
- **Ollama** (`src/services/ollama.ts`) is the preferred auto-summarize provider (`SUMMARIZE_PROVIDER=auto|ollama|grok`, see `src/services/auto-summarize.ts`) — falls back to Grok
- **Parallel.ai** (`src/services/parallel.ts` + `parallel-task.ts`) powers `tool_type: 'parallel'` scan prompts (Grok plans → Parallel retrieves → Grok extracts) and the weekly issue's cited verification pass
- URL routing for summarization happens in `src/services/processor.ts` which imports `isXcomUrl()` from `src/services/grok.ts`

### API Provider System
- All API keys can be stored in the `api_providers` DB table with env var fallback (`src/services/api-provider.ts`)
- Resolution order: explicit param > DB provider default_model > hardcoded default
- Providers are cached in-memory and refreshed on upsert
- Dashboard Settings > API Providers tab manages keys, base URLs, default models, and connection testing
- Known providers: grok, anthropic, firecrawl, perplexity, resend, telegram, telegram-intake, ollama, parallel

### Storage Strategy
- **Generated files** and **schedule configs** are persisted to Postgres (survive restarts)
- **Sessions** are DB-backed (`sessions` table, 7-day expiry, survive deploys; in-memory read-through cache)
- **Magic link tokens, download tokens, and job queues** are in-memory (reset on restart)
- **Small job state** (summary-sync watermark, agent daily-scan briefs) lives in the `app_state` KV table (`getAppState`/`setAppState` in `src/db/index.ts`)
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
├── server.ts             # Express setup, route mounting (ORDER MATTERS — see Internal API Key Auth), verifies the recorded schema version at boot (migrations run via `npm run db:migrate -- --apply` before deploy), background interval timers
├── config/
│   ├── index.ts          # Environment variables and validation
│   ├── brand.ts          # Deployment-agnostic brand config (audience, contentType, contentVerb)
│   └── db-config.ts      # Persistent DB config file storage
├── db/
│   ├── startup-migrations.ts # Ordered migration list + schema version; migration CLI/CI apply it, server verifies it read-only
│   └── index.ts          # Postgres queries + ensure*/DDL implementations (schedules, feeds, scan tables, scan prompts, distribution, app_state). CHECK constraints defined here — see enum-lockstep warning below
├── middleware/
│   ├── auth.ts           # Privy session auth (requireAuth middleware)
│   ├── internal-auth.ts  # Internal API key auth for agent access (requireAuthOrInternalKey)
│   └── rate-limit.ts     # In-memory rateLimit() helper used by expensive/admin endpoints
├── routes/               # Express route modules (mounted in server.ts — 18 routers)
│   ├── accounts.ts       # monitored_accounts CRUD (X account/people watch-list)
│   ├── admin.ts          # Admin operations (migrations, backfills, purges, contacts-sync trigger)
│   ├── auth.ts           # Login, logout, session, file download
│   ├── dashboard.ts      # Overview stats
│   ├── database.ts       # DB introspection, paginated queries, schema info
│   ├── distribution.ts   # Distribution config, channels CRUD, run, newsletter
│   ├── export.ts         # CSV export
│   ├── feeds.ts          # Feed CRUD
│   ├── grants-intel.ts   # Grants-intel asset queries (orgs/opportunities intelligence surface)
│   ├── integrations.ts   # Notion CRM sync config
│   ├── jobs.ts           # Background job triggers, SSE progress, Telegram webhook (mounted FIRST)
│   ├── models.ts         # Model & wire lookup
│   ├── orgs.ts           # Org profiles
│   ├── providers.ts      # API providers, usage tracking, pricing
│   ├── scan-entries.ts   # Entry queries, submit, queue, actions, curate stamp, redistribute, seen-urls, agent brief
│   ├── scan-execution.ts # Scan execution + forum/feeds/cohort run triggers (/api/scan/run, /api/feeds/run, /api/forum/run, /api/cohort/run)
│   ├── scan-prompts.ts   # Scan prompts CRUD, test, review, run
│   └── schedules.ts      # Schedule CRUD, scheduler status, digest send-now
├── scripts/              # Manual CLI tools (npx ts-node / railway run) — NOT scheduled
│   ├── forum-dryrun.ts / forum-run-once.ts / forum-activity-probe.ts   # Forum lane testing/audit
│   ├── cohort-bridge-run-once.ts # Notion cohort bridge (heartbeat + backfill); --dry-run available
│   ├── source-feeds-dryrun.ts / source-feeds-run-once.ts               # Feed lane testing
│   ├── weekly-preview.ts / weekly-run-once.ts / weekly-seed-prior.ts / weekly-send-md.ts  # Weekly issue tooling
│   ├── program-backfill.ts # Program-identity backfill: one-off corpus canonicalization (--dry-run mode)
│   └── cleanup-lane-noise.ts / lane-quality-report.ts / queue-dedup-review.ts  # June-2026 one-off audits
├── jobs/
│   ├── account-monitor.ts  # Poll monitored X accounts (orgs + people) for new URLs -> intake
│   ├── bd-leads.ts         # Weekly BD leads (Wednesdays in the digest fold): relationship signals -> qualify -> verify -> Notion Paid Work Leads
│   ├── contacts-sync.ts    # Notion Contacts DB -> monitored_accounts reconcile (30-min timer)
│   ├── csv-export.ts       # Approved entries CSV export (runs inside daily-digest; also on-demand)
│   ├── cohort-bridge.ts    # Notion Cowork+Codex scans table → source_runs heartbeat + queue (daily-digest fold)
│   ├── cohort-health.ts    # Digest probe for the cohort heartbeat / replay cursor
│   ├── daily-digest.ts     # Daily digest aggregation + cost recap (see "the daily fold" below)
│   ├── daily-intake.ts     # Scan intake pipeline orchestrator (parse -> dedup -> classify -> queue)
│   ├── deadline-digest.ts  # data provider for the daily digest's Closing-soon fold — no standalone email
│   ├── decided-recheck.ts  # LLM semantic dedup of queued entries vs 365d decided corpus (5-min cycle)
│   ├── enrichment.ts       # Thin-entry scrape + re-summarize — MANUAL ONLY (POST /api/enrich)
│   ├── forum-scan.ts       # Governance-forum lane: discuss.watch allowlist + LLM judge -> intake
│   ├── process-raw.ts      # 5-min background cycle: raw -> Gate 1 -> dedup -> classify -> queue
│   ├── scan-execution.ts   # Prompt-driven scans (Grok x_search/web_search, Perplexity, Parallel)
│   ├── source-feeds.ts     # Registry feed ingester (Karma GAP, Grants.gov, EA Forum, own-site scrapes...) with per-source app_state watermark
│   ├── summary-sync.ts     # tele-sum summaries -> scan_entries review candidates (15-min timer, watermark)
│   └── weekly-issue.ts     # Friday weekly Substack draft: gather -> verify (Parallel/Firecrawl) -> synthesize -> email + Notion Paste Log
├── migrations/           # One-time TS cleanup scripts (historical)
├── services/
│   ├── anthropic.ts      # Claude API calls with scraping integration (uses getBrand())
│   ├── api-provider.ts   # DB-backed API key management with env var fallback (api_providers table)
│   ├── api-usage.ts      # Fire-and-forget API usage logging + cost estimation (api_usage_log table)
│   ├── approval-guard.ts # Pre-approval validation (blocks bad source/description data)
│   ├── auth.ts           # Sessions, magic-link/download tokens, cleanup sweep
│   ├── auto-summarize.ts # Auto-generate summary on approve (Ollama-first, Grok fallback)
│   ├── bd-leads-notion.ts # Write verified BD leads to the Notion Paid Work Leads db (dedup by Source URL)
│   ├── bd-qualifier.ts   # BD shape-screen: scores signals against SOV_SHAPE (3 service lines, ecosystem-blind)
│   ├── bd-roles.ts       # BD roles lane: ATS/RSS registry + title taxonomy + net-new watermark (Phase B)
│   ├── bd-verify.ts      # BD verification via Parallel Task API (real? currently active? cited status)
│   ├── classifier.ts     # Gate 2 LLM classifier (GRANT/NEWS/EXPIRED/NOISE + score + scope gate + wire reassignment)
│   ├── contact-discovery.ts # Evidence-gated people discovery (org + content anchored) -> discovered_contacts/Notion
│   ├── curator.ts        # Curator route/confidence stamp logic (queue triage signal, written via /curate)
│   ├── dedup.ts          # URL exact-match + exact-name dedup (fuzzy layer disabled) + alternate-source annotation
│   ├── discord-channel.ts # Discord channel posting via REST API (built, unused in prod)
│   ├── distribution.ts   # Distribution orchestrator: send entries to channels, retry, newsletter
│   ├── email.ts          # Resend email templates (digest, weekly draft, CSV, alerts, login)
│   ├── entry-actions.ts  # Approve/decline/restore business logic + approve side-effects (audit: actor/reason/dryRun)
│   ├── forum.ts          # discuss.watch client: pre-classified /grants feed pull + governance allowlist, age gate, LLM thread judge
│   ├── grok.ts           # Grok Chat + Responses API for X.com content and scans (uses getBrand())
│   ├── intake.ts         # Scan result parser (4 strategies) + sanitizeResult()
│   ├── intake-core.ts    # Channel-agnostic intake (URL extraction, wire detection, dumb-pipe insert)
│   ├── job-queue.ts      # SSE-based job progress tracking
│   ├── models.ts         # Dynamic model fetching from provider APIs
│   ├── notion-sync.ts    # Notion CRM sync (org_profiles -> Notion database, DB-backed config)
│   ├── ollama.ts         # Ollama client (auto-summarize provider)
│   ├── operator-signals.ts # Feedback loop: mines approve/decline decisions to calibrate classifier
│   ├── org-enricher.ts   # LLM + web org profile enrichment (6h timer) with url-verify guard
│   ├── org-extractor.ts  # Canonical org name extraction + fuzzy org dedup + entry linking on approve
│   ├── org-merge.ts      # Org profile merge (source -> target), relink entries
│   ├── parallel.ts       # Parallel.ai Search API client (scan retrieval)
│   ├── parallel-task.ts  # Parallel.ai Task API client (weekly issue cited verification)
│   ├── perplexity.ts     # Perplexity sonar-pro scans
│   ├── post-generator.ts # claude-sonnet-4-6 generates tweet + Telegram HTML per entry (template fallback)
│   ├── processor.ts      # Entry processing with retry logic
│   ├── program-identity.ts # Program canonicalization: resolve entries to canonical programs + the Layer 1.75 advisory resolver
│   ├── scan-stats.ts     # Prompt effectiveness and overlap metrics
│   ├── scheduler.ts      # node-cron scheduling, DB-driven; daily-digest branch runs the daily fold
│   ├── scraper.ts        # Firecrawl integration, URL resolution (SSRF-hardened shortener resolution)
│   ├── source-feeds.ts   # SOURCE_REGISTRY + fetch handlers (rss/atom, rest_json, graphql, github_csv, scrape)
│   ├── source-filter.ts  # Gate-1 aggregator-source blocklist (SOURCE_BLOCKLIST_EXTRA extendable)
│   ├── storage.ts        # Postgres-backed file storage with in-memory cache
│   ├── telegram-adapter.ts # Telegram intake bot adapter (webhook handler -> intake-core)
│   ├── telegram-channel.ts # Telegram Bot API posting to channels (the LIVE distribution channel)
│   ├── url-verify.ts     # Deterministic URL verification (drops 404s in enrichment)
│   ├── weekly-notion.ts  # Markdown -> Notion blocks + Paste Log landing for the weekly
│   ├── x-client.ts       # Twitter/X posting via twitter-api-v2 (built, unused in prod)
│   └── x-thread.ts       # X thread context fetching (aggregate-thread summaries)
├── views/                # Server-rendered pages (login + error only; dashboard is React SPA)
├── utils/                # sleep(), escapeHtml(), masking, normalizeUrl(), validation helpers
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
- Both use the shared head/style helpers from `src/views/shared.ts` (`sharedHead`, `sharedBaseStyles`, `sharedCenteredPageStyles`)

### Changing AI Prompts
- Grok newsletter prompt: `src/services/grok.ts` - `buildGrokPrompt()` function
- Claude prompts: `src/services/anthropic.ts` - `buildScrapedContentPrompt()` and `buildFallbackPrompt()` functions
- Classifier prompt: `src/services/classifier.ts` - `buildClassificationPrompt()` function
- Scan prompts: Stored in `scan_prompts` table, managed via `/api/scan/prompts` CRUD API. Each prompt has `prompt_text` and optional `response_format`.

### Adding an Enum Value (status / scan_source / prompt_variant / tool_type / schedule_type)
1. Add the value to the ONE canonical const in `src/types/intake.ts`
2. Done — DDL CHECK constraints, TS unions, and route validators derive from it
3. Increment `SCHEMA_VERSION`, apply the migration command before deployment, and run `tests/enum-lockstep.test.js`

### Adding a Table or Column
1. Write/extend the `ensure*` function (usually in `src/db/index.ts`)
2. Add ONE entry to `STARTUP_MIGRATIONS` in `src/db/startup-migrations.ts` (order matters)
3. Increment `SCHEMA_VERSION` and update `scripts/database-runtime-grants.sql` for any new runtime table
4. The explicit `db:migrate -- --apply` command and CI run this list. Server boot only verifies the recorded version. Never call `ensure*` from runtime paths.

Production runtime uses a non-owner login. Supply the owner connection only to
the separate migration process, then apply the explicit runtime grants before
deployment. `wro_schema_migrations` is writable only by the migration owner.
Missing or incompatible versions stop startup before any background work begins.

### Adding Environment Variables
1. Add to `src/config/index.ts` in the `config` object
2. Add validation in `validateConfig()` if required
3. Update `.env.example`
4. Update README.md environment variables table

Program counts (`entry_count`, `approved_count`, `declined_count`) are maintained
by database triggers for all entry writers, including direct SQL maintenance.
Installation is schema version 3 through the migration-owner command. Upgrades
apply only migration steps newer than the recorded version; unversioned entries
belong to the original version 1 baseline. New contracts must carry their version.
The count triggers do not change program identity, canonical representatives,
organization links, source fields, or editorial decisions. Existing application
refreshes still maintain program timelines and eligible representatives.

## Database Architecture

### Recorded decision dates

Schema version 4 stamps `scan_entries.decision_at` only when an entry is inserted
as approved/declined or changes into one of those statuses. General edits cannot
change that timestamp. Existing entries retain NULL because their edit dates do
not prove a decision date. Program `last_decision` is maintained transactionally
for every writer and shown as the last *recorded* decision. The former edit-date
labels are retained in `programs.legacy_last_decision` for historical review;
they are never used as current decision evidence. This archive can be retired
only after that historical review and a retained recovery copy.

### Shared PostgreSQL Database

`wire-room-ops` and `tele-sum` share one PostgreSQL database hosted on Railway (`wire-room-db`). This repo is the primary writer. (The retired `the-wire-room` site's Railway service was deleted 2026-07-02.) The `grant-wire-scout` Railway services and the local `grant-wire-engine`/`grant-wire-weekly` tooling also connect to this database directly — treat its schema as a shared contract.

### Table Groups

| Group | Tables | Purpose |
|-------|--------|---------|
| **Scan pipeline** | `scan_entries`, `seen_urls`, `seen_names`, `intake_runs`, `scan_prompts` | Core intake/dedup/queue pipeline |
| **Watchtower** | `watch_surfaces` | Discovery registry: one row per watchable surface of an org (grants page, blog, forum, RSS, X account, ...) with tier/wire and per-surface machine state (last checked/changed, failure streak). Seeded 2026-07-03 with 1,136 surfaces via `src/scripts/import-watch-surfaces*.ts`; humans edit orgs in Notion, machine state lives only here. Phase 1 consumes it: `src/jobs/registry-watch.ts` polls the rss-tagged surfaces and hash-diffs the grants_page/application ones, writing checked-state back to this table |
| **tele-sum legacy** | `messages`, `summaries`, `categories`, `users`, `telegram_bots`, `channel_configs` | Telegram ingestion (bridged via `summary-sync.ts`) |
| **Distribution** | `distribution_channels`, `distribution_logs`, `distribution_config` (legacy) | Channel output tracking |
| **Config** | `feeds`, `schedules`, `integration_config` | Wire/schedule/integration config |
| **API management** | `api_providers`, `api_usage_log`, `model_pricing` | DB-backed API keys, usage tracking, cost estimation |
| **Identity** | `org_profiles`, `sessions` | Organization tracking + auth sessions |
| **Programs** | `programs` | Program-identity registry: canonical program per funder (aliases, url_domains, round + decision history); `scan_entries.program_id` links members; fed by the advisory intake resolver (Layer 1.75) and `src/scripts/program-backfill.ts` |
| **Legacy** | `grant_entries`, `grok_usage`, `review_queue`, `alembic_version`, `sync_status` | Historical/dormant tables |

### scan_entries — The Central Table

All pipeline data flows through `scan_entries`. Key columns:

| Column | Type | Purpose |
|--------|------|---------|
| `status` | text | Pipeline stage: `raw` → `deduped` → `queued` → `approved`/`declined`/`archived`/`duplicate`/`skipped`/`incomplete` |
| `classification` | varchar | Gate 2 label: `GRANT`, `NEWS`, `EXPIRED`, `NOISE`, `UNCHECKED` |
| `quality_score` | integer | 0-100 score from LLM classifier (null on dumb-pipe Telegram/manual intake — the curator stamp is the queue's triage signal) |
| `wire` | text | Feed vertical (crypto/ai/oss) |
| `scan_source` | text | Ingestion channel — all 17 allowed values, derived from `SCAN_SOURCES` in `src/types/intake.ts` (including `grok-scout`, `known-org-watch`, and `stringer`) |
| `source_url` | text | Original source link |
| `metadata` | jsonb | LLM-extracted structured data (amount, deadline, eligibility, summary) + curator stamp + decided-recheck verdict |
| `org_id` | integer | FK to `org_profiles` (auto-linked on approve) |

> ✅ **Enum single-source-of-truth (since 2026-07-03):** the canonical lists for `scan_entries.status`/`scan_source`, `scan_prompts.tool_type`, and `schedules.schedule_type` live as consts in `src/types/intake.ts` (`SCAN_STATUSES`, `SCAN_SOURCES`, `TOOL_TYPES`/`TOOL_TYPES_DB`, `SCHEDULE_TYPES`). Every CHECK constraint interpolates them via `sqlEnumList()`, every TS union derives from them, and every route validator references them. **To add an enum value: edit the ONE const** — DDL, types, and validators pick it up automatically (`tests/enum-lockstep.test.js` fails if anyone reintroduces a literal list). This replaced the multi-writer drift pattern that crash-looped production 3× in June 2026. Note `scan_prompts.variant` remains a hand-list (legacy, stable).

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

`*` Queue/archive rules are not identical for every intake path. Scan execution archives `NOISE`; raw background processing queues complete non-duplicates even when classification is weak (archiving only off-scope items). **Operator intake (a human pasting into the Telegram bot or the dashboard) never auto-archives** — the dumb pipe queues everything unclassified, and `determinePostClassificationStatus` returns `queued` for every route (wide net). The same doors called with an internal API key are **agent intake** (`IntakeOptions.origin = 'agent'`, since 2026-09-04): rows start `raw` and the process-raw cycle classifies them like every other automated lane, still wide-net queued but carrying a real score and route (off-scope items archive). The classifier's `operator_route` (`publish`/`source_check`/`park`/`relationship_signal`/`decline`) persists into `metadata.operator_route` (written by process-raw Gate 2 and the classify backfill — the BD loop and the queue's ROUTE filter depend on it). `quality_score` ranks and explains items but is no longer a universal queue threshold.

### Dedup Tables

- **`seen_urls`**: Exact URL match. Composite unique on `(normalized_url, wire)`. Handles aggregate URLs (same URL, different entries) via name similarity check.
- **`seen_names`**: Stores normalized names and tokens for review intelligence and alternate-source detection. Hard duplicate blocking currently relies on URL exact match; fuzzy name blocking is intentionally disabled after false positives.
- **Program resolver (Layer 1.75)**: The `programs` table supplies advisory program and round context. It does not demote entries. A 53-link audit found that broad program identities could collapse distinct proposals, rounds, calls, and cross-wire events. Exact URL and exact name layers remain the automatic duplicate gates. A same-round repeat gets an operator note with the program history (`Program repeat (seen N× …)`), and the digest renders the history via the programs join (see `src/services/program-identity.ts`).
- **Recheck holds**: decided-recheck blocks automatic demotion when the semantic match is cross-wire (immediate candidate OR resolved terminal parent), when the chain resolves to a canonical parent with a different source, or when the duplicate chain is broken. Held entries STAY QUEUED with a "Human review required" note and a `decided_recheck` hold stamp (`cross_wire_blocked` / `canonical_parent_blocked` / `duplicate_chain_error`). Visibility contract: holds stay visible in the digest's fresh finds (the same_listing exclusion excepts hold stamps), count as `held` in `RecheckStats` (surfaced in the run log, the Telegram intake receipt, and the digest's `held` ledger lane). Do not add a new hold outcome without carrying it through those three surfaces (see `src/jobs/decided-recheck.ts`, `src/jobs/daily-digest.ts`, `src/services/telegram-adapter.ts`).

### Approval Validation Guard

Pre-approval validation (`src/services/approval-guard.ts`) prevents bad data from reaching the public website:
- **Blocks**: empty description, empty source_url
- **Warns**: EXPIRED classification, oversized names (>120 chars), junk deadline data, UNCHECKED classification, missing quality score
- Applied to both single and bulk approve endpoints. Operator can override with `?force=true`.

### The Telegram Bridge

`summary-sync.ts` bridges `tele-sum`'s `summaries` table → `scan_entries` as **review-queue candidates** (`status=queued`, `operator_route='source_check'`, `classification=UNCHECKED`, `quality_score=70` — NOT auto-approved; they land in the operator queue for source verification):
- Runs every 15 minutes with a high-water mark stored in `app_state` (1-hour overlap; falls back to a 7-day lookback on first run or after errors)
- Idempotent: skips entries where `source_url` already exists in `scan_entries`
- Full dedup citizen: runs `checkDuplicate()` (normalized URL + exact name) before inserting, and calls `registerSeen()` after, so intake dedup can see telegram-synced entries
- **`seen_urls` ownership contract (2026-09-30):** a `seen_urls` row with `first_seen_entry_id IS NULL` is treated by `registerSeenInTransaction` as seed-only history and is a permanent conflict: a fresh entry that hits one is parked as `status='deduped'` / `duplicate_reason='URL already exists in seed history'`, which no queue, digest, or recovery job surfaces. Only this repo may write `seen_urls`, and every write carries the owning entry id. tele-sum wrote ownerless rows for every summarized URL from 2026-04-27 until its fix on 2026-09-30, which parked 55 of 57 bridged entries in Aug–Sep and 37 bot-door entries (98 total, recovered 2026-09-30). If bridged entries start vanishing again, check for ownerless rows first: `SELECT count(*) FROM seen_urls WHERE first_seen_entry_id IS NULL AND created_at > now() - interval '7 days'`.
- Infers wire from content keywords (AI/OSS detection, defaults to crypto)
- Historical backfill available via `POST /api/admin/summary-sync-backfill`

The bridge is one half of a loop with tele-sum; the other half is tele-sum's **round-trip guard**: when this app distributes an approved entry to a Telegram wire channel, tele-sum skips re-importing that post by checking `distribution_logs` (`channel='telegram' AND status='success'`, matched on `external_id` = Telegram message id + `wire`). **Contract:** keep logging successful telegram sends with `external_id` and `wire`, or tele-sum will re-ingest every distributed post and duplicate it into `summaries` (this happened 2026-05-14 → 2026-06-10; ~98% of approvals duplicated).

### Admin Endpoints
All `POST /api/admin/*` — rate-limited maintenance operations: `run-migration`, `classify-backfill`, `tag-backfill`, `summary-sync-backfill`, `recover-self-dupes`, `clean-stale-seen`, `clean-orgs`, `dedup-orgs`, `enrich-orgs`, `purge-source`. See `src/routes/admin.ts` for details.

### Other Tables

Schedule configuration uses a `schedules` table with UUID primary keys, supporting multiple named schedules with a `schedule_type` field (5 types — see Schedule Types below). Cron expressions are computed dynamically from `hour`/`minute`/`frequencyHours` columns via `buildCronExpression()`. Saving a daily-digest schedule auto-derives per-wire AM/PM scan-execution schedules (`syncScanSchedulesFromDigest`).

The `feeds` table manages dynamic wire/feed types, seeded from `SEED_FEEDS` and auto-discovered from `channel_configs`. Scan prompts are stored in `scan_prompts` with CRUD support.

Distribution uses `distribution_channels` (managed channels with UUID PK, per-channel credentials in JSONB) and `distribution_logs` (tracks per-entry, per-channel send status with a unique partial index to prevent double-posts). Legacy `distribution_config` remains a compatibility path and is still read by the distribution service.

## API Integration Details

All providers support DB-backed credentials (`api_providers` table) with env var fallback. Model resolution: explicit param > provider.default_model > hardcoded default.

- **Grok** (`src/services/grok.ts`): Chat Completions for classification/summaries + Responses API for scan execution (`x_search`/`web_search` tools). Has native X.com access.
- **Claude** (`src/services/anthropic.ts`): Summarization (Opus) + post generation (Sonnet for cost efficiency). Uses `@anthropic-ai/sdk`.
- **Perplexity** (`src/services/perplexity.ts`): `sonar-pro` model, natively searches web with citations. For `tool_type: 'perplexity'` prompts.
- **Firecrawl** (`src/services/scraper.ts`): Web scraping for non-X.com URLs.
- **Resend** (`src/services/email.ts`): all outbound email — daily digest, weekly draft, CSV export, scan digest, login/magic link, test alert, scheduled-job failure alert, download-link resend.

## Error Handling & Security

- **Retry**: `withRetry()` in `processor.ts` (3 attempts newsletter, 2 for scans). Batch concurrency: 3 at a time.
- **Concurrent job guard**: Duplicate manual jobs return 409. Scheduler skips overlapping cron runs.
- **Scrape fallback**: If Firecrawl fails, Claude uses cached summary.
- **Security**: CSRF origin checking, HttpOnly session cookies, `escapeHtml()` XSS prevention, open redirect protection, SSE keepalive (30s).
- **Memory**: Cleanup timers (15-min) for the job queue, one-time tokens, and the rate-limit store. Sessions are DB-backed with an in-memory read-through cache. Timers use `.unref()` and graceful shutdown hooks.

## Testing Locally

1. Copy `.env.example` to `.env` and fill in all API keys
2. `npm install`
3. `npm run dev` (uses ts-node)
4. Access http://localhost:3000
5. Login with the email matching `NOTIFICATION_EMAIL`

## Common Issues

### "Missing required environment variables"
Check that all 4 required env vars are set: DATABASE_URL, NOTIFICATION_EMAIL, PRIVY_APP_ID, PRIVY_APP_SECRET. API keys (ANTHROPIC_API_KEY, GROK_API_KEY, FIRECRAWL_API_KEY, RESEND_API_KEY) are optional at startup and produce warnings -- they can also be configured via Settings > API Providers in the dashboard.

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
See `.env.example` for full list. Key optional vars: `PORT`, `APP_URL`, `ALLOWED_EMAILS`, `STARTUP_LLM_RESCORE_ENABLED` (explicit opt-in to queue-only LLM score repair on boot; default false and may spend API credits), `TELEGRAM_BOT_TOKEN`, `PERPLEXITY_API_KEY`, `PARALLEL_API_KEY` (Parallel.ai scans), `FORUM_SCAN_ENABLED`, `SUMMARIZE_PROVIDER` + `OLLAMA_DEFAULT_MODEL` (auto-summarize provider), `SUMMARY_SYNC_WIRES` (tele-sum bridge wire filter), `SOURCE_BLOCKLIST_EXTRA` (extra Gate-1 blocked domains), `CRM_ENRICH_ENABLED` (org enrichment in the daily CRM cycle — default off), `CRM_CONTACT_DISCOVERY_ENABLED` (writes Needs Review contacts — default off, keep off until that queue is worked), `WEEKLY_PASTE_LOG_PAGE_ID` (Notion landing page), `BD_LEADS_DATABASE_ID` (Notion Paid Work Leads db for the BD loop), `BRAND_*` (deployment-agnostic config overrides), `INTERNAL_API_KEY` + `INTERNAL_API_KEY_DAILY_SCAN` (named agent API keys — see Internal API Key Auth), `X_BEARER_TOKEN` (X account monitor, X list watcher), `WATCHTOWER_BUDGET_MONTHLY_USD` (monthly discovery spend cap, default $20), `X_LISTS_ENABLED` (enable the X list watcher lane, default false), `X_LISTS_DRY_RUN` (log without submitting to intake, default true), `X_LIST_IDS` (comma-separated wire:listId pairs), `REGISTRY_WATCH_ENABLED` (enable the registry-watch lane over `watch_surfaces`, default off), `REGISTRY_WATCH_TIERS` (which `watch_surfaces` tiers the lane polls — `"1"`, `"1,2"`, or `"2"`, default `"1"`), `DEV_MODE` (skip auth in dev), `DATA_DIR` (local data storage).

## Feeds System

Dynamic wire/feed management via the `feeds` table.

### How Feeds Work
- **Wires are locked to the canonical `CORE_WIRES` (crypto / ai / oss)** in `src/db/index.ts` — `getAvailableWires()` and every wire picker/validator derive from it; stray wire values in `channel_configs` can no longer pollute the feeds table or dropdowns. `GET /api/feeds?includeArchived=true` is the raw-table escape hatch.
- Seeded from `SEED_FEEDS` in `src/db/index.ts` (crypto, ai, oss)
- Auto-discovered from `channel_configs` table only for core wires
- CRUD API at `/api/feeds` (GET, POST) and `/api/feeds/:key` (PUT, DELETE)
- `archived` flag soft-deletes feeds; use `?includeArchived=true` to list all
- Used throughout the app to filter summaries, schedules, and scan prompts by wire

## Scan Pipeline System

### Overview
Automated discovery of grant opportunities via X.com scanning, web search, and forum scanning. Intake processing eliminates duplicates and surfaces high-quality entries.

### Ingestion Channels
- **X.com scan** (`x-scan`): Grok Responses API with `x_search` tool, prompt-driven
- **Web search** (`web-search`): Grok Responses API with `web_search` tool, same prompt system as X scan
- **Perplexity scan** (`perplexity`): Perplexity sonar-pro with native web search and citations (prompts with `tool_type: 'perplexity'`)
- **Parallel scan** (`web-search` via `tool_type: 'parallel'`): Grok plans queries (operator can pin them via a `Search queries: a | b | c` line in the prompt) → Parallel retrieves → Grok extracts
- **Source feeds** (`feed`): registry-driven ingester (`src/services/source-feeds.ts` `SOURCE_REGISTRY`) — aggregator APIs (Karma GAP, Grants.gov, EA Forum GraphQL…), RSS/Atom (FLI, NLnet, OTF), and own-site funder scrapes via Firecrawl. Per-source seen-URL watermark in `app_state` (`feed:seen:<key>`); only net-new items reach the classifier; first-run cap prevents queue floods
- **Cohort Notion bridge** (`claude-cohort-notion`): in-process ingest of the Cowork + Codex Daily Grant Scans Notion table (`src/jobs/cohort-bridge.ts`). Writes a durable `source_runs` heartbeat, persists `opportunity_observations`, and promotes Verified / Top of Digest rows through intake. Folded into the daily-digest cycle; a missed window opens a replay cursor that clears only after a successful `backfill`/`replay` run_id. Manual: `POST /api/cohort/run`, `POST /api/admin/cohort-bridge`, or `npx ts-node src/scripts/cohort-bridge-run-once.ts`. Env: `COHORT_BRIDGE_ENABLED` (default on), `COHORT_NOTION_DATABASE_ID`, `COHORT_NOTION_TOKEN` (falls back to the enabled Notion integration token). The SimpleCRM Notion integration must be granted access to the scans table.
- **Forum scan** (`forum`): governance-forum lane via discuss.watch — curated per-wire governance allowlist + `hot=true` catch-all, 30-day createdAt age gate, then an LLM judge per thread batch (opportunity/not + extraction). Replaced the retired broad-keyword search (2% approve / 67% dupes)
- **X account monitor** (`x-monitor`): polls `monitored_accounts` (funder orgs + key people, Notion Contacts-controlled) for new URLs in recent tweets
- **X list watcher** (`x-list`): Watchtower Tier 1 — polls the latest posts per curated per-wire X List and filters client-side against an id watermark (the Lists endpoint has no `since_id` support), one API read per wire per scheduled run, budget-gated (`src/jobs/x-lists.ts`). Env-gated: `X_LISTS_ENABLED`, dry-run default
- **Registry watch** (`feed`): Watchtower Phase 1 — reads `watch_surfaces` tier-1/2 rss feeds plus grants/application pages, change-gated extraction (hash-diffs the page and only pays for an LLM read when the hash changes and it isn't the surface's first-ever check), budget-gated (`src/jobs/registry-watch.ts`). Env-gated: `REGISTRY_WATCH_ENABLED`, default OFF, dry-run default
- **Telegram intake** (`telegram`): Bot-based URL/article submission via webhook — a **dumb pipe** for a human's own paste: queue unclassified with URL-only dedup, no Gate 2 at intake. Supports single URLs and batch messages (numbered lists, bold-name, or `Link:` format). Adapter pattern (`telegram-adapter.ts` -> `intake-core.ts`). The HTTP door (`POST /api/scan/telegram-batch`) shares the parser but an internal-key caller is `origin: 'agent'` and inserts `raw` for the 5-min classifier — The Stringer's batches (600+/month) were riding the human trust path unclassified until 2026-09-04
- **Agent submits** (`claude-code`, `x-scan`/`web-search` via API): the daily-grant-scan claude.ai routine and The Stringer submit via `POST /api/scan/submit` with the internal API key — inserted raw (`insertOnly`), completed by the 5-minute process-raw cycle
- **Known Org Watch** (`known-org-watch`): Stringer compiler inserts official-source org-watch findings into the review queue. Keep this value in `SCAN_SOURCES` so boot does not recreate `scan_entries_scan_source_check` without it.
- **Strings** (`stringer`): Cursor Grok Bot submits finds via `POST /api/scan/submit`. Dedicated producer label — do not reuse `grok-scout`, `claude-code`, or `known-org-watch`.
- **Manual paste** (`manual-intake`): Dashboard paste-in flow (historically the highest-approval channel)

### Data Flow
1. **Execute**: `scan-execution.ts` fetches active prompts from `scan_prompts`, routes to the correct provider per `tool_type`: Grok Responses API (`x_search`/`web_search`), Perplexity (`perplexity`), or Parallel (`parallel`)
2. **Parse**: `intake.ts` extracts structured results via 4 parser strategies (structured text, JSON, X-post format, lenient numbered list). All strategies extract `sourcePublishedAt` when available (Published/Announced/Updated dates)
3. **Sanitize**: Post-parse `sanitizeResult()` cleans all parsed output — strips leading/trailing brackets from names, truncates names >120 chars, rejects junk deadlines (>50 chars, contains URLs/semicolons), discards suspicious small amounts (<$100 bare), moves excess name text into description
4. **Insert**: Raw results written to `scan_entries` with `status: raw`
5. **Gate 1 — Completeness**: Entries with empty/garbage `source_url` or missing critical fields are archived or marked incomplete before dedup, depending on intake path
6. **Dedup**: `dedup.ts` blocks exact URL repeats via `seen_urls` (Layer 1) and exact case-insensitive name repeats per wire via a direct `scan_entries` lookup (Layer 1.5, 180-day window — catches the same program arriving from a different source under a different URL). Callers that insert the raw row BEFORE dedup-checking must pass `excludeEntryId` or the entry matches itself. `seen_names` remains useful for related-opportunity/alternate-source signals, but fuzzy (token-overlap) name blocking is disabled.
7. **Gate 2 — LLM Classify + Score**: `classifier.ts` calls Grok to classify (GRANT/NEWS/EXPIRED/NOISE) and score (0-100) in one call. Failed classifications retry once with 2-second delay.
8. **Queue/archive**: Source-specific behavior: scan execution archives `NOISE`; raw background processing queues complete non-duplicates; Telegram/manual intake uses `operator_route`.
9. **Approve Guard**: Pre-approval validation blocks entries with empty descriptions or empty URLs from being published; warns on EXPIRED classification

### Schedule Types (5)
- **`daily-digest`** — **the anchor cron: one daily cycle runs the whole discovery fold** (`scheduler.ts` daily-digest branch): (1) forum scan (if `FORUM_SCAN_ENABLED`), (2) source feeds, (3) cohort Notion bridge (Cowork+Codex table → `source_runs` heartbeat + queue), (4) **Fridays only** the weekly Grant Wire issue, (5) **Wednesdays only** the BD leads run, then (6) the digest email — assembled by `assembleAndSendDailyDigest()` (fresh watermarked finds + run ledger + closing soon fold + Wednesday BD leads + anomalies; the cost recap and per-source breakdown feed anomaly derivation only, they don't get their own email sections) — then (7) CSV export of 24h approvals (files persisted for the dashboard; links no longer in the email), then (8) the daily CRM cycle — org enrichment (40, `CRM_ENRICH_ENABLED`), contact discovery (20, 90-day revisit, `CRM_CONTACT_DISCOVERY_ENABLED`), Notion CRM sync — after the email so it can never delay it. Each lane is isolated in try/catch so a lane failure never blocks the digest. Saving this schedule auto-derives per-wire AM/PM scan-execution schedules. **Do not add new standalone crons for periodic work — fold it into this cycle** (owner rule). **The digest email is decisions-first (2026-07-09 "Run Ledger" redesign):** status band (RUN CLEAN/⚠ N issues + lane ledger) → production issues → "New for review" (watermarked, never repeats, curator-stamped, queue deep links) → closing soon fold (data from `runDeadlineDigest`, renders only when non-empty — replaces the retired standalone deadline-digest email) → Wednesday BD leads. Ops telemetry tables (per-source matrix, cost table, wire table) live in the dashboard only — `renderDailyDigest()` in email.ts is the pure renderer, pinned by tests/digest-email.test.js
- **`scan-execution`**: Runs `runScanExecution()` — executes all active prompts for a wire
- **`forum-scan`**: Runs `runForumScan()` — standalone/extra forum runs (the daily fold already covers one/day)
- **`source-feeds`**: Runs `runSourceFeeds()` — standalone/extra feed runs (the daily fold already covers one/day)
- **`account-monitor`**: Runs `runAccountMonitor()` — polls monitored X accounts for new URLs

Besides node-cron schedules, `src/server.ts` starts plain interval timers at boot: process-raw + decided-recheck cycle (5 min), summary-sync bridge (15 min), contacts-sync (30 min). **CRM work (org enrichment, contact discovery, Notion CRM sync) is folded into the daily-digest cycle** — it runs AFTER the digest email sends, so CRM latency can never delay the morning touchpoint. (Retired 2026-07-03: drip-distribution, experiment-loop, collect-engagement schedule types and the digest-orgs timer — their `schedules` rows are deleted at boot.)

### Prompt Management
- Prompts stored in `scan_prompts` table with `wire`, `label`, `prompt_text`, `response_format`, `variant`, `tool_type`, `intent`
- `tool_type` values: `x_search` (Grok X.com), `web_search` (Grok web), `perplexity` (Perplexity sonar-pro), `parallel` (Parallel.ai retrieval), `community` (community sources)
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


## Distribution System

### Overview
Per-feed multi-channel distribution of approved scan entries. **Approve = publish**: a normal dashboard approval fires per-entry distribution automatically (fire-and-forget `setImmediate` in `entry-actions.ts`); quiet approvals and internal-key agent approvals set `distributable=false` and skip it. Manual batch distribution from the dashboard remains available for approved-but-undistributed entries. Five channel types are supported: Telegram (**the only live channel in production**), Discord, Slack, X/Twitter, and newsletter (copyable markdown).

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
- **`distribution_logs`**: Per-entry, per-channel send status. Unique partial index on `(entry_id, channel) WHERE status IN ('pending','success')` prevents double-posts. **Read by tele-sum**: its import guard matches `channel='telegram' AND status='success'` rows on `external_id` (Telegram message id) + `wire` to skip re-ingesting distributed posts — don't change those columns' semantics without updating tele-sum's `distribution_guard.py`.

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

### Key Endpoints
- `POST /api/distribution/run/:wire` — trigger distribution for a wire
- `GET /api/distribution/newsletter/:wire` — generate newsletter markdown
- `POST /api/scan/entries/:id/redistribute` — retry failed sends
- Channel CRUD + config via `/api/distribution/config` routes (see `src/routes/distribution.ts`)

## BD Leads Loop (find + qualify, never contact)

Pillar-2 revenue loop (strategy: Notion "BD Loop — Strategy & Direction"). **Wednesdays only, inside the daily-digest fold** (`scheduler.ts`, same pattern as the Friday weekly): `src/jobs/bd-leads.ts` pulls the last 7 days of `metadata.operator_route = 'relationship_signal'` entries → `bd-qualifier.ts` shape-screens them against `SOV_SHAPE` (three service lines; crypto/AI/OSS treated equally, organic no-bias, default-no) → `bd-verify.ts` grounds survivors in current reality via the Parallel Task API (strict: unverified = disqualified) → dedup by org → `bd-leads-notion.ts` writes them to the Notion **Paid Work Leads** db as Status=Lead (dedup by Source URL across weeks; db id from integration_config `leads_database_id` or `BD_LEADS_DATABASE_ID` env). **Structural guarantees:** finds + qualifies ONLY — imports no send/contact path; never creates Opps (Sov converts manually in Notion); no email in Phase A (review-first). **Roles lane (Phase B):** `src/services/bd-roles.ts` — a verified ATS/RSS registry (`ROLES_REGISTRY`: Greenhouse + Ashby JSON APIs + LF/fossjobs RSS, each source lane-tagged crypto/ai/oss) fetched in the same Wednesday run. Postings pass a title taxonomy (senior BD/partnerships/ecosystem/grants/governance/ops/CoS/revenue; engineering and junior titles excluded), a per-source net-new watermark (`bd:roles:seen:<key>` in app_state, first-run capped, advanced ONLY after a clean Notion write), then the same SOV_SHAPE qualifier — but SKIP Parallel verification (ATS data is fresh by construction). Weekly role cap: 10, ranked by qualifier confidence. Adding a role source is config, not architecture. Manual tooling: `src/scripts/bd-pipeline-run.ts`, `bd-qualify-demo.ts`, `smoke-bd-signals.ts`.

## Operator Signals (Feedback Loop)

The classifier is calibrated by operator approve/decline decisions (`src/services/operator-signals.ts`):
- Queries 30-day history of approve/decline actions per wire
- Computes per-entity approval rates, score thresholds for approved vs declined entries, and common decline reasons
- Formats guidance as a prompt addendum injected into the classifier prompt
- Results cached for 6 hours to avoid repeated DB queries
- The classifier (`src/services/classifier.ts`) calls `computeOperatorSignals()` and `formatSignalsForPrompt()` before each classification

## Scoring Experiments (RETIRED 2026-07-03)

The AutoResearch subsystem is fully retired: dashboard tab + `/api/experiments` removed 2026-06-13 (`112a5a0`); engine, rule-based scorer, `experiment-loop`/`collect-engagement` schedule types, drip lane, and `experiment_id` intake tagging removed 2026-07-03 (Phase 4). The DB tables (`scoring_experiments`, `scoring_param_log`, `engagement_metrics`) and columns (`scan_entries.experiment_id`, `distribute_after`) remain as dormant data — nothing reads or writes them. Do not build on this subsystem.

## Entry Actions Service

`src/services/entry-actions.ts` extracts approve/decline/restore logic from HTTP handlers into a reusable service layer. Supports `ActionOptions`: `quiet` (skip distribution), `force` (override validation), `actor` (audit trail — who), `reason` (audit trail — why), `dryRun` (validate without committing). Both `singleEntryAction()` and `bulkEntryAction()` are used by REST API routes and agent integrations. Audit columns: `actioned_by`, `action_reason` on `scan_entries`.

Approve side-effects (fire-and-forget unless noted): write-through to `summaries` (synchronous, even for quiet approvals), per-entry distribution (skipped when quiet), auto-summarize when the summary is thin, org extraction/linking/enrichment when unlinked, and — single approves of X-sourced entries only — `monitored_accounts` tracking (3 approvals from the same X account auto-enables it as a recurring discovery source).

## Curator Stamps

The Stringer's queue-triage layer: `POST /api/scan/entries/:id/curate` (internal-key reachable) writes a non-destructive stamp into `scan_entries.metadata.curator` — route + confidence + rationale (`src/services/curator.ts`). It never changes entry status. The queue UI shows curator route + confidence instead of the legacy Score column (PR #45); `quality_score` is null on dumb-pipe intake paths, so the stamp is the primary triage signal for those entries. `GET /api/scan/agent/approval-patterns` serves recent approve/decline examples for agent calibration.

## Internal API Key Auth

`src/middleware/internal-auth.ts` provides `requireAuthOrInternalKey` middleware. Accepts a valid **named** internal API key bearer token (timing-safe compare) or falls through to standard Privy session auth. Each key maps to its own audit-trail identity: `INTERNAL_API_KEY` → `agent:stringer` (The Stringer), `INTERNAL_API_KEY_DAILY_SCAN` → `agent:daily-scan` (the claude.ai daily-grant-scan routine). **Agents can never publish**: entry actions are force-quieted server-side and `POST /entries/:id/redistribute` returns 403 for agent sessions (operator-only).

Internal-key mounts (see `src/server.ts`): `/api/scan/prompts`, `/api/scan` (entries, actions, queue, seen-urls, agent endpoints), `/api` scan-execution (`/api/scan/run`, `/api/feeds/run`, `/api/forum/run`, `/api/cohort/run`), `/api/grants-intel`, `/api/accounts`, and the SSE job-progress endpoint. Agent behaviors enforced server-side: entry actions are **force-quieted** (agents cannot trigger distribution), `POST /api/scan/submit` runs `insertOnly` (dedup/classify completed by the 5-min process-raw cycle), `POST /api/scan/telegram-batch` (and `/manual-intake`) share `processBatchMessage` with `@GrantWireSummarizer_bot` (`parseBatchEntries`, URL/name dedupe, `scan_source=telegram`) but an agent session inserts `raw` (`IntakeOptions.origin = 'agent'`, response carries `processing: 'background'`) so process-raw classifies within ~5 min — only a human session gets the unclassified queued insert, and `POST /entries/:id/curate` writes a non-destructive curator stamp.

**Mount order in `server.ts` is load-bearing**: the Telegram webhook router mounts first, and `scanExecutionRouter` must mount before the session-only `/api/feeds` + schedule routers or the internal key gets 401s from prefix shadowing (this broke agent access once — fixed in `8cc119f`).

## API Usage Tracking

All LLM API calls are logged for cost monitoring (`src/services/api-usage.ts`):
- **`api_usage_log`** table: provider, model, purpose, wire, duration_ms, tokens_in/out, success, error_message
- **`model_pricing`** table: per-model cost rates (input/output per million tokens)
- `logApiUsage()` is fire-and-forget (never blocks the caller)
- Dashboard API exposes usage aggregation and pricing CRUD
- Cost estimation computed from usage logs joined with model pricing

## Organization Management

Org profiles track organizations mentioned in entries (`org_profiles` table). Contact discovery revisits each org every 90 days (`contacts_checked_at` gate) rather than one-shot-forever:
- **Extractor** (`src/services/org-extractor.ts`): Pattern matching + LLM-based extraction of canonical org names from entry text. Title prefixes prefer the most specific known alias. Organization-name normalization uses whole-name aliases only. Approval and batch extraction reuse a unique exact profile name or recorded alias; ambiguous matches abort linking. Substring and token overlap never establish identity. Automatic creation, lookup and final linking reject program-shaped profiles even when enriched; held or already-linked entries are preserved after a locked re-read. Historical archive rules are separate. See `docs/org-identity.md`. Auto-links eligible entries to `org_profiles` on approve.
- **Enricher** (`src/services/org-enricher.ts`): LLM + web enrichment of org profiles — **BD lens since 2026-07-03 (PR #62)**: description covers how the org RUNS funding/programs (named teams/leads when sourced), `last_signal` is a dated org-side trigger, and `operator_read` is one grounded sentence on the operator need an outsider could serve (never invented — "no visible gap" is a valid answer). Also fills taxonomy fields (type, source_type, website, tier, tags). Grok Responses + web_search + url-verify guard (dead URLs dropped, not written). Selection: >30-day staleness, `entry_count DESC`, chunks of 10; `enrichBatch({force, limit})` caps limit at 200. Runs daily in the digest fold; admin endpoint for batch enrichment. `operator_read` renders into the Notion Action(s) block between description and "Latest:".
- **Derived metrics** (`src/db/org-metrics.ts`): Schema version 2 keeps `entry_count`, `avg_quality_score`, and `tier` tied to linked `scan_entries` in `queued` or `approved` status. Counts exclude digest sightings and other statuses; averages ignore null scores and round to one decimal. Entry mutations update affected profiles transactionally, including restricted maintenance writers. Profile sightings never increment counts. Refreshes update only changed metrics. See `docs/org-metrics.md` for the migration and rollback contract.
- **Merge** (`src/services/org-merge.ts`): Merge duplicate org profiles (source -> target), relink all entries. Admin endpoint for manual dedup.
- **Notion sync** (`src/services/notion-sync.ts`): Sync org profiles to the Notion CRM. Config stored in `integration_config` table (DB-backed, not env vars). **The Notion Orgs db is a pruned 10-field HUMAN VIEW** (Name, Type, Wire, Relationship, Website, Action(s), Quality Score, Tier, Contacts, Last Checked — CRM simplification 2026-07-03); Twitter/GitHub/Tags/Source Type/Items Sourced live only in Postgres `org_profiles`. Do not add Notion property writes without adding the schema field in the same change (tests/notion-sync-props.test.js pins this).
- Admin endpoints: `/api/admin/clean-orgs`, `/api/admin/dedup-orgs`, `/api/admin/enrich-orgs`

## Approved Entries Export

Cross-wire CSV export via `src/jobs/csv-export.ts`. `GET /api/export/csv?hoursBack=24` for direct download, `POST /api/export/csv` to generate + email. Runs automatically after daily-digest (skipped if 0 entries).

## Weekly Grant Wire Issue

`src/jobs/weekly-issue.ts` — runs **Fridays only inside the daily-digest fold** (no separate cron). Gathers the week's distributed+approved entries (spine = `distribution_logs` success joined to approved `scan_entries`, window from the prior issue's date) plus currently-open queued/approved GRANT items ("Also open"); verifies each item is still open via Parallel Task API (primary, cited) or Firecrawl scrape + Sonnet judge (fallback), correcting amounts/deadlines and dropping closed items; synthesizes the locked Substack shape with `claude-opus-4-8`; emails the draft (`sendWeeklyDraftEmail`) and lands it in the Notion "Weekly Summaries Paste Log" (`src/services/weekly-notion.ts`). Continuity via `app_state` keys `weekly:last-issue` and `weekly:week-number`. Publishing to Substack stays human. Manual tooling: `src/scripts/weekly-run-once.ts` (`--no-email`), `weekly-preview.ts`, `weekly-seed-prior.ts`.

## Rate Limiting

In-memory `rateLimit()` helper in `src/middleware/rate-limit.ts` (15-min cleanup sweep). All expensive/admin endpoints are rate-limited (search code for `rateLimit(` to see specific limits).

## Code Style Notes

- TypeScript strict mode
- Express for HTTP server
- Login page uses React (via ESM) with Privy + starfield canvas animation; dashboard is a React/Vite/Tailwind SPA (`client/`)
- Server-rendered views (login/error only) are in `src/views/` sharing head/style helpers from `shared.ts` (deep space palette, Orbitron headings)
- Validation helpers (`isValidUuid()`, `isValidFeedKey()`, `slugifyFeedKey()`) are defined in `src/utils/validation.ts`
- Minimal dependencies
- Error messages include context for debugging

### Dashboard UI lessons (operator feedback)
- In wide settings tables, keep primary actions (edit/remove) visible inline — don't hide them in the last column
- Don't expose internal identifiers (slugs/keys) in create flows when a human-facing name suffices; generate them automatically
- Action labels must match real behavior (if it archives, say "Archive", not "Delete"), and don't blur "edit metadata" vs "open workspace" actions

## Planned / Not Yet Implemented

- **Slack/Discord intake adapters** (same `intake-core.ts` interface, new inbound channel adapters -- distribution already works)
- **Email inbound ingestion** (URL extraction from forwarded emails)
