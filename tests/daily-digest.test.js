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
  assert.match(findsSql, /NOT \(q\.id = ANY\(\$2::int\[\]\)\)/);
  assert.match(findsSql, /deadline_parsed IS NULL OR q\.deadline_parsed >= CURRENT_DATE/);
  assert.match(findsSql, /metadata->'curator'->>'route'/);
  assert.match(findsSql, /quality_score DESC NULLS LAST/);
  assert.match(findsSql, /created_at >= NOW\(\) - INTERVAL '60 days'/, 'candidate window must match watermark retention');
  assert.ok(!findsSql.includes('24 hours'), 'watermark replaces the 24h window');
  assert.deepEqual(pool.calls[0].params, [8, [7]]);
  const countSql = pool.calls[1].sql;
  assert.match(countSql, /created_at >= NOW\(\) - INTERVAL '60 days'/, 'totalNew count must match the same 60-day window');
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

test('getFreshFinds: a seeding write failure degrades to the 24h-window fallback instead of throwing', async () => {
  const pool = fakePool();
  pool.queueResponse([{ id: 1 }, { id: 2 }]); // seed SELECT id (queued ids)
  pool.queueResponse([{ id: 1, name: 'X', wire: 'ai', quality_score: 90, amount: null, deadline: null, source_url: null, curator_route: null, curator_confidence: null }]); // fallback SELECT
  const deps = {
    async getAppState() { return null; },
    async setAppState() { throw new Error('write failed'); },
  };

  const res = await getFreshFinds(pool, 8, deps);

  assert.equal(res.seeded, false);
  assert.equal(res.fallback, true);
  assert.equal(res.finds.length, 1);
  assert.match(pool.calls[1].sql, /24 hours/);
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

test('advanceDigestWatermark: a failed read never wipes history — it skips the write entirely', async () => {
  let setCalled = false;
  const deps = {
    async getAppState() { throw new Error('boom'); },
    async setAppState() { setCalled = true; },
  };

  await advanceDigestWatermark([5, 6], deps, new Date('2026-07-09T00:00:00Z'));

  assert.equal(setCalled, false, 'setAppState must never be called when the read fails');
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

test('buildRunLedger: failed scans produce an anomaly; stale bridge warns without flipping the verdict', async () => {
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
  assert.equal(anomalies.length, 1);
  assert.match(anomalies[0], /2 failed/);
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

test('assembleAndSendDailyDigest: a watermark advance failure never fails a delivered email', async () => {
  const { deps, sent } = assemblyDeps({ advance: async () => { throw new Error('app_state write failed'); } });

  const summary = await assembleAndSendDailyDigest({}, {}, deps);

  assert.equal(sent.length, 1);
  assert.equal(summary.freshCount, 1);
});

test('assembleAndSendDailyDigest: cost spike >$5 becomes an anomaly', async () => {
  const { deps, sent } = assemblyDeps({ cost: async () => ({ rows: [], total: 6.4 }) });
  await assembleAndSendDailyDigest({}, {}, deps);
  assert.ok(sent[0][3].anomalies.some(a => a.includes('$6.40')));
});

test('getFreshFinds excludes recheck-flagged duplicates and selects the card summary', async () => {
  const pool = fakePool();
  pool.queueResponse([]);
  pool.queueResponse([{ total_new: '0' }]);
  const { deps } = fakeState({ [DIGEST_WATERMARK_KEY]: { '7': '2026-07-01T00:00:00Z' } });

  await getFreshFinds(pool, 8, deps);

  const findsSql = pool.calls[0].sql;
  assert.match(findsSql, /decided_recheck/, 'stamped recheck verdicts must be consulted');
  assert.match(findsSql, /<> 'same_listing'/, 'flagged same_listing entries must never reach the email');
  assert.match(findsSql, /AS summary/, 'cards need the classifier summary');
  assert.match(findsSql, /recheck_matched_name/, 'update notes need the matched entry name');
  const countSql = pool.calls[1].sql;
  assert.match(countSql, /<> 'same_listing'/, 'the totalNew count must apply the same exclusion');
});

test('buildRunLedger: gate lane appears with 24h auto-dupe count, omitted at zero', async () => {
  const pool = fakePool();
  pool.queueResponse([{ ok: '5', failed: '0' }]);   // scans probe
  pool.queueResponse([{ n: '12' }]);                 // gate probe
  const { deps } = fakeState({ 'summary-sync:watermark': new Date().toISOString() });
  const { ledger } = await buildRunLedger(pool, { date: '2026-07-10' }, deps);
  const gate = ledger.lanes.find(l => l.key === 'gate');
  assert.equal(gate.detail, 'gate 12 duped');
  assert.equal(gate.state, 'ok');

  const pool2 = fakePool();
  pool2.queueResponse([{ ok: '5', failed: '0' }]);
  pool2.queueResponse([{ n: '0' }]);
  const r2 = await buildRunLedger(pool2, { date: '2026-07-10' }, deps);
  assert.ok(!r2.ledger.lanes.some(l => l.key === 'gate'), 'zero → omitted');
});

test('getFreshFinds selects program history via the programs join', async () => {
  const pool = fakePool();
  pool.queueResponse([]);
  pool.queueResponse([{ total_new: '0' }]);
  const { deps } = fakeState({ [DIGEST_WATERMARK_KEY]: {} });
  await getFreshFinds(pool, 8, deps);
  assert.match(pool.calls[0].sql, /LEFT JOIN programs/);
  assert.match(pool.calls[0].sql, /program_history/);
  assert.match(pool.calls[0].sql, /program_verdict/);
});
