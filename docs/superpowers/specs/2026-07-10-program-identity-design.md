# Program Identity Layer — Design

**Date:** 2026-07-10
**Status:** Approved by Sov (scope: "Both: patch now, then build" 2026-07-09; gate gear: **act and report** from day one).
**Prior art:** the 2026-07-09 dupe-introspection patch (PR #72) fixed the decided-recheck chain bug and backfill-demoted 15 stalled dupes. This layer attacks the root: the pipeline has URL identity and exact-name identity but no *program* identity, so the same program re-enters under every new name variant and URL (Anthropic Fellows: ~60 entries, 15+ name variants, 8+ URLs; corpus-wide, a crude 12-char name fingerprint clusters 57.5% of 10,722 entries into 799 groups).

## Goal

Every entry resolves at intake to a canonical **program** (funder + program, round-agnostic). Known program + same round → auto-duplicate with a pointer and full history ("act and report"). Known program + new round → queued ONCE, annotated with history ("new round of a program you approved Mar 13, declined 11×"). Unknown → a new program row is born. The digest and queue stop pretending recycled programs are news.

## Non-goals (v1)

No Notion sync, no dashboard tab, no changes to the Telegram dumb pipe's insert path (it stays URL-only by design; its entries meet the gate later via process-raw? — no: dumb-pipe entries insert directly at `queued` and skip process-raw, so v1 leaves them ungated; the decided-recheck cycle still covers them). No replacement of decided-recheck (it remains the semantic net for non-program dupes and for dumb-pipe entries).

## 1. The `programs` registry

New table, DDL in the new service (same pattern as org_profiles living in org-extractor.ts), one `STARTUP_MIGRATIONS` entry (`{ name: 'programs', run: ensureProgramsTable }` — keep the exact `{ name, run }` format; the lockstep test regex-parses it):

```sql
CREATE TABLE IF NOT EXISTS programs (
  id SERIAL PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  normalized_key TEXT NOT NULL,          -- lower alnum, round/cohort/year tokens stripped
  org_id INTEGER REFERENCES org_profiles(id) ON DELETE SET NULL,
  org_name TEXT,                          -- denormalized for display/matching before org link exists
  wire TEXT,
  aliases TEXT[] NOT NULL DEFAULT '{}',   -- every name variant seen (feeds the matcher, like org_profiles.aliases)
  canonical_url TEXT,                     -- best-known program page
  url_domains TEXT[] NOT NULL DEFAULT '{}',
  canonical_entry_id INTEGER,             -- the entry dupes point at (best decided/queued exemplar)
  latest_round_label TEXT,                -- 'Sept 2026 cohort', 'Fund14', NULL when roundless
  latest_deadline DATE,
  entry_count INTEGER NOT NULL DEFAULT 0,
  approved_count INTEGER NOT NULL DEFAULT 0,
  declined_count INTEGER NOT NULL DEFAULT 0,
  last_decision TEXT,                     -- 'approved 2026-03-13' style display string
  first_seen DATE,
  last_seen DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (normalized_key)
);
CREATE INDEX IF NOT EXISTS idx_programs_org ON programs(org_id);
```

Plus `scan_entries.program_id INTEGER REFERENCES programs(id)` + `idx_scan_entries_program`, added in the same ensure function (mirrors how org-extractor adds org_id).

`UNIQUE(normalized_key)` note: two genuinely different programs can normalize to the same key only if org tokens are also identical — accepted at v1 (the LLM canonicalizer includes the org in the name it returns, e.g. "Anthropic Fellows Program", "Arbitrum Foundation Audit Program").

## 2. Resolution service — `src/services/program-identity.ts`

- `normalizeProgramKey(name: string): string` — lowercase, strip non-alnum, strip round/cohort noise tokens BEFORE squashing: standalone years (20\d\d), month names, 'cohort', 'round', 'batch', 'wave', 'fund' + trailing digits (Fund14 → fund), 'q1'-'q4', 'h1'/'h2', 'season' + digits, ordinals. Pure function, heavily unit-tested — it is the primary identity key.
- `resolveProgram(pool, candidate: { name; orgName?; sourceUrl?; wire }): Promise<ProgramMatch | null>` — deterministic 3-pass mirror of `findSimilarOrg` over `programs` (normalized-exact vs normalized_key + normalized aliases → substring containment ≥8 chars → token overlap ≥70% with ≥2 shared tokens), with two anchors: org agreement (when both sides know the org, mismatch vetoes pass-2/3 matches) and URL identity (candidate's canonical-ish URL domain+path appearing in `url_domains`/`canonical_url` upgrades confidence). Returns `{ program, confidence: number, pass: 'key'|'substring'|'tokens'|'url' }`. Confidence mapping (pinned): normalized-key exact = 0.95; substring = 0.85; token-overlap = 0.75; URL-identity agreement adds +0.10 (capped 0.99); org mismatch vetoes substring/token matches outright. So the ≥0.85 auto-dupe bar means: key matches always qualify, substring matches qualify as-is, token matches only with URL corroboration.
- `canonicalizeBatch(entries): Promise<CanonicalizationResult[]>` — Grok, chunks of 20 (same shape as org-extractor's `extractOrgsWithGrok`), prompt returns `{ org, program, round_label|null }` per entry: "name the FUNDING PROGRAM canonically (funder + program), strip cohort/round/dates into round_label". Used by the backfill for cluster representatives and at intake ONLY when deterministic resolution finds nothing and the entry is creating a new program row. `purpose: 'program-identity'` in api_usage_log.
- `recordSighting(pool, programId, entry, decisionCounts?)` — appends alias if new, unions url domain, bumps entry_count/last_seen, refreshes latest_round_label/latest_deadline when newer.
- `getProgramHistory(pool, programId): Promise<ProgramHistory>` — `{ sightings, approved, declined, lastDecision, firstSeen }` for card/queue display (cheap: read the counters).

## 3. Link introspection (URL canonicalization before resolution)

v1 ships the deterministic tier only; the scrape tier is budget-capped:

- **Tweet unwrap:** when `source_url` is x.com and the entry's description contains a non-x.com URL, treat that outbound URL (via existing `extractAndResolveUrls` + `normalizeUrl`) as the canonical-URL candidate.
- **ATS mapping:** `job-boards.greenhouse.io/<org>/…`, `jobs.ashbyhq.com/<org>/…`, `jobs.lever.co/<org>/…` → org slug extracted deterministically; the URL counts as the ORG's domain identity, not a distinct program page.
- **Aggregator scrape (capped):** a config list of known aggregator domains (`opportunitiesforyouth.org`, `opportunities247.org`, extendable via env `PROGRAM_AGGREGATOR_DOMAINS`); when an entry from one is UNRESOLVED after deterministic passes, one Firecrawl scrape may extract the outbound canonical link. Hard cap: 10 scrapes/day tracked in `app_state` key `program-gate:scrape-count:<date>`; over cap → skip introspection, resolution proceeds on name alone.

## 4. The intake gate ("act and report")

New **Layer 1.75** inside `checkDuplicate` (src/services/dedup.ts), after the exact-name layer, gated by a new option `programGate?: boolean` (default **false** — callers opt in; process-raw and daily-intake pass true; intake-core's `urlOnly` paths remain untouched):

- Resolve the entry. No match → `checkDuplicate` returns non-duplicate as today; the CALLER (process-raw Gate-2 block / daily-intake Phase 2) then creates the program row (using Gate-2's extracted org when available) and stamps `metadata.program = { id, verdict: 'new_program' }`.
- Match + **same round** + confidence ≥ 0.85 + the program has any prior entry → `DedupResult` with new `matchType: 'program'`, `matchedEntryId = program.canonical_entry_id ?? newest member`, reason `Program "X" seen N× (approved a×, declined d×, last <decision date>)`. Caller demotes exactly as it does for other layers (`status='duplicate'`, `duplicate_of_id`, `duplicate_reason`, `actioned_by='program-gate'`).
- Match + **new round** (differing round_label, or a later deadline when labels absent; ambiguity resolves to new-round, mirroring decided-recheck's CRITICAL BIAS RULE — filtering a real update costs more than showing a near-dupe) → NOT a duplicate; caller stamps `metadata.program = { id, verdict: 'new_round', round_label, history }` and queues normally.
- Match below 0.85 → stamp `metadata.program = { id, verdict: 'tentative', confidence }`, queue normally (annotation only).
- `SCAN_STATUSES`/enums untouched — `matchType` is a TS union, not a DB CHECK. `DedupResult.matchType` gains `'program'`.

**Report half of "act and report":** the digest run ledger gains a `gate` lane — `gate 12 duped` from `SELECT COUNT(*) FROM scan_entries WHERE actioned_by='program-gate' AND updated_at >= NOW() - INTERVAL '24 hours'` (durable evidence, same style as the scans lane; omitted when zero). Restore stays the existing one-click dashboard restore.

## 5. Digest & queue surfacing

- `TopFindEntry` gains `program_history: string | null` — a prebuilt display string ("3rd sighting · approved once (Mar 13) · declined 11×") composed in `getFreshFinds`'s SQL via a LEFT JOIN on programs through `scan_entries.program_id`; the card renders it in the mono meta area, replacing the recheck update note when both exist (program note is strictly richer). `verdict: 'new_round'` renders as `↻ New round of "X" — approved Mar 13, declined 11×`.
- Queue UI: none in v1 (metadata.program is visible in the entry details sheet's raw metadata already).

## 6. Backfill — `src/scripts/program-backfill.ts` (manual, `railway run`, resumable)

1. **Cluster:** group all 10,722 entries by `normalizeProgramKey(name)` (in-memory; ~800-1,200 clusters ≥1 member).
2. **Canonicalize:** for clusters with ≥2 members (or ≥1 decided member), send ONE representative per cluster through `canonicalizeBatch` (≈40-60 Grok calls at 20/chunk; a few dollars once). Singleton undecided clusters get programs rows lazily at next sighting instead (keeps the registry meaningful).
3. **Write:** upsert programs (merge clusters whose canonicalization returns the same org+program), set `scan_entries.program_id` for every member, compute counters from members' statuses, pick `canonical_entry_id` (prefer approved > declined > queued, newest).
4. **Chain hygiene (same pass):** walk `duplicate_of_id` chains cycle-safe (path-array guard); repair the 15 known cycle members by pointing every cycle member at the oldest member; give the 58 pointer-less duplicates a `duplicate_of_id` to their program's canonical entry when resolvable (else leave, log).
5. Resumable via `app_state` key `program-backfill:progress`; idempotent (re-running skips entries with program_id).

## 7. Error handling & budgets

- The gate is fail-open like every dedup layer: resolution error → log, no block, entry proceeds.
- Grok canonicalization at intake happens at most once per NEW program (not per entry); daily cost ≈ pennies. Backfill one-off ≈ single-digit dollars. Scrape tier capped at 10/day.
- No cross-process lock on programs upserts: `UNIQUE(normalized_key)` + `ON CONFLICT` makes concurrent creation converge.

## 8. Testing

- `tests/program-identity.test.js` — `normalizeProgramKey` table-driven (the Anthropic/Arbitrum/EF variants from the corpus as fixtures); 3-pass matcher with fake pool; org-veto; URL upgrade; same-round vs new-round verdicts.
- `tests/dedup-program-gate.test.js` — Layer 1.75 wiring: opt-in flag respected, `matchType 'program'`, fail-open on resolver error, dumb-pipe paths unaffected (urlOnly never triggers the gate).
- `tests/daily-digest.test.js` — ledger `gate` lane; `tests/digest-email.test.js` — program history line + new-round note rendering.
- Backfill: pure helpers unit-tested (clustering, cycle-safe chain walk with the real cycle fixture ids); the script itself is manual-run with a `--dry-run` mode printing the plan.
- Full `npm test` green, `tsc` bare exit 0.

## 9. Rollout

PR → merge → deploy (gate live immediately for scan/feed/agent lanes) → `railway run` backfill with `--dry-run` review, then live run → verify: queue history lines appear, `gate` lane appears in the next digest, decided-recheck load drops. The first digest after backfill will show program history on every card that has priors — that's the "what does this tell me" answer becoming permanent.
