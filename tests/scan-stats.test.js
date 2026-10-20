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
  ]), { openCalls: 2, forthcomingCalls: 2 });
});
