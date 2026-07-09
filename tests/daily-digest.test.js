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
