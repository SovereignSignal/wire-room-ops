require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertSnapshotShape, buildPublicSnapshot } = require('../src/services/public-snapshot');

// Scan the CODE, not the prose. Doc comments legitimately mention the things
// these tests forbid (e.g. "no SELECT *, ever"), so strip comments first.
const JOB = fs.readFileSync(path.join(__dirname, '../src/jobs/public-snapshot.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

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

test('queries only touch the three tables the projection is allowed to read', () => {
  // Anchor to line starts: a bare /FROM\s+(\w+)/ also matches the argument
  // separator inside EXTRACT(minute FROM created_at).
  const tables = [
    ...JOB.matchAll(/^\s*FROM\s+([a-z_]+)/gim),
    ...JOB.matchAll(/\bJOIN\s+([a-z_]+)/gi),
  ].map(m => m[1].toLowerCase());
  const ALLOWED = new Set(['scan_entries', 'distribution_logs', 'watch_surfaces']);
  assert.ok(tables.length >= 4, `expected several table references, found ${tables.length}`);
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
  bad.events.push({
    at: '2026-07-30T00:00:00Z', kind: 'dedup', n: 2,
    item: { name: 'X', amount: null, wire: 'ai', url: 'u' },
  });
  assert.throws(() => assertSnapshotShape(bad), /only publish events/i);
});

test('the assertion rejects a publish item with extra fields', () => {
  const bad = valid();
  bad.events.push({
    at: '2026-07-30T00:00:00Z', kind: 'publish',
    item: { name: 'X', amount: null, wire: 'ai', url: 'u', score: 91 },
  });
  assert.throws(() => assertSnapshotShape(bad), /unexpected fields/i);
});

test('the assertion rejects an oversized payload', () => {
  const bad = valid();
  bad.events = Array.from({ length: 60000 },
    () => ({ at: '2026-07-30T00:00:00Z', kind: 'queue', n: 1 }));
  assert.throws(() => assertSnapshotShape(bad), /too large/i);
});
