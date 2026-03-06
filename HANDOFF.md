# Wire Room Ops: Session Handoff (Historical)

> Note: This document is retained for historical context. Some sections (especially distribution/weekly-summary references) are no longer accurate for the current codebase.

## What This Session Covered

This was a working session on the `wire-room-ops` repo (deployed on Railway) focused on transitioning from a fully manual grant discovery workflow to the automated scan pipeline that already exists in the codebase but has never been turned on.

---

## Current State of the System

The app is live at `wire-room-ops-production.up.railway.app`. It has a Privy-authenticated dashboard, a scheduler that shows 6 schedules, and all the pipeline code wired up. But zero scan prompts are loaded, zero automated scans have run, and zero entries have gone through the intake pipeline. Everything happens manually right now: Sov finds grant opportunities, posts them to t.me/cryptograntwire, TeleSum picks them up and writes to the Railway Postgres database.

The goal is to flip this so the system discovers, deduplicates, scores, and queues entries automatically, and Sov just reviews and approves daily.

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

All 9 prompts are documented in Notion under "Daily Scans: Approach and Tools" (https://www.notion.so/2b9000c0d59080d8965af97109ef20b4). Three wires, three variants each (A/B/C). All are v3.0 from Feb 16, 2026.

### Prompt Strategy

**A (Action Scan)**: Keyword-driven queries using action language ("applications open", "deadline", "apply"). Catches open calls and program launches. Most reliable.

**B (Landscape Scan)**: Tracks named ecosystems/orgs (crypto), government/institutional programs (AI), or specific foundations (OSS). Catches awards, results, governance moves that don't use action language. Crypto B works well on X. AI B uses regional/government context instead of org names because AI funding orgs don't get discussed on X in grant contexts.

**C (Open Sweep)**: No fixed query list. Grok searches freely based on its understanding of the space. Discovery engine for new and emerging programs. Catches what A and B miss.

### Prompt Pages in Notion

**Crypto:**
- Crypto A (Action Scan): https://www.notion.so/309000c0d59081a59b21dc94da540bc6
- Crypto B (Landscape Scan): https://www.notion.so/309000c0d59081b190c2f4e615046199
- Crypto C (Open Sweep): https://www.notion.so/309000c0d59081e89903f1ddba8ad53b

**AI:**
- AI A (Action Scan): https://www.notion.so/309000c0d590815989aaf297c996329a
- AI B (Landscape Scan): https://www.notion.so/309000c0d5908146b101df00589b48e6
- AI C (Open Sweep): https://www.notion.so/309000c0d59081c3a601ee8cb423ea36

**OSS:**
- OSS A (Action Scan): https://www.notion.so/309000c0d59081799254c5056d746bec
- OSS B (Landscape Scan): https://www.notion.so/309000c0d5908115bd59cf3d7583d300
- OSS C (Open Sweep): https://www.notion.so/309000c0d59081f5ab84db03a49bf1dd

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
7. Approving an entry sets `status: approved` (immediately visible on thewireroom.xyz) and triggers distribution if enabled

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

5. **Enable distribution** for the crypto Telegram channel first (it has the audience). Set `DISTRIBUTION_ENABLED=true` in Railway env vars and configure the Telegram channel ID.

6. **Set up the aggregated X account** and configure X credentials for distribution.

7. **Enable forum scanning** if desired (`FORUM_SCAN_ENABLED=true`). The discuss.watch integration searches 150+ Discourse forums.

8. **Tune quality scoring and dedup** based on what the pipeline surfaces. Adjust weights in quality-scorer.ts or the threshold if too much noise or too many good entries are being filtered.

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

Need to set for distribution:
```
DISTRIBUTION_ENABLED=true
TELEGRAM_CHANNEL_CRYPTO=@cryptograntwire (or numeric channel ID)
TELEGRAM_CHANNEL_AI=@aigrantwire
TELEGRAM_CHANNEL_OSS=@ossgrantwire
X_CRYPTO_API_KEY, X_CRYPTO_API_SECRET, X_CRYPTO_ACCESS_TOKEN, X_CRYPTO_ACCESS_TOKEN_SECRET
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
