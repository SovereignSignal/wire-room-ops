# Run Ledger Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the daily digest email as an operator's cockpit (never-repeat review items + run-ledger trust band + folded deadline digest) per `docs/superpowers/specs/2026-07-09-run-ledger-digest-design.md`.

**Architecture:** A watermark in `app_state` guarantees an entry is emailed at most once; a `RunLedger` assembled from durable evidence (`api_usage_log`, `app_state` watermarks, just-ran fold results) drives a green/amber status band; one shared `assembleAndSendDailyDigest()` serves both the scheduler fold and the dashboard send-now button; the standalone deadline email is retired and its data folds in as "Closing soon".

**Tech Stack:** Node.js/TypeScript, Express, Postgres (`pg`), Resend, `node:test` with ts-node transpile-only, React/Vite client.

## Global Constraints

- Baseline is the current working tree on branch `codex/digest-email-refresh` (Codex WIP changes to `src/jobs/daily-digest.ts`, `src/services/email.ts`, `tests/digest-email.test.js` are the starting point; `tests/daily-digest.test.js` exists untracked and gets fully replaced). Baseline `npm test` = 182 pass.
- `renderDailyDigest()` stays a pure function; `extras.anomalies` remains the ONLY channel for ops telemetry into the email.
- Never pipe `tsc` through `head`/`grep` in a chain — run `npm run typecheck` bare and read its exit code (owner rule).
- `tests/enum-lockstep.test.js` regex-pins formatting: `STARTUP_MIGRATIONS` entries must keep the exact `{ name: 'kebab', run: ensureFn }` shape; `sqlEnumList(SCHEDULE_TYPES)` must appear ≥2 times in `src/db/index.ts`; the schedules route must keep `SCHEDULE_TYPES as readonly string[]).includes(scheduleType)`.
- Tests import via `require('ts-node/register/transpile-only')` and `node --test tests/**/*.test.js`.
- No new crons, no new schedule types (owner rule: fold, don't multiply).
- Commit after every task with a conventional message ending in the Claude co-author trailer.

## File Structure

- `src/jobs/daily-digest.ts` — gains watermark helpers, `getFreshFinds`, `buildRunLedger`, `assembleAndSendDailyDigest`; loses `getTopPendingFinds` (Task 4).
- `src/services/email.ts` — `TopFindEntry` extended; new `RunLedger`/`ClosingSoonRow` types; `renderDailyDigest` rewritten; `sendDeadlineDigestEmail` deleted (Task 5).
- `src/services/scheduler.ts` — daily-digest branch calls the shared assembly; CSV export moves after the email; deadline-digest branch deleted.
- `src/routes/schedules.ts` — send-now uses the shared assembly.
- `src/types/intake.ts` + `src/db/index.ts` + `tests/enum-lockstep.test.js` — `deadline-digest` retirement.
- `src/routes/scan-entries.ts` — new `GET /entries/:id`.
- `client/src/api/index.ts` + `client/src/pages/Index.tsx` — `fetchEntry` + deep-link effect.
- `tests/daily-digest.test.js` (replace), `tests/digest-email.test.js` (rewrite).

---

### Task 1: Watermark data layer + fresh-finds query

**Files:**
- Modify: `src/jobs/daily-digest.ts`
- Modify: `src/services/email.ts` (TopFindEntry only)
- Test: `tests/daily-digest.test.js` (replace entire file)

**Interfaces:**
- Consumes: `getAppState<T>(key): Promise<T|null>` / `setAppState(key, value): Promise<void>` from `src/db` (app_state jsonb KV).
- Produces (Task 4 relies on these exact names):
  - `DIGEST_WATERMARK_KEY = 'digest:emailed-ids'`
  - `type EmailedIdsMap = Record<string, string>`
  - `pruneEmailedIds(map: EmailedIdsMap, now?: Date, maxAgeDays?: number): EmailedIdsMap`
  - `getFreshFinds(pool: Pool, limit?: number, deps?: { getAppState; setAppState }): Promise<FreshFindsResult>` where `FreshFindsResult = { finds: TopFindEntry[]; totalNew: number; seeded: boolean; fallback: boolean }`
  - `advanceDigestWatermark(ids: number[], deps?, now?: Date): Promise<void>`
  - `TopFindEntry` (in email.ts) gains `id: number`, `curator_route: string | null`, `curator_confidence: string | null`; `quality_score` becomes `number | null`.

- [ ] **Step 1: Extend `TopFindEntry` in `src/services/email.ts`**

Replace the existing interface (lines ~333-340) with:

```ts
export interface TopFindEntry {
  id: number;
  name: string;
  wire: string;
  quality_score: number | null;
  amount: string | null;
  deadline: string | null;
  source_url: string | null;
  curator_route: string | null;
  curator_confidence: string | null;
}
```

To keep the tree compiling until Task 4 removes it, also add the new columns to the existing `getTopPendingFinds` SELECT in `src/jobs/daily-digest.ts`:

```sql
SELECT id, name, wire, quality_score, amount, deadline, source_url,
       metadata->'curator'->>'route' AS curator_route,
       metadata->'curator'->>'confidence' AS curator_confidence
```

(and widen its inline row generic to match). The Codex-era test file `tests/daily-digest.test.js` pins the old SELECT — it is replaced in Step 2, so update both in the same commit.

- [ ] **Step 2: Replace `tests/daily-digest.test.js` with the watermark tests (failing)**

```js
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getFreshFinds, advanceDigestWatermark, pruneEmailedIds, DIGEST_WATERMARK_KEY,
} = require('../src/jobs/daily-digest');

function fakePool() {
  const calls = [];
  const responses = [];
  return {
    calls,
    queueResponse(rows) { responses.push({ rows }); },
    async query(sql, params) {
      calls.push({ sql, params });
      return responses.shift() ?? { rows: [] };
    },
  };
}

function fakeState(initial) {
  const store = new Map(Object.entries(initial ?? {}));
  return {
    store,
    deps: {
      async getAppState(key) { return store.has(key) ? store.get(key) : null; },
      async setAppState(key, value) { store.set(key, value); },
    },
  };
}

const DAY = 24 * 60 * 60 * 1000;

test('pruneEmailedIds drops entries older than 60 days and malformed dates', () => {
  const now = new Date('2026-07-09T00:00:00Z');
  const map = {
    '1': new Date(now.getTime() - 59 * DAY).toISOString(),
    '2': new Date(now.getTime() - 61 * DAY).toISOString(),
    '3': 'not-a-date',
  };
  const pruned = pruneEmailedIds(map, now);
  assert.deepEqual(Object.keys(pruned), ['1']);
});

test('getFreshFinds excludes watermarked ids, keeps curator ordering, and has NO 24h window', async () => {
  const pool = fakePool();
  pool.queueResponse([]); // finds
  pool.queueResponse([{ total_new: '0' }]); // count
  const { deps } = fakeState({ [DIGEST_WATERMARK_KEY]: { '7': '2026-07-01T00:00:00Z' } });

  const res = await getFreshFinds(pool, 8, deps);

  const findsSql = pool.calls[0].sql;
  assert.match(findsSql, /status = 'queued'/);
  assert.match(findsSql, /NOT \(id = ANY\(\$2::int\[\]\)\)/);
  assert.match(findsSql, /deadline_parsed IS NULL OR deadline_parsed >= CURRENT_DATE/);
  assert.match(findsSql, /metadata->'curator'->>'route'/);
  assert.match(findsSql, /quality_score DESC NULLS LAST/);
  assert.ok(!findsSql.includes('24 hours'), 'watermark replaces the 24h window');
  assert.deepEqual(pool.calls[0].params, [8, [7]]);
  assert.equal(res.seeded, false);
  assert.equal(res.fallback, false);
});

test('getFreshFinds first run seeds the watermark with all queued ids and surfaces nothing', async () => {
  const pool = fakePool();
  pool.queueResponse([{ id: 4 }, { id: 9 }]); // seed SELECT id
  const { deps, store } = fakeState({});

  const res = await getFreshFinds(pool, 8, deps);

  assert.equal(res.seeded, true);
  assert.deepEqual(res.finds, []);
  assert.equal(res.totalNew, 0);
  const saved = store.get(DIGEST_WATERMARK_KEY);
  assert.deepEqual(Object.keys(saved).sort(), ['4', '9']);
});

test('getFreshFinds falls back to a 24h window when the watermark read throws', async () => {
  const pool = fakePool();
  pool.queueResponse([{ id: 1, name: 'X', wire: 'ai', quality_score: 90, amount: null, deadline: null, source_url: null, curator_route: null, curator_confidence: null }]);
  const deps = {
    async getAppState() { throw new Error('boom'); },
    async setAppState() { throw new Error('must not write'); },
  };

  const res = await getFreshFinds(pool, 8, deps);

  assert.equal(res.fallback, true);
  assert.match(pool.calls[0].sql, /24 hours/);
  assert.equal(res.finds.length, 1);
});

test('advanceDigestWatermark merges shown ids, prunes old ones, and no-ops on empty', async () => {
  const now = new Date('2026-07-09T00:00:00Z');
  const old = new Date(now.getTime() - 61 * DAY).toISOString();
  const { deps, store } = fakeState({ [DIGEST_WATERMARK_KEY]: { '1': old, '2': now.toISOString() } });

  await advanceDigestWatermark([5, 6], deps, now);
  const saved = store.get(DIGEST_WATERMARK_KEY);
  assert.deepEqual(Object.keys(saved).sort(), ['2', '5', '6']);

  store.clear();
  await advanceDigestWatermark([], deps, now);
  assert.equal(store.size, 0, 'empty ids must not touch app_state');
});
```

- [ ] **Step 3: Run to verify failure** — `node --test tests/daily-digest.test.js` → FAIL (`getFreshFinds is not a function`).

- [ ] **Step 4: Implement in `src/jobs/daily-digest.ts`**

Add `import { getAppState, setAppState } from '../db';` at the top (next to the `Pool` import), then append:

```ts
// ── Digest email watermark ─────────────────────────────────────────────────
// An entry is emailed by the digest AT MOST ONCE, ever. The watermark is a
// forward-only map in app_state; it advances only after a successful send
// (same pattern as the BD roles lane), so a failed email never swallows items.

export const DIGEST_WATERMARK_KEY = 'digest:emailed-ids';
const WATERMARK_MAX_AGE_DAYS = 60;

/** entryId -> ISO timestamp of the digest that emailed it */
export type EmailedIdsMap = Record<string, string>;

export interface WatermarkDeps {
  getAppState: typeof getAppState;
  setAppState: typeof setAppState;
}
const defaultWatermarkDeps: WatermarkDeps = { getAppState, setAppState };

export function pruneEmailedIds(map: EmailedIdsMap, now = new Date(), maxAgeDays = WATERMARK_MAX_AGE_DAYS): EmailedIdsMap {
  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
  const out: EmailedIdsMap = {};
  for (const [id, iso] of Object.entries(map)) {
    const t = Date.parse(iso);
    if (!Number.isNaN(t) && t >= cutoff) out[id] = iso;
  }
  return out;
}

export interface FreshFindsResult {
  finds: TopFindEntry[];
  totalNew: number;   // all eligible never-emailed items (finds is the top slice)
  seeded: boolean;    // first run: watermark initialized, nothing surfaced
  fallback: boolean;  // watermark unreadable: 24h window used instead
}

const FRESH_FINDS_SELECT = `
  SELECT id, name, wire, quality_score, amount, deadline, source_url,
         metadata->'curator'->>'route' AS curator_route,
         metadata->'curator'->>'confidence' AS curator_confidence
  FROM scan_entries
  WHERE status = 'queued'
    AND (deadline_parsed IS NULL OR deadline_parsed >= CURRENT_DATE)`;

const CURATOR_ORDER = `
  ORDER BY
    CASE metadata->'curator'->>'route'
      WHEN 'publish' THEN 0
      WHEN 'source_check' THEN 1
      WHEN 'relationship_signal' THEN 2
      WHEN 'park' THEN 3
      WHEN 'decline' THEN 4
      ELSE 5
    END,
    CASE metadata->'curator'->>'confidence'
      WHEN 'high' THEN 0
      WHEN 'med' THEN 1
      WHEN 'low' THEN 2
      ELSE 3
    END,
    quality_score DESC NULLS LAST,
    deadline_parsed ASC NULLS LAST,
    created_at DESC`;

export async function getFreshFinds(pool: Pool, limit = 8, deps: WatermarkDeps = defaultWatermarkDeps): Promise<FreshFindsResult> {
  let map: EmailedIdsMap | null;
  try {
    map = await deps.getAppState<EmailedIdsMap>(DIGEST_WATERMARK_KEY);
  } catch (err) {
    console.error('[DailyDigest] Watermark read failed — falling back to 24h window:', err instanceof Error ? err.message : err);
    const { rows } = await pool.query<TopFindEntry>(
      `${FRESH_FINDS_SELECT}
        AND created_at >= NOW() - INTERVAL '24 hours'
      ${CURATOR_ORDER}
      LIMIT $1`, [limit]);
    return { finds: rows, totalNew: rows.length, seeded: false, fallback: true };
  }

  if (map === null) {
    const { rows } = await pool.query<{ id: number }>(`SELECT id FROM scan_entries WHERE status = 'queued'`);
    const nowIso = new Date().toISOString();
    const seeded: EmailedIdsMap = {};
    for (const r of rows) seeded[String(r.id)] = nowIso;
    await deps.setAppState(DIGEST_WATERMARK_KEY, seeded);
    console.log(`[DailyDigest] Watermark seeded with ${rows.length} queued entries (forward-only start)`);
    return { finds: [], totalNew: 0, seeded: true, fallback: false };
  }

  const excluded = Object.keys(map).map(Number).filter(Number.isInteger);
  const { rows } = await pool.query<TopFindEntry>(
    `${FRESH_FINDS_SELECT}
      AND NOT (id = ANY($2::int[]))
    ${CURATOR_ORDER}
    LIMIT $1`, [limit, excluded]);
  const count = await pool.query<{ total_new: string }>(
    `SELECT COUNT(*) AS total_new
     FROM scan_entries
     WHERE status = 'queued'
       AND (deadline_parsed IS NULL OR deadline_parsed >= CURRENT_DATE)
       AND NOT (id = ANY($1::int[]))`, [excluded]);
  return { finds: rows, totalNew: parseInt(count.rows[0]?.total_new ?? '0', 10), seeded: false, fallback: false };
}

export async function advanceDigestWatermark(ids: number[], deps: WatermarkDeps = defaultWatermarkDeps, now = new Date()): Promise<void> {
  if (ids.length === 0) return;
  let map: EmailedIdsMap = {};
  try {
    map = (await deps.getAppState<EmailedIdsMap>(DIGEST_WATERMARK_KEY)) ?? {};
  } catch {
    // Unreadable map: start fresh — worst case an old item repeats once.
  }
  const iso = now.toISOString();
  for (const id of ids) map[String(id)] = iso;
  await deps.setAppState(DIGEST_WATERMARK_KEY, pruneEmailedIds(map, now));
}
```

- [ ] **Step 5: Run to verify pass** — `node --test tests/daily-digest.test.js` → all pass. Then `npm test` (whole suite green; `tests/digest-email.test.js` still passes because the renderer is untouched) and `npm run typecheck` (exit 0).

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(digest): emailed-ids watermark + fresh-finds query"` (with co-author trailer).

---

### Task 2: Run ledger builder

**Files:**
- Modify: `src/services/email.ts` (types only), `src/jobs/daily-digest.ts`
- Test: `tests/daily-digest.test.js` (append)

**Interfaces:**
- Produces (Tasks 3-4 rely on these exact names):
  - In `email.ts`: `export type LaneState = 'ok' | 'warn' | 'fail';`, `export interface RunLedgerLane { key: string; state: LaneState; detail: string; }`, `export interface RunLedger { lanes: RunLedgerLane[]; }`
  - In `daily-digest.ts`: `buildRunLedger(pool, inputs: RunLedgerInputs, deps?): Promise<{ ledger: RunLedger; anomalies: string[] }>` with `RunLedgerInputs = { date: string; feeds?: { ok: number; total: number } | null; forum?: 'ok' | 'fail' | null }`

- [ ] **Step 1: Write failing tests (append to `tests/daily-digest.test.js`)**

```js
const { buildRunLedger } = require('../src/jobs/daily-digest');

test('buildRunLedger: clean day — scans ok, bridge fresh, agent present, no anomalies', async () => {
  const pool = fakePool();
  pool.queueResponse([{ ok: '41', failed: '0' }]);
  const { deps } = fakeState({
    'summary-sync:watermark': new Date().toISOString(),
    'agent-brief:2026-07-09': { runs: [{}, {}] },
  });

  const { ledger, anomalies } = await buildRunLedger(pool, { date: '2026-07-09', feeds: { ok: 19, total: 19 }, forum: 'ok' }, deps);

  const details = ledger.lanes.map(l => l.detail);
  assert.deepEqual(details, ['scans 41✓', 'feeds 19/19', 'forum ✓', 'bridge ✓', 'agent 2 runs']);
  assert.ok(ledger.lanes.every(l => l.state === 'ok'));
  assert.deepEqual(anomalies, []);
});

test('buildRunLedger: failed scans and stale bridge produce anomalies', async () => {
  const pool = fakePool();
  pool.queueResponse([{ ok: '39', failed: '2' }]);
  const { deps } = fakeState({
    'summary-sync:watermark': new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
  });

  const { ledger, anomalies } = await buildRunLedger(pool, { date: '2026-07-09' }, deps);

  const scans = ledger.lanes.find(l => l.key === 'scans');
  assert.equal(scans.state, 'fail');
  assert.equal(scans.detail, 'scans 39✓ 2✗');
  const bridge = ledger.lanes.find(l => l.key === 'bridge');
  assert.equal(bridge.state, 'warn');
  assert.equal(anomalies.length, 2);
  assert.match(anomalies[0], /2 failed/);
  assert.match(anomalies[1], /stale/);
});

test('buildRunLedger: probe failures degrade to "?" lanes and never throw', async () => {
  const pool = { async query() { throw new Error('db down'); } };
  const deps = { async getAppState() { throw new Error('db down'); }, async setAppState() {} };

  const { ledger, anomalies } = await buildRunLedger(pool, { date: '2026-07-09', feeds: { ok: 17, total: 19 } }, deps);

  assert.equal(ledger.lanes.find(l => l.key === 'scans').detail, 'scans ?');
  assert.equal(ledger.lanes.find(l => l.key === 'feeds').state, 'fail');
  assert.equal(ledger.lanes.find(l => l.key === 'bridge').detail, 'bridge ?');
  assert.deepEqual(anomalies, []);
});
```

- [ ] **Step 2: Run to verify failure** — `node --test tests/daily-digest.test.js` → FAIL (`buildRunLedger is not a function`).

- [ ] **Step 3: Implement**

In `src/services/email.ts`, next to `TopFindEntry`:

```ts
export type LaneState = 'ok' | 'warn' | 'fail';
export interface RunLedgerLane { key: string; state: LaneState; detail: string; }
/** Evidence that the machine ran — rendered inside the digest status band. */
export interface RunLedger { lanes: RunLedgerLane[]; }
```

In `src/jobs/daily-digest.ts` (extend the type-only email import with `RunLedger, RunLedgerLane`):

```ts
export interface RunLedgerInputs {
  date: string;                                  // digest date — the agent-brief app_state key
  feeds?: { ok: number; total: number } | null;  // just-ran fold result; omit on send-now
  forum?: 'ok' | 'fail' | null;                  // null/undefined = lane disabled → omitted
}

/**
 * Assemble the run ledger from durable evidence, never scheduler bookkeeping
 * (in-memory JobStatus resets on restart). Every probe is isolated: a failed
 * probe renders "?" and can never block the digest email.
 */
export async function buildRunLedger(
  pool: Pool,
  inputs: RunLedgerInputs,
  deps: WatermarkDeps = defaultWatermarkDeps,
): Promise<{ ledger: RunLedger; anomalies: string[] }> {
  const lanes: RunLedgerLane[] = [];
  const anomalies: string[] = [];

  // scans — api_usage_log purpose='scan' over 24h (grok/perplexity/parallel all log it)
  try {
    const { rows } = await pool.query<{ ok: string; failed: string }>(`
      SELECT COUNT(*) FILTER (WHERE success) AS ok,
             COUNT(*) FILTER (WHERE NOT success) AS failed
      FROM api_usage_log
      WHERE purpose = 'scan' AND created_at >= NOW() - INTERVAL '24 hours'`);
    const ok = parseInt(rows[0]?.ok ?? '0', 10);
    const failed = parseInt(rows[0]?.failed ?? '0', 10);
    if (failed > 0) {
      lanes.push({ key: 'scans', state: 'fail', detail: `scans ${ok}✓ ${failed}✗` });
      anomalies.push(`Scan calls: ${failed} failed in 24h`);
    } else if (ok === 0) {
      lanes.push({ key: 'scans', state: 'warn', detail: 'scans 0' });
    } else {
      lanes.push({ key: 'scans', state: 'ok', detail: `scans ${ok}✓` });
    }
  } catch {
    lanes.push({ key: 'scans', state: 'warn', detail: 'scans ?' });
  }

  if (inputs.feeds) {
    const { ok, total } = inputs.feeds;
    // feed-source failures already push their own anomaly in the scheduler fold
    lanes.push({ key: 'feeds', state: ok === total ? 'ok' : 'fail', detail: `feeds ${ok}/${total}` });
  }
  if (inputs.forum) {
    lanes.push({ key: 'forum', state: inputs.forum === 'ok' ? 'ok' : 'fail', detail: inputs.forum === 'ok' ? 'forum ✓' : 'forum ✗' });
  }

  // bridge — tele-sum summary-sync watermark age (15-min cycle; >6h = stale)
  try {
    const wm = await deps.getAppState<string>('summary-sync:watermark');
    if (wm) {
      const age = Date.now() - Date.parse(wm);
      if (Number.isNaN(age) || age > 6 * 60 * 60 * 1000) {
        lanes.push({ key: 'bridge', state: 'warn', detail: 'bridge stale' });
        anomalies.push('Bridge: summary-sync watermark stale (>6h)');
      } else {
        lanes.push({ key: 'bridge', state: 'ok', detail: 'bridge ✓' });
      }
    }
  } catch {
    lanes.push({ key: 'bridge', state: 'warn', detail: 'bridge ?' });
  }

  // agent — today's brief presence; omitted when no agent ran (that is normal)
  try {
    const brief = await deps.getAppState<{ runs?: unknown[] }>(`agent-brief:${inputs.date}`);
    const runs = brief?.runs?.length ?? 0;
    if (runs > 0) lanes.push({ key: 'agent', state: 'ok', detail: `agent ${runs} run${runs === 1 ? '' : 's'}` });
  } catch {
    // omit — agent lane is optional evidence
  }

  return { ledger: { lanes }, anomalies };
}
```

- [ ] **Step 4: Run to verify pass** — `node --test tests/daily-digest.test.js`, then `npm test` and `npm run typecheck` (exit 0).

- [ ] **Step 5: Commit** — `git commit -m "feat(digest): run ledger built from durable evidence"`.

---

### Task 3: Renderer rewrite (Run Ledger layout)

**Files:**
- Modify: `src/services/email.ts`
- Test: `tests/digest-email.test.js` (rewrite entire file)

**Interfaces:**
- Consumes: `RunLedger` (Task 2), `TopFindEntry` (Task 1), existing `dailyDigestShell`, `sectionLabel`, `escapeHtml`, `FONT`, `MONO`, `getBrand`.
- Produces: `DigestEmailExtras` gains `freshFinds?: TopFindEntry[]`, `totalNewEligible?: number`, `runLedger?: RunLedger`, `closingSoon?: ClosingSoonRow[]`; keeps `costRecap`, `bdLeads`, `bdLeadsUrl`, `anomalies`; keeps `topFinds`/`csvExport`/`downloadUrls`/`agentBrief`/`sourceBreakdown` as deprecated ignored fields until Task 4 removes them. New export `ClosingSoonRow { name: string; wire: string; deadline: string; daysUntil: number; amount: string | null; sourceUrl: string }`.
- Subject contract: `⚠ ` prefix iff issues; forms `Jul 9 — 4 new for review · run clean`, `⚠ Jul 9 — 2 issues · 1 new`, `Jul 9 — nothing new · run clean`.

- [ ] **Step 1: Rewrite `tests/digest-email.test.js` (failing)**

```js
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderDailyDigest } = require('../src/services/email');

const DIGEST = {
  date: '2026-07-09',
  wires: [
    { wire: 'crypto', scansRun: 2, totalIngested: 25, newUnique: 8, duplicatesFound: 12, avgQualityScore: 61, highQualityCount: 3, pendingReview: 6, recentlyApproved: 2 },
    { wire: 'ai', scansRun: 1, totalIngested: 16, newUnique: 5, duplicatesFound: 7, avgQualityScore: 58, highQualityCount: 2, pendingReview: 5, recentlyApproved: 1 },
  ],
  totalPendingReview: 11,
  totalNewUnique: 13,
  hasActivity: true,
};

const FINDS = [
  { id: 101, name: 'Schmidt Sciences RFP', wire: 'ai', quality_score: 91, amount: '$2M pool', deadline: 'Jul 31', source_url: 'https://x.org/1', curator_route: 'publish', curator_confidence: 'high' },
  { id: 102, name: 'NLnet Open Call', wire: 'oss', quality_score: 84, amount: null, deadline: null, source_url: null, curator_route: 'source_check', curator_confidence: 'med' },
];

const LEDGER = {
  lanes: [
    { key: 'scans', state: 'ok', detail: 'scans 41✓' },
    { key: 'feeds', state: 'ok', detail: 'feeds 19/19' },
    { key: 'bridge', state: 'ok', detail: 'bridge ✓' },
  ],
};

const CLOSING = [
  { name: 'EF Academic Grants', wire: 'ai', deadline: '2026-07-12', daysUntil: 3, amount: '$50-150k', sourceUrl: 'https://x.org/ef' },
];

test('clean day: RUN CLEAN band, ledger lanes, state-carrying subject', () => {
  const r = renderDailyDigest(DIGEST, 'https://app.example', { freshFinds: FINDS, totalNewEligible: 2, runLedger: LEDGER, costRecap: { rows: [], total: 1.2 } });
  assert.match(r.html, /RUN CLEAN/);
  assert.match(r.html, /scans 41✓/);
  assert.match(r.html, /feeds 19\/19/);
  assert.match(r.html, /41 in/); // totalIngested sum
  assert.match(r.html, /\$1\.20/);
  assert.equal(r.subject, 'Jul 9 — 2 new for review · run clean');
});

test('new-for-review cards: deep link into the queue, curator stamp, source as secondary link', () => {
  const r = renderDailyDigest(DIGEST, 'https://app.example', { freshFinds: FINDS, totalNewEligible: 2, runLedger: LEDGER });
  assert.match(r.html, /New for review \(2\)/);
  assert.match(r.html, /https:\/\/app\.example\/queue\?entry=101/);
  assert.match(r.html, /PUBLISH·HIGH/);
  assert.match(r.html, /CHECK·MED/);
  assert.match(r.html, /https:\/\/x\.org\/1/); // source stays, as the secondary link
  assert.match(r.html, /Open queue → 11 waiting/);
  assert.match(r.text, /queue\?entry=101/);
});

test('more-new line renders when eligible items exceed the shown cap', () => {
  const r = renderDailyDigest(DIGEST, 'https://app.example', { freshFinds: FINDS, totalNewEligible: 7, runLedger: LEDGER });
  assert.match(r.html, /5 more new in the queue/);
});

test('bad day: amber band, Production issues section, ⚠ subject leads with issues', () => {
  const r = renderDailyDigest(DIGEST, 'https://app.example', {
    freshFinds: FINDS.slice(0, 1), totalNewEligible: 1, runLedger: LEDGER,
    anomalies: ['Source feeds: 2 of 19 sources errored', 'API spend $6.40 in 24h (>$5)'],
  });
  assert.match(r.html, /⚠ 2 ISSUES/);
  assert.match(r.html, /Production issues \(2\)/);
  assert.match(r.html, /2 of 19 sources errored/);
  assert.equal(r.subject, '⚠ Jul 9 — 2 issues · 1 new');
});

test('quiet day: short email, green band, older-items pointer, no backlog framing', () => {
  const r = renderDailyDigest(DIGEST, 'https://app.example', { freshFinds: [], totalNewEligible: 0, runLedger: LEDGER });
  assert.equal(r.subject, 'Jul 9 — nothing new · run clean');
  assert.match(r.html, /Nothing new for review/);
  assert.match(r.html, /11 older items still queued/);
  assert.ok(!r.html.includes('Needs you'), 'no backlog framing');
  assert.ok(r.html.length < 4000, `quiet email should be small, got ${r.html.length}`);
});

test('closing soon: renders only when non-empty, with bold day counts', () => {
  const withRows = renderDailyDigest(DIGEST, 'https://app.example', { freshFinds: [], runLedger: LEDGER, closingSoon: CLOSING });
  assert.match(withRows.html, /Closing soon/);
  assert.match(withRows.html, /EF Academic Grants/);
  assert.match(withRows.html, /3 days/);
  const without = renderDailyDigest(DIGEST, 'https://app.example', { freshFinds: [], runLedger: LEDGER, closingSoon: [] });
  assert.ok(!without.html.includes('Closing soon'));
});

test('BD leads block renders only when leads are passed (Wednesdays)', () => {
  const plain = renderDailyDigest(DIGEST, 'https://app.example', { freshFinds: FINDS, runLedger: LEDGER });
  assert.ok(!plain.html.includes('BD leads'));
  const wed = renderDailyDigest(DIGEST, 'https://app.example', {
    freshFinds: FINDS, runLedger: LEDGER,
    bdLeads: [{ lead: 'Filecoin — grants-ops opportunity', source: 'https://x.org/fil', notes: '[Grants-ops · crypto · high] ProPGF open' }],
    bdLeadsUrl: 'https://notion.so/leads',
  });
  assert.match(wed.html, /BD leads/);
  assert.match(wed.html, /Filecoin — grants-ops opportunity/);
  assert.match(wed.html, /Triage in Notion/);
  assert.ok(!wed.subject.includes('BD'), 'subject stays new-work + verdict');
});

test('ops telemetry stays out: no CSV links, no agent activity, no source/cost tables', () => {
  const r = renderDailyDigest(DIGEST, 'https://app.example', {
    freshFinds: FINDS, runLedger: LEDGER,
    csvExport: { entryCount: 3, htmlTable: '<table><tr><td>SHOULD NOT APPEAR</td></tr></table>' },
    downloadUrls: { csv: 'https://x.org/csv', md: null },
    agentBrief: { runs: [{ searchesDone: 8, totalFound: 11, entries: [{}, {}], skippedDuplicates: 5 }] },
  });
  assert.ok(!r.html.includes('SHOULD NOT APPEAR'));
  assert.ok(!r.html.includes('Agent scan:'), 'agent evidence lives in the ledger, not prose');
  assert.ok(!r.html.includes('Approved last 24h'));
  assert.ok(!r.html.includes('Intake by Source'));
  assert.ok(!r.html.includes('API Costs'));
});
```

- [ ] **Step 2: Run to verify failure** — `node --test tests/digest-email.test.js` → FAIL on subject/band assertions.

- [ ] **Step 3: Implement the renderer**

In `src/services/email.ts`: add `ClosingSoonRow`, update `DigestEmailExtras`, replace `renderDailyDigest`:

```ts
export interface ClosingSoonRow {
  name: string;
  wire: string;
  deadline: string;
  daysUntil: number;
  amount: string | null;
  sourceUrl: string;
}

export interface DigestEmailExtras {
  /** Never-before-emailed queue items (watermarked) — the "New for review" cards */
  freshFinds?: TopFindEntry[];
  /** Total eligible new items behind freshFinds (drives the "+N more new" line) */
  totalNewEligible?: number;
  /** Evidence the machine ran — rendered inside the status band */
  runLedger?: RunLedger;
  /** Approved entries closing within 7 days (folds the retired deadline email) */
  closingSoon?: ClosingSoonRow[];
  costRecap?: { rows: import('../jobs/daily-digest').CostRow[]; total: number };
  /** Wednesday BD leads written to Paid Work Leads this run */
  bdLeads?: DigestBdLead[];
  bdLeadsUrl?: string;
  /** Operational anomalies — the ONLY way ops telemetry gets into the email. */
  anomalies?: string[];
  /** @deprecated ignored by the renderer — removed once callers migrate (Task 4) */
  topFinds?: TopFindEntry[];
  /** @deprecated ignored */
  csvExport?: import('../jobs/csv-export').CsvExportResult;
  /** @deprecated ignored */
  downloadUrls?: { csv: string | null; md: string | null };
  /** @deprecated ignored */
  agentBrief?: StoredAgentBrief | null;
  /** @deprecated ignored */
  sourceBreakdown?: import('../jobs/daily-digest').SourceBreakdownRow[];
}

/**
 * Render the daily digest email (2026-07-09 "Run Ledger" redesign).
 *
 * The operator's cockpit — three jobs, in order:
 *   1. Status band: prove the machine ran (RUN CLEAN / ⚠ N ISSUES + lane ledger).
 *   2. New for review: never-before-emailed queue items, curator-stamped,
 *      deep-linked into the dashboard queue (?entry=<id>).
 *   3. Closing soon: approved entries with deadlines ≤7d.
 * Backlog appears only on the queue button. Quiet day = short email.
 */
export function renderDailyDigest(
  digest: import('../jobs/daily-digest').DailyDigestResult,
  dashboardUrl: string,
  extras: DigestEmailExtras = {},
): { subject: string; html: string; text: string } {
  const brand = getBrand();
  const base = dashboardUrl.replace(/\/$/, '');
  const queueUrl = `${base}/queue`;
  const { freshFinds, totalNewEligible, runLedger, closingSoon, costRecap, bdLeads, bdLeadsUrl, anomalies } = extras;

  const finds = freshFinds ?? [];
  const freshCount = finds.length;
  const totalNew = Math.max(totalNewEligible ?? freshCount, freshCount);
  const issueCount = anomalies?.length ?? 0;
  const totalIn = digest.wires.reduce((n, w) => n + w.totalIngested, 0);
  const waiting = digest.totalPendingReview;

  const day = new Date(`${digest.date}T00:00:00Z`);
  const subjDate = day.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const slugDate = day.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).replace(/,/g, '').toUpperCase();

  // ── 1. Status band ───────────────────────────────────────────────────
  const ledgerParts = [
    ...(runLedger?.lanes ?? []).map(l => l.detail),
    `${totalIn} in`,
    costRecap ? `$${costRecap.total.toFixed(2)}` : null,
  ].filter((p): p is string => Boolean(p));
  const clean = issueCount === 0;
  const verdict = clean ? 'RUN CLEAN' : `⚠ ${issueCount} ISSUE${issueCount === 1 ? '' : 'S'}`;
  const bandHtml = `
    <div style="padding:9px 24px;background-color:${clean ? '#e6f6ee' : '#fdeee4'};border-bottom:1px solid ${clean ? '#bfe4d0' : '#f0c4a4'};">
      <p style="margin:0;font-size:11px;color:${clean ? '#116b45' : '#a23b00'};${MONO}"><strong style="letter-spacing:1px;">${escapeHtml(verdict)}</strong> &nbsp; ${ledgerParts.map(p => escapeHtml(p)).join(' &middot; ')}</p>
    </div>`;
  const bandText = `${verdict} | ${ledgerParts.join(' · ')}`;

  // ── 2. Production issues (bad day only) ──────────────────────────────
  let issuesHtml = '';
  let issuesText = '';
  if (issueCount > 0 && anomalies) {
    issuesHtml = `
      ${sectionLabel(`Production issues (${issueCount})`)}
      ${anomalies.map(a => `<div style="background:#fff7ed;border:1px solid #f0b38a;border-radius:5px;padding:10px 12px;margin:0 0 8px;color:#a23b00;font-size:12px;line-height:1.45;">${escapeHtml(a)}</div>`).join('')}`;
    issuesText = `\nPRODUCTION ISSUES (${issueCount})\n` + anomalies.map(a => `  ! ${a}`).join('\n') + '\n';
  }

  // ── 3. New for review ────────────────────────────────────────────────
  const routeLabel: Record<string, string> = {
    publish: 'PUBLISH', source_check: 'CHECK', relationship_signal: 'SIGNAL', park: 'PARK', decline: 'DECLINE',
  };
  const queueBtn = `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:16px 0 4px;">
    <tr><td style="background-color:#14181c;padding:10px 24px;">
      <a href="${escapeHtml(queueUrl)}" target="_blank" style="color:#ffffff;font-size:13px;font-weight:600;text-decoration:none;${FONT}">Open queue &rarr; ${waiting} waiting</a>
    </td></tr>
  </table>`;

  let reviewHtml = '';
  let reviewText = '';
  if (freshCount > 0) {
    const cards = finds.map(e => {
      const entryUrl = `${queueUrl}?entry=${e.id}`;
      const route = e.curator_route ? routeLabel[e.curator_route] ?? null : null;
      const stamp = route ? `${route}${e.curator_confidence ? `·${e.curator_confidence.toUpperCase()}` : ''}` : null;
      const isPublish = e.curator_route === 'publish';
      const metaParts = [
        escapeHtml(e.wire.toUpperCase()),
        stamp ? `<span style="color:${isPublish ? '#116b45' : '#8a6d1f'};font-weight:700;">${escapeHtml(stamp)}</span>` : null,
        e.amount ? escapeHtml(e.amount) : null,
        e.deadline ? `due ${escapeHtml(e.deadline)}` : null,
        e.source_url ? `<a href="${escapeHtml(e.source_url)}" style="color:#93a2ac;text-decoration:none;">source &#8599;</a>` : null,
      ].filter(Boolean);
      return `<div style="border:1px solid #e2e8ed;border-left:3px solid ${isPublish ? '#1a8a5a' : '#d0d9df'};padding:10px 12px;margin:0 0 8px;">
        <p style="margin:0;font-size:13px;line-height:1.4;"><a href="${escapeHtml(entryUrl)}" style="color:#14181c;font-weight:700;text-decoration:none;border-bottom:1px solid #9fd4f5;">${escapeHtml(e.name)}</a></p>
        <p style="margin:5px 0 0;font-size:10.5px;color:#64717b;${MONO}">${metaParts.join(' &middot; ')}</p>
      </div>`;
    }).join('');
    const more = totalNew - freshCount;
    reviewHtml = `
      ${sectionLabel(`New for review (${freshCount})`)}
      ${cards}
      ${more > 0 ? `<p style="margin:4px 0 0;font-size:12px;color:#64717b;">${more} more new in the queue</p>` : ''}
      ${queueBtn}`;
    reviewText = `\nNEW FOR REVIEW (${freshCount})\n` + finds.map(e => {
      const route = e.curator_route ? routeLabel[e.curator_route] ?? '' : '';
      const stamp = route ? ` [${route}${e.curator_confidence ? `·${e.curator_confidence.toUpperCase()}` : ''}]` : '';
      return `  [${e.wire}]${stamp} ${e.name}${e.amount ? ` | ${e.amount}` : ''}${e.deadline ? ` | due ${e.deadline}` : ''}\n    ${queueUrl}?entry=${e.id}`;
    }).join('\n') + (more > 0 ? `\n  ${more} more new in the queue` : '') + `\n  Open queue (${waiting} waiting): ${queueUrl}\n`;
  } else {
    reviewHtml = `
      <p style="margin:18px 0 0;font-size:13px;color:#444;">Nothing new for review. Everything ingested overnight was duplicate or off-scope &mdash; the machine ran, filtered, and left you alone.</p>
      ${waiting > 0 ? `<p style="margin:10px 0 0;font-size:12px;color:#64717b;"><a href="${escapeHtml(queueUrl)}" style="color:#64717b;">${waiting} older item${waiting === 1 ? '' : 's'} still queued</a></p>` : ''}`;
    reviewText = `\nNothing new for review.${waiting > 0 ? ` ${waiting} older item${waiting === 1 ? '' : 's'} still queued: ${queueUrl}` : ''}\n`;
  }

  // ── 4. Closing soon ──────────────────────────────────────────────────
  let closingHtml = '';
  let closingText = '';
  if (closingSoon && closingSoon.length > 0) {
    const rows = closingSoon.map(c => {
      const days = c.daysUntil <= 0 ? 'today' : c.daysUntil === 1 ? '1 day' : `${c.daysUntil} days`;
      const name = c.sourceUrl
        ? `<a href="${escapeHtml(c.sourceUrl)}" style="color:#14181c;font-weight:600;text-decoration:none;">${escapeHtml(c.name)}</a>`
        : `<span style="font-weight:600;color:#14181c;">${escapeHtml(c.name)}</span>`;
      return `<tr>
        <td style="padding:6px 0;border-bottom:1px solid #eef2f5;font-size:12px;">${name}</td>
        <td style="padding:6px 0;border-bottom:1px solid #eef2f5;font-size:12px;color:#64717b;text-align:right;${MONO}">${escapeHtml(c.amount || '')}</td>
        <td style="padding:6px 0 6px 14px;border-bottom:1px solid #eef2f5;font-size:12px;color:#b45309;font-weight:800;text-align:right;white-space:nowrap;${MONO}">${days}</td>
      </tr>`;
    }).join('');
    closingHtml = `
      ${sectionLabel(`Closing soon · approved (${closingSoon.length})`)}
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${rows}</table>`;
    closingText = `\nCLOSING SOON (${closingSoon.length})\n` + closingSoon.map(c =>
      `  [${c.wire}] ${c.name} — ${c.deadline} (in ${c.daysUntil}d)${c.amount ? ` | ${c.amount}` : ''}`
    ).join('\n') + '\n';
  }

  // ── 5. BD leads (Wednesdays) ─────────────────────────────────────────
  let bdHtml = '';
  let bdText = '';
  if (bdLeads && bdLeads.length > 0) {
    const lines = bdLeads.map(l => {
      const title = l.source
        ? `<a href="${escapeHtml(l.source)}" style="color:#0b86d1;text-decoration:none;font-weight:700;">${escapeHtml(l.lead)}</a>`
        : `<span style="font-weight:700;color:#14181c;">${escapeHtml(l.lead)}</span>`;
      const note = l.notes ? `<div style="margin-top:5px;color:#64717b;font-size:12px;">${escapeHtml(l.notes.slice(0, 140))}</div>` : '';
      return `<div style="border:1px solid #e2e8ed;border-radius:5px;padding:11px 12px;margin:0 0 8px;">${title}${note}</div>`;
    }).join('');
    bdHtml = `
      ${sectionLabel(`BD leads (${bdLeads.length})`)}
      ${lines}
      ${bdLeadsUrl ? emailBtn(bdLeadsUrl, 'Triage in Notion') : ''}`;
    bdText = `\nBD LEADS - VERIFIED, NOT CONTACTED (${bdLeads.length})\n` + bdLeads.map(l =>
      `  ${l.lead}${l.notes ? ` | ${l.notes.slice(0, 110)}` : ''}${l.source ? `\n    ${l.source}` : ''}`
    ).join('\n') + (bdLeadsUrl ? `\n  Triage: ${bdLeadsUrl}` : '') + '\n';
  }

  const body = `
    ${bandHtml}
    <div style="padding:0 24px 20px;">
      ${issuesHtml}
      ${reviewHtml}
      ${closingHtml}
      ${bdHtml}
      <p style="margin:20px 0 0;font-size:11px;color:#a6b1b9;"><a href="${escapeHtml(base)}" style="color:#a6b1b9;">Dashboard</a> &middot; backlog, sources, and cost detail live there.</p>
    </div>`;

  const html = dailyDigestShell(`WireOps - ${digest.date}`, slugDate, body);

  const newPart = freshCount > 0 ? `${freshCount} new for review` : 'nothing new';
  const subject = issueCount > 0
    ? `⚠ ${subjDate} — ${issueCount} issue${issueCount === 1 ? '' : 's'} · ${freshCount > 0 ? `${freshCount} new` : 'nothing new'}`
    : `${subjDate} — ${newPart} · run clean`;

  const text = `WIREOPS - ${digest.date}
${bandText}
${issuesText}${reviewText}${closingText}${bdText}
Dashboard: ${base}

---
${brand.name}`;

  return { subject, html, text };
}
```

- [ ] **Step 4: Run to verify pass** — `node --test tests/digest-email.test.js`, then `npm test` (the scheduler/send-now still pass old extras — the deprecated fields keep them compiling) and `npm run typecheck` (exit 0).

- [ ] **Step 5: Commit** — `git commit -m "feat(digest): Run Ledger email renderer"`.

---

### Task 4: Shared assembly, scheduler + send-now wiring

**Files:**
- Modify: `src/jobs/daily-digest.ts`, `src/services/scheduler.ts`, `src/routes/schedules.ts`, `src/services/email.ts` (drop deprecated extras fields)
- Test: `tests/daily-digest.test.js` (append)

**Interfaces:**
- Consumes: Tasks 1-3 exports; `runDeadlineDigest(pool)` from `./deadline-digest`; `sendDailyDigestEmail(digest, dashboardUrl, recipients, extras)` from `../services/email`; `config.app.url`.
- Produces: `assembleAndSendDailyDigest(pool, opts?: AssembleDigestOptions, deps?): Promise<DigestSendSummary>` in `daily-digest.ts` with
  `AssembleDigestOptions = { recipients?: string[]; laneAnomalies?: string[]; feeds?: { ok; total } | null; forum?: 'ok'|'fail'|null; bdLeads?: DigestBdLead[]; bdLeadsUrl?: string }` and
  `DigestSendSummary = { date: string; freshCount: number; totalNew: number; issueCount: number; seeded: boolean }`.
- Removes: `getTopPendingFinds` (both callers migrate here) and the deprecated `DigestEmailExtras` fields.

- [ ] **Step 1: Write failing tests (append to `tests/daily-digest.test.js`)**

```js
const { assembleAndSendDailyDigest } = require('../src/jobs/daily-digest');

function assemblyDeps(overrides = {}) {
  const sent = [];
  const advanced = [];
  return {
    sent, advanced,
    deps: {
      digest: async () => ({ date: '2026-07-09', wires: [], totalPendingReview: 3, totalNewUnique: 5, hasActivity: true }),
      fresh: async () => ({ finds: [{ id: 7, name: 'A', wire: 'ai', quality_score: 90, amount: null, deadline: null, source_url: null, curator_route: 'publish', curator_confidence: 'high' }], totalNew: 4, seeded: false, fallback: false }),
      ledger: async () => ({ ledger: { lanes: [{ key: 'scans', state: 'ok', detail: 'scans 5✓' }] }, anomalies: [] }),
      deadlines: async () => ([{ wire: 'ai', entries: [{ id: 9, name: 'EF', wire: 'ai', deadline: '2026-07-12', deadlineParsed: null, amount: null, sourceUrl: 'https://x.org/ef', daysUntil: 3 }], generatedAt: new Date() }]),
      cost: async () => ({ rows: [], total: 1.5 }),
      sources: async () => ([{ wire: 'ai', source: 'feed', total: 20, queued: 2, approved: 1, archived: 3, duplicates: 14, parked: 0, signals: 0 }]),
      send: async (...args) => { sent.push(args); },
      advance: async (ids) => { advanced.push(ids); },
      ...overrides,
    },
  };
}

test('assembleAndSendDailyDigest: sends one email and advances the watermark with shown ids', async () => {
  const { deps, sent, advanced } = assemblyDeps();
  const summary = await assembleAndSendDailyDigest({}, { laneAnomalies: [] }, deps);

  assert.equal(sent.length, 1);
  const extras = sent[0][3];
  assert.equal(extras.freshFinds.length, 1);
  assert.equal(extras.totalNewEligible, 4);
  assert.equal(extras.closingSoon.length, 1);
  assert.equal(extras.closingSoon[0].daysUntil, 3);
  assert.deepEqual(advanced, [[7]]);
  assert.equal(summary.freshCount, 1);
  assert.equal(summary.totalNew, 4);
});

test('assembleAndSendDailyDigest: derives dupe-rate anomaly (>60% of >=10) and merges lane anomalies', async () => {
  const { deps, sent } = assemblyDeps();
  await assembleAndSendDailyDigest({}, { laneAnomalies: ['Forum lane failed: x'] }, deps);
  const extras = sent[0][3];
  assert.ok(extras.anomalies.some(a => a.includes('Forum lane failed')));
  assert.ok(extras.anomalies.some(a => a.includes('High dupe rate')), 'ai/feed is 70% dupes of 20');
});

test('assembleAndSendDailyDigest: a failed send never advances the watermark', async () => {
  const { deps, advanced } = assemblyDeps({ send: async () => { throw new Error('resend down'); } });
  await assert.rejects(() => assembleAndSendDailyDigest({}, {}, deps));
  assert.deepEqual(advanced, []);
});

test('assembleAndSendDailyDigest: cost spike >$5 becomes an anomaly', async () => {
  const { deps, sent } = assemblyDeps({ cost: async () => ({ rows: [], total: 6.4 }) });
  await assembleAndSendDailyDigest({}, {}, deps);
  assert.ok(sent[0][3].anomalies.some(a => a.includes('$6.40')));
});
```

- [ ] **Step 2: Run to verify failure** — `node --test tests/daily-digest.test.js` → FAIL.

- [ ] **Step 3: Implement `assembleAndSendDailyDigest` in `src/jobs/daily-digest.ts`**

Add imports: `import { config } from '../config';`, `import { sendDailyDigestEmail } from '../services/email';`, `import type { DigestBdLead, ClosingSoonRow } from '../services/email';`, `import { runDeadlineDigest } from './deadline-digest';`. Then:

```ts
export interface AssembleDigestOptions {
  recipients?: string[];
  /** In-fold lane failures collected by the scheduler (forum/feeds/weekly/BD) */
  laneAnomalies?: string[];
  feeds?: { ok: number; total: number } | null;
  forum?: 'ok' | 'fail' | null;
  bdLeads?: DigestBdLead[];
  bdLeadsUrl?: string;
}

export interface DigestSendSummary {
  date: string;
  freshCount: number;
  totalNew: number;
  issueCount: number;
  seeded: boolean;
}

export interface AssembleDigestDeps {
  digest: typeof runDailyDigest;
  fresh: typeof getFreshFinds;
  ledger: typeof buildRunLedger;
  deadlines: typeof runDeadlineDigest;
  cost: typeof getCostRecap;
  sources: typeof getSourceBreakdown;
  send: typeof sendDailyDigestEmail;
  advance: (ids: number[]) => Promise<void>;
}

const defaultAssembleDeps: AssembleDigestDeps = {
  digest: runDailyDigest,
  fresh: getFreshFinds,
  ledger: buildRunLedger,
  deadlines: runDeadlineDigest,
  cost: getCostRecap,
  sources: getSourceBreakdown,
  send: sendDailyDigestEmail,
  advance: (ids) => advanceDigestWatermark(ids),
};

/**
 * ONE code path for the digest email — used by both the scheduler's daily
 * fold and the dashboard send-now button, so the two can never diverge.
 * The watermark advances only after the send succeeds.
 */
export async function assembleAndSendDailyDigest(
  pool: Pool,
  opts: AssembleDigestOptions = {},
  deps: AssembleDigestDeps = defaultAssembleDeps,
): Promise<DigestSendSummary> {
  const digest = await deps.digest(pool);
  const freshRes = await deps.fresh(pool, 8);

  let ledger: import('../services/email').RunLedger = { lanes: [] };
  const anomalies = [...(opts.laneAnomalies ?? [])];
  try {
    const built = await deps.ledger(pool, { date: digest.date, feeds: opts.feeds ?? null, forum: opts.forum ?? null });
    ledger = built.ledger;
    anomalies.push(...built.anomalies);
  } catch (e) {
    console.error('[DailyDigest] Run ledger failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  let closingSoon: ClosingSoonRow[] = [];
  try {
    const results = await deps.deadlines(pool);
    closingSoon = results.flatMap(r => r.entries.map(e => ({
      name: e.name, wire: r.wire, deadline: e.deadline, daysUntil: e.daysUntil,
      amount: e.amount, sourceUrl: e.sourceUrl,
    })));
  } catch (e) {
    console.error('[DailyDigest] Closing-soon fold failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  let costRecap: { rows: CostRow[]; total: number } | undefined;
  try {
    costRecap = await deps.cost(pool);
    if (costRecap.total > 5) anomalies.push(`API spend $${costRecap.total.toFixed(2)} in 24h (>$5)`);
  } catch (e) {
    console.error('[DailyDigest] Cost recap failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  try {
    const breakdown = await deps.sources(pool);
    for (const row of breakdown) {
      if (row.total >= 10 && row.duplicates / row.total > 0.6) {
        anomalies.push(`High dupe rate: ${row.wire}/${row.source} — ${Math.round((row.duplicates / row.total) * 100)}% of ${row.total}`);
      }
    }
  } catch (e) {
    console.error('[DailyDigest] Source breakdown failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  await deps.send(digest, config.app.url, opts.recipients, {
    freshFinds: freshRes.finds,
    totalNewEligible: freshRes.totalNew,
    runLedger: ledger,
    closingSoon,
    costRecap,
    bdLeads: opts.bdLeads,
    bdLeadsUrl: opts.bdLeadsUrl,
    anomalies,
  });
  await deps.advance(freshRes.finds.map(f => f.id));

  return {
    date: digest.date,
    freshCount: freshRes.finds.length,
    totalNew: freshRes.totalNew,
    issueCount: anomalies.length,
    seeded: freshRes.seeded,
  };
}
```

Delete `getTopPendingFinds` from `daily-digest.ts` in this same step (callers migrate below).

- [ ] **Step 4: Rewire the scheduler daily-digest branch (`src/services/scheduler.ts`)**

Add `assembleAndSendDailyDigest` to scheduler.ts's import from `../jobs/daily-digest`. Inside the branch: capture lane evidence while the lanes run —

```ts
let feedsLane: { ok: number; total: number } | null = null;
let forumLane: 'ok' | 'fail' | null = null;
```

In the forum try/catch: set `forumLane = 'ok'` after a successful run, `forumLane = 'fail'` in the catch (only when `config.forum.enabled`). In the feeds try/catch: after the run, `feedsLane = { ok: sf.perSource.length - failed, total: sf.perSource.length };` and in the catch `feedsLane = { ok: 0, total: 0 }` is wrong — leave `feedsLane = null` on catch (the anomaly line already reports the failure).

Then REPLACE everything from `const digest = await runDailyDigest(pool);` down to the end of the send-email block (the `let digestEmailError` block inclusive) with:

```ts
        let digestEmailError: string | null = null;
        const recipients = currentScheduleData.notifyEmails
          ? currentScheduleData.notifyEmails.split(',').map(e => e.trim()).filter(Boolean)
          : undefined;

        try {
          const summary = await assembleAndSendDailyDigest(pool, {
            recipients,
            laneAnomalies: anomalies,
            feeds: feedsLane,
            forum: forumLane,
            bdLeads: bdLeadsForEmail,
            bdLeadsUrl: '<BD_LEADS_DIGEST_URL>',
          });
          console.log(`[Scheduler] Daily digest email sent (${summary.freshCount} new of ${summary.totalNew}, ${summary.issueCount} issues${summary.seeded ? ', watermark seeded' : ''})`);
        } catch (emailErr) {
          console.error(`[Scheduler] Failed to send daily digest email:`, emailErr);
          digestEmailError = emailErr instanceof Error ? emailErr.message : String(emailErr);
        }
```

Keep the existing `if (digestEmailError) { status.status = 'failed'; ... }` block unchanged. Move the CSV-export block (runCsvExport + logging, WITHOUT the createMagicLink lines — links no longer feed the email; files stay dashboard-downloadable) to AFTER the digest email, before the CRM cycle, still in its own try/catch. Delete the now-unused agentBrief/sourceBreakdown/costRecap loading blocks and their imports if unused (`getTopPendingFinds`, `getSourceBreakdown`, `getCostRecap`, `StoredAgentBrief`, `createMagicLink` — check each with grep before removing; `sendDailyDigestEmail` import is no longer needed in scheduler.ts, and `runDailyDigest` may also be unused now).

- [ ] **Step 5: Rewire send-now (`src/routes/schedules.ts`)**

Replace the handler body's assembly with:

```ts
    const pool = getPool();
    const { assembleAndSendDailyDigest } = await import('../jobs/daily-digest');

    // Get configured recipients from the daily-digest schedule
    const allSchedules = getSchedules();
    const digestSchedule = allSchedules.find(s => s.scheduleType === 'daily-digest');
    const recipients = digestSchedule?.notifyEmails
      ? digestSchedule.notifyEmails.split(',').map(e => e.trim()).filter(Boolean)
      : undefined;

    const summary = await assembleAndSendDailyDigest(pool, { recipients });
    res.json({
      success: true,
      message: `Digest sent to ${recipients?.join(', ') || 'default recipients'}`,
      stats: { date: summary.date, fresh: summary.freshCount, totalNew: summary.totalNew, issues: summary.issueCount },
    });
```

- [ ] **Step 6: Remove the deprecated `DigestEmailExtras` fields** (`topFinds`, `csvExport`, `downloadUrls`, `agentBrief`, `sourceBreakdown`) from `src/services/email.ts` — all callers now pass the new shape. Keep `StoredAgentBrief`/`AgentBriefRun`/`AgentBriefEntry` interfaces (the agent send-brief route in `src/routes/scan-entries.ts` still imports them — verify with `grep -rn "StoredAgentBrief" src/`).

- [ ] **Step 7: Verify** — `node --test tests/daily-digest.test.js tests/digest-email.test.js`, then `npm test`, then `npm run typecheck` (exit 0, run bare).

- [ ] **Step 8: Commit** — `git commit -m "feat(digest): shared assembly for scheduler + send-now; watermark advances after send"`.

---

### Task 5: Retire the standalone deadline email

**Files:**
- Modify: `src/types/intake.ts`, `src/db/index.ts`, `src/services/scheduler.ts`, `src/services/email.ts`, `tests/enum-lockstep.test.js`, `CLAUDE.md`
- Possibly modify: client Settings schedule-type options (grep first)

**Interfaces:**
- Consumes: nothing new. `runDeadlineDigest` STAYS (data provider for the fold and for `GET /api/scan/deadline-digest`).
- Produces: `SCHEDULE_TYPES` shrinks to 5 entries.

- [ ] **Step 1: Update the lockstep test first (failing)** — in `tests/enum-lockstep.test.js` change `assert.equal(SCHEDULE_TYPES.length, 6);` to `assert.equal(SCHEDULE_TYPES.length, 5);` and add below it:

```js
  assert.ok(!SCHEDULE_TYPES.includes('deadline-digest'), 'deadline-digest retired 2026-07-09 — folded into the daily digest');
```

Run `node --test tests/enum-lockstep.test.js` → FAIL (length is still 6).

- [ ] **Step 2: Retire the type**

`src/types/intake.ts`:

```ts
// node-cron schedule types the scheduler dispatches (see scheduler.ts).
// deadline-digest retired 2026-07-09 — closing-soon now folds into the daily digest.
export const SCHEDULE_TYPES = ['scan-execution', 'forum-scan', 'daily-digest', 'account-monitor', 'source-feeds'] as const;
```

`src/db/index.ts` — extend the boot DELETE (keep the comment style):

```ts
  // Phase 4 (2026-07-03): drip-distribution, experiment-loop and collect-engagement
  // are retired. 2026-07-09: deadline-digest folded into the daily digest.
  // Rows are DELETED (not normalized) — normalizing would silently turn a
  // retired lane into a paid scan-execution cron.
  await pool.query(`DELETE FROM schedules WHERE schedule_type IN ('collect-engagement', 'experiment-loop', 'drip-distribution', 'deadline-digest')`);
```

- [ ] **Step 3: Delete the dead code**
  - `src/services/scheduler.ts`: remove the whole `deadline-digest` branch and the `sendDeadlineDigestEmail` import; remove `runDeadlineDigest` import if now unused in that file.
  - `src/services/email.ts`: delete `sendDeadlineDigestEmail` entirely.
  - `grep -rn "deadline-digest\|sendDeadlineDigestEmail" src/ client/src/ --include="*.ts" --include="*.tsx"` — for every remaining hit decide: `GET /api/scan/deadline-digest` data route and `runDeadlineDigest` STAY; any client Settings dropdown offering `deadline-digest` as a schedule type must drop that option; anything else referencing the retired email goes.

- [ ] **Step 4: Update CLAUDE.md** — "Schedule Types (6)" → "(5)": delete the `deadline-digest` bullet, and in the `daily-digest` bullet add that the digest email now carries the "Closing soon (7d)" fold (data from `runDeadlineDigest`, renders only when non-empty). Also update the `src/jobs/deadline-digest.ts` line in the file tree ("data provider for the daily digest's Closing-soon fold — no standalone email") and the email.ts line (drop "deadline digest" from the template list).

- [ ] **Step 5: Verify** — `npm test` (all green, lockstep passes), `npm run typecheck` (exit 0).

- [ ] **Step 6: Commit** — `git commit -m "feat(digest)!: retire standalone deadline-digest email — folded into daily digest"`.

---

### Task 6: Single-entry endpoint + dashboard deep link

**Files:**
- Modify: `src/routes/scan-entries.ts`, `client/src/api/index.ts`, `client/src/pages/Index.tsx`

**Interfaces:**
- Produces: `GET /api/scan/entries/:id` → `{ entry: <full scan_entries row> }`, 400 on non-integer id, 404 when missing. Client `fetchEntry(id: string): Promise<ScanEntry | null>`.
- The email's deep link (Task 3) is `{APP_URL}/queue?entry=<id>` — this task makes it land.

- [ ] **Step 1: Server route** — in `src/routes/scan-entries.ts`, directly after the `GET /entries` list handler:

```ts
// GET /entries/:id — single entry (dashboard deep links from the digest email)
router.get('/entries/:id', async (req: Request, res: Response) => {
  const entryId = parseInt(req.params.id, 10);
  if (isNaN(entryId) || String(entryId) !== req.params.id) {
    res.status(400).json({ error: 'Invalid entry ID' });
    return;
  }
  try {
    const pool = getPool();
    const { rows } = await pool.query(`SELECT * FROM scan_entries WHERE id = $1`, [entryId]);
    if (rows.length === 0) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }
    res.json({ entry: rows[0] });
  } catch (error) {
    console.error('Failed to fetch scan entry:', error);
    res.status(500).json({ error: 'Failed to fetch scan entry' });
  }
});
```

(Express matches full segments, so this cannot shadow `/entries/:id/distribution`; the strict `String(entryId) !== req.params.id` check rejects junk like `12abc`.)

- [ ] **Step 2: Client fetch helper** — in `client/src/api/index.ts`, after `fetchEntries`:

```ts
export async function fetchEntry(id: string): Promise<ScanEntry | null> {
  const res = await authFetch(`${BASE}/scan/entries/${encodeURIComponent(id)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch entry: ${res.status}`);
  const data = await res.json();
  const e = data.entry;
  return { ...e, id: String(e.id), wire: e.wire || '', quality_score: Number(e.quality_score) || 0 };
}
```

- [ ] **Step 3: Deep-link effect in `client/src/pages/Index.tsx`** — import `fetchEntry` from `@/api`; add after the existing state hooks:

```tsx
  // Digest-email deep link: /queue?entry=<id> opens the entry's details sheet.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const entryId = params.get('entry');
    if (!entryId) return;
    setActiveTab('queue');
    fetchEntry(entryId)
      .then(entry => { if (entry) setSelectedEntry(entry); })
      .catch(() => { /* deep link is best-effort; the queue still shows */ });
  }, []);
```

and change the sheet's `onClose` to also clear the param:

```tsx
      <EntryDetailsSheet
        entry={selectedEntry}
        onClose={() => {
          setSelectedEntry(null);
          if (window.location.search.includes('entry=')) {
            window.history.replaceState(null, '', window.location.pathname);
          }
        }}
      />
```

(If `useEffect` isn't already imported in Index.tsx, add it to the React import.)

- [ ] **Step 4: Verify** — `npm run typecheck` (exit 0) and `npm run typecheck:client` (exit 0). `npm test` still green.

- [ ] **Step 5: Commit** — `git commit -m "feat(dashboard): GET /entries/:id + queue?entry= deep link from digest email"`.

---

### Task 7: Full verification, docs, smoke preview

**Files:**
- Modify only if verification reveals an issue. Preview file goes to the session scratchpad, NOT the repo.

- [ ] **Step 1: Full gates, each run bare with its exit code checked**
  - `npm test` → all pass (expect ~190+, zero fail)
  - `npm run typecheck` → exit 0
  - `npm run typecheck:client` → exit 0

- [ ] **Step 2: Render a real preview** — write a throwaway script to the scratchpad (not the repo) that requires `ts-node/register/transpile-only`, calls `renderDailyDigest` with the Task 3 fixtures (clean day, bad day, quiet day), writes the three HTML outputs to scratchpad files, and prints the three subjects. Eyeball the HTML in a browser: band colors, cards, closing-soon table, footer.

- [ ] **Step 3: Spec sweep** — reread `docs/superpowers/specs/2026-07-09-run-ledger-digest-design.md` section by section against `git diff main...HEAD`; confirm each spec section maps to shipped code (watermark §1, ledger §2, renderer §3, retirement §4, shared assembly §5, deep link §6, tests §7). Fix any gap found.

- [ ] **Step 4: Final commit** of any stragglers (CLAUDE.md wording, comments): `git commit -m "chore(digest): verification sweep"` — only if changes exist.
