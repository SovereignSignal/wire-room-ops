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

test('an empty day produces a valid, zeroed snapshot rather than throwing', () => {
  const snap = buildPublicSnapshot(base({ funnel: [] }), NOW);
  assert.equal(snap.funnel.find(f => f.stage === 'scanned').count, 0);
  assert.deepEqual(snap.events, []);
  assert.equal(snap.v, SNAPSHOT_VERSION);
});
