# CRM Enrichment Phase 1 — Link Digest Orgs + Revive Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Source orgs from tele-sum digest content (repos/models/claw) into `org_profiles` behind an auto-create quality bar, link each digest item to its org, and revive + schedule the dormant SimpleCRM Notion sync so all orgs (grant + digest) stay current in `Sov's Orgs`.

**Architecture:** All in wire-room-ops (TypeScript/Express/pg, tests via `node:test` + `ts-node/register/transpile-only`, tables created via `CREATE TABLE IF NOT EXISTS` ensure-functions — NOT alembic). Reuse existing functions: `upsertOrgProfile`/`findSimilarOrg`/`linkEntryToOrg` (`src/services/org-extractor.ts`), `syncOrgsToNotion`/`getIntegrationConfigs` (`src/services/notion-sync.ts`). Add a digest-org sourcing path that reads tele-sum's `summaries` (the same shared Postgres, same read pattern as `summary-sync.ts`), plus cron + admin-endpoint triggers mirroring the existing pattern.

**Tech Stack:** Node/TypeScript, `pg`, `node-cron`, `node:test`. Shared Postgres (tele-sum `summaries` + wire-room-ops `org_profiles`). Notion REST `2022-06-28`.

**Spec:** `docs/superpowers/specs/2026-06-13-crm-org-contact-enrichment-design.md`.

**Repo mechanics:** wire-room-ops IS a git repo at `/Users/home/Documents/Sovereign Signal/repos/wire-room-ops`; work in place, commit to `main`, push deploys it (Railway project `17165452-…`). Run tests with `npm test` (node:test) and `npm run typecheck`. Shared DB URL: `cat /tmp/telesum_dburl.txt` (gondola.proxy.rlwy.net — same instance wire-room-ops uses). The SimpleCRM integration is row `provider='notion', name='SimpleCRM - Notion'` in `integration_config` (verified token valid 2026-06-13, integration "Wire Room Ops", access to both CRM DBs).

**Verified facts (do not re-litigate):**
- `upsertOrgProfile(orgName: string, wire: string, date?: string): Promise<number>` — INSERTs into `org_profiles (name, slug, wires, first_seen, last_seen, entry_count)` with ON CONFLICT update; returns the org id. Reusable for digest orgs (pass the digest wire).
- `findSimilarOrg(candidateName: string): Promise<{ id: number; name: string } | null>` — normalized-exact + alias + fuzzy match against existing `org_profiles`.
- `syncOrgsToNotion(integrationId: number)` — reads ALL `org_profiles`, upserts to `Sov's Orgs` by Name; `buildOrgProperties` already maps `Wire`/`Items Sourced`(=entry_count)/`Last Checked`(=last_seen)/etc. Digest orgs flow automatically once in `org_profiles`.
- tele-sum digest summaries: `summaries.entities->>'profile' = 'digest'`, items at `summaries.entities->'items'` (each `{title,url,note,category,tags,org}`), wire on `messages.wire IN ('repos','models','claw')`.

---

### Task 0: Branch + baseline

**Files:** none

- [ ] **Step 1: Create a feature branch**

```bash
cd "/Users/home/Documents/Sovereign Signal/repos/wire-room-ops" && git checkout main && git pull --ff-only && git checkout -b crm-phase1-digest-orgs
```

- [ ] **Step 2: Baseline green**

Run: `npm run typecheck && npm test 2>&1 | grep -E "ℹ (tests|pass|fail)"`
Expected: typecheck clean; all tests pass, `fail 0`. Record the pass count.

---

### Task 1: Quality bar — `qualifiesAsDigestOrg` (pure function)

**Files:**
- Create: `src/services/digest-orgs.ts`
- Test: `tests/digest-orgs.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/digest-orgs.test.js`:

```js
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { qualifiesAsDigestOrg, normalizeDigestOrg } = require('../src/services/digest-orgs');

test('rejects bare owner/repo handles', () => {
  assert.equal(qualifiesAsDigestOrg('crafter-station/petdex', { mentionCount: 5, hasLink: true }), false);
  assert.equal(qualifiesAsDigestOrg('orhun', { mentionCount: 1, hasLink: true }), false);
});

test('accepts a named org with >=2 mentions', () => {
  assert.equal(qualifiesAsDigestOrg('Anthropic', { mentionCount: 2, hasLink: false }), true);
});

test('accepts a named org with a resolvable link even at 1 mention', () => {
  assert.equal(qualifiesAsDigestOrg('MiniMax', { mentionCount: 1, hasLink: true }), true);
});

test('rejects a single-mention org with no link', () => {
  assert.equal(qualifiesAsDigestOrg('SomeStartup', { mentionCount: 1, hasLink: false }), false);
});

test('rejects empty/whitespace/junk', () => {
  assert.equal(qualifiesAsDigestOrg('', { mentionCount: 9, hasLink: true }), false);
  assert.equal(qualifiesAsDigestOrg('   ', { mentionCount: 9, hasLink: true }), false);
});

test('normalizeDigestOrg trims and collapses whitespace', () => {
  assert.equal(normalizeDigestOrg('  Anthropic  '), 'Anthropic');
  assert.equal(normalizeDigestOrg('huggingface-org'), 'huggingface-org');
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `node --test tests/digest-orgs.test.js`
Expected: FAIL — cannot find module `../src/services/digest-orgs`.

- [ ] **Step 3: Implement the pure functions**

Create `src/services/digest-orgs.ts`:

```typescript
/**
 * Sourcing orgs from tele-sum digest content (repos/models/claw) into org_profiles.
 * Pure helpers here; DB-touching runner is sourceDigestOrgs() below.
 */

export function normalizeDigestOrg(raw: string | null | undefined): string {
  return (raw || '').replace(/\s+/g, ' ').trim();
}

/**
 * Auto-create quality bar. A digest org mention becomes a CRM org only if it is a
 * real organization (not an incidental owner/repo handle) AND has enough signal:
 * >=2 distinct mentions, or a resolvable link from the content.
 */
export function qualifiesAsDigestOrg(
  rawName: string,
  signal: { mentionCount: number; hasLink: boolean },
): boolean {
  const name = normalizeDigestOrg(rawName);
  if (!name) return false;
  if (name.includes('/')) return false;       // owner/repo handle, not an org
  if (name.length < 2) return false;
  return signal.mentionCount >= 2 || signal.hasLink === true;
}
```

- [ ] **Step 4: Run it, watch it pass**

Run: `node --test tests/digest-orgs.test.js`
Expected: 6 pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/digest-orgs.ts tests/digest-orgs.test.js && git -c user.name="SovereignSignal" -c user.email="sov@sovereignsignal.com" commit -m "digest-orgs: auto-create quality bar (pure)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `digest_item_orgs` link table + `linkDigestItemToOrg`

**Files:**
- Modify: `src/services/digest-orgs.ts`
- Test: `tests/digest-orgs-link.test.js`

- [ ] **Step 1: Write the failing test** (stubbed pool — assert the SQL shape, mirroring `tests/dedup.test.js` stub style)

Create `tests/digest-orgs-link.test.js`:

```js
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureDigestItemOrgsTable, linkDigestItemToOrg } = require('../src/services/digest-orgs');

function stubPool() {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
}

test('ensureDigestItemOrgsTable creates table with unique (summary_id,item_index,org_id)', async () => {
  const pool = stubPool();
  await ensureDigestItemOrgsTable(pool);
  const sql = pool.calls[0].sql;
  assert.match(sql, /CREATE TABLE IF NOT EXISTS digest_item_orgs/);
  assert.match(sql, /UNIQUE\s*\(\s*summary_id\s*,\s*item_index\s*,\s*org_id\s*\)/);
});

test('linkDigestItemToOrg upserts idempotently (ON CONFLICT DO NOTHING)', async () => {
  const pool = stubPool();
  await linkDigestItemToOrg(pool, 4159, 0, 77);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /INSERT INTO digest_item_orgs/);
  assert.match(sql, /ON CONFLICT .* DO NOTHING/);
  assert.deepEqual(params, [4159, 0, 77]);
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `node --test tests/digest-orgs-link.test.js`
Expected: FAIL — `ensureDigestItemOrgsTable` is not a function.

- [ ] **Step 3: Implement**

Append to `src/services/digest-orgs.ts`:

```typescript
import type { Pool } from 'pg';

export async function ensureDigestItemOrgsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS digest_item_orgs (
      id SERIAL PRIMARY KEY,
      summary_id INTEGER NOT NULL,
      item_index INTEGER NOT NULL,
      org_id INTEGER NOT NULL REFERENCES org_profiles(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (summary_id, item_index, org_id)
    )
  `);
}

export async function linkDigestItemToOrg(
  pool: Pool, summaryId: number, itemIndex: number, orgId: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO digest_item_orgs (summary_id, item_index, org_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (summary_id, item_index, org_id) DO NOTHING`,
    [summaryId, itemIndex, orgId],
  );
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `node --test tests/digest-orgs-link.test.js && npm run typecheck`
Expected: 2 pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/digest-orgs.ts tests/digest-orgs-link.test.js && git -c user.name="SovereignSignal" -c user.email="sov@sovereignsignal.com" commit -m "digest-orgs: digest_item_orgs link table + idempotent link

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `sourceDigestOrgs(pool)` runner

**Files:**
- Modify: `src/services/digest-orgs.ts`
- Test: `tests/digest-orgs-source.test.js`

**Behavior:** read tele-sum digest summaries; aggregate org mentions across items into `Map<normalizedName,{mentionCount,hasLink,occurrences:[{summaryId,itemIndex}]}>`; for each that passes `qualifiesAsDigestOrg`, resolve via `findSimilarOrg` (reuse) else `upsertOrgProfile(name, wire)` (reuse); then `linkDigestItemToOrg` for each occurrence. Returns `{orgsCreatedOrMatched, itemsLinked, skipped}`.

- [ ] **Step 1: Write the failing test** (inject the reused fns + a stub pool so it's unit-testable)

Create `tests/digest-orgs-source.test.js`:

```js
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateDigestOrgMentions } = require('../src/services/digest-orgs');

test('aggregateDigestOrgMentions counts distinct mentions and link presence', () => {
  const summaries = [
    { id: 1, wire: 'models', items: [
      { org: 'Anthropic', url: 'https://anthropic.com' },
      { org: 'Anthropic', url: null },
      { org: 'crafter-station/petdex', url: 'https://github.com/crafter-station/petdex' },
      { org: '', url: null },
    ]},
    { id: 2, wire: 'models', items: [ { org: 'Anthropic', url: null } ] },
  ];
  const agg = aggregateDigestOrgMentions(summaries);
  const anthropic = agg.get('Anthropic');
  assert.equal(anthropic.mentionCount, 3);
  assert.equal(anthropic.hasLink, true);
  assert.deepEqual(anthropic.occurrences, [
    { summaryId: 1, itemIndex: 0, wire: 'models' },
    { summaryId: 1, itemIndex: 1, wire: 'models' },
    { summaryId: 2, itemIndex: 0, wire: 'models' },
  ]);
  // handle still aggregated (filtering happens at qualify step, not here)
  assert.equal(agg.get('crafter-station/petdex').mentionCount, 1);
  // empty org name dropped
  assert.equal(agg.has(''), false);
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `node --test tests/digest-orgs-source.test.js`
Expected: FAIL — `aggregateDigestOrgMentions` is not a function.

- [ ] **Step 3: Implement aggregation (pure) + the DB runner**

Append to `src/services/digest-orgs.ts`:

```typescript
import { findSimilarOrg, upsertOrgProfile } from './org-extractor';

export interface DigestOrgOccurrence { summaryId: number; itemIndex: number; wire: string; }
export interface DigestOrgAgg { mentionCount: number; hasLink: boolean; occurrences: DigestOrgOccurrence[]; }

/** Pure: roll up org mentions across digest summaries. Keyed by normalized name. */
export function aggregateDigestOrgMentions(
  summaries: Array<{ id: number; wire: string; items: Array<{ org?: string | null; url?: string | null }> }>,
): Map<string, DigestOrgAgg> {
  const agg = new Map<string, DigestOrgAgg>();
  for (const s of summaries) {
    (s.items || []).forEach((item, idx) => {
      const name = normalizeDigestOrg(item.org);
      if (!name) return;
      const cur = agg.get(name) || { mentionCount: 0, hasLink: false, occurrences: [] };
      cur.mentionCount += 1;
      if (item.url) cur.hasLink = true;
      cur.occurrences.push({ summaryId: s.id, itemIndex: idx, wire: s.wire });
      agg.set(name, cur);
    });
  }
  return agg;
}

/** Read recent tele-sum digest summaries from the shared DB. */
export async function loadDigestSummaries(pool: Pool, lookbackDays = 30): Promise<Array<{ id: number; wire: string; items: any[] }>> {
  const { rows } = await pool.query(
    `SELECT s.id, m.wire, s.entities->'items' AS items
     FROM summaries s JOIN messages m ON m.id = s.message_id
     WHERE s.processing_status = 'SUCCESS'
       AND s.entities->>'profile' = 'digest'
       AND m.wire IN ('repos','models','claw')
       AND s.created_at >= NOW() - INTERVAL '1 day' * $1`,
    [lookbackDays],
  );
  return rows.map((r: any) => ({ id: r.id, wire: r.wire, items: Array.isArray(r.items) ? r.items : [] }));
}

export async function sourceDigestOrgs(
  pool: Pool, lookbackDays = 30,
): Promise<{ orgsTouched: number; itemsLinked: number; skipped: number }> {
  await ensureDigestItemOrgsTable(pool);
  const summaries = await loadDigestSummaries(pool, lookbackDays);
  const agg = aggregateDigestOrgMentions(summaries);
  let orgsTouched = 0, itemsLinked = 0, skipped = 0;
  for (const [name, info] of agg.entries()) {
    if (!qualifiesAsDigestOrg(name, { mentionCount: info.mentionCount, hasLink: info.hasLink })) {
      skipped += 1; continue;
    }
    const wire = info.occurrences[0]?.wire || 'models';
    const match = await findSimilarOrg(name);
    const orgId = match ? match.id : await upsertOrgProfile(name, wire);
    if (!match) {
      // ensure wire recorded even when matched to an existing row created from another wire
      await pool.query(
        `UPDATE org_profiles SET wires = (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(wires,'{}') || $2::text))), last_seen = CURRENT_DATE WHERE id = $1`,
        [orgId, wire],
      );
    } else {
      await pool.query(
        `UPDATE org_profiles SET wires = (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(wires,'{}') || $2::text))), last_seen = CURRENT_DATE WHERE id = $1`,
        [orgId, wire],
      );
    }
    orgsTouched += 1;
    for (const occ of info.occurrences) {
      await linkDigestItemToOrg(pool, occ.summaryId, occ.itemIndex, orgId);
      itemsLinked += 1;
    }
  }
  console.log(`[DigestOrgs] orgs touched=${orgsTouched} itemsLinked=${itemsLinked} skipped=${skipped}`);
  return { orgsTouched, itemsLinked, skipped };
}
```

(The two UPDATE branches are identical on purpose for clarity now; the engineer MAY collapse them — behavior must stay: dedupe `wires` and bump `last_seen`.)

- [ ] **Step 4: Run tests + typecheck**

Run: `node --test tests/digest-orgs-source.test.js && npm run typecheck`
Expected: 1 pass; typecheck clean. (The pure `aggregateDigestOrgMentions` is unit-tested; the DB runner is exercised in Task 5 backfill against the real DB.)

- [ ] **Step 5: Commit**

```bash
git add src/services/digest-orgs.ts tests/digest-orgs-source.test.js && git -c user.name="SovereignSignal" -c user.email="sov@sovereignsignal.com" commit -m "digest-orgs: aggregate mentions + sourceDigestOrgs runner

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Admin endpoints + cron schedule

**Files:**
- Modify: `src/routes/admin.ts` (add two endpoints, mirroring existing `/api/admin/*` handlers)
- Modify: wherever `syncSummariesToScanEntries` is registered on an interval (find it: `grep -rn "syncSummariesToScanEntries" src/` → that file shows the cron/interval registration pattern to mirror)

- [ ] **Step 1: Locate the scheduling pattern**

Run: `grep -rn "syncSummariesToScanEntries\|cron.schedule\|SummarySync" src/` from the repo root.
Expected: find the interval/cron registration (e.g. in `src/server.ts` or a scheduler init). Note the exact idiom used (node-cron `cron.schedule('*/15 * * * *', ...)` or `setInterval`).

- [ ] **Step 2: Add admin endpoints (manual triggers)**

In `src/routes/admin.ts`, following the existing `/api/admin/*` handler style (rate-limited, internal-auth), add:

```typescript
// POST /api/admin/source-digest-orgs — extract+link digest orgs into org_profiles
router.post('/source-digest-orgs', async (_req, res) => {
  try {
    const { sourceDigestOrgs } = await import('../services/digest-orgs');
    const result = await sourceDigestOrgs(getPool());
    res.json({ success: true, ...result });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/admin/sync-crm — push org_profiles to the SimpleCRM Notion DB
router.post('/sync-crm', async (_req, res) => {
  try {
    const { getIntegrationConfigs, syncOrgsToNotion } = await import('../services/notion-sync');
    const [crm] = (await getIntegrationConfigs('notion')).filter(i => i.name === 'SimpleCRM - Notion' && i.enabled);
    if (!crm) return res.status(404).json({ success: false, error: 'SimpleCRM integration not found/enabled' });
    const result = await syncOrgsToNotion(crm.id);
    res.json({ success: true, ...result });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});
```

(Match the file's actual import for `getPool` and its router/auth middleware — read the top of `admin.ts` first.)

- [ ] **Step 3: Register the cron jobs**

In the same place `syncSummariesToScanEntries` is scheduled, add (mirror its idiom; run digest-org sourcing every 30 min, CRM sync every 60 min, offset so sourcing runs first):

```typescript
// Source digest orgs from tele-sum content, then keep the CRM current.
cron.schedule('*/30 * * * *', async () => {
  try {
    const { sourceDigestOrgs } = await import('./services/digest-orgs');
    await sourceDigestOrgs(getPool());
  } catch (e) { console.error('[DigestOrgs] scheduled run failed:', e); }
});
cron.schedule('15 * * * *', async () => {
  try {
    const { getIntegrationConfigs, syncOrgsToNotion } = await import('./services/notion-sync');
    const [crm] = (await getIntegrationConfigs('notion')).filter(i => i.name === 'SimpleCRM - Notion' && i.enabled);
    if (crm) await syncOrgsToNotion(crm.id);
  } catch (e) { console.error('[CRMSync] scheduled run failed:', e); }
});
```

(Use the exact import paths relative to the file you edit. If that file uses `setInterval` instead of node-cron, mirror that instead.)

- [ ] **Step 4: Typecheck + full test suite**

Run: `npm run typecheck && npm test 2>&1 | grep -E "ℹ (tests|pass|fail)"`
Expected: typecheck clean; all tests pass (baseline + 9 new across Tasks 1–3), `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin.ts src/server.ts && git -c user.name="SovereignSignal" -c user.email="sov@sovereignsignal.com" commit -m "crm: admin triggers + cron for digest-org sourcing and CRM sync

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
(Adjust the staged file list to whatever you actually edited for the cron registration.)

---

### Task 5: Deploy, backfill, and verify

**Files:** none (ops)

- [ ] **Step 1: Merge + push (deploys)**

```bash
cd "/Users/home/Documents/Sovereign Signal/repos/wire-room-ops" && git checkout main && git merge --no-ff crm-phase1-digest-orgs -m "CRM Phase 1: digest-org sourcing + revived CRM sync" && git push origin main
```

- [ ] **Step 2: Watch deploy to SUCCESS + health**

Run (background): `/Users/home/.claude/skills/railway-ops/scripts/watch-deploy.sh 17165452-9a41-4abf-b350-a3c0cf492623 5cc01564-4e3d-4e57-8423-949e9544c595 d0d4c7f4-dea9-4cab-ba8c-ec7363f0470e`
Expected: `FINAL=SUCCESS`, then `curl -s -o /dev/null -w "%{http_code}" https://wire-room-ops-production.up.railway.app/health` → `200`.

- [ ] **Step 3: Backfill — source digest orgs from the already-ingested 103 items**

```bash
curl -s -X POST https://wire-room-ops-production.up.railway.app/api/admin/source-digest-orgs | jq .
```
Expected: `{success:true, orgsTouched:N, itemsLinked:M, skipped:K}` with N≥10 (Anthropic, Google, NVIDIA, MiniMax, DeepSeek, OpenAI, …). Verify in DB:
```bash
DBURL=$(cat /tmp/telesum_dburl.txt); psql "$DBURL" -c "SELECT count(*) FROM digest_item_orgs;" -c "SELECT name, wires, entry_count FROM org_profiles WHERE 'models'=ANY(wires) OR 'claw'=ANY(wires) OR 'repos'=ANY(wires) ORDER BY entry_count DESC LIMIT 15;"
```

- [ ] **Step 4: Revive the CRM sync**

```bash
curl -s -X POST https://wire-room-ops-production.up.railway.app/api/admin/sync-crm | jq .
```
Expected: `{success:true, created:>0, updated:>=0, errors:0}`. Then confirm digest orgs now appear in `Sov's Orgs`:
```bash
DBURL=$(cat /tmp/telesum_dburl.txt); TK=$(psql "$DBURL" -tA -c "SELECT config->>'notion_token' FROM integration_config WHERE name='SimpleCRM - Notion';")
curl -s -X POST "https://api.notion.com/v1/databases/301000c0-d590-81c4-8435-c6db7782db12/query" -H "Authorization: Bearer $TK" -H "Notion-Version: 2022-06-28" -H "Content-Type: application/json" -d '{"filter":{"property":"Wire","multi_select":{"contains":"Models"}},"page_size":5}' | jq -r '.results[].properties.Name.title[0].plain_text'
```
Expected: AI-lab org names (Anthropic, Google, …) with the Models wire.

- [ ] **Step 5: Confirm sync status + no grant regression**

```bash
DBURL=$(cat /tmp/telesum_dburl.txt); psql "$DBURL" -c "SELECT last_sync_at, last_sync_status, last_sync_message FROM integration_config WHERE name='SimpleCRM - Notion';"
```
Expected: `last_sync_at` is now (today), status success. Spot-check that an existing grant org (e.g. one created earlier) still has its grant data intact in `Sov's Orgs` (no overwrite of curated fields beyond the mapped ones).

---

## Self-review (done at write time)

- **Spec coverage:** digest org sourcing (T1–T3) · quality bar rejecting handles + ≥2-mentions/link (T1) · `digest_item_orgs` link table (T2) · entry_count/wires/last_seen upkeep (T3) · revive + schedule sync (T4) · backfill + CRM verification (T5). Field mapping (Wire/Items Sourced/Last Checked) is handled by the existing `buildOrgProperties` — no new mapping code, confirmed in spec. ✓
- **Placeholders:** Task 4 intentionally instructs locating the exact scheduling idiom via grep (the repo's scheduler is config/cron-driven and the precise call site must be matched, not guessed) — the code to add is fully specified; only the host file/idiom is discovered. Not a vague requirement. ✓
- **Type consistency:** `qualifiesAsDigestOrg(name, {mentionCount,hasLink})`, `normalizeDigestOrg`, `aggregateDigestOrgMentions` → `Map<string,{mentionCount,hasLink,occurrences}>`, `sourceDigestOrgs(pool,lookbackDays)`, `linkDigestItemToOrg(pool,summaryId,itemIndex,orgId)`, reused `upsertOrgProfile(name,wire)`/`findSimilarOrg(name)`/`syncOrgsToNotion(id)` — names consistent across tasks and match the verified existing signatures. ✓

## Deferred to Phase 2/3 (not in this plan)

- Web enrichment of org fields (`github_url` column add, description/twitter/last_signal). 
- Contacts discovery + the `Contacts` DB sync.
- Backfilling `org_weekly_snapshots` from digest activity.
