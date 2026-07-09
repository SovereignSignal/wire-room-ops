# Run Ledger Digest — Design

**Date:** 2026-07-09
**Status:** Approved by Sov (visual direction "Run Ledger" chosen from 4 mockups; content architecture "Operator's Cockpit" chosen from 3 approaches).
**Supersedes:** `2026-07-09-digest-email-refresh-design.md` (Codex WIP — kept as input; its curator-first ORDER BY survives, its 24h window and "Ops Dashboard Lite" shell do not).

## Goal

The daily digest email becomes an operator's cockpit with exactly three jobs:

1. **Drive the review workflow** — surface queue items Sov has never seen before, with curator context, deep-linked into the dashboard queue.
2. **System trust at a glance** — prove the machine ran, via a color-coded status band whose states (clean / issues) are unmistakable at arm's length.
3. **Fold in deadlines** — absorb the standalone weekly "Closing Soon" email (retired) as a conditional section.

Diagnosed failure modes of the current email (operator interview, 2026-07-09): stale/repetitive content (all-time queue top-N re-serves the same items daily) and weak visual hierarchy. Explicit non-goals: the digest is NOT a briefing/newsletter and NOT exception-based — it sends every day.

## Out of scope

Weekly Substack draft, scan digest, failure alerts, and transactional emails are untouched. No new schedule types, no new crons (owner rule: fold, don't multiply).

## 1. Freshness: the emailed-IDs watermark

Replaces both the current all-time top-N and the Codex 24h window.

- `app_state` key **`digest:emailed-ids`**: JSON map of `entryId → ISO date emailed`.
- Candidate query (in `src/jobs/daily-digest.ts`, evolving `getTopPendingFinds`):
  - `status = 'queued'`
  - `deadline_parsed IS NULL OR deadline_parsed >= CURRENT_DATE`
  - `id` NOT in the watermark set
  - ORDER BY curator route (`publish` → `source_check` → `relationship_signal` → `park` → `decline` → none), then curator confidence (`high`/`med`/`low`), then `quality_score DESC NULLS LAST`, then `deadline_parsed ASC NULLS LAST`, then `created_at DESC` (the Codex ordering, kept).
  - Query returns ALL eligible rows' count plus the top 8 for display ("N more new" line when over 8).
- **Watermark advances only after a successful send** (same pattern as the BD roles lane): a failed email never swallows items; unshown eligible items (beyond the top 8) are NOT watermarked and appear the next day.
- **First-run seeding:** if the key is absent, seed it with ALL currently-queued entry IDs and send a digest with zero "new" items — forward-only, no day-one backlog flood.
- **Pruning:** on each write, drop map entries older than 60 days (queued items that old are stale by definition; the queue itself keeps them).
- **Degradation:** if the watermark read fails, fall back to a 24h `created_at` window (never flood).

## 2. The run ledger (trust band)

A new `RunLedger` structure assembled by the scheduler's daily-digest branch from **evidence, not scheduler bookkeeping** (in-memory `JobStatus` resets on restart and is untrustworthy):

| Lane | Source | Renders as |
|------|--------|-----------|
| scans | `api_usage_log` WHERE `purpose='scan'`, last 24h: ok + failed call counts | `scans 41✓` or `scans 39✓ 2✗` |
| feeds | the fold's own `runSourceFeeds()` result (per-source ok/error) | `feeds 19/19` |
| forum | the fold's own `runForumScan()` result (or skipped when disabled) | `forum ✓` / omitted |
| bridge | age of `app_state` `summary-sync:watermark` (15-min cycle; stale > 6h flags) | `bridge ✓` / `bridge stale` |
| agent | today's `agent-brief:<date>` present | `agent 2 runs` / omitted |
| in / spend | 24h ingest count (digest result) + `costRecap.total` | `41 in · $1.84` |

- **Verdict:** `anomalies.length === 0` → green **RUN CLEAN** band; otherwise amber/red **⚠ N ISSUES** band, with the issues itemized in a "Production issues" section directly under the band. A stale bridge or failed-scan count adds an anomaly (single thresholds, no new config).
- **Degradation:** each probe is isolated try/catch; a failed probe renders that lane as `?` and never blocks the email.

## 3. Renderer contract (`src/services/email.ts`)

`renderDailyDigest()` stays a pure, test-pinned function. Input changes to `DigestEmailExtras`:

- `runLedger?: RunLedger` (new), `closingSoon?: ClosingSoonRow[]` (new)
- `TopFindEntry` gains `id: number`, `curatorRoute?: string`, `curatorConfidence?: string`
- `csvExport`/`downloadUrls`/`agentBrief`/`sourceBreakdown` no longer render in the body (agent shows in the ledger; exports live in the dashboard); the fields may remain on the type for the send-now route but the renderer ignores them.

Layout (approved mockup "Direction 1 — Run Ledger"):

1. Dark header bar: `WIREOPS` wordmark + `THU JUL 9 · 07:00 PT` date slug (mono).
2. Full-width status band: green (`#e6f6ee`/`#116b45`) **RUN CLEAN** or amber-red (`#fdeee4`/`#a23b00`) **⚠ N ISSUES**, containing the mono lane ledger.
3. Bad day only: **Production issues (N)** cards directly under the band.
4. **New for review (N)** — cards with a 3px left border (green for `publish` route, neutral otherwise): entry name links to `{dashboard}/queue?entry=<id>`; mono meta line `WIRE · ROUTE·CONF · amount · due date · source ↗` where `source ↗` is the small secondary link to `source_url`. Cap 8 + "N more new" line.
5. Button: `Open queue → N waiting` (N = total queued, the only place backlog appears).
6. **Closing soon · approved** — compact table (name linked to source, amount, bold amber `N days`), only when non-empty.
7. **BD leads** block — unchanged, Wednesdays.
8. Footer: dashboard link + brand.

Quiet day (zero new, zero issues): header + green band + two sentences ("Nothing new for review… the machine ran, filtered, and left you alone.") + footer. Small HTML (< ~4KB body).

Subjects carry state (no "WireOps" prefix — the sender name covers it):
- `Jul 9 — 4 new for review · run clean`
- `⚠ Jul 9 — 2 issues · 1 new`
- `Jul 9 — nothing new · run clean`

Plain-text part mirrors all sections. All styles inline; table-based layout; email-client-safe (same constraints as today).

## 4. Deadline email retirement

- `jobs/deadline-digest.ts` survives as the **data provider**: the daily fold calls `runDeadlineDigest(pool)` and passes rows to the renderer as `closingSoon`.
- `deadline-digest` is removed from `SCHEDULE_TYPES` in `src/types/intake.ts` (enum-lockstep propagates to DDL CHECK + validators); existing `schedules` rows with that type are deleted at boot (same pattern as the 2026-07-03 retirements).
- `sendDeadlineDigestEmail()` and the scheduler's `deadline-digest` branch are deleted.

## 5. Shared assembly: `assembleDigestEmail`

The dashboard "send digest now" route (`src/routes/schedules.ts`) currently builds its own extras and would silently diverge. Extract the full assembly (digest result, watermarked finds, run ledger, closing soon, cost recap, anomalies, BD leads passthrough) into one function used by both the scheduler branch and the send-now route. One code path, one email.

Note: send-now runs outside the fold, so its feeds/forum lane entries come from the same evidence probes (api_usage_log / app_state), not from just-ran results — the assembly function takes optional "just ran" lane results that the scheduler provides and the route omits.

Both paths advance the watermark after their send succeeds (an item emailed via send-now must not reappear the next morning), so the advance lives next to the shared assembly, not in the scheduler.

## 6. Dashboard deep link

The dashboard has no client router — `client/src/pages/Index.tsx` owns tab state and the `selectedEntry` state that controls `EntryDetailsSheet`, so the deep link lands there: on mount, read `?entry=<id>` from the URL; if present, switch to the queue tab, fetch that entry, and open the sheet; clear the param when the sheet closes. No single-entry endpoint exists today, so add `GET /api/scan/entries/:id` to `src/routes/scan-entries.ts` (validated integer id, 404 when missing; lands on the existing `/api/scan` mount, so session and internal-key auth behave like the other read endpoints). The SPA is already served for `/queue`; no other server change.

## 7. Testing

- `tests/digest-email.test.js` (renderer pin, rewritten): band states + verdict colors, all three subject forms, deep-link URLs (`/queue?entry=`), curator stamps on cards, closing-soon table renders only when non-empty, BD leads block, quiet-day size bound, absence of CSV links / agent activity / ops tables / stale backlog framing.
- `tests/daily-digest.test.js` (new, adapted from Codex WIP): watermark exclusion in the SQL (fake pool), curator-first ordering preserved, first-run seeding behavior, 60-day pruning, watermark-advances-only-after-send.
- `tests/enum-lockstep.test.js` already pins the `SCHEDULE_TYPES` change mechanics.
- Full suite `npm test` green; `tsc` exit code checked directly (never piped — owner rule).

## 8. Rollout

- Ships on branch `codex/digest-email-refresh` → PR → Railway deploy.
- First production run seeds the watermark (quiet "new" section is expected on day one) — note this in the PR body so it isn't mistaken for a bug.
- Smoke: send one real digest via the send-now route after deploy.
