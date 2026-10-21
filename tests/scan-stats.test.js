require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const { getPromptEffectivenessStats, splitOpenCallCounts } = require('../src/services/scan-stats');

test('prompt stats bind the optional wire and count overlap before deduplication', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('WITH prompt_entries')) return { rows: [] };
      return { rows: [{ total_unique: '4', found_by_multiple: '2' }] };
    },
  };

  const stats = await getPromptEffectivenessStats(pool, 21, 'oss');
  assert.deepEqual(calls[0].params, [21, 'oss']);
  assert.deepEqual(calls[1].params, [21, 'oss']);
  assert.doesNotMatch(calls[1].sql, /status != 'duplicate'/);
  assert.match(calls[1].sql, /normalized_source_url/);
  assert.equal(stats.overlapStats.overlapRate, 0.5);
  assert.match(calls[0].sql, /open_calls/);
  assert.match(calls[0].sql, /forthcoming_calls/);
  assert.doesNotMatch(calls[0].sql, /fresh_open_calls/);
});

test('open and forthcoming counts do not lump a not-yet-open call into open', () => {
  assert.deepEqual(splitOpenCallCounts([
    { classification: 'GRANT', lifecycle: null },
    { classification: 'GRANT', lifecycle: 'forthcoming' },
    { classification: 'GRANT', lifecycle: 'closed' },
    { classification: 'NEWS', lifecycle: 'forthcoming' },
    { classification: 'GRANT', lifecycle: 'open' },
  ]), { openCalls: 2, forthcomingCalls: 1 });
});

test('open count takes only open or blank GRANT rows, skipping unknown and duplicates', () => {
  assert.deepEqual(splitOpenCallCounts([
    { classification: 'GRANT', lifecycle: 'open', status: 'queued' },
    { classification: 'GRANT', lifecycle: null, status: 'approved' },
    { classification: 'GRANT', lifecycle: '', status: 'queued' },
    { classification: 'GRANT', lifecycle: 'unknown', status: 'queued' },
    { classification: 'GRANT', lifecycle: 'open', status: 'duplicate' },
    { classification: 'GRANT', lifecycle: null, status: 'duplicate' },
    { classification: 'NEWS', lifecycle: 'open', status: 'queued' },
  ]), { openCalls: 3, forthcomingCalls: 0 });
});

test('forthcoming count takes only non-duplicate GRANT rows', () => {
  assert.deepEqual(splitOpenCallCounts([
    { classification: 'GRANT', lifecycle: 'forthcoming', status: 'queued' },
    { classification: 'NOISE', lifecycle: 'forthcoming', status: 'queued' },
    { classification: 'GRANT', lifecycle: 'forthcoming', status: 'duplicate' },
    { classification: null, lifecycle: 'forthcoming' },
  ]), { openCalls: 0, forthcomingCalls: 1 });
});

test('prompt stats SQL applies the GRANT, lifecycle and duplicate filters', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('WITH prompt_entries')) return { rows: [] };
      return { rows: [{ total_unique: '0', found_by_multiple: '0' }] };
    },
  };
  await getPromptEffectivenessStats(pool, 7);
  const sql = calls[0].sql.replace(/\s+/g, ' ');
  assert.match(sql, /classification = 'GRANT' AND status IS DISTINCT FROM 'duplicate' AND lifecycle = 'forthcoming' \) AS forthcoming_calls/);
  assert.match(sql, /classification = 'GRANT' AND status IS DISTINCT FROM 'duplicate' AND COALESCE\(NULLIF\(btrim\(lifecycle\), ''\), 'open'\) = 'open' \) AS open_calls/);
  assert.doesNotMatch(sql, /NOT IN \('forthcoming', 'closed'\)/);
});
