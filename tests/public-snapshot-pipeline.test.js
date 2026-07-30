require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { gatherSnapshotInput } = require('../src/jobs/public-snapshot');
const { buildPublicSnapshot, assertSnapshotShape } = require('../src/services/public-snapshot');

/**
 * End-to-end over a fake pool. The unit tests cover the builder and the
 * contract, but nothing checked that the QUERY ALIASES line up with what the
 * builder reads — a typo'd `AS n` would only surface in production. This walks
 * the whole chain: rows -> gather -> build -> assert.
 *
 * Responses are queued in the order gatherSnapshotInput issues them:
 * funnel, buckets, publishes, stations, coverage.
 */
const fakeDeps = (week = 30) => ({
  async getAppState() { return week; },
  async setAppState() {},
});

function fakePool(responses) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      return queue.shift() ?? { rows: [] };
    },
  };
}

const BUCKET = '2026-07-30T02:00:00.000Z';

function realisticPool() {
  return fakePool([
    { rows: [
      { status: 'duplicate', n: 143 },
      { status: 'queued', n: 41 },
      { status: 'archived', n: 60 },
      { status: 'approved', n: 12 },
    ] },
    { rows: [
      { bucket: BUCKET, status: 'duplicate', n: 6 },
      { bucket: BUCKET, status: 'queued', n: 4 },
    ] },
    { rows: [
      // Deliberately shaped like the real join, private columns and all.
      {
        created_at: '2026-07-30T02:33:00.000Z',
        external_id: '4821',
        wire: 'oss',
        name: 'NLnet Commons Fund',
        amount: '€50k',
      },
    ] },
    { rows: [
      { id: 'stringer', last_run_at: '2026-07-30T02:38:00.000Z', items_touched: 34 },
      { id: 'dedup', last_run_at: null, items_touched: 0 },
      { id: 'classifier', last_run_at: '2026-07-30T01:00:00.000Z', items_touched: 12 },
    ] },
    { rows: [{ total: 1136, fresh: 412, dark: 204 }] },
  ]);
}

test('gather -> build -> assert produces a valid snapshot from realistic rows', async () => {
  const pool = realisticPool();
  const input = await gatherSnapshotInput(pool, fakeDeps());
  const snap = buildPublicSnapshot(input, new Date('2026-07-30T02:41:00Z'));

  assert.doesNotThrow(() => assertSnapshotShape(snap));
  assert.equal(snap.v, 1);
  assert.equal(snap.coverage.total, 1136);
  assert.equal(snap.desk.surfacesWatched, 1136);

  const stage = k => snap.funnel.find(f => f.stage === k).count;
  assert.equal(stage('scanned'), 256);      // 143 + 41 + 60 + 12
  assert.equal(stage('duplicate'), 143);
  assert.equal(stage('review'), 41);
  assert.equal(stage('published'), 1);      // from distribution rows

  const pub = snap.events.find(e => e.kind === 'publish');
  assert.equal(pub.item.name, 'NLnet Commons Fund');
  assert.equal(pub.item.url, 'https://t.me/thegrantwire/4821');

  const byId = Object.fromEntries(snap.stations.map(s => [s.id, s.state]));
  assert.equal(byId.stringer, 'running');   // 3 min ago
  assert.equal(byId.classifier, 'idle');    // 101 min ago
  assert.equal(byId.dedup, 'idle');         // never
});

test('date columns arrive as strings from pg and are still handled', async () => {
  // node-postgres can return timestamps as strings depending on parser config.
  // gatherSnapshotInput wraps them in new Date(); this proves nothing throws
  // and the ISO output is correct rather than "Invalid Date".
  const snap = buildPublicSnapshot(
    await gatherSnapshotInput(realisticPool(), fakeDeps()), new Date('2026-07-30T02:41:00Z'));
  for (const e of snap.events) {
    assert.ok(!Number.isNaN(Date.parse(e.at)), `event time not parseable: ${e.at}`);
  }
  assert.equal(snap.stations.find(s => s.id === 'stringer').lastRunAt,
    '2026-07-30T02:38:00.000Z');
});

test('an entirely empty database yields a valid, publishable empty snapshot', async () => {
  const pool = fakePool([]);   // every query returns { rows: [] }
  const input = await gatherSnapshotInput(pool, fakeDeps());
  const snap = buildPublicSnapshot(input, new Date('2026-07-30T02:41:00Z'));

  assert.doesNotThrow(() => assertSnapshotShape(snap));
  assert.equal(snap.funnel.find(f => f.stage === 'scanned').count, 0);
  assert.deepEqual(snap.events, []);
  assert.equal(snap.coverage.total, 0);
});

test('the snapshot stays comfortably small on a busy day', async () => {
  // 96 buckets (24h at 15-min granularity) x 4 statuses, plus 40 publishes.
  const buckets = [];
  for (let i = 0; i < 96; i++) {
    const t = new Date(Date.UTC(2026, 6, 30, Math.floor(i / 4), (i % 4) * 15)).toISOString();
    for (const status of ['duplicate', 'queued', 'archived', 'raw']) {
      buckets.push({ bucket: t, status, n: 7 });
    }
  }
  const publishes = Array.from({ length: 40 }, (_, i) => ({
    created_at: new Date(Date.UTC(2026, 6, 30, i % 24, 0)).toISOString(),
    external_id: String(1000 + i),
    wire: 'crypto',
    name: `Programme number ${i} with a fairly long descriptive name`,
    amount: '$1,500,000',
  }));

  const pool = fakePool([
    { rows: [{ status: 'duplicate', n: 700 }, { status: 'queued', n: 200 }] },
    { rows: buckets },
    { rows: publishes },
    { rows: [] },
    { rows: [{ total: 1136, fresh: 412, dark: 204 }] },
  ]);

  const snap = buildPublicSnapshot(await gatherSnapshotInput(pool, fakeDeps()), new Date('2026-07-30T23:59:00Z'));
  assert.doesNotThrow(() => assertSnapshotShape(snap));
  const bytes = JSON.stringify(snap).length;
  assert.ok(bytes < 120 * 1024, `snapshot grew to ${bytes} bytes on a busy day`);
});
