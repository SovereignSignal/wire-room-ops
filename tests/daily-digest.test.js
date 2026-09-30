require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getFreshFinds, advanceDigestWatermark, pruneEmailedIds, DIGEST_WATERMARK_KEY, formatStaleSourceAnomalies,
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

function freshCohortRun() {
  const finished = new Date();
  return {
    run_id: 'claude-cohort-test',
    status: 'ok',
    started_at: new Date(finished.getTime() - 1000),
    finished_at: finished,
  };
}

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
  pool.queueResponse([{ n: '0' }]); // program gate
  pool.queueResponse([]); // provider outages
  pool.queueResponse([freshCohortRun()]);
  const { deps } = fakeState({
    'summary-sync:watermark': new Date().toISOString(),
    'agent-brief:2026-07-09': { runs: [{}, {}] },
  });

  const { ledger, anomalies } = await buildRunLedger(pool, { date: '2026-07-09', feeds: { ok: 19, total: 19 }, forum: 'ok' }, deps);

  const details = ledger.lanes.map(l => l.detail);
  assert.deepEqual(details, ['scans 41✓', 'feeds 19/19', 'forum ✓', 'bridge ✓', 'cohort ✓', 'agent 2 runs']);
  assert.ok(ledger.lanes.every(l => l.state === 'ok'));
  assert.deepEqual(anomalies, []);
});

test('buildRunLedger: sparse scan failures warn without becoming a production issue', async () => {
  const pool = fakePool();
  pool.queueResponse([{ ok: '39', failed: '2' }]);
  pool.queueResponse([{ n: '0' }]); // program gate
  pool.queueResponse([]); // provider outages
  pool.queueResponse([freshCohortRun()]);
  const { deps } = fakeState({
    'summary-sync:watermark': new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
  });

  const { ledger, anomalies } = await buildRunLedger(pool, { date: '2026-07-09' }, deps);

  const scans = ledger.lanes.find(l => l.key === 'scans');
  assert.equal(scans.state, 'warn');
  assert.equal(scans.detail, 'scans 39✓ 2✗');
  const bridge = ledger.lanes.find(l => l.key === 'bridge');
  assert.equal(bridge.state, 'warn');
  assert.deepEqual(anomalies, []);
});

test('buildRunLedger: repeated scan failures affecting at least half of attempts produce an anomaly', async () => {
  const pool = fakePool();
  pool.queueResponse([{ ok: '2', failed: '3' }]);
  const { deps } = fakeState({});

  const { ledger, anomalies } = await buildRunLedger(pool, { date: '2026-07-09' }, deps);

  const scans = ledger.lanes.find(l => l.key === 'scans');
  assert.equal(scans.state, 'fail');
  assert.equal(scans.detail, 'scans 2✓ 3✗');
  assert.match(anomalies[0], /3 failed/);
});

test('buildRunLedger: one failed scan with no successes still produces an anomaly', async () => {
  const pool = fakePool();
  pool.queueResponse([{ ok: '0', failed: '1' }]);
  const { deps } = fakeState({});

  const { ledger, anomalies } = await buildRunLedger(pool, { date: '2026-07-09' }, deps);

  const scans = ledger.lanes.find(l => l.key === 'scans');
  assert.equal(scans.state, 'fail');
  assert.equal(scans.detail, 'scans 0✓ 1✗');
  assert.match(anomalies[0], /1 failed/);
});

test('buildRunLedger: probe failures degrade to "?" lanes and never throw', async () => {
  const pool = { async query() { throw new Error('db down'); } };
  const deps = { async getAppState() { throw new Error('db down'); }, async setAppState() {} };

  const { ledger, anomalies } = await buildRunLedger(pool, { date: '2026-07-09', feeds: { ok: 17, total: 19 } }, deps);

  assert.equal(ledger.lanes.find(l => l.key === 'scans').detail, 'scans ?');
  assert.equal(ledger.lanes.find(l => l.key === 'feeds').state, 'fail');
  assert.equal(ledger.lanes.find(l => l.key === 'bridge').detail, 'bridge ?');
  assert.equal(ledger.lanes.find(l => l.key === 'cohort').detail, 'cohort cursor unreadable');
  assert.deepEqual(anomalies, ['Cohort bridge health state unreadable: db down']);
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
      yield_: async () => ([]),
      producers: async () => ([]),
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

test('assembleAndSendDailyDigest: derives a zero-yield lane anomaly and merges lane anomalies', async () => {
  const yield_ = async () => ([{ source: 'web-search', total: 20, netNew: 0 }]);
  const { deps, sent } = assemblyDeps({ yield_ });
  await assembleAndSendDailyDigest({}, { laneAnomalies: ['Forum lane failed: x'] }, deps);
  const extras = sent[0][3];
  assert.ok(extras.anomalies.some(a => a.includes('Forum lane failed')));
  assert.ok(extras.anomalies.some(a => a.includes('Lane web-search: 0 net-new')), '20 fetched, 0 net-new');
});

test('assembleAndSendDailyDigest: human and chat intake lanes stay out of production issues', async () => {
  const yield_ = async () => ([
    { source: 'telegram', total: 17, netNew: 0 },
    { source: 'telegram-intake', total: 12, netNew: 0 },
    { source: 'manual-intake', total: 10, netNew: 0 },
    { source: 'forum', total: 11, netNew: 0 },
  ]);
  const { deps, sent } = assemblyDeps({ yield_ });

  await assembleAndSendDailyDigest({}, {}, deps);

  const anomalies = sent[0][3].anomalies;
  assert.ok(anomalies.some(a => a.includes('Lane forum')));
  assert.ok(!anomalies.some(a => a.includes('Lane telegram-intake')));
  assert.ok(!anomalies.some(a => a.includes('Lane telegram')));
  assert.ok(!anomalies.some(a => a.includes('Lane manual-intake')));
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
  assert.match(findsSql, /= 'same_listing'/, 'flagged same_listing entries must never reach the email');
  assert.match(findsSql, /cross_wire_blocked/, 'held cross-wire blocks must stay visible for review');
  assert.match(findsSql, /canonical_parent_blocked/, 'held canonical-parent blocks must stay visible for review');
  assert.match(findsSql, /duplicate_chain_error/, 'broken-chain holds must stay visible for review');
  assert.match(findsSql, /AS summary/, 'cards need the classifier summary');
  assert.match(findsSql, /recheck_matched_name/, 'update notes need the matched entry name');
  const countSql = pool.calls[1].sql;
  assert.match(countSql, /= 'same_listing'/, 'the totalNew count must apply the same exclusion');
  assert.match(countSql, /cross_wire_blocked/, 'the totalNew count must keep held entries visible');
});

test('buildRunLedger: held lane appears with 24h review-hold count, omitted at zero', async () => {
  const pool = fakePool();
  pool.queueResponse([{ ok: '5', failed: '0' }]);   // scans probe
  pool.queueResponse([{ n: '3' }]);                  // held probe
  const { deps } = fakeState({ 'summary-sync:watermark': new Date().toISOString() });
  const { ledger } = await buildRunLedger(pool, { date: '2026-07-10' }, deps);
  const held = ledger.lanes.find(l => l.key === 'held');
  assert.equal(held.detail, 'held 3 for review');
  assert.equal(held.state, 'warn');
  assert.match(pool.calls[1].sql, /cross_wire_blocked/, 'held probe must count recheck holds');
  assert.ok(!ledger.lanes.some(l => l.key === 'gate'), 'the retired program-gate lane must not appear');

  const pool2 = fakePool();
  pool2.queueResponse([{ ok: '5', failed: '0' }]);
  pool2.queueResponse([{ n: '0' }]);
  const r2 = await buildRunLedger(pool2, { date: '2026-07-10' }, deps);
  assert.ok(!r2.ledger.lanes.some(l => l.key === 'held'), 'zero → omitted');
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

test('buildRunLedger: a provider with failures and zero successes flags an account-level outage', async () => {
  const pool = fakePool();
  pool.queueResponse([{ ok: '12', failed: '0' }]);               // scans probe: healthy
  pool.queueResponse([{ n: '0' }]);                              // gate probe: no auto-dupes this run
  pool.queueResponse([                                            // provider-outage probe
    { provider: 'grok', ok: '0', failed: '120' },
    { provider: 'parallel', ok: '7', failed: '0' },
    { provider: 'firecrawl', ok: '3', failed: '2' },
  ]);
  pool.queueResponse([freshCohortRun()]);
  const { deps } = fakeState({ 'summary-sync:watermark': new Date().toISOString() });

  const { ledger, anomalies } = await buildRunLedger(pool, { date: '2026-07-11' }, deps);

  const providerSql = pool.calls[2].sql;
  assert.match(providerSql, /purpose <> 'scan-test'/);
  assert.match(providerSql, /purpose NOT LIKE 'parallel-test-%'/);

  const outage = ledger.lanes.find(l => l.key === 'api:grok');
  assert.equal(outage.state, 'fail');
  assert.match(outage.detail, /120✗/);
  assert.equal(ledger.lanes.find(l => l.key === 'api:parallel'), undefined, 'healthy providers add no lane');
  assert.equal(ledger.lanes.find(l => l.key === 'api:firecrawl'), undefined, 'mixed results add no lane');
  assert.match(anomalies.find(a => /grok/.test(a)), /account\/endpoint-level/);
});

const NOW = Date.parse('2026-07-30T13:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

test('a source failing its first day produces no anomaly', () => {
  const out = formatStaleSourceAnomalies([{ key: 'karma-gap', error: 'timeout after 45s', lastOk: daysAgo(1) }], NOW);
  assert.deepEqual(out, []);
});

test('a source failing 2+ days is named with its day count and last-OK date', () => {
  const out = formatStaleSourceAnomalies([{ key: 'karma-gap', error: 'timeout after 45s', lastOk: daysAgo(3) }], NOW);
  assert.equal(out.length, 1);
  assert.match(out[0], /^Source feeds: karma-gap failing 3 days \(last OK 2026-07-27\)$/);
});

test('healthy sources produce nothing', () => {
  const out = formatStaleSourceAnomalies([{ key: 'nlnet-news', lastOk: daysAgo(0) }], NOW);
  assert.deepEqual(out, []);
});

test('a source that has never succeeded is reported without a date', () => {
  const out = formatStaleSourceAnomalies([{ key: 'new-src', error: 'HTTP 404', lastOk: null }], NOW);
  assert.equal(out.length, 1);
  assert.match(out[0], /^Source feeds: new-src failing \(never succeeded\)$/);
});

test('multiple stale sources each get their own line, worst first', () => {
  const out = formatStaleSourceAnomalies([
    { key: 'a', error: 'x', lastOk: daysAgo(2) },
    { key: 'b', error: 'x', lastOk: daysAgo(5) },
  ], NOW);
  assert.equal(out.length, 2);
  assert.match(out[0], /^Source feeds: b failing 5 days/);
  assert.match(out[1], /^Source feeds: a failing 2 days/);
});

const { formatYieldAnomalies, getLaneYield } = require('../src/jobs/daily-digest');

test('a lane with zero net-new across the window is an issue', () => {
  const out = formatYieldAnomalies([{ source: 'web-search', total: 92, netNew: 0 }], 3);
  assert.equal(out.length, 1);
  assert.match(out[0], /^Lane web-search: 0 net-new in 3 days \(92 fetched\)$/);
});

test('a lane producing anything is not an issue', () => {
  assert.deepEqual(formatYieldAnomalies([{ source: 'web-search', total: 92, netNew: 1 }], 3), []);
});

test('low-volume lanes are ignored — 0 of 3 is not evidence', () => {
  assert.deepEqual(formatYieldAnomalies([{ source: 'forum', total: 3, netNew: 0 }], 3), []);
});

test('human intake lanes never produce a yield anomaly', () => {
  const rows = [
    { source: 'telegram', total: 40, netNew: 0 },
    { source: 'manual-intake', total: 30, netNew: 0 },
    { source: 'telegram-intake', total: 20, netNew: 0 },
  ];
  assert.deepEqual(formatYieldAnomalies(rows, 3), []);
});

test('yield is counted per lane, so a low-volume wire cannot hide', () => {
  // The retired dupe-rate rule had a per-wire total>=10 floor, which is how
  // crypto's 100% duplicate rate stayed out of the Jul 30 email.
  const out = formatYieldAnomalies([{ source: 'x-monitor', total: 7, netNew: 0 }], 3);
  assert.deepEqual(out, [], 'below the volume floor');
  const out2 = formatYieldAnomalies([{ source: 'x-monitor', total: 12, netNew: 0 }], 3);
  assert.equal(out2.length, 1);
});

test('the volume floor boundary is inclusive — total === 10 counts', () => {
  const out = formatYieldAnomalies([{ source: 'x-monitor', total: 10, netNew: 0 }], 3);
  assert.equal(out.length, 1, 'total === 10 must clear the >= floor');
});

test('getLaneYield asks for net-new excluding duplicate and deduped', async () => {
  let captured = null;
  const pool = { query: async (sql, params) => { captured = { sql, params }; return { rows: [] }; } };
  await getLaneYield(pool, 3);
  assert.match(captured.sql, /NOT IN \('duplicate',\s*'deduped'\)/);
  assert.deepEqual(captured.params, ['3']);
});

test('getLaneYield maps the net_new column onto netNew', async () => {
  const pool = { query: async () => ({ rows: [
    { source: 'web-search', total: 31, net_new: 1 },
    { source: 'feed', total: 6, net_new: 4 },
  ] }) };
  const rows = await getLaneYield(pool, 3);
  assert.deepEqual(rows, [
    { source: 'web-search', total: 31, netNew: 1 },
    { source: 'feed', total: 6, netNew: 4 },
  ]);
});

// ── public snapshot lane ────────────────────────────────────────────────────
// The Wire Room Live page is fed by a publisher inside this app. If it stops,
// the page silently serves stale data — so publisher health is a digest lane.

const { SNAPSHOT_STATE_KEY } = require('../src/jobs/public-snapshot');

function ledgerFixture(snapshotState) {
  const pool = fakePool();
  pool.queueResponse([{ ok: '41', failed: '0' }]);
  pool.queueResponse([{ n: '0' }]);   // program gate
  pool.queueResponse([]);             // provider outages
  pool.queueResponse([freshCohortRun()]);
  const state = { 'summary-sync:watermark': new Date().toISOString() };
  if (snapshotState !== undefined) state[SNAPSHOT_STATE_KEY] = snapshotState;
  const { deps } = fakeState(state);
  return { pool, deps };
}
const runLedger = f => buildRunLedger(f.pool, { date: '2026-07-09', feeds: { ok: 19, total: 19 }, forum: 'ok' }, f.deps);

test('snapshot lane is absent entirely when the publisher has never run', async () => {
  const { ledger } = await runLedger(ledgerFixture(undefined));
  assert.equal(ledger.lanes.find(l => l.key === 'snapshot'), undefined,
    'an unconfigured publisher must add no noise to the band');
});

test('snapshot lane is absent when the publisher is unconfigured', async () => {
  const { ledger } = await runLedger(ledgerFixture({ ok: false, reason: 'unconfigured' }));
  assert.equal(ledger.lanes.find(l => l.key === 'snapshot'), undefined);
});

test('a healthy recent publish renders an ok lane and no anomaly', async () => {
  const { ledger, anomalies } = await runLedger(
    ledgerFixture({ ok: true, bytes: 8123, at: new Date().toISOString() }));
  const lane = ledger.lanes.find(l => l.key === 'snapshot');
  assert.equal(lane.state, 'ok');
  assert.equal(lane.detail, 'snapshot ✓');
  assert.ok(!anomalies.some(a => /snapshot/i.test(a)));
});

test('a failing publisher becomes a fail lane AND a production anomaly', async () => {
  const { ledger, anomalies } = await runLedger(
    ledgerFixture({ ok: false, reason: 'http_403', at: new Date().toISOString() }));
  const lane = ledger.lanes.find(l => l.key === 'snapshot');
  assert.equal(lane.state, 'fail');
  assert.match(lane.detail, /http_403/);
  assert.ok(anomalies.some(a => /Wire Room Live/.test(a)),
    'a broken publisher must reach the operator, not just the logs');
});

test('a stale-but-successful publish warns without raising an anomaly', async () => {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { ledger, anomalies } = await runLedger(ledgerFixture({ ok: true, at: twoHoursAgo }));
  const lane = ledger.lanes.find(l => l.key === 'snapshot');
  assert.equal(lane.state, 'warn');
  assert.match(lane.detail, /120m old/);
  assert.ok(!anomalies.some(a => /snapshot/i.test(a)));
});

// ── Silent producers ────────────────────────────────────────────────────────
const { formatSilentProducerAnomalies, getProducerActivity, isSilentProducer } = require('../src/jobs/daily-digest');

test('a daily producer with nothing in 24h is an issue, named for what it is', () => {
  // 2026-09-05: Grok Build fed the queue 6 of 7 days, then its grok.com
  // automations did not fire. Nothing noticed until a human looked.
  const out = formatSilentProducerAnomalies([{ producer: 'telegram / agent:stringer', activeDays7d: 6, rows24h: 0, rows7d: 255 }]);
  assert.equal(out.length, 1);
  assert.match(out[0], /^Producer telegram \/ agent:stringer: 0 rows in 24h after 6 active days this week \(255 rows\)/);
});

test('a producer that ran today is not an issue, however thin', () => {
  assert.deepEqual(formatSilentProducerAnomalies([{ producer: 'feed', activeDays7d: 6, rows24h: 2, rows7d: 21 }]), []);
});

test('a lane on a three-day-a-week cadence never trips the daily rule', () => {
  assert.equal(isSilentProducer({ producer: 'grok-scout', activeDays7d: 3, rows24h: 0, rows7d: 29 }), false);
  assert.deepEqual(formatSilentProducerAnomalies([{ producer: 'claude-code', activeDays7d: 3, rows24h: 0, rows7d: 9 }]), []);
});

test('the active-days floor is inclusive — 5 of 7 is a daily cadence', () => {
  assert.equal(isSilentProducer({ producer: 'claude-cohort-notion', activeDays7d: 5, rows24h: 0, rows7d: 42 }), true);
  assert.equal(isSilentProducer({ producer: 'claude-cohort-notion', activeDays7d: 4, rows24h: 0, rows7d: 42 }), false);
});

test('a human pasting into the bot is not a schedule', () => {
  const rows = [
    { producer: 'telegram', activeDays7d: 7, rows24h: 0, rows7d: 30 },
    { producer: 'manual-intake', activeDays7d: 6, rows24h: 0, rows7d: 12 },
  ];
  assert.deepEqual(formatSilentProducerAnomalies(rows), []);
});

test('getProducerActivity keys agent submissions apart from the human door', async () => {
  let captured = null;
  const pool = { query: async (sql) => { captured = sql; return { rows: [] }; } };
  await getProducerActivity(pool);
  assert.match(captured, /submitted_by LIKE 'agent:%'/);
  assert.match(captured, /COUNT\(DISTINCT created_at::date\)/);
  assert.match(captured, /INTERVAL '24 hours'/);
});

test('assembleAndSendDailyDigest folds silent producers into anomalies', async () => {
  const producers = async () => ([{ producer: 'telegram / agent:stringer', activeDays7d: 6, rows24h: 0, rows7d: 255 }]);
  const { deps, sent } = assemblyDeps({ producers });
  await assembleAndSendDailyDigest({}, {}, deps);
  const opts = sent[0][3];
  assert.ok(opts.anomalies.some(a => /^Producer telegram \/ agent:stringer/.test(a)));
});

