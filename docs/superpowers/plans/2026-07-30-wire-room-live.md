# The Wire Room Live — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a public, animated page that renders the wire-room-ops pipeline as a live 32-bit pixel-art monitoring room, fed by a narrow snapshot that cannot leak private data.

**Architecture:** A publisher inside `wire-room-ops` runs on the existing 5-minute `process-raw` interval, projects six narrow queries into an ~8 KB `snapshot.json`, and **pushes** it outbound to a tiny Cloudflare Worker. The Worker stores it and serves it publicly with cache headers. A separate static repo, `wire-room-live`, fetches that JSON and animates the room. The public tier holds no credentials and speaks no SQL; `wire-room-ops` gains no new inbound surface — it only makes an outbound POST.

**Tech Stack:** TypeScript throughout. Producer: existing Express/`pg` app, no new runtime dependencies. Consumer: Vite + TypeScript, no UI framework, plain CSS. Tests: `node --test` with `ts-node/register/transpile-only` (matches the existing repo idiom). Anchor verification uses `pngjs` (devDependency).

**Spec:** `docs/superpowers/specs/2026-07-29-wire-room-live-design.md`

## Status

**Phase 1 (producer) — COMPLETE, 2026-07-30**, on branch `feat/wire-room-live`.
465 tests passing (up from a 435 baseline), typecheck clean, nothing deployed.

| Task | Commit |
|---|---|
| 1 · types + leak-proof builder | `3fc838a` |
| 2 · shape and arithmetic tests | `6140027` |
| 3 · queries + outbound push | `808e684` |
| 3b · assertion, contract test, digest lane | `4e72ed2` |
| — · deps injection + end-to-end test | `9e53034` |

**Deviations from plan, and why:**

1. **`assertSnapshotShape` landed in Task 3, not 3b.** Wiring the push first and adding
   the guard afterwards would have left a window where an unvalidated payload could ship.
2. **The `unconfigured` result is not recorded to `app_state`.** The plan said to record every
   outcome. In practice that meant a wasted DB write every 5 minutes forever, for a state that
   never changes and that the digest explicitly ignores. Found by running the verification step.
3. **`gatherSnapshotInput` now takes injected `SnapshotDeps`.** The end-to-end test exposed that
   it accepted a `pool` argument but reached for the *global* pool for the week-number read —
   identical in production, but inconsistent and untestable.
4. **Added `tests/public-snapshot-pipeline.test.js`** (not in the plan). Nothing else pinned the
   query aliases to what the builder reads; a typo'd `AS n` would have surfaced only in production.
5. **Contract-test regexes needed two fixes**, both false positives on my own source: `EXTRACT(minute
   FROM created_at)` matched the `FROM <table>` pattern, and a doc comment reading *"no SELECT \*,
   ever"* matched the `SELECT *` check. The test now strips comments and anchors `FROM` to line starts.
   Verified by negative control: injecting `SELECT *` and swapping in `org_profiles` each make it fail.

**Phase 2 (consumer) is not started** and is deliberately paused — the visual direction is unsettled.
Nothing in Phase 1 depends on how the page eventually looks. Note the anchor values in Task 9 name
backplate **B**; the current candidate is **32-BIT A** (`assets/wire-room-live/room.png`), and its
measured anchors live in `assets/wire-room-live/prototype-build.py`.

## Global Constraints

- **Never spread a database row into snapshot output.** Every output object is constructed field by field from an explicit allowlist. This is the single rule the leak test enforces.
- **Only `kind: "publish"` events may carry an `item`**, and only for rows with a successful `distribution_logs` Telegram send. All other events carry counts only.
- **Allowlisted item fields, exhaustive:** `name`, `amount`, `wire`, `url`. Forbidden anywhere in output: `description`, `quality_score`, `classification`, `operator_route`, `actioned_by`, `action_reason`, `org_id`, `metadata`, and anything from `api_usage_log`, `org_profiles`, or `discovered_contacts`.
- **No new cron.** The publisher hangs off the existing 5-minute pipeline cycle in `src/server.ts`.
- **The publisher must never throw into the pipeline cycle.** It logs and returns a result object; a failure cannot block `process-raw` or `decided-recheck`.
- **Publisher no-ops when unconfigured.** If `SNAPSHOT_PUSH_URL` or `SNAPSHOT_PUSH_TOKEN` is unset, it returns `{ ok: false, reason: 'unconfigured' }` without erroring, so the change is safe to deploy before Cloudflare exists.
- **Snapshot version is `1`.** The consumer refuses any payload whose `v` differs and keeps its last good copy.
- **Palette:** `#05070d` background, `#0b1220` walls, `#00eaff` cyan, `#ffb347` amber, `#ff5f56` red, `#5ce89a` green.
- **Backplate:** `room-v5-b.png` (32-bit pixel art). Regenerate with `prompt-room-v5.txt`.
- **Existing test command:** `npm test` runs `node --test tests/**/*.test.js` from the repo root.

---

## File Structure

### Phase 1 — Producer, inside `wire-room-ops`

| File | Responsibility |
|---|---|
| `src/types/public-snapshot.ts` | Snapshot types and `SNAPSHOT_VERSION`. No logic. |
| `src/services/public-snapshot.ts` | Pure builder: raw query rows → validated snapshot. No DB, no I/O — this is what the leak test exercises. |
| `src/jobs/public-snapshot.ts` | The six queries, plus the outbound push. |
| `tests/public-snapshot-leak.test.js` | Poisoned fixtures; asserts no forbidden string reaches output. |
| `tests/public-snapshot-build.test.js` | Shape, funnel arithmetic, event ordering, version guard. |
| `src/server.ts` (modify) | Add the publisher to `runPipelineCycle`. |
| `src/config/index.ts` (modify) | `SNAPSHOT_PUSH_URL`, `SNAPSHOT_PUSH_TOKEN`. |
| `.env.example` (modify) | Document both. |

### Phase 2 — Consumer, new repo `wire-room-live`

| File | Responsibility |
|---|---|
| `worker/snapshot-worker.js` | Cloudflare Worker: authenticated PUT, public GET. |
| `src/types.ts` | Snapshot types (mirrors producer) + `SNAPSHOT_VERSION`. |
| `src/snapshot.ts` | Validate a payload; fetch + poll + last-good cache. |
| `src/anchors.ts` | Per-backplate anchor maps. Data only. |
| `src/path.ts` | Polyline with arc-length parameterisation. |
| `src/tape.ts` | Events → loop schedule with minimum spacing. |
| `src/items.ts` | Item fates: exit points, targets, positions. |
| `src/scene.ts` | DOM overlay rendering: board, coverage, stations, ticker, badge. |
| `src/main.ts` | Wiring and the animation frame loop. |
| `src/style.css` | All styling. |
| `public/room.jpg` | The backplate. |
| `scripts/verify-anchors.mjs` | Samples the PNG under each anchor; fails on drift. |
| `tests/*.test.js` | Unit tests per module. |

---

## Phase 1 — Producer

### Task 1: Snapshot types and the pure builder

**Files:**
- Create: `src/types/public-snapshot.ts`
- Create: `src/services/public-snapshot.ts`
- Test: `tests/public-snapshot-leak.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `SNAPSHOT_VERSION: 1`; types `PublicSnapshot`, `SnapshotInput`, `FunnelRow`, `PublishRow`, `BucketRow`, `StationRow`, `CoverageRow`; function `buildPublicSnapshot(input: SnapshotInput, generatedAt: Date): PublicSnapshot`.

- [ ] **Step 1: Write the failing leak test**

Create `tests/public-snapshot-leak.test.js`:

```js
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPublicSnapshot } = require('../src/services/public-snapshot');

// Every value below is a canary. If any appears in the serialised snapshot,
// the projection leaked a field it was never allowed to emit.
const POISON = {
  email: 'canary-person@example.com',
  operatorRead: 'CANARY they have no grants lead, Sov could run it',
  declineReason: 'CANARY declined, funder is hostile',
  description: 'CANARY long internal description',
  actor: 'CANARY agent:stringer',
};

const INPUT = {
  funnel: [
    { status: 'duplicate', n: 143 },
    { status: 'queued', n: 41 },
    { status: 'archived', n: 60 },
    { status: 'incomplete', n: 8 },
    { status: 'approved', n: 20 },
  ],
  buckets: [
    { bucket: new Date('2026-07-30T02:00:00Z'), status: 'duplicate', n: 6 },
    { bucket: new Date('2026-07-30T02:00:00Z'), status: 'queued', n: 4 },
  ],
  publishes: [
    {
      created_at: new Date('2026-07-30T02:33:00Z'),
      name: 'NLnet Commons Fund',
      amount: '€50k',
      wire: 'oss',
      external_id: '4821',
      // fields the projection must ignore even though they are present:
      description: POISON.description,
      quality_score: 91,
      classification: 'GRANT',
      operator_route: 'publish',
      actioned_by: POISON.actor,
      action_reason: POISON.declineReason,
      org_id: 77,
      operator_read: POISON.operatorRead,
      contact_email: POISON.email,
    },
  ],
  stations: [
    { id: 'stringer', last_run_at: new Date('2026-07-30T02:14:00Z'), items_touched: 34 },
  ],
  coverage: { total: 1136, fresh: 412, dark: 204 },
  desk: { weekNumber: 30, wires: ['crypto', 'ai', 'oss'] },
  telegramBase: 'https://t.me/thegrantwire',
};

test('no poisoned value survives the projection', () => {
  const snap = buildPublicSnapshot(INPUT, new Date('2026-07-30T02:41:00Z'));
  const json = JSON.stringify(snap);
  for (const [label, value] of Object.entries(POISON)) {
    assert.ok(!json.includes(value), `leaked ${label}: ${value}`);
  }
  assert.ok(!json.includes('CANARY'), 'a canary string survived');
});

test('forbidden keys never appear anywhere in the output tree', () => {
  const snap = buildPublicSnapshot(INPUT, new Date('2026-07-30T02:41:00Z'));
  const FORBIDDEN = [
    'description', 'quality_score', 'classification', 'operator_route',
    'actioned_by', 'action_reason', 'org_id', 'metadata', 'operator_read',
    'contact_email', 'cost', 'email',
  ];
  const keys = new Set();
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) { keys.add(k); walk(node[k]); }
    }
  })(snap);
  for (const k of FORBIDDEN) assert.ok(!keys.has(k), `forbidden key present: ${k}`);
});

test('published item carries exactly the four allowlisted fields', () => {
  const snap = buildPublicSnapshot(INPUT, new Date('2026-07-30T02:41:00Z'));
  const pub = snap.events.find(e => e.kind === 'publish');
  assert.ok(pub, 'expected a publish event');
  assert.deepEqual(Object.keys(pub.item).sort(), ['amount', 'name', 'url', 'wire']);
});

test('non-publish events never carry an item', () => {
  const snap = buildPublicSnapshot(INPUT, new Date('2026-07-30T02:41:00Z'));
  for (const e of snap.events) {
    if (e.kind !== 'publish') assert.equal(e.item, undefined, `${e.kind} carried an item`);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- --test-name-pattern="poisoned"`
Expected: FAIL — `Cannot find module '../src/services/public-snapshot'`

- [ ] **Step 3: Write the types**

Create `src/types/public-snapshot.ts`:

```ts
/**
 * The public projection contract. Anything not declared here cannot reach the
 * open internet — see src/services/public-snapshot.ts, which constructs every
 * object literally rather than spreading database rows.
 */
export const SNAPSHOT_VERSION = 1 as const;

export type EventKind = 'run' | 'dedup' | 'archive' | 'queue' | 'publish';

/** The ONLY shape allowed to carry text from an entry, and only once published. */
export interface PublicItem {
  name: string;
  amount: string | null;
  wire: string;
  url: string;
}

export interface PublicEvent {
  at: string;            // ISO 8601
  kind: EventKind;
  station?: string;      // 'run' only
  n?: number;            // counts for non-publish kinds
  item?: PublicItem;     // publish only
}

export interface PublicSnapshot {
  v: typeof SNAPSHOT_VERSION;
  generatedAt: string;
  windowHours: number;
  desk: { surfacesWatched: number; weekNumber: number; wires: string[] };
  funnel: { stage: string; count: number }[];
  stations: { id: string; state: 'idle' | 'running'; lastRunAt: string | null; itemsTouched: number }[];
  coverage: { total: number; fresh: number; dark: number };
  events: PublicEvent[];
}

// ── raw query row shapes (input side) ────────────────────────────────────────
export interface FunnelRow { status: string; n: number }
export interface BucketRow { bucket: Date; status: string; n: number }
export interface StationRow { id: string; last_run_at: Date | null; items_touched: number }
export interface CoverageRow { total: number; fresh: number; dark: number }

/** Rows may carry any number of extra private columns; the builder ignores them. */
export interface PublishRow {
  created_at: Date;
  name: string;
  amount: string | null;
  wire: string;
  external_id: string | null;
  [extra: string]: unknown;
}

export interface SnapshotInput {
  funnel: FunnelRow[];
  buckets: BucketRow[];
  publishes: PublishRow[];
  stations: StationRow[];
  coverage: CoverageRow;
  desk: { weekNumber: number; wires: string[] };
  telegramBase: string;
}
```

- [ ] **Step 4: Write the builder**

Create `src/services/public-snapshot.ts`:

```ts
import {
  SNAPSHOT_VERSION, type BucketRow, type PublicEvent, type PublicItem,
  type PublicSnapshot, type PublishRow, type SnapshotInput,
} from '../types/public-snapshot';

const WINDOW_HOURS = 24;
const RUNNING_WITHIN_MS = 10 * 60 * 1000;

/** Statuses that mean "this never reached a human". */
const ARCHIVED_STATUSES = new Set(['archived', 'incomplete', 'skipped']);

/**
 * Build a published item. Constructed field by field on purpose — spreading the
 * row is what leaks, and the row legitimately carries private columns.
 */
function toItem(row: PublishRow, telegramBase: string): PublicItem {
  return {
    name: String(row.name ?? '').slice(0, 120),
    amount: row.amount == null ? null : String(row.amount).slice(0, 40),
    wire: String(row.wire ?? ''),
    url: row.external_id ? `${telegramBase}/${row.external_id}` : telegramBase,
  };
}

function bucketKind(status: string): PublicEvent['kind'] | null {
  if (status === 'duplicate') return 'dedup';
  if (ARCHIVED_STATUSES.has(status)) return 'archive';
  if (status === 'queued') return 'queue';
  return null;
}

export function buildPublicSnapshot(input: SnapshotInput, generatedAt: Date): PublicSnapshot {
  const byStatus = new Map(input.funnel.map(r => [r.status, Number(r.n) || 0]));
  const sum = (...keys: string[]) => keys.reduce((t, k) => t + (byStatus.get(k) ?? 0), 0);

  const scanned = [...byStatus.values()].reduce((t, n) => t + n, 0);
  const funnel = [
    { stage: 'scanned', count: scanned },
    { stage: 'duplicate', count: sum('duplicate') },
    { stage: 'archived', count: sum('archived', 'incomplete', 'skipped') },
    { stage: 'review', count: sum('queued') },
    { stage: 'published', count: input.publishes.length },
  ];

  const events: PublicEvent[] = [];

  // One synthetic 'run' event per bucket that saw any activity, so the room has
  // a heartbeat even when nothing published.
  const runTotals = new Map<number, number>();
  for (const b of input.buckets as BucketRow[]) {
    runTotals.set(b.bucket.getTime(), (runTotals.get(b.bucket.getTime()) ?? 0) + (Number(b.n) || 0));
  }
  for (const [ms, n] of runTotals) {
    events.push({ at: new Date(ms).toISOString(), kind: 'run', station: 'stringer', n });
  }
  for (const b of input.buckets as BucketRow[]) {
    const kind = bucketKind(b.status);
    if (!kind) continue;
    events.push({ at: new Date(b.bucket.getTime() + 60_000).toISOString(), kind, n: Number(b.n) || 0 });
  }
  for (const p of input.publishes) {
    events.push({ at: p.created_at.toISOString(), kind: 'publish', item: toItem(p, input.telegramBase) });
  }
  events.sort((a, b) => a.at.localeCompare(b.at));

  const stations = input.stations.map(s => ({
    id: String(s.id),
    state: (s.last_run_at && generatedAt.getTime() - s.last_run_at.getTime() < RUNNING_WITHIN_MS
      ? 'running' : 'idle') as 'idle' | 'running',
    lastRunAt: s.last_run_at ? s.last_run_at.toISOString() : null,
    itemsTouched: Number(s.items_touched) || 0,
  }));

  return {
    v: SNAPSHOT_VERSION,
    generatedAt: generatedAt.toISOString(),
    windowHours: WINDOW_HOURS,
    desk: {
      surfacesWatched: Number(input.coverage.total) || 0,
      weekNumber: Number(input.desk.weekNumber) || 0,
      wires: input.desk.wires.map(String),
    },
    funnel,
    stations,
    coverage: {
      total: Number(input.coverage.total) || 0,
      fresh: Number(input.coverage.fresh) || 0,
      dark: Number(input.coverage.dark) || 0,
    },
    events,
  };
}
```

- [ ] **Step 5: Run the leak test to verify it passes**

Run: `npm test -- --test-name-pattern="poison|forbidden|allowlisted|non-publish"`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/types/public-snapshot.ts src/services/public-snapshot.ts tests/public-snapshot-leak.test.js
git commit -m "feat(public-snapshot): leak-proof projection builder with poisoned-fixture test"
```

---

### Task 2: Builder shape and arithmetic tests

**Files:**
- Test: `tests/public-snapshot-build.test.js`

**Interfaces:**
- Consumes: `buildPublicSnapshot`, `SNAPSHOT_VERSION` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

Create `tests/public-snapshot-build.test.js`:

```js
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPublicSnapshot } = require('../src/services/public-snapshot');
const { SNAPSHOT_VERSION } = require('../src/types/public-snapshot');

const NOW = new Date('2026-07-30T02:41:00Z');
const base = (over = {}) => ({
  funnel: [
    { status: 'duplicate', n: 10 },
    { status: 'queued', n: 4 },
    { status: 'archived', n: 5 },
    { status: 'incomplete', n: 1 },
  ],
  buckets: [],
  publishes: [],
  stations: [],
  coverage: { total: 1136, fresh: 412, dark: 204 },
  desk: { weekNumber: 30, wires: ['crypto', 'ai', 'oss'] },
  telegramBase: 'https://t.me/thegrantwire',
  ...over,
});

test('version is stamped', () => {
  assert.equal(buildPublicSnapshot(base(), NOW).v, SNAPSHOT_VERSION);
});

test('scanned equals the sum of every status bucket', () => {
  const snap = buildPublicSnapshot(base(), NOW);
  const stage = k => snap.funnel.find(f => f.stage === k).count;
  assert.equal(stage('scanned'), 20);
  assert.equal(stage('duplicate'), 10);
  assert.equal(stage('archived'), 6);   // archived + incomplete
  assert.equal(stage('review'), 4);
});

test('published count comes from distribution rows, not entry status', () => {
  const snap = buildPublicSnapshot(base({
    publishes: [
      { created_at: new Date('2026-07-30T01:00:00Z'), name: 'A', amount: null, wire: 'oss', external_id: '1' },
      { created_at: new Date('2026-07-30T02:00:00Z'), name: 'B', amount: '$1M', wire: 'ai', external_id: '2' },
    ],
  }), NOW);
  assert.equal(snap.funnel.find(f => f.stage === 'published').count, 2);
});

test('events are sorted ascending by time', () => {
  const snap = buildPublicSnapshot(base({
    publishes: [
      { created_at: new Date('2026-07-30T05:00:00Z'), name: 'late', amount: null, wire: 'ai', external_id: '9' },
      { created_at: new Date('2026-07-30T01:00:00Z'), name: 'early', amount: null, wire: 'ai', external_id: '8' },
    ],
  }), NOW);
  const times = snap.events.map(e => e.at);
  assert.deepEqual(times, [...times].sort());
});

test('a bucket produces a run event plus one event per mapped status', () => {
  const b = new Date('2026-07-30T02:00:00Z');
  const snap = buildPublicSnapshot(base({
    buckets: [
      { bucket: b, status: 'duplicate', n: 6 },
      { bucket: b, status: 'queued', n: 4 },
      { bucket: b, status: 'raw', n: 2 },   // no mapped kind
    ],
  }), NOW);
  const kinds = snap.events.map(e => e.kind).sort();
  assert.deepEqual(kinds, ['dedup', 'queue', 'run']);
  assert.equal(snap.events.find(e => e.kind === 'run').n, 12);  // 6+4+2
});

test('station is running only when its last run is recent', () => {
  const snap = buildPublicSnapshot(base({
    stations: [
      { id: 'stringer', last_run_at: new Date('2026-07-30T02:38:00Z'), items_touched: 34 },
      { id: 'classifier', last_run_at: new Date('2026-07-30T01:00:00Z'), items_touched: 12 },
      { id: 'dedup', last_run_at: null, items_touched: 0 },
    ],
  }), NOW);
  const byId = Object.fromEntries(snap.stations.map(s => [s.id, s.state]));
  assert.equal(byId.stringer, 'running');
  assert.equal(byId.classifier, 'idle');
  assert.equal(byId.dedup, 'idle');
});

test('telegram url is built from external_id, falling back to the channel', () => {
  const snap = buildPublicSnapshot(base({
    publishes: [
      { created_at: NOW, name: 'A', amount: null, wire: 'oss', external_id: '4821' },
      { created_at: NOW, name: 'B', amount: null, wire: 'oss', external_id: null },
    ],
  }), NOW);
  const urls = snap.events.filter(e => e.kind === 'publish').map(e => e.item.url);
  assert.deepEqual(urls, ['https://t.me/thegrantwire/4821', 'https://t.me/thegrantwire']);
});

test('oversized name and amount are truncated', () => {
  const snap = buildPublicSnapshot(base({
    publishes: [{ created_at: NOW, name: 'x'.repeat(400), amount: 'y'.repeat(200), wire: 'ai', external_id: '1' }],
  }), NOW);
  const item = snap.events.find(e => e.kind === 'publish').item;
  assert.equal(item.name.length, 120);
  assert.equal(item.amount.length, 40);
});
```

- [ ] **Step 2: Run to verify**

Run: `npm test -- --test-name-pattern="version|scanned|published count|sorted|bucket produces|station is running|telegram url|truncated"`
Expected: PASS, 8 tests. If any fail, fix `src/services/public-snapshot.ts` — the tests are the specification.

- [ ] **Step 3: Commit**

```bash
git add tests/public-snapshot-build.test.js
git commit -m "test(public-snapshot): shape, funnel arithmetic, event ordering, station state"
```

---

### Task 3: Queries and the outbound push

**Files:**
- Create: `src/jobs/public-snapshot.ts`
- Modify: `src/config/index.ts`
- Modify: `.env.example`
- Modify: `src/server.ts` (inside `runPipelineCycle`, around line 326)

**Interfaces:**
- Consumes: `buildPublicSnapshot` (Task 1); `getPool`, `getAppState` from `src/db/index.ts`; `config` from `src/config/index.ts`.
- Produces: `gatherSnapshotInput(pool): Promise<SnapshotInput>`; `publishPublicSnapshot(pool): Promise<PublishResult>` where `PublishResult = { ok: boolean; reason?: string; bytes?: number }`.

- [ ] **Step 1: Add config**

In `src/config/index.ts`, inside the exported `config` object, add:

```ts
  publicSnapshot: {
    pushUrl: process.env.SNAPSHOT_PUSH_URL || '',
    pushToken: process.env.SNAPSHOT_PUSH_TOKEN || '',
    telegramBase: process.env.SNAPSHOT_TELEGRAM_BASE || 'https://t.me/thegrantwire',
  },
```

In `.env.example`, add:

```
# Public snapshot push (the Wire Room Live page). Both must be set or the
# publisher no-ops. The target is a Cloudflare Worker that stores the JSON and
# serves it publicly; wire-room-ops only ever makes an outbound request.
SNAPSHOT_PUSH_URL=
SNAPSHOT_PUSH_TOKEN=
SNAPSHOT_TELEGRAM_BASE=https://t.me/thegrantwire
```

- [ ] **Step 2: Write the job**

Create `src/jobs/public-snapshot.ts`:

```ts
import type { Pool } from 'pg';
import { config } from '../config';
import { getAppState } from '../db';
import { buildPublicSnapshot } from '../services/public-snapshot';
import type { SnapshotInput } from '../types/public-snapshot';

export interface PublishResult { ok: boolean; reason?: string; bytes?: number }

/** Six narrow queries. Every SELECT names its columns — no SELECT *, ever. */
export async function gatherSnapshotInput(pool: Pool): Promise<SnapshotInput> {
  const [funnel, buckets, publishes, stations, coverage, week] = await Promise.all([
    pool.query(`
      SELECT status, COUNT(*)::int AS n
      FROM scan_entries
      WHERE created_at >= NOW() - INTERVAL '24 hours'
      GROUP BY status`),
    pool.query(`
      SELECT date_trunc('hour', created_at)
               + INTERVAL '15 minutes' * FLOOR(EXTRACT(minute FROM created_at) / 15) AS bucket,
             status, COUNT(*)::int AS n
      FROM scan_entries
      WHERE created_at >= NOW() - INTERVAL '24 hours'
      GROUP BY 1, 2
      ORDER BY 1`),
    pool.query(`
      SELECT dl.created_at, dl.external_id, dl.wire, se.name, se.amount
      FROM distribution_logs dl
      JOIN scan_entries se ON se.id = dl.entry_id
      WHERE dl.channel = 'telegram' AND dl.status = 'success'
        AND dl.created_at >= NOW() - INTERVAL '24 hours'
      ORDER BY dl.created_at`),
    pool.query(`
      SELECT 'stringer'::text AS id, MAX(created_at) AS last_run_at, COUNT(*)::int AS items_touched
      FROM scan_entries WHERE created_at >= NOW() - INTERVAL '24 hours'
      UNION ALL
      SELECT 'dedup', MAX(updated_at), COUNT(*)::int
      FROM scan_entries
      WHERE status = 'duplicate' AND updated_at >= NOW() - INTERVAL '24 hours'
      UNION ALL
      SELECT 'classifier', MAX(updated_at), COUNT(*)::int
      FROM scan_entries
      WHERE classification IS NOT NULL AND classification <> 'UNCHECKED'
        AND updated_at >= NOW() - INTERVAL '24 hours'`),
    pool.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE last_changed_at >= NOW() - INTERVAL '30 days')::int AS fresh,
             COUNT(*) FILTER (WHERE last_checked_at IS NULL
                                 OR last_checked_at < NOW() - INTERVAL '30 days')::int AS dark
      FROM watch_surfaces WHERE status = 'active'`),
    getAppState<number>('weekly:week-number'),
  ]);

  return {
    funnel: funnel.rows.map(r => ({ status: r.status, n: r.n })),
    buckets: buckets.rows.map(r => ({ bucket: new Date(r.bucket), status: r.status, n: r.n })),
    publishes: publishes.rows.map(r => ({
      created_at: new Date(r.created_at),
      name: r.name, amount: r.amount, wire: r.wire, external_id: r.external_id,
    })),
    stations: stations.rows.map(r => ({
      id: r.id,
      last_run_at: r.last_run_at ? new Date(r.last_run_at) : null,
      items_touched: r.items_touched,
    })),
    coverage: coverage.rows[0] ?? { total: 0, fresh: 0, dark: 0 },
    desk: { weekNumber: Number(week) || 0, wires: ['crypto', 'ai', 'oss'] },
    telegramBase: config.publicSnapshot.telegramBase,
  };
}

/**
 * Gather → build → push. Never throws: the caller runs inside the 5-minute
 * pipeline cycle and a broken publisher must not stop process-raw.
 */
export async function publishPublicSnapshot(pool: Pool): Promise<PublishResult> {
  const { pushUrl, pushToken } = config.publicSnapshot;
  if (!pushUrl || !pushToken) return { ok: false, reason: 'unconfigured' };

  try {
    const input = await gatherSnapshotInput(pool);
    const snapshot = buildPublicSnapshot(input, new Date());
    const body = JSON.stringify(snapshot);

    const res = await fetch(pushUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${pushToken}`,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      console.error(`[PublicSnapshot] push failed: HTTP ${res.status}`);
      return { ok: false, reason: `http_${res.status}` };
    }
    console.log(`[PublicSnapshot] published ${body.length} bytes, ${snapshot.events.length} events`);
    return { ok: true, bytes: body.length };
  } catch (error) {
    console.error('[PublicSnapshot] publish failed:', error);
    return { ok: false, reason: 'exception' };
  }
}
```

- [ ] **Step 3: Wire it into the existing 5-minute cycle**

In `src/server.ts`, add the import beside the others near line 15:

```ts
import { publishPublicSnapshot } from './jobs/public-snapshot';
```

Then extend `runPipelineCycle` (currently ends at line 337) so the publisher runs after the pipeline has settled, in its own try/catch:

```ts
    // Public snapshot for the Wire Room Live page. Runs last so it always sees
    // the state this cycle produced, and is isolated so a push failure can
    // never stop process-raw or decided-recheck. No new cron — folded in.
    try {
      await publishPublicSnapshot(getPool());
    } catch (error) {
      console.error('[PublicSnapshot] Scheduled run failed:', error);
    }
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: exit code 0, no output. **Check the exit code explicitly** — never pipe `tsc` through `head` or `grep`, which masks a non-zero exit:

```bash
npm run typecheck; echo "exit=$?"
```

- [ ] **Step 5: Verify the publisher no-ops when unconfigured**

Run:

```bash
node -e "
require('ts-node/register/transpile-only');
const { publishPublicSnapshot } = require('./src/jobs/public-snapshot');
publishPublicSnapshot(null).then(r => {
  console.log(JSON.stringify(r));
  if (r.reason !== 'unconfigured') { console.error('FAIL: expected unconfigured'); process.exit(1); }
  console.log('OK: no-ops safely without env vars');
});
"
```

Expected: `{"ok":false,"reason":"unconfigured"}` then `OK`. It must not touch the database — that is why passing `null` for the pool is safe.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: all tests pass, including the pre-existing suite.

- [ ] **Step 7: Commit**

```bash
git add src/jobs/public-snapshot.ts src/config/index.ts .env.example src/server.ts
git commit -m "feat(public-snapshot): queries + outbound push, folded into the 5-min pipeline cycle"
```

---

### Task 3b: Column contract, output assertion, and digest visibility

Three spec requirements that Task 3 left open: the producer must assert its own output before pushing, a renamed column must fail a test rather than production, and a broken publisher must surface in the morning digest instead of only in logs.

**Files:**
- Modify: `src/services/public-snapshot.ts` (add `assertSnapshotShape`)
- Modify: `src/jobs/public-snapshot.ts` (assert before push; persist result)
- Modify: `src/jobs/daily-digest.ts:473` (add a ledger lane)
- Test: `tests/public-snapshot-contract.test.js`

**Interfaces:**
- Consumes: `buildPublicSnapshot` (Task 1); `getAppState`/`setAppState` from `src/db/index.ts`; `RunLedgerLane` from `src/services/email.ts`.
- Produces: `assertSnapshotShape(snap: PublicSnapshot): void` (throws on violation); app_state key `public-snapshot:last` holding `{ ok: boolean; at: string; reason?: string; bytes?: number }`.

- [ ] **Step 1: Write the failing contract test**

Create `tests/public-snapshot-contract.test.js`:

```js
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertSnapshotShape, buildPublicSnapshot } = require('../src/services/public-snapshot');

const JOB = fs.readFileSync(path.join(__dirname, '../src/jobs/public-snapshot.ts'), 'utf8');

// The projection is only safe if the queries stay narrow. These assertions are
// the wire-room-ops half of the leak guarantee: the builder cannot omit a column
// it was never handed.
test('no SELECT * anywhere in the snapshot queries', () => {
  assert.ok(!/SELECT\s+\*/i.test(JOB), 'SELECT * would hand private columns to the builder');
});

test('snapshot queries never name a forbidden column', () => {
  const FORBIDDEN = [
    'operator_read', 'contacts_checked_at', 'action_reason', 'actioned_by',
    'quality_score', 'operator_route', 'api_key', 'discovered_contacts',
    'api_usage_log', 'org_profiles',
  ];
  for (const col of FORBIDDEN) {
    assert.ok(!JOB.includes(col), `snapshot query references forbidden identifier: ${col}`);
  }
});

test('queries only touch the four tables the projection is allowed to read', () => {
  const tables = [...JOB.matchAll(/\bFROM\s+([a-z_]+)/gi)].map(m => m[1].toLowerCase());
  const ALLOWED = new Set(['scan_entries', 'distribution_logs', 'watch_surfaces']);
  for (const t of tables) assert.ok(ALLOWED.has(t), `unexpected table in snapshot query: ${t}`);
});

const valid = () => buildPublicSnapshot({
  funnel: [{ status: 'queued', n: 1 }],
  buckets: [], publishes: [], stations: [],
  coverage: { total: 1, fresh: 1, dark: 0 },
  desk: { weekNumber: 30, wires: ['ai'] },
  telegramBase: 'https://t.me/x',
}, new Date('2026-07-30T00:00:00Z'));

test('a well-formed snapshot passes the output assertion', () => {
  assert.doesNotThrow(() => assertSnapshotShape(valid()));
});

test('the assertion rejects a forbidden key smuggled into the tree', () => {
  const bad = valid();
  bad.events.push({ at: '2026-07-30T00:00:00Z', kind: 'queue', n: 1, actioned_by: 'agent:stringer' });
  assert.throws(() => assertSnapshotShape(bad), /forbidden key/i);
});

test('the assertion rejects an item on a non-publish event', () => {
  const bad = valid();
  bad.events.push({ at: '2026-07-30T00:00:00Z', kind: 'dedup', n: 2, item: { name: 'X', amount: null, wire: 'ai', url: 'u' } });
  assert.throws(() => assertSnapshotShape(bad), /only publish events/i);
});

test('the assertion rejects an oversized payload', () => {
  const bad = valid();
  bad.events = Array.from({ length: 60000 }, () => ({ at: '2026-07-30T00:00:00Z', kind: 'queue', n: 1 }));
  assert.throws(() => assertSnapshotShape(bad), /too large/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern="SELECT|forbidden|four tables|assertion"`
Expected: FAIL — `assertSnapshotShape is not a function`.

- [ ] **Step 3: Implement the assertion**

Append to `src/services/public-snapshot.ts`:

```ts
const FORBIDDEN_KEYS = new Set([
  'description', 'quality_score', 'classification', 'operator_route',
  'actioned_by', 'action_reason', 'org_id', 'metadata', 'operator_read',
  'contact_email', 'email', 'cost',
]);
const MAX_BYTES = 512 * 1024;

/**
 * Last line of defence before the payload leaves the building. The builder is
 * already explicit, but this catches a future edit that reintroduces a spread.
 */
export function assertSnapshotShape(snap: PublicSnapshot): void {
  (function walk(node: unknown): void {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (FORBIDDEN_KEYS.has(k)) throw new Error(`snapshot contains forbidden key: ${k}`);
        walk(v);
      }
    }
  })(snap);

  for (const e of snap.events) {
    if (e.item && e.kind !== 'publish') {
      throw new Error(`only publish events may carry an item (saw ${e.kind})`);
    }
    if (e.item) {
      const keys = Object.keys(e.item).sort().join(',');
      if (keys !== 'amount,name,url,wire') {
        throw new Error(`publish item has unexpected fields: ${keys}`);
      }
    }
  }

  const bytes = JSON.stringify(snap).length;
  if (bytes > MAX_BYTES) throw new Error(`snapshot too large: ${bytes} bytes`);
}
```

- [ ] **Step 4: Assert before pushing, and record the result**

In `src/jobs/public-snapshot.ts`, add `assertSnapshotShape` to the import from `../services/public-snapshot`, add `setAppState` to the import from `../db`, and change the body of `publishPublicSnapshot`'s `try` block so the assertion runs before the network call, and every outcome is persisted:

```ts
    const input = await gatherSnapshotInput(pool);
    const snapshot = buildPublicSnapshot(input, new Date());
    assertSnapshotShape(snapshot);          // refuse to publish a violating payload
    const body = JSON.stringify(snapshot);
```

and replace each `return` with a recorded result. Add this helper above `publishPublicSnapshot`:

```ts
async function record(result: PublishResult): Promise<PublishResult> {
  try {
    await setAppState('public-snapshot:last', { ...result, at: new Date().toISOString() });
  } catch { /* recording failure must not mask the real result */ }
  return result;
}
```

Then every `return { ... }` inside `publishPublicSnapshot` becomes `return record({ ... })`, including the `unconfigured` early return.

- [ ] **Step 5: Surface it in the daily digest**

In `src/jobs/daily-digest.ts`, immediately before `return { ledger: { lanes }, anomalies };` at line 473, add:

```ts
  // The public snapshot is a lane like any other: if the Wire Room Live page has
  // gone stale, it shows up in the morning band instead of only in the logs.
  try {
    const last = await getAppState<{ ok: boolean; at: string; reason?: string }>('public-snapshot:last');
    if (last && last.reason !== 'unconfigured') {
      const ageMin = (Date.now() - Date.parse(last.at)) / 60000;
      if (!last.ok) {
        lanes.push({ key: 'snapshot', state: 'fail', detail: `snapshot ✗ ${last.reason ?? 'error'}` });
        anomalies.push(`Public snapshot failing (${last.reason ?? 'error'}) — the Wire Room Live page is serving stale data.`);
      } else if (ageMin > 30) {
        lanes.push({ key: 'snapshot', state: 'warn', detail: `snapshot ${Math.round(ageMin)}m old` });
      } else {
        lanes.push({ key: 'snapshot', state: 'ok', detail: 'snapshot ✓' });
      }
    }
  } catch {
    lanes.push({ key: 'snapshot', state: 'warn', detail: 'snapshot ?' });
  }
```

Two things to confirm before running the typecheck:
- `getAppState` is imported in `daily-digest.ts` — add it to the existing `../db` import if not.
- The enclosing function is `async`. It already awaits elsewhere in the ledger build, but check:
  if it is not, the `await getAppState(...)` will not compile.

- [ ] **Step 6: Run everything**

```bash
npm run typecheck; echo "typecheck exit=$?"
npm test; echo "test exit=$?"
```

Both must exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/services/public-snapshot.ts src/jobs/public-snapshot.ts src/jobs/daily-digest.ts tests/public-snapshot-contract.test.js
git commit -m "feat(public-snapshot): output assertion, column-contract test, digest ledger lane"
```

---

## Phase 2 — Consumer

### Task 4: The Cloudflare Worker and repo scaffold

**Files:**
- Create: `wire-room-live/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `.gitignore`
- Create: `wire-room-live/worker/snapshot-worker.js`
- Create: `wire-room-live/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a Worker exposing `PUT /snapshot.json` (bearer-authenticated) and `GET /snapshot.json` (public); an npm project with `dev`, `build`, `test`, `verify:anchors` scripts.

- [ ] **Step 1: Create the repo and scaffold**

```bash
mkdir -p "$HOME/Documents/Sovereign Signal/repos/wire-room-live"
cd "$HOME/Documents/Sovereign Signal/repos/wire-room-live"
git init
mkdir -p src tests public worker scripts
```

Create `package.json`:

```json
{
  "name": "wire-room-live",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "node --test tests/*.test.js",
    "verify:anchors": "node scripts/verify-anchors.mjs",
    "check": "npm run typecheck && npm test && npm run verify:anchors"
  },
  "devDependencies": {
    "@types/node": "^22.16.5",
    "pngjs": "^7.0.0",
    "ts-node": "^10.9.2",
    "typescript": "^5.8.3",
    "vite": "^8.1.5"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUnusedLocals": true,
    "skipLibCheck": true,
    "types": ["node", "vite/client"],
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src", "scripts"]
}
```

Create `vite.config.ts`:

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  build: { target: 'es2022', assetsInlineLimit: 0 },
});
```

Create `.gitignore`:

```
node_modules
dist
.DS_Store
```

Create `index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>The Wire Room</title>
    <meta name="description" content="An intelligence desk that runs itself. Watch it work." />
    <link rel="stylesheet" href="/src/style.css" />
  </head>
  <body>
    <div class="scene" id="scene">
      <img class="plate" id="plate" src="/room.jpg" alt="" />
      <div id="overlay"></div>
    </div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Write the Worker**

Create `worker/snapshot-worker.js`:

```js
/**
 * The lane. wire-room-ops PUTs the snapshot here with a bearer token; the world
 * GETs it anonymously. This is the only component both tiers touch, and it
 * speaks no SQL and holds no database credential.
 */
const KEY = 'snapshot';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/snapshot.json') {
      return new Response('not found', { status: 404 });
    }

    if (request.method === 'PUT') {
      const auth = request.headers.get('Authorization') || '';
      const expected = `Bearer ${env.SNAPSHOT_WRITE_TOKEN}`;
      // Constant-time-ish compare: bail on length first, then char by char.
      if (auth.length !== expected.length) return new Response('forbidden', { status: 403 });
      let diff = 0;
      for (let i = 0; i < auth.length; i++) diff |= auth.charCodeAt(i) ^ expected.charCodeAt(i);
      if (diff !== 0) return new Response('forbidden', { status: 403 });

      const body = await request.text();
      if (body.length > 512 * 1024) return new Response('too large', { status: 413 });
      try { JSON.parse(body); } catch { return new Response('invalid json', { status: 400 }); }

      await env.SNAPSHOTS.put(KEY, body);
      return new Response('ok', { status: 200 });
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      const body = await env.SNAPSHOTS.get(KEY);
      if (!body) return new Response('{}', { status: 503, headers: cors() });
      return new Response(body, { status: 200, headers: cors() });
    }

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    return new Response('method not allowed', { status: 405 });
  },
};

function cors() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=60, stale-while-revalidate=600',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  };
}
```

Create `README.md`:

````markdown
# wire-room-live

The public face of the Wire Room: a 32-bit pixel-art monitoring room, animated from a
snapshot of the real pipeline.

## How it fits together

```
wire-room-ops ──PUT (bearer)──▶ Cloudflare Worker ──GET (public)──▶ this site
   (private)                      (the lane)                        (static)
```

This repo holds no credentials and never touches the database.

## Deploy

The Worker needs a KV namespace bound as `SNAPSHOTS` and a secret `SNAPSHOT_WRITE_TOKEN`.
Set the same token as `SNAPSHOT_PUSH_TOKEN` in wire-room-ops, and point
`SNAPSHOT_PUSH_URL` at `https://<worker-host>/snapshot.json`.

## Checks

`npm run check` runs typecheck, unit tests, and the anchor verification that proves the
overlays still line up with the artwork.
````

- [ ] **Step 3: Install and verify the scaffold builds**

```bash
npm install
npm run typecheck; echo "exit=$?"
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: scaffold wire-room-live + snapshot Worker"
```

---

### Task 5: Path module — polyline with arc-length parameterisation

**Files:**
- Create: `wire-room-live/src/path.ts`
- Test: `wire-room-live/tests/path.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Point = { x: number; y: number }`; `buildPath(pts: [number, number][]): Path`; `pointAt(path: Path, u: number): Point`. `Path` is `{ segs: {a,b,len,acc}[]; total: number }`.

- [ ] **Step 1: Write the failing test**

Create `tests/path.test.js`:

```js
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPath, pointAt } = require('../src/path.ts');

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('a single straight segment interpolates linearly', () => {
  const p = buildPath([[0, 0], [10, 0]]);
  assert.ok(near(pointAt(p, 0).x, 0));
  assert.ok(near(pointAt(p, 0.5).x, 5));
  assert.ok(near(pointAt(p, 1).x, 10));
});

test('u is clamped outside 0..1', () => {
  const p = buildPath([[0, 0], [10, 0]]);
  assert.ok(near(pointAt(p, -5).x, 0));
  assert.ok(near(pointAt(p, 99).x, 10));
});

test('arc-length parameterisation ignores segment count', () => {
  // Same geometry, different vertex density. Halfway must be the same point.
  const coarse = buildPath([[0, 0], [100, 0]]);
  const fine = buildPath([[0, 0], [1, 0], [2, 0], [50, 0], [100, 0]]);
  assert.ok(near(pointAt(coarse, 0.5).x, pointAt(fine, 0.5).x, 1e-9));
});

test('unequal segments advance at constant speed, not per-segment', () => {
  // Segment 1 is 10 long, segment 2 is 90. At u=0.5 we must be 50 along,
  // i.e. inside the SECOND segment — not at the joint.
  const p = buildPath([[0, 0], [10, 0], [100, 0]]);
  assert.ok(near(pointAt(p, 0.5).x, 50));
  assert.ok(near(pointAt(p, 0.1).x, 10));
});

test('total length is the sum of segment lengths', () => {
  const p = buildPath([[0, 0], [3, 4], [3, 14]]);
  assert.ok(near(p.total, 15));   // 5 + 10
});

test('diagonal segments interpolate in both axes', () => {
  const p = buildPath([[0, 0], [10, 20]]);
  const mid = pointAt(p, 0.5);
  assert.ok(near(mid.x, 5));
  assert.ok(near(mid.y, 10));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find `../src/path.ts`.

- [ ] **Step 3: Implement**

Create `src/path.ts`:

```ts
export interface Point { x: number; y: number }
export interface Segment { a: [number, number]; b: [number, number]; len: number; acc: number }
export interface Path { segs: Segment[]; total: number }

/**
 * Precompute cumulative lengths so a point can be found by DISTANCE along the
 * polyline rather than by segment index. Indexing by segment makes packets
 * speed up through short segments and crawl through long ones.
 */
export function buildPath(pts: [number, number][]): Path {
  const segs: Segment[] = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segs.push({ a, b, len, acc: total });
    total += len;
  }
  return { segs, total };
}

export function pointAt(path: Path, u: number): Point {
  const clamped = Math.max(0, Math.min(1, u));
  const d = clamped * path.total;
  let seg = path.segs[path.segs.length - 1];
  for (const s of path.segs) {
    if (d <= s.acc + s.len) { seg = s; break; }
  }
  const k = seg.len === 0 ? 0 : (d - seg.acc) / seg.len;
  return {
    x: seg.a[0] + (seg.b[0] - seg.a[0]) * k,
    y: seg.a[1] + (seg.b[1] - seg.a[1]) * k,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/path.ts tests/path.test.js
git commit -m "feat(path): polyline with arc-length parameterisation"
```

---

### Task 6: Item fate engine

**Files:**
- Create: `wire-room-live/src/items.ts`
- Test: `wire-room-live/tests/items.test.js`

**Interfaces:**
- Consumes: `buildPath`, `pointAt`, `Path`, `Point` from `src/path.ts`.
- Produces: `type Fate = 'dup' | 'arc' | 'rev' | 'pub'`; `FATES: Record<Fate, FateSpec>` where `FateSpec = { exit: number; to: 'grate' | 'desk'; col: string; glow: string }`; `itemState(fate, p, ctx): ItemState` where `ctx = { path: Path; grate: Point; desk: Point }` and `ItemState = { x, y, col, glow, size, opacity }`.

- [ ] **Step 1: Write the failing test**

Create `tests/items.test.js`. The third test is the one that matters — it is written specifically to catch the unreachable-branch bug found in the prototype, where every fate fell into a leading `p <= cut` condition that was always true for publishes:

```js
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPath } = require('../src/path.ts');
const { FATES, itemState } = require('../src/items.ts');

const CTX = {
  path: buildPath([[0, 60], [50, 80], [100, 100]]),
  grate: { x: 40, y: 40 },
  desk: { x: 90, y: 30 },
};
const near = (a, b, eps = 0.5) => Math.abs(a - b) < eps;

test('every fate rides the channel before its exit point', () => {
  for (const fate of Object.keys(FATES)) {
    const s = itemState(fate, FATES[fate].exit * 0.5, CTX);
    assert.equal(s.col, '#00eaff', `${fate} should still be cyan on the channel`);
    assert.ok(s.opacity > 0.9, `${fate} should be visible on the channel`);
  }
});

test('grate fates end near the grate, desk fates end near the desk', () => {
  for (const [fate, spec] of Object.entries(FATES)) {
    const s = itemState(fate, spec.exit + 0.19, CTX);
    const target = spec.to === 'grate' ? CTX.grate : CTX.desk;
    assert.ok(near(s.x, target.x, 2), `${fate} x should approach ${spec.to} (got ${s.x})`);
    assert.ok(near(s.y, target.y, 2), `${fate} y should approach ${spec.to} (got ${s.y})`);
  }
});

// REGRESSION: the prototype funnelled all fates through one leading branch that
// matched for every p, so 'pub' never reached its desk approach. Assert each
// fate actually LEAVES the channel and changes colour.
test('every fate leaves the channel and takes its own colour', () => {
  for (const [fate, spec] of Object.entries(FATES)) {
    const before = itemState(fate, spec.exit - 0.01, CTX);
    const after = itemState(fate, spec.exit + 0.15, CTX);
    assert.equal(before.col, '#00eaff', `${fate} should be cyan before exit`);
    assert.notEqual(after.col, '#00eaff', `${fate} never left the channel — unreachable branch`);
    assert.equal(after.col, spec.col, `${fate} took the wrong colour after exit`);
  }
});

test('duplicates leave earlier than archives, which leave before queue and publish', () => {
  assert.ok(FATES.dup.exit < FATES.arc.exit);
  assert.ok(FATES.arc.exit < FATES.rev.exit);
  assert.equal(FATES.rev.exit, FATES.pub.exit);
});

test('dropped items fade out, publishes stay bright on arrival', () => {
  assert.ok(itemState('dup', FATES.dup.exit + 0.19, CTX).opacity < 0.15);
  assert.ok(itemState('arc', FATES.arc.exit + 0.19, CTX).opacity < 0.15);
  assert.ok(itemState('pub', FATES.pub.exit + 0.19, CTX).opacity > 0.9);
});

test('a publish rises above the desk and fades after arriving', () => {
  const arrive = itemState('pub', FATES.pub.exit + 0.20, CTX);
  const late = itemState('pub', FATES.pub.exit + 0.36, CTX);
  assert.ok(late.y < arrive.y, 'publish should rise');
  assert.ok(late.opacity < arrive.opacity, 'publish should fade as it rises');
});

test('an unknown fate throws rather than rendering silently wrong', () => {
  assert.throws(() => itemState('nonsense', 0.5, CTX), /unknown fate/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find `../src/items.ts`.

- [ ] **Step 3: Implement**

Create `src/items.ts`:

```ts
import { pointAt, type Path, type Point } from './path';

export type Fate = 'dup' | 'arc' | 'rev' | 'pub';

export interface FateSpec {
  exit: number;                 // fraction of life spent riding the channel
  to: 'grate' | 'desk';
  col: string;
  glow: string;
}

/**
 * Each fate owns its exit point and destination explicitly. An earlier version
 * shared one branch whose leading condition was true for every p, which made the
 * desk approach unreachable for publishes — see tests/items.test.js.
 */
export const FATES: Record<Fate, FateSpec> = {
  dup: { exit: 0.40, to: 'grate', col: '#ff5f56', glow: 'rgba(255,95,86,.90)' },
  arc: { exit: 0.60, to: 'grate', col: '#5b6b82', glow: 'rgba(91,107,130,.55)' },
  rev: { exit: 0.78, to: 'desk', col: '#ffb347', glow: 'rgba(255,179,71,.85)' },
  pub: { exit: 0.78, to: 'desk', col: '#5ce89a', glow: 'rgba(92,232,154,.95)' },
};

export interface ItemState { x: number; y: number; col: string; glow: string; size: number; opacity: number }
export interface ItemCtx { path: Path; grate: Point; desk: Point }

const APPROACH = 0.20;   // fraction of life spent moving from channel to target
const RISE = 0.18;       // publish-only: rise and fade after arrival
const CYAN = '#00eaff';
const CYAN_GLOW = 'rgba(0,234,255,.9)';

export function itemState(fate: string, p: number, ctx: ItemCtx): ItemState {
  const spec = FATES[fate as Fate];
  if (!spec) throw new Error(`unknown fate: ${fate}`);

  if (p <= spec.exit) {
    const q = pointAt(ctx.path, p);
    return { x: q.x, y: q.y, col: CYAN, glow: CYAN_GLOW, size: 7, opacity: 1 };
  }

  const k = Math.min(1, (p - spec.exit) / APPROACH);
  const from = pointAt(ctx.path, spec.exit);
  const target = spec.to === 'grate' ? ctx.grate : ctx.desk;
  const x = from.x + (target.x - from.x) * k;
  const y = from.y + (target.y - from.y) * k;

  if (spec.to === 'grate') {
    return { x, y, col: spec.col, glow: spec.glow, size: 7 + k * 3, opacity: 1 - k * 0.95 };
  }
  if (fate === 'rev') {
    return { x, y, col: spec.col, glow: spec.glow, size: 7, opacity: 1 - k * 0.85 };
  }
  if (k < 1) {
    return { x, y, col: spec.col, glow: spec.glow, size: 7 + k * 5, opacity: 1 };
  }
  const r = Math.min(1, (p - spec.exit - APPROACH) / RISE);
  return {
    x: target.x, y: target.y - r * 11,
    col: spec.col, glow: spec.glow,
    size: 12 - r * 4, opacity: 1 - r,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: PASS, 13 tests total (6 path + 7 items).

- [ ] **Step 5: Commit**

```bash
git add src/items.ts tests/items.test.js
git commit -m "feat(items): explicit per-fate exit points, with unreachable-branch regression test"
```

---

### Task 7: Replay tape — events onto a loop

**Files:**
- Create: `wire-room-live/src/tape.ts`
- Test: `wire-room-live/tests/tape.test.js`

**Interfaces:**
- Consumes: `PublicEvent` (structurally; declared locally in `src/types.ts` in Task 8 — for this task, accept `{ at: string; kind: string; n?: number; item?: unknown }`).
- Produces: `buildTape(events, opts): TapeEntry[]` where `opts = { windowHours: number; loopMs: number; minGapMs: number }` and `TapeEntry = { ms: number; kind: string; n?: number; item?: unknown; at: string }`.

- [ ] **Step 1: Write the failing test**

Create `tests/tape.test.js`:

```js
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTape } = require('../src/tape.ts');

const OPTS = { windowHours: 24, loopMs: 96000, minGapMs: 1000 };
const at = (h, m = 0) => new Date(Date.UTC(2026, 6, 30, h, m)).toISOString();

test('an empty event list yields an empty tape', () => {
  assert.deepEqual(buildTape([], OPTS), []);
});

test('events map proportionally onto the loop', () => {
  const tape = buildTape([{ at: at(12), kind: 'run', n: 1 }], OPTS);
  assert.equal(tape.length, 1);
  assert.ok(Math.abs(tape[0].ms - 48000) < 1, 'midday should land mid-loop');
});

test('order is preserved', () => {
  const tape = buildTape([
    { at: at(2), kind: 'run', n: 1 },
    { at: at(9), kind: 'dedup', n: 3 },
    { at: at(18), kind: 'publish', item: { name: 'X' } },
  ], OPTS);
  assert.deepEqual(tape.map(t => t.kind), ['run', 'dedup', 'publish']);
});

test('bursts are spread to at least the minimum gap', () => {
  // Five events inside one minute would otherwise be simultaneous.
  const burst = Array.from({ length: 5 }, (_, i) => ({ at: at(2, i * 0.2), kind: 'dedup', n: 1 }));
  const tape = buildTape(burst, OPTS);
  for (let i = 1; i < tape.length; i++) {
    assert.ok(tape[i].ms - tape[i - 1].ms >= OPTS.minGapMs - 1e-9,
      `gap ${i} was ${tape[i].ms - tape[i - 1].ms}ms`);
  }
});

test('spreading never reorders and never exceeds the loop', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ at: at(1, i), kind: 'queue', n: 1 }));
  const tape = buildTape(many, OPTS);
  const times = tape.map(t => t.ms);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'reordered');
  assert.ok(times[times.length - 1] <= OPTS.loopMs, 'ran past the end of the loop');
});

test('counts and items are carried through untouched', () => {
  const item = { name: 'NLnet Commons Fund', amount: '€50k', wire: 'oss', url: 'https://t.me/x/1' };
  const tape = buildTape([{ at: at(3), kind: 'publish', item }], OPTS);
  assert.deepEqual(tape[0].item, item);
  const counted = buildTape([{ at: at(3), kind: 'dedup', n: 7 }], OPTS);
  assert.equal(counted[0].n, 7);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find `../src/tape.ts`.

- [ ] **Step 3: Implement**

Create `src/tape.ts`:

```ts
export interface TapeSource { at: string; kind: string; n?: number; item?: unknown; station?: string }
export interface TapeEntry extends TapeSource { ms: number }
export interface TapeOpts { windowHours: number; loopMs: number; minGapMs: number }

/**
 * Map real event times onto the replay loop.
 *
 * Real activity is bursty — clusters around scheduled runs with long dead gaps.
 * Played at literal compressed scale the room would be still for most of the
 * loop, so gaps are evened out to a minimum spacing. Order, grouping and counts
 * are preserved; only dead air is compressed. The page badge says "replaying"
 * precisely because of this transformation.
 */
export function buildTape(events: TapeSource[], opts: TapeOpts): TapeEntry[] {
  if (events.length === 0) return [];

  const windowMs = opts.windowHours * 3600 * 1000;
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const t0 = Date.parse(sorted[0].at);
  const span = Math.max(1, Date.parse(sorted[sorted.length - 1].at) - t0);

  // If everything fits inside the window, position proportionally within it;
  // otherwise fall back to spreading across the observed span.
  const denom = span > windowMs ? span : windowMs;

  let prev = -Infinity;
  const out: TapeEntry[] = sorted.map(e => {
    let ms = ((Date.parse(e.at) - t0) / denom) * opts.loopMs;
    if (ms - prev < opts.minGapMs) ms = prev + opts.minGapMs;
    prev = ms;
    return { ...e, ms };
  });

  // Spreading can push the tail past the loop; rescale so it always fits.
  const last = out[out.length - 1].ms;
  if (last > opts.loopMs) {
    const scale = opts.loopMs / last;
    for (const entry of out) entry.ms *= scale;
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: PASS, 19 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/tape.ts tests/tape.test.js
git commit -m "feat(tape): map bursty events onto the replay loop with minimum spacing"
```

---

### Task 8: Snapshot validation and fetching

**Files:**
- Create: `wire-room-live/src/types.ts`
- Create: `wire-room-live/src/snapshot.ts`
- Test: `wire-room-live/tests/snapshot.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `SNAPSHOT_VERSION = 1`; types mirroring the producer; `validateSnapshot(raw: unknown): PublicSnapshot | null`; `createSnapshotClient(opts)` returning `{ get(): PublicSnapshot | null; status(): 'live' | 'cached' | 'stale' | 'empty'; poll(now: number): Promise<boolean> }`.

- [ ] **Step 1: Write the failing test**

Create `tests/snapshot.test.js`:

```js
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSnapshot, createSnapshotClient } = require('../src/snapshot.ts');

const good = (over = {}) => ({
  v: 1,
  generatedAt: '2026-07-30T02:41:00Z',
  windowHours: 24,
  desk: { surfacesWatched: 1136, weekNumber: 30, wires: ['crypto'] },
  funnel: [{ stage: 'scanned', count: 312 }],
  stations: [{ id: 'stringer', state: 'idle', lastRunAt: null, itemsTouched: 0 }],
  coverage: { total: 1136, fresh: 412, dark: 204 },
  events: [{ at: '2026-07-30T02:14:00Z', kind: 'run', n: 34 }],
  ...over,
});

test('a well-formed snapshot validates', () => {
  assert.ok(validateSnapshot(good()));
});

test('a wrong version is rejected', () => {
  assert.equal(validateSnapshot(good({ v: 2 })), null);
  assert.equal(validateSnapshot(good({ v: undefined })), null);
});

test('junk is rejected rather than thrown on', () => {
  for (const junk of [null, undefined, 42, 'nope', [], {}]) {
    assert.equal(validateSnapshot(junk), null);
  }
});

test('missing required sections are rejected', () => {
  assert.equal(validateSnapshot(good({ funnel: undefined })), null);
  assert.equal(validateSnapshot(good({ events: 'not an array' })), null);
  assert.equal(validateSnapshot(good({ coverage: undefined })), null);
});

test('client keeps the last good snapshot when a fetch fails', async () => {
  let mode = 'ok';
  const client = createSnapshotClient({
    url: 'https://example.invalid/snapshot.json',
    fetcher: async () => {
      if (mode === 'fail') throw new Error('network down');
      return { ok: true, json: async () => good() };
    },
  });

  assert.equal(await client.poll(0), true);
  assert.equal(client.status(), 'live');
  assert.equal(client.get().desk.surfacesWatched, 1136);

  mode = 'fail';
  assert.equal(await client.poll(1000), false);
  assert.equal(client.status(), 'cached', 'should fall back to cached, not empty');
  assert.equal(client.get().desk.surfacesWatched, 1136, 'last good must survive');
});

test('client rejects a bad payload and keeps the previous one', async () => {
  let payload = good();
  const client = createSnapshotClient({
    url: 'x', fetcher: async () => ({ ok: true, json: async () => payload }),
  });
  await client.poll(0);
  payload = { v: 99, garbage: true };
  assert.equal(await client.poll(1000), false);
  assert.equal(client.get().v, 1, 'a version mismatch must not replace good data');
});

test('status goes stale when the snapshot ages past the threshold', async () => {
  const client = createSnapshotClient({
    url: 'x',
    staleAfterMs: 30 * 60 * 1000,
    fetcher: async () => ({ ok: true, json: async () => good() }),
    now: () => Date.parse('2026-07-30T02:41:00Z'),
  });
  await client.poll(0);
  assert.equal(client.status(), 'live');
  client.setClock(() => Date.parse('2026-07-30T03:41:00Z'));
  assert.equal(client.status(), 'stale');
});

test('a brand new client with no data reports empty', () => {
  const client = createSnapshotClient({ url: 'x', fetcher: async () => { throw new Error('x'); } });
  assert.equal(client.status(), 'empty');
  assert.equal(client.get(), null);
});

test('newEvents reports only events not seen before', async () => {
  let payload = good();
  const client = createSnapshotClient({ url: 'x', fetcher: async () => ({ ok: true, json: async () => payload }) });
  await client.poll(0);
  assert.equal(client.newEvents().length, 1, 'first poll surfaces its events');
  await client.poll(1000);
  assert.equal(client.newEvents().length, 0, 'unchanged payload surfaces nothing');
  payload = good({ events: [
    { at: '2026-07-30T02:14:00Z', kind: 'run', n: 34 },
    { at: '2026-07-30T02:55:00Z', kind: 'publish', item: { name: 'X', amount: null, wire: 'ai', url: 'u' } },
  ] });
  await client.poll(2000);
  const fresh = client.newEvents();
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].kind, 'publish');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find `../src/snapshot.ts`.

- [ ] **Step 3: Write the types**

Create `src/types.ts`:

```ts
export const SNAPSHOT_VERSION = 1 as const;

export type EventKind = 'run' | 'dedup' | 'archive' | 'queue' | 'publish';

export interface PublicItem { name: string; amount: string | null; wire: string; url: string }

export interface PublicEvent {
  at: string;
  kind: EventKind;
  station?: string;
  n?: number;
  item?: PublicItem;
}

export interface PublicSnapshot {
  v: typeof SNAPSHOT_VERSION;
  generatedAt: string;
  windowHours: number;
  desk: { surfacesWatched: number; weekNumber: number; wires: string[] };
  funnel: { stage: string; count: number }[];
  stations: { id: string; state: 'idle' | 'running'; lastRunAt: string | null; itemsTouched: number }[];
  coverage: { total: number; fresh: number; dark: number };
  events: PublicEvent[];
}

export type SnapshotStatus = 'live' | 'cached' | 'stale' | 'empty';
```

- [ ] **Step 4: Implement the client**

Create `src/snapshot.ts`:

```ts
import { SNAPSHOT_VERSION, type PublicEvent, type PublicSnapshot, type SnapshotStatus } from './types';

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validate before the animator ever sees it. A malformed payload is discarded. */
export function validateSnapshot(raw: unknown): PublicSnapshot | null {
  if (!isObj(raw)) return null;
  if (raw.v !== SNAPSHOT_VERSION) return null;
  if (typeof raw.generatedAt !== 'string') return null;
  if (typeof raw.windowHours !== 'number') return null;
  if (!isObj(raw.desk) || !isObj(raw.coverage)) return null;
  if (!Array.isArray(raw.funnel) || !Array.isArray(raw.stations) || !Array.isArray(raw.events)) return null;
  return raw as unknown as PublicSnapshot;
}

export interface SnapshotClientOpts {
  url: string;
  fetcher?: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
  staleAfterMs?: number;
  now?: () => number;
}

export function createSnapshotClient(opts: SnapshotClientOpts) {
  const fetcher = opts.fetcher ?? ((u: string) => fetch(u, { cache: 'no-store' }));
  const staleAfterMs = opts.staleAfterMs ?? 30 * 60 * 1000;
  let now = opts.now ?? (() => Date.now());

  let current: PublicSnapshot | null = null;
  let lastOkAt = 0;
  let lastFetchFailed = false;
  let seen = new Set<string>();
  let fresh: PublicEvent[] = [];

  const keyOf = (e: PublicEvent) => `${e.at}|${e.kind}|${e.n ?? ''}|${e.item?.name ?? ''}`;

  return {
    get: () => current,

    setClock(fn: () => number) { now = fn; },

    status(): SnapshotStatus {
      if (!current) return 'empty';
      if (lastFetchFailed) return 'cached';
      const age = now() - Date.parse(current.generatedAt);
      return age > staleAfterMs ? 'stale' : 'live';
    },

    /** Events present in the newest payload that were absent from the previous one. */
    newEvents: () => fresh,

    async poll(_tick: number): Promise<boolean> {
      try {
        const res = await fetcher(opts.url);
        if (!res.ok) { lastFetchFailed = true; return false; }
        const valid = validateSnapshot(await res.json());
        if (!valid) { lastFetchFailed = true; return false; }

        const firstLoad = current === null;
        fresh = firstLoad
          ? valid.events.slice()
          : valid.events.filter(e => !seen.has(keyOf(e)));
        seen = new Set(valid.events.map(keyOf));

        current = valid;
        lastOkAt = now();
        lastFetchFailed = false;
        return true;
      } catch {
        lastFetchFailed = true;
        return false;
      }
    },

    lastOkAt: () => lastOkAt,
  };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm test`
Expected: PASS, 28 tests total.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/snapshot.ts tests/snapshot.test.js
git commit -m "feat(snapshot): version-guarded validation, last-good cache, new-event detection"
```

---

### Task 9: Anchors and the artwork-drift check

**Files:**
- Create: `wire-room-live/src/anchors.ts`
- Create: `wire-room-live/scripts/verify-anchors.mjs`
- Copy: the chosen backplate to `wire-room-live/public/room.jpg` and `wire-room-live/art/room.png`

**Interfaces:**
- Consumes: nothing.
- Produces: `ANCHORS: Record<string, Anchor>` where `Anchor = { board: Box; cover: Box; channel: [number,number][]; grate: Point; desk: Point; deskLabel: Point; glowW: number; tickerW: number; stations: {id,x,y,lx,ly}[] }` and `Box = { l,t,w,h,skew }`; default export key `'room'`.

- [ ] **Step 1: Copy the artwork in**

The chosen backplate is committed in the producer repo at
`wire-room-ops/docs/superpowers/assets/wire-room-live/room.png`, alongside the prompt that
generated it.

```bash
cd "$HOME/Documents/Sovereign Signal/repos/wire-room-live"
mkdir -p art public
ASSETS="$HOME/Documents/Sovereign Signal/repos/wire-room-ops/docs/superpowers/assets/wire-room-live"
cp "$ASSETS/room.png"        art/room.png
cp "$ASSETS/room-prompt.txt" art/room-prompt.txt
cp "$ASSETS/room.png"        public/room.png
ls -la art/room.png public/room.png && echo "artwork present"
```

`art/room.png` is the master used by the anchor check; `public/room.png` is what Vite serves.
`index.html` already references `/room.jpg` — change that `src` to `/room.png`, or produce a
JPEG copy and keep the reference. Either is fine; the PNG is ~2.3 MB, a quality-82 JPEG is
roughly a tenth of that, which matters for a page meant to be opened from a phone.

**Verify the two files exist before continuing** — every later step in this task reads them.

- [ ] **Step 2: Write the anchor map**

Create `src/anchors.ts` with the values measured from `room-v5-b.png`:

```ts
export interface Box { l: number; t: number; w: number; h: number; skew: number }
export interface Pt { x: number; y: number }
export interface Station { id: string; x: number; y: number; lx: number; ly: number }

export interface Anchor {
  board: Box;
  cover: Box;
  channel: [number, number][];
  grate: Pt;
  desk: Pt;
  deskLabel: Pt;
  glowW: number;
  tickerW: number;
  stations: Station[];
}

/**
 * Overlay positions are DATA, not CSS, because they belong to one specific
 * render. Regenerating the artwork means re-measuring these — which is what
 * scripts/verify-anchors.mjs checks. All values are percentages of the frame.
 */
export const ANCHORS: Record<string, Anchor> = {
  room: {
    board: { l: 4.0, t: 3.5, w: 16.5, h: 14.0, skew: -3 },
    cover: { l: 34.0, t: 5.8, w: 6.5, h: 6.0, skew: 0 },
    channel: [[3, 68], [10, 73], [17, 77], [24, 84], [33, 86], [45, 87], [57, 89], [66, 92], [75, 95], [84, 99]],
    grate: { x: 37, y: 52 },
    desk: { x: 75, y: 38 },
    deskLabel: { x: 75, y: 56 },
    glowW: 11,
    tickerW: 30,
    stations: [
      { id: 'stringer', x: 7, y: 52, lx: 7, ly: 70 },
      { id: 'dedup', x: 29, y: 40, lx: 29, ly: 58 },
      { id: 'classifier', x: 54, y: 32, lx: 54, ly: 48 },
    ],
  },
};

export const DEFAULT_ANCHOR = 'room';
```

- [ ] **Step 3: Write the drift check**

Create `scripts/verify-anchors.mjs`:

```js
/**
 * Prove the overlays still line up with the artwork.
 *
 * Two invariants:
 *   1. Both wall panels must be DARK — they exist to hold DOM overlays. If a
 *      regenerated room lit them up, the funnel board would sit on top of art.
 *   2. Every channel point must have strong cyan nearby — otherwise packets
 *      drift over bare floor instead of riding the light channel.
 *
 * Run after regenerating the backplate. No browser required.
 */
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const IMG = new URL('../art/room.png', import.meta.url);
const png = PNG.sync.read(readFileSync(IMG));
const { width: W, height: H, data } = png;

const px = (x, y) => {
  const i = (y * W + x) * 4;
  return [data[i], data[i + 1], data[i + 2]];
};
const cyanness = (r, g, b) => (g + b) / 2 - r;

// Kept in step with src/anchors.ts by hand; the assertions below are what
// actually catch drift.
const BOARD = { l: 4.0, t: 3.5, w: 16.5, h: 14.0 };
const COVER = { l: 34.0, t: 5.8, w: 6.5, h: 6.0 };
const CHANNEL = [[3,68],[10,73],[17,77],[24,84],[33,86],[45,87],[57,89],[66,92],[75,95],[84,99]];

const MAX_MEAN_LUMA = 40;
const MAX_BRIGHT_FRACTION = 0.05;
const MIN_CHANNEL_CYAN = 45;
const SEARCH_PX = 14;

let failures = 0;
const fail = m => { console.error(`  ✗ ${m}`); failures++; };
const pass = m => console.log(`  ✓ ${m}`);

for (const [name, box] of [['board', BOARD], ['cover', COVER]]) {
  let total = 0, n = 0, bright = 0;
  const x0 = Math.floor(box.l / 100 * W), x1 = Math.floor((box.l + box.w) / 100 * W);
  const y0 = Math.floor(box.t / 100 * H), y1 = Math.floor((box.t + box.h) / 100 * H);
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const [r, g, b] = px(x, y);
      const L = (r + g + b) / 3;
      total += L; n++;
      if (L > 70) bright++;
    }
  }
  const mean = total / Math.max(n, 1);
  const frac = bright / Math.max(n, 1);
  if (mean > MAX_MEAN_LUMA || frac > MAX_BRIGHT_FRACTION) {
    fail(`${name} panel is not blank (mean luma ${mean.toFixed(1)}, bright ${(frac * 100).toFixed(1)}%) — the overlay would sit on lit artwork`);
  } else {
    pass(`${name} panel blank (mean luma ${mean.toFixed(1)}, bright ${(frac * 100).toFixed(1)}%)`);
  }
}

let onLine = 0;
for (const [xp, yp] of CHANNEL) {
  const x = Math.floor(xp / 100 * W);
  let best = 0;
  for (let dy = -SEARCH_PX; dy <= SEARCH_PX; dy += 2) {
    const y = Math.floor(yp / 100 * H) + dy;
    if (y < 0 || y >= H) continue;
    best = Math.max(best, cyanness(...px(x, y)));
  }
  if (best >= MIN_CHANNEL_CYAN) onLine++;
  else fail(`channel point (${xp},${yp}) is off the lit line (peak cyan ${best.toFixed(1)})`);
}
pass(`${onLine}/${CHANNEL.length} channel points sit on the lit line`);

if (failures) {
  console.error(`\nanchor verification FAILED with ${failures} problem(s).`);
  console.error('Re-measure src/anchors.ts against the new artwork.');
  process.exit(1);
}
console.log('\nanchor verification passed.');
```

- [ ] **Step 4: Run it**

Run: `npm run verify:anchors`
Expected: all checks pass, `10/10 channel points sit on the lit line`, exit 0.

- [ ] **Step 5: Prove the check actually fails on drift**

Temporarily edit `scripts/verify-anchors.mjs`, changing the first channel point to `[3, 20]` (up in the window, off the floor). Run `npm run verify:anchors` and confirm it exits non-zero with `off the lit line`. **Then revert the edit** and confirm it passes again. A check that cannot fail is not a check.

- [ ] **Step 6: Commit**

```bash
git add src/anchors.ts scripts/verify-anchors.mjs art public
git commit -m "feat(anchors): measured anchor map + artwork-drift verification"
```

---

### Task 10: Scene rendering

**Files:**
- Create: `wire-room-live/src/scene.ts`
- Create: `wire-room-live/src/style.css`
- Test: `wire-room-live/tests/scene.test.js`

**Interfaces:**
- Consumes: `Anchor` from `src/anchors.ts`; `PublicSnapshot` from `src/types.ts`.
- Produces: `funnelRows(snapshot): {stage,count,pct,colour}[]`; `coverageDots(coverage, n): ('fresh'|'dark'|'aging')[]`; `formatClock(loopFraction): string`; `tickerLine(event): {text,cls}`.

Pure helpers are separated from DOM writes on purpose: everything here is unit-testable without a browser, and `main.ts` does the appending.

- [ ] **Step 1: Write the failing test**

Create `tests/scene.test.js`:

```js
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { funnelRows, coverageDots, formatClock, tickerLine } = require('../src/scene.ts');

test('funnel bars are scaled against the largest stage', () => {
  const rows = funnelRows({ funnel: [
    { stage: 'scanned', count: 300 },
    { stage: 'duplicate', count: 150 },
    { stage: 'published', count: 0 },
  ] });
  const byStage = Object.fromEntries(rows.map(r => [r.stage, r]));
  assert.equal(byStage.scanned.pct, 100);
  assert.equal(byStage.duplicate.pct, 50);
  assert.ok(byStage.published.pct >= 2, 'a zero bar still needs a visible stub');
});

test('funnel handles an all-zero day without dividing by zero', () => {
  const rows = funnelRows({ funnel: [{ stage: 'scanned', count: 0 }] });
  assert.ok(Number.isFinite(rows[0].pct));
});

test('each stage gets its palette colour', () => {
  const rows = funnelRows({ funnel: [
    { stage: 'scanned', count: 1 }, { stage: 'duplicate', count: 1 },
    { stage: 'archived', count: 1 }, { stage: 'review', count: 1 },
    { stage: 'published', count: 1 },
  ] });
  const c = Object.fromEntries(rows.map(r => [r.stage, r.colour]));
  assert.equal(c.scanned, '#00eaff');
  assert.equal(c.duplicate, '#ff5f56');
  assert.equal(c.review, '#ffb347');
  assert.equal(c.published, '#5ce89a');
});

test('coverage dots reflect the fresh/dark proportions', () => {
  const dots = coverageDots({ total: 100, fresh: 50, dark: 25 }, 48);
  assert.equal(dots.length, 48);
  const count = k => dots.filter(d => d === k).length;
  assert.ok(Math.abs(count('fresh') - 24) <= 1, `fresh was ${count('fresh')}`);
  assert.ok(Math.abs(count('dark') - 12) <= 1, `dark was ${count('dark')}`);
  assert.equal(count('fresh') + count('dark') + count('aging'), 48);
});

test('coverage handles a zero total', () => {
  const dots = coverageDots({ total: 0, fresh: 0, dark: 0 }, 12);
  assert.equal(dots.length, 12);
  assert.ok(dots.every(d => d === 'aging'));
});

test('clock maps loop fraction onto a 24-hour day', () => {
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(0.5), '12:00');
  assert.equal(formatClock(0.25), '06:00');
  assert.equal(formatClock(0.999), '23:58');
});

test('ticker lines are styled by event kind', () => {
  assert.equal(tickerLine({ kind: 'dedup', n: 6 }).cls, 'bad');
  assert.equal(tickerLine({ kind: 'archive', n: 3 }).cls, 'dim');
  assert.equal(tickerLine({ kind: 'publish', item: { name: 'X', amount: '€50k' } }).cls, 'good');
  assert.match(tickerLine({ kind: 'publish', item: { name: 'NLnet', amount: '€50k' } }).text, /NLnet/);
  assert.match(tickerLine({ kind: 'run', station: 'stringer', n: 34 }).text, /34/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find `../src/scene.ts`.

- [ ] **Step 3: Implement**

Create `src/scene.ts`:

```ts
import type { PublicEvent } from './types';

const STAGE_COLOUR: Record<string, string> = {
  scanned: '#00eaff',
  duplicate: '#ff5f56',
  archived: '#5b6b82',
  review: '#ffb347',
  published: '#5ce89a',
};
const MIN_BAR_PCT = 2;

export interface FunnelRow { stage: string; count: number; pct: number; colour: string }

export function funnelRows(snapshot: { funnel: { stage: string; count: number }[] }): FunnelRow[] {
  const max = Math.max(1, ...snapshot.funnel.map(f => f.count));
  return snapshot.funnel.map(f => ({
    stage: f.stage,
    count: f.count,
    pct: Math.max(MIN_BAR_PCT, (f.count / max) * 100),
    colour: STAGE_COLOUR[f.stage] ?? '#5b6b82',
  }));
}

export type DotState = 'fresh' | 'dark' | 'aging';

/** Distribute dots deterministically so the grid does not shimmer between frames. */
export function coverageDots(cov: { total: number; fresh: number; dark: number }, n: number): DotState[] {
  if (!cov.total) return Array.from({ length: n }, () => 'aging' as DotState);
  const freshN = Math.round((cov.fresh / cov.total) * n);
  const darkN = Math.round((cov.dark / cov.total) * n);
  return Array.from({ length: n }, (_, i) =>
    i < freshN ? 'fresh' : i < freshN + darkN ? 'dark' : 'aging');
}

export function formatClock(loopFraction: number): string {
  const mins = Math.floor(Math.max(0, Math.min(0.99999, loopFraction)) * 1440);
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

export function tickerLine(e: Pick<PublicEvent, 'kind' | 'n' | 'station' | 'item'>): { text: string; cls: string } {
  switch (e.kind) {
    case 'run':
      return { text: `${e.station ?? 'stringer'} swept ${e.n ?? 0} surfaces`, cls: 'dim' };
    case 'dedup':
      return { text: `${e.n ?? 0} duplicate · dropped before review`, cls: 'bad' };
    case 'archive':
      return { text: `${e.n ?? 0} off-scope · archived`, cls: 'dim' };
    case 'queue':
      return { text: `${e.n ?? 0} reached the queue`, cls: '' };
    case 'publish': {
      const amount = e.item?.amount ? ` · ${e.item.amount}` : '';
      return { text: `✓ published · ${e.item?.name ?? ''}${amount} → telegram`, cls: 'good' };
    }
    default:
      return { text: String(e.kind), cls: 'dim' };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: PASS, 35 tests total.

- [ ] **Step 5: Write the stylesheet**

The working prototype is committed at
`wire-room-ops/docs/superpowers/assets/wire-room-live/prototype.html`. Extract its `<style>` block:

```bash
python3 - <<'PY' > src/style.css
import re
src = "../wire-room-ops/docs/superpowers/assets/wire-room-live/prototype.html"
css = re.search(r"<style>(.*?)</style>", open(src).read(), re.S).group(1)
# Drop demo-only chrome: the public page has no wrapper, toolbar or buttons.
for block in (r"\.wrap\{[^}]*\}", r"\.bar\b[^{]*\{[^}]*\}", r"\.bar b\{[^}]*\}",
              r"button\{[^}]*\}", r"button\.on\{[^}]*\}", r"\.cap\b[^{]*\{[^}]*\}",
              r"\.cap b\{[^}]*\}"):
    css = re.sub(block, "", css)
print(css.strip())
PY
```

Then confirm every selector the markup relies on survived:

```bash
for s in .scene .plate '#overlay' .board .brow .btrk .bfil .bnum .cover '#cgrid' \
         .cdot .item .glow '#deskglow' .tag .top .badge '#clock' '#ticker' .tl; do
  grep -q -- "$s" src/style.css && echo "  ok  $s" || echo "  MISSING  $s"
done
```

Every line must read `ok`. Add `html,body{margin:0;background:#02040a}` and make `.scene`
full-viewport (`width:100vw;height:100vh` with `object-fit:cover` on `.plate`) — the prototype
sized it as a boxed preview, but the public page is the whole window.

- [ ] **Step 6: Commit**

```bash
git add src/scene.ts src/style.css tests/scene.test.js
git commit -m "feat(scene): pure render helpers for funnel, coverage, clock and ticker"
```

---

### Task 11: Wire it together

**Files:**
- Create: `wire-room-live/src/main.ts`
- Modify: `wire-room-live/index.html` (overlay markup)

**Interfaces:**
- Consumes: everything from Tasks 5–10.
- Produces: a running page.

- [ ] **Step 1: Add the overlay markup**

Replace the `<div id="overlay"></div>` line in `index.html` with:

```html
      <div id="overlay">
        <div class="glow" data-id="stringer"></div>
        <div class="glow" data-id="dedup"></div>
        <div class="glow" data-id="classifier"></div>
        <div id="deskglow"></div>
        <div class="board" id="board"><div class="btitle">LAST 24 HOURS</div></div>
        <div class="cover" id="cover"><div id="cgrid"></div><div class="clab">SURFACES</div></div>
        <div id="items"></div>
        <div class="tag" data-id="stringer"><b>Stringer</b>intake</div>
        <div class="tag" data-id="dedup"><b>Dedup</b><s>dropped here</s></div>
        <div class="tag" data-id="classifier"><b>Classifier</b>scores · sorts</div>
        <div class="tag" data-id="desk"><b>The human</b>minutes a day</div>
        <div class="top">
          <span><b>THE WIRE ROOM</b> <span id="wires"></span> <span id="clock">00:00</span></span>
          <span class="badge" id="badge"><span id="badgetext">CONNECTING</span></span>
        </div>
        <div id="ticker"></div>
      </div>
```

- [ ] **Step 2: Write main.ts**

Create `src/main.ts`:

```ts
import { ANCHORS, DEFAULT_ANCHOR } from './anchors';
import { itemState, type Fate } from './items';
import { buildPath } from './path';
import { funnelRows, coverageDots, formatClock, tickerLine } from './scene';
import { createSnapshotClient } from './snapshot';
import { buildTape, type TapeEntry } from './tape';
import type { PublicEvent, PublicSnapshot } from './types';

const SNAPSHOT_URL = import.meta.env.VITE_SNAPSHOT_URL ?? '/snapshot.json';
const LOOP_MS = 78_000;
const MIN_GAP_MS = 1_100;
const ITEM_MS = 6_000;
const POLL_MS = 60_000;
const DOT_COUNT = 48;

const A = ANCHORS[DEFAULT_ANCHOR];
const PATH = buildPath(A.channel);
const CTX = { path: PATH, grate: A.grate, desk: A.desk };

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const client = createSnapshotClient({ url: SNAPSHOT_URL });

let tape: TapeEntry[] = [];
let cursor = 0;
let lastLoopT = 0;
let loopStart = 0;
let items: { fate: Fate; born: number }[] = [];
let ticker: { text: string; cls: string; born: number }[] = [];
let lit: Record<string, number> = { stringer: 0, dedup: 0, classifier: 0 };
let deskFlash = 0;
let liveUntil = 0;
const pool: HTMLDivElement[] = [];

// ── static layout from the anchor map ────────────────────────────────────────
function layout() {
  const b = A.board, c = A.cover;
  $('#board').style.cssText =
    `left:${b.l}%;top:${b.t}%;width:${b.w}%;height:${b.h}%;transform:skewY(${b.skew}deg)`;
  $('#cover').style.cssText =
    `left:${c.l}%;top:${c.t}%;width:${c.w}%;height:${c.h}%;transform:skewY(${c.skew}deg)`;
  $('#ticker').style.width = `${A.tickerW}%`;
  document.querySelectorAll<HTMLElement>('.tag').forEach(t => {
    const s = A.stations.find(s => s.id === t.dataset.id);
    const pos = s ? { x: s.lx, y: s.ly } : A.deskLabel;
    t.style.left = `${pos.x}%`; t.style.top = `${pos.y}%`;
  });
  document.querySelectorAll<HTMLElement>('.glow').forEach(g => {
    const s = A.stations.find(s => s.id === g.dataset.id);
    if (!s) return;
    g.style.left = `${s.x}%`; g.style.top = `${s.y}%`; g.style.width = `${A.glowW}%`;
  });
  const dg = $('#deskglow');
  dg.style.left = `${A.desk.x}%`; dg.style.top = `${A.desk.y}%`; dg.style.width = `${A.glowW + 3}%`;
}

function renderStatic(snap: PublicSnapshot) {
  const board = $('#board');
  board.querySelectorAll('.brow').forEach(n => n.remove());
  for (const row of funnelRows(snap)) {
    const el = document.createElement('div');
    el.className = 'brow';
    el.innerHTML =
      `<div><div class="blab">${row.stage.toUpperCase()}</div>` +
      `<div class="btrk"><div class="bfil" data-stage="${row.stage}" ` +
      `style="width:${row.pct}%;background:${row.colour}"></div></div></div>` +
      `<div class="bnum" data-stage="${row.stage}">${row.count}</div>`;
    board.appendChild(el);
  }
  const grid = $('#cgrid');
  grid.innerHTML = coverageDots(snap.coverage, DOT_COUNT)
    .map(d => `<div class="cdot ${d === 'fresh' ? 'f' : d === 'dark' ? 'd' : ''}"></div>`).join('');
  $('.clab').textContent = `${snap.coverage.total.toLocaleString()} SURFACES`;
  $('#wires').textContent = `· ${snap.desk.wires.join(' · ')} · week ${snap.desk.weekNumber}`;
}

function fateFor(kind: string): Fate | null {
  if (kind === 'dedup') return 'dup';
  if (kind === 'archive') return 'arc';
  if (kind === 'queue') return 'rev';
  if (kind === 'publish') return 'pub';
  return null;
}

function fire(entry: TapeEntry, now: number) {
  // TapeEntry widens `kind` to string and `item` to unknown, so the cast needs
  // to go through `unknown`. buildTape carries both through untouched.
  const line = tickerLine(entry as unknown as PublicEvent);
  ticker.unshift({ ...line, born: now });
  if (ticker.length > 6) ticker.pop();

  if (entry.kind === 'run') { lit.stringer = now + 2800; return; }
  if (entry.kind === 'dedup') lit.dedup = now + 2600;
  if (entry.kind === 'archive' || entry.kind === 'queue') lit.classifier = now + 2400;
  if (entry.kind === 'publish') { liveUntil = now + 5400; deskFlash = now + ITEM_MS + 1100; }

  const fate = fateFor(entry.kind);
  if (!fate) return;
  const n = entry.kind === 'publish' ? 1 : Math.min(entry.n ?? 1, 4);
  for (let i = 0; i < n; i++) items.push({ fate, born: now + i * 320 });
}

function itemEl(i: number): HTMLDivElement {
  while (pool.length <= i) {
    const d = document.createElement('div');
    d.className = 'item';
    $('#items').appendChild(d);
    pool.push(d);
  }
  return pool[i];
}

function frame(now: number) {
  if (!loopStart) loopStart = now - 4000;
  const t = (now - loopStart) % LOOP_MS;
  if (t < lastLoopT) cursor = 0;
  lastLoopT = t;

  while (cursor < tape.length && tape[cursor].ms <= t) { fire(tape[cursor], now); cursor++; }

  $('#clock').textContent = formatClock(t / LOOP_MS);

  const status = client.status();
  const live = now < liveUntil && status === 'live';
  const badge = $('#badge');
  badge.className = live ? 'badge live' : 'badge';
  $('#badgetext').textContent =
    live ? 'LIVE'
    : status === 'empty' ? 'CONNECTING'
    : status === 'cached' ? 'CACHED'
    : status === 'stale' ? `AS OF ${new Date(client.get()!.generatedAt).toUTCString().slice(17, 22)} UTC`
    : 'REPLAYING LAST 24H';

  for (const id of ['stringer', 'dedup', 'classifier']) {
    const on = now < lit[id];
    const g = document.querySelector<HTMLElement>(`.glow[data-id="${id}"]`);
    if (g) g.style.opacity = String(on ? 0.55 + 0.45 * Math.sin(now / 110) : 0.10);
    document.querySelector(`.tag[data-id="${id}"]`)?.classList.toggle('active', on);
  }
  $('#deskglow').style.opacity = String(now < deskFlash ? 0.6 + 0.4 * Math.sin(now / 130) : 0.16);

  items = items.filter(it => now - it.born < ITEM_MS * 1.25);
  let n = 0;
  for (const it of items) {
    const p = (now - it.born) / ITEM_MS;
    if (p < 0 || p > 1.2) continue;
    const s = itemState(it.fate, p, CTX);
    if (s.opacity <= 0.02) continue;
    const d = itemEl(n++);
    d.style.cssText =
      `display:block;left:${s.x}%;top:${s.y}%;width:${s.size}px;height:${s.size}px;` +
      `background:${s.col};opacity:${s.opacity};box-shadow:0 0 ${s.size + 8}px ${s.size / 2}px ${s.glow}`;
  }
  for (let i = n; i < pool.length; i++) pool[i].style.display = 'none';

  $('#ticker').innerHTML = ticker.map((l, i) => {
    const age = (now - l.born) / 1000;
    const o = Math.max(0.1, 1 - i * 0.15 - Math.max(0, age - 14) * 0.05);
    return `<div class="tl ${l.cls}" style="opacity:${o}">${l.text}</div>`;
  }).join('');

  requestAnimationFrame(frame);
}

async function refresh() {
  const changed = await client.poll(Date.now());
  const snap = client.get();
  if (!snap) return;
  if (changed) {
    renderStatic(snap);
    tape = buildTape(snap.events, { windowHours: snap.windowHours, loopMs: LOOP_MS, minGapMs: MIN_GAP_MS });
    // A genuinely new event since the last poll breaks in immediately.
    if (client.newEvents().some(e => e.kind === 'publish')) liveUntil = performance.now() + 5400;
  }
}

layout();
refresh();
setInterval(refresh, POLL_MS);
requestAnimationFrame(frame);
```

- [ ] **Step 3: Typecheck and build**

```bash
npm run typecheck; echo "exit=$?"
npm run build; echo "exit=$?"
```

Both must exit 0.

- [ ] **Step 4: Run it against a fixture**

Create `public/snapshot.json` containing a hand-written snapshot with at least one of each event kind (copy the shape from `tests/snapshot.test.js`'s `good()` helper and add `dedup`, `archive`, `queue` and `publish` events at different hours). Then:

```bash
npm run dev
```

Open the printed URL. Confirm, by watching one full 78-second loop:
- the clock advances 00:00 → 23:5x
- funnel numbers and bars render inside the wall panel
- packets ride the floor channel
- red packets peel off toward the grate, grey ones later
- a publish reaches the desk, flares green, rises, and the badge reads `LIVE`
- the ticker shows lines for each kind

- [ ] **Step 5: Layout smoke test across three viewports**

The page is meant to be opened from a phone off a shared link, so a horizontal
scrollbar is a real defect. Add `tests/layout.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '../src/style.css'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

test('nothing can overflow horizontally', () => {
  assert.match(css, /overflow\s*:\s*hidden/, '.scene must clip its overlays');
  assert.ok(!/width\s*:\s*\d{3,}px/.test(css), 'no fixed pixel widths — everything scales');
});

test('overlay positions are percentages, never pixels', () => {
  // main.ts writes left/top as %; a px value here means an anchor was hardcoded.
  const src = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');
  const positional = [...src.matchAll(/style\.(left|top)\s*=\s*`([^`]*)`/g)].map(m => m[2]);
  for (const v of positional) assert.match(v, /%`?$|%\`|\$\{[^}]+\}%/, `non-% position: ${v}`);
});

test('the markup provides every element main.ts queries', () => {
  for (const id of ['scene', 'plate', 'overlay', 'board', 'cover', 'cgrid',
                    'items', 'deskglow', 'clock', 'badge', 'badgetext', 'ticker', 'wires']) {
    assert.ok(html.includes(`id="${id}"`), `index.html is missing #${id}`);
  }
  for (const cls of ['glow', 'tag', 'top', 'btitle', 'clab']) {
    assert.ok(html.includes(`class="${cls}`) || html.includes(`${cls}"`), `missing .${cls}`);
  }
});
```

Run: `npm test`
Expected: PASS. Then check it visually at three widths — with `npm run dev` running, resize
to roughly 390px, 820px and 1440px and confirm no horizontal scrollbar appears at any of them.

- [ ] **Step 6: Run the full check**

```bash
npm run check; echo "exit=$?"
```

Expected: typecheck, all unit tests, and anchor verification all pass. Exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/main.ts index.html public/snapshot.json tests/layout.test.js
git commit -m "feat: wire the replay engine to the scene and the snapshot client"
```

---

### Task 12: Deploy

**Files:**
- Create: `wire-room-live/wrangler.toml`

**Interfaces:**
- Consumes: the Worker from Task 4; the built site from Task 11.
- Produces: a public URL.

> **Gate:** this task performs outward-facing actions. Confirm the hosting and domain decisions with the owner before running it — they are open questions 2 and 3 in the spec.

- [ ] **Step 1: Create the Worker config**

Create `wrangler.toml`:

```toml
name = "wire-room-snapshot"
main = "worker/snapshot-worker.js"
compatibility_date = "2026-07-01"

[[kv_namespaces]]
binding = "SNAPSHOTS"
id = "REPLACE_WITH_KV_NAMESPACE_ID"
```

- [ ] **Step 2: Create the KV namespace and deploy the Worker**

```bash
npx wrangler kv namespace create SNAPSHOTS
# paste the returned id into wrangler.toml, then:
npx wrangler secret put SNAPSHOT_WRITE_TOKEN     # paste a freshly generated token
npx wrangler deploy
```

Generate the token with `openssl rand -hex 32`.

- [ ] **Step 3: Verify the Worker end to end**

```bash
WORKER=https://wire-room-snapshot.<subdomain>.workers.dev/snapshot.json
TOKEN=<the token>

# unauthenticated write must be refused
curl -s -o /dev/null -w "no-token PUT -> %{http_code} (expect 403)\n" -X PUT -d '{}' "$WORKER"

# authenticated write must succeed
curl -s -o /dev/null -w "authed PUT   -> %{http_code} (expect 200)\n" \
  -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data-binary @public/snapshot.json "$WORKER"

# public read must succeed and be cacheable
curl -s -D- -o /dev/null "$WORKER" | grep -iE "^(HTTP|cache-control|access-control-allow-origin)"
```

Expected: 403, then 200, then `HTTP/2 200`, `cache-control: public, max-age=60...`, `access-control-allow-origin: *`.

- [ ] **Step 4: Point the producer at it**

In the Railway `wire-room-ops` service, set `SNAPSHOT_PUSH_URL` to the Worker URL and `SNAPSHOT_PUSH_TOKEN` to the same token, then redeploy. Within five minutes the logs should show:

```
[PublicSnapshot] published NNNN bytes, NN events
```

Confirm the live payload is real and, critically, that it leaked nothing:

```bash
curl -s "$WORKER" | python3 -m json.tool | head -40
curl -s "$WORKER" | grep -icE "operator_read|actioned_by|quality_score|decline|@" \
  && echo "LEAK — investigate immediately" || echo "clean"
```

- [ ] **Step 5: Deploy the site**

```bash
npm run build
npx wrangler pages deploy dist --project-name wire-room-live
```

Set `VITE_SNAPSHOT_URL` to the Worker URL at build time so the page fetches the live snapshot rather than the fixture:

```bash
VITE_SNAPSHOT_URL="$WORKER" npm run build && npx wrangler pages deploy dist --project-name wire-room-live
```

- [ ] **Step 6: Verify the deployed page**

Open the Pages URL. Confirm: the room renders, the badge leaves `CONNECTING`, funnel numbers match the Worker payload, and a full loop animates. Then delete the fixture so production can never silently serve it:

```bash
git rm public/snapshot.json
git commit -m "chore: drop the local snapshot fixture now that the Worker serves live data"
```

- [ ] **Step 7: Commit**

```bash
git add wrangler.toml
git commit -m "chore: Worker config and deploy"
```

---

## Notes for the implementer

**Where the artwork lives.** The chosen backplate is `room-v5-b.png`, generated with `art/room-prompt.txt` via the `openai-images` skill (`gpt-image-2`, `1536x1024`, quality `high`). To regenerate: rerun that prompt, replace `art/room.png`, re-measure `src/anchors.ts`, and run `npm run verify:anchors` until it passes. **Never** ship a new backplate without re-running that check.

**Why the panels must stay empty.** The two dark wall panels are where the funnel board and coverage grid live. Image models will happily fill a blank screen with invented content if the prompt drifts; the anchor check is what catches that before it ships.

**The one rule that matters most.** In `src/services/public-snapshot.ts`, never write `...row`. Every output object is constructed field by field. The database rows genuinely carry private columns — contact emails, BD-lens notes, decline reasons — and a spread would publish them. `tests/public-snapshot-leak.test.js` exists to make that failure loud.
