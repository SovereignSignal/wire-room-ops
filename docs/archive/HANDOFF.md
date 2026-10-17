# Wire Room Ops: Session Handoff

> **Historical document**: This handoff was written during an earlier session and should not be used as live operating guidance. Some env vars and architectural references (thewireroom.xyz, DISTRIBUTION_ENABLED, TELEGRAM_CHANNEL_* vars) no longer exist. See CLAUDE.md and STRINGER.md for current state.

## March 9, 2026 — Theme, Intake Bot, Deployment-Agnostic Refactor

### What Was Shipped

1. **Lovable satellite array theme**: Login page and shared shell updated with deep space palette (hsl 245,35%,6%), signal cyan accent (#00eaff), Orbitron font for headings, and starfield canvas animation. Privy modal accentColor updated.

2. **React dashboard**: `client/` directory added — full React/Vite/Tailwind frontend (Lovable wireops-dashboard UI). Server now serves `dist/client/index.html` for all authenticated routes. Only login/error pages remain server-rendered.

3. **Telegram intake bot**: Channel-agnostic intake core (`src/services/intake-core.ts`) with Telegram adapter (`src/services/telegram-adapter.ts`). Webhook at `POST /api/telegram/intake-webhook`. Auto-registers webhook on startup if `TELEGRAM_INTAKE_BOT_TOKEN` is set. Wire detection via per-wire keyword scoring; inline keyboard for ambiguous cases. Only allowed user ID can submit.

4. **Deployment-agnostic refactor**: Brand config (`src/config/brand.ts`) with `getBrand()` for audience, contentType, contentVerb. AI prompts (Grok, Claude, Perplexity), quality scorer keywords, and email templates all use `getBrand()`. Wire lists DB-driven everywhere (summary-sync, scheduler, forum-scan). Quality scorer `FUNDING_TYPES`/`ACTIONABLE_TYPES` and forum search terms overrideable via env vars.

### New Environment Variables

All optional, all added to `.env.example`:
- `TELEGRAM_INTAKE_BOT_TOKEN`, `TELEGRAM_INTAKE_WEBHOOK_SECRET`, `TELEGRAM_INTAKE_ALLOWED_USER_ID`
- `INTAKE_WIRES`, `INTAKE_WIRE_KEYWORDS_{WIRE}`
- `BRAND_AUDIENCE`, `BRAND_CONTENT_TYPE`, `BRAND_CONTENT_VERB`, `BRAND_NAME`, `BRAND_TAGLINE`, `BRAND_COLOR`, `BRAND_URL`, `BRAND_FROM_NAME`
- `FORUM_SEARCH_TERMS`, `QUALITY_FUNDING_TYPES`, `QUALITY_ACTIONABLE_TYPES`

### Key New Files

- `client/` — React/Vite/Tailwind dashboard (Lovable design)
- `src/config/brand.ts` — deployment-agnostic brand config
- `src/services/intake-core.ts` — channel-agnostic intake logic
- `src/services/telegram-adapter.ts` — Telegram intake bot adapter

---

# Historical Handoff (Original Session)

> Note: This section is retained for historical context. Some references (especially distribution/weekly-summary) have since been implemented.

## What This Session Covered

This was a working session on the `wire-room-ops` repo (deployed on Railway) focused on transitioning from a fully manual grant discovery workflow to the automated scan pipeline that already exists in the codebase but has never been turned on.

---

## Current State of the System

The app is live at the Railway app URL. It has a Privy-authenticated dashboard, a scheduler that shows 6 schedules, and all the pipeline code wired up. But zero scan prompts are loaded, zero automated scans have run, and zero entries have gone through the intake pipeline. Everything happens manually right now: the operator finds grant opportunities, posts them to t.me/cryptograntwire, TeleSum picks them up and writes to the Railway Postgres database.

The goal is to flip this so the system discovers, deduplicates, scores, and queues entries automatically, and the operator just reviews and approves daily.

---

## Code Changes Made This Session

### Auth Allowlist (already pushed and deployed)

Modified `src/server.ts` (around line 233-298) to add email-based access control to the dashboard. Before this change, anyone who could authenticate via Privy could access the dashboard.

The auth callback now:
1. Verifies the Privy JWT token
2. Fetches the full Privy user profile via `https://auth.privy.io/api/v1/users/{userId}`
3. Extracts the user's email from `linked_accounts`
4. Checks against an allowlist: `NOTIFICATION_EMAIL` (always allowed) plus optional `ALLOWED_EMAILS` env var (comma-separated)
5. Returns 403 if the email isn't in the allowlist
6. Frontend login page was updated to show a proper error message on 403

The `ALLOWED_EMAILS` env var is optional. If not set, only `NOTIFICATION_EMAIL` can access the dashboard.

### Operations Guide (already in repo)

Created `operations-guide.md` in the repo root. Covers the full 7-phase transition from manual to automated pipeline: verify deployment, create prompts, manual scan, review queue, set up schedules, enable distribution, transition daily routine.

---

## Architecture Decisions Made

### Distribution Channel Strategy

**Telegram**: Three separate channels, segmented by beat.
- Crypto: t.me/cryptograntwire (4K+ subscribers, established)
- AI: separate channel (newer)
- OSS: separate channel (newer)

**X (Twitter)**: One aggregated account for all three beats (e.g., @sovsgrantwire or similar). The three existing accounts (@cryptograntwire, @aigrantwire, @ossgrantwire) would eventually redirect or go dormant.

This means the distribution config for X credentials only needs one set of creds shared across wires (or one wire posts to the aggregated account and others skip X).

---

## The 9 Grok Prompts (Ready to Load)

All 9 prompts are documented in Notion under "Daily Scans: Approach and Tools" (private Notion page). Three wires, three variants each (A/B/C). All are v3.0 from Feb 16, 2026.

### Prompt Strategy

**A (Action Scan)**: Keyword-driven queries using action language ("applications open", "deadline", "apply"). Catches open calls and program launches. Most reliable.

**B (Landscape Scan)**: Tracks named ecosystems/orgs (crypto), government/institutional programs (AI), or specific foundations (OSS). Catches awards, results, governance moves that don't use action language. Crypto B works well on X. AI B uses regional/government context instead of org names because AI funding orgs don't get discussed on X in grant contexts.

**C (Open Sweep)**: No fixed query list. Grok searches freely based on its understanding of the space. Discovery engine for new and emerging programs. Catches what A and B miss.

### Prompt Pages in Notion

**Crypto:**
- Crypto A (Action Scan): private Notion page
- Crypto B (Landscape Scan): private Notion page
- Crypto C (Open Sweep): private Notion page

**AI:**
- AI A (Action Scan): private Notion page
- AI B (Landscape Scan): private Notion page
- AI C (Open Sweep): private Notion page

**OSS:**
- OSS A (Action Scan): private Notion page
- OSS B (Landscape Scan): private Notion page
- OSS C (Open Sweep): private Notion page

### Prompt Output Format

All 9 prompts currently output in this format (from manual Grok usage):

```
@Handle — Short description
Full tweet text
https://x.com/handle/status/123456789
2026-02-16
```

### How the Parser Works

The intake parser in `src/services/intake.ts` (`parseStructuredOutput`) tries 4 strategies in order:

1. **Structured text** (Strategy 1): Numbered list with `**bold names**`, Deadline: line, Link: line. This is the most reliable format and what the response_format field can request.
2. **JSON** (Strategy 2): Array of objects with name/description/url/deadline/amount fields. Handles multiple wrapper keys.
3. **X-post format** (Strategy 3): `@Handle — Description` blocks with URLs and dates. This matches the current manual prompt output.
4. **Lenient numbered list** (Strategy 4): Numbered items without bold, flexible URL detection.

The parser extracts these fields into `RawScanResult`: `name`, `description`, `deadline`, `sourceUrl`, `amount`.

### Important: Responses API vs Manual Grok Chat

The prompts were written for manual Grok chat. When loaded into `scan_prompts` and executed via the automated pipeline, they go through `executeScanPrompt()` in `src/services/grok.ts` which uses the **Grok Responses API** (`/v1/responses`) with the `x_search` tool (or `web_search` depending on `toolType`).

The Responses API gives Grok real-time access to X.com data (or web data). The prompt text is sent as-is, with any `response_format` appended. Grok's output format from the Responses API may differ slightly from manual chat, but the multi-strategy parser handles this.

The prompts should work as-is with the Responses API. The `x_search` tool type is correct for all 9 prompts since they all scan X. Adding a `response_format` that requests Strategy 1 format (structured numbered list) would make parsing more reliable, but is not strictly required since Strategy 3 (X-post format) already handles the expected output.

### Loading Prompts: What Each One Needs

For each prompt, POST to `/api/scan/prompts`:

```json
{
  "wire": "crypto|ai|oss",
  "label": "Crypto A — Action Scan",
  "promptText": "[the prompt text from the code block in Notion]",
  "responseFormat": "",
  "toolType": "x_search",
  "isActive": true,
  "sortOrder": 0,
  "variant": "A|B|C"
}
```

Sort order: A=0, B=1, C=2 within each wire.

---

## Pipeline Execution Flow (How It All Connects)

1. **`runScanExecution()`** (src/jobs/scan-execution.ts) fetches all active prompts from `scan_prompts` table
2. Executes each prompt sequentially via **`executeScanPrompt()`** (src/services/grok.ts) — each call takes 60-90s
3. Raw text output goes through **`parseStructuredOutput()`** (src/services/intake.ts) — tries 4 parsing strategies
4. Parsed results are bundled into `ScanSubmission` objects
5. **`runDailyIntake()`** (src/jobs/daily-intake.ts) processes all submissions:
   - Dedup via `seen_urls` (exact URL match) and `seen_names` (fuzzy token overlap)
   - Quality scoring via `scoreEntry()` (src/services/quality-scorer.ts)
   - Entries scoring >= 40 get `status: queued`, below threshold gets `status: archived`
6. Queued entries appear in the dashboard for review
7. Approving an entry sets `status: approved` and triggers configured distribution unless the approval is quiet

Full run of 9 prompts takes ~9-14 minutes.

---

## Quality Scoring (For Reference)

Defined in `src/services/quality-scorer.ts`:

| Signal | Points |
|--------|--------|
| Has dollar amount | +25 |
| Amount over $5K | +15 |
| Has specific deadline | +15 |
| Deadline within 60 days | +10 |
| Is a funding opportunity (grant, fellowship, hackathon) | +20 |
| Is actionable (can apply/register) | +15 |
| Governance/DAO noise | -15 |
| Already awarded (past tense) | -10 |

Queue threshold: 40. Max possible: 100.

---

## What Still Needs to Happen

### Immediate (get the pipeline running)

1. **Load all 9 prompts into `scan_prompts`** via the dashboard or API. The prompt text is in the Notion pages linked above (inside the code blocks). Each prompt needs wire, label, variant, toolType (x_search for all), sortOrder.

2. **Test each prompt** via `POST /api/scan/prompts/:id/test` to verify the Responses API returns parseable results. Check that the parser picks up entries correctly. If parsing is spotty, add a `responseFormat` that requests structured numbered list output.

3. **Run a manual scan** for one wire: `POST /api/scan/run { "wire": "crypto" }`. Review the queue. Check quality scores, dedup behavior, and whether good stuff is making it through.

4. **Set up daily schedules** for scan-execution (one per wire, or one for all). Recommended: run once daily, review the queue in the morning.

### Near-term (once daily scans are validated)

5. **Enable distribution** for the crypto Telegram channel first (it has the audience). Configure channel credentials in Settings > Distribution.

6. **Set up the aggregated X account** and configure X credentials for distribution.

7. **Enable forum scanning** if desired (`FORUM_SCAN_ENABLED=true`). The discuss.watch integration searches 150+ Discourse forums.

8. **Tune quality scoring and dedup** based on what the pipeline surfaces. Use operator-signal feedback and classifier/routing calibration before changing legacy rule-based scoring.

### Longer-term

9. **Add web_search prompts** as a second channel (same prompts adapted for open web instead of X)
10. **Sunset TeleSum** once automated scans cover enough ground
11. **Weekly newsletter generation** via the existing weekly-summary job (already built, needs schedule)

---

## Key Files Quick Reference

| File | What It Does |
|------|-------------|
| `src/server.ts` | All API routes, dashboard HTML, auth callback (line ~233) |
| `src/services/grok.ts` | `executeScanPrompt()` — sends prompts to Grok Responses API |
| `src/services/intake.ts` | `parseStructuredOutput()` — 4-strategy parser for Grok output |
| `src/jobs/scan-execution.ts` | Orchestrates scan: fetch prompts → execute → parse → intake |
| `src/jobs/daily-intake.ts` | Dedup → score → queue pipeline |
| `src/services/quality-scorer.ts` | 0-100 scoring engine |
| `src/services/dedup.ts` | URL exact match + fuzzy name overlap |
| `src/services/distribution.ts` | Approve → Telegram + X posting |
| `src/services/post-generator.ts` | Claude-powered tweet/Telegram message generation |
| `src/services/scheduler.ts` | Cron scheduling with health tracking |
| `src/config/index.ts` | All environment variable config |
| `operations-guide.md` | Full operational walkthrough (created this session) |

---

## Environment Variables Relevant to Next Steps

Already set (presumably, since the app is deployed):
```
DATABASE_URL, ANTHROPIC_API_KEY, GROK_API_KEY, FIRECRAWL_API_KEY,
RESEND_API_KEY, NOTIFICATION_EMAIL, PRIVY_APP_ID, PRIVY_APP_SECRET
```

Historical distribution env vars from the old path:
```
Current distribution credentials are managed via Settings > Distribution / `distribution_channels`; do not add DISTRIBUTION_ENABLED or TELEGRAM_CHANNEL_* vars.
X_CRYPTO_API_KEY, X_CRYPTO_API_SECRET, X_CRYPTO_ACCESS_TOKEN, X_CRYPTO_ACCESS_TOKEN_SECRET may still be needed if X posting is configured.
```

Optional:
```
ALLOWED_EMAILS=other@email.com (comma-separated, adds to NOTIFICATION_EMAIL allowlist)
FORUM_SCAN_ENABLED=true
TELEGRAM_BOT_TOKEN (for bot-based URL ingestion)
```

---

## Database Tables in Play

- `scan_prompts` — Prompt storage (currently empty, needs loading)
- `scan_entries` — Where results land after intake processing
- `seen_urls` — URL dedup index
- `seen_names` — Fuzzy name dedup index
- `intake_runs` — Intake run metadata
- `distribution_logs` — Per-entry distribution tracking
- `schedules` — Cron schedule configs
- `feeds` — Wire/feed type registry (crypto, ai, oss already seeded)
