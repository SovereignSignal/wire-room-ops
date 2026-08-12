require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const { runDecidedRecheckForIds } = require('../src/jobs/decided-recheck');

test('targeted recheck queries only unique integer submission ids', async () => {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };

  const stats = await runDecidedRecheckForIds(pool, [12, 12, 13, 1.5, Number.NaN]);
  assert.deepEqual(stats, { checked: 0, duplicates: 0, updates: 0, distinct: 0, held: 0, errors: 0 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /id = ANY\(\$1::bigint\[\]\)/);
  assert.deepEqual(calls[0].params, [[12, 13]]);
});

test('no-candidate stamp compares the text deadline without a date type mismatch', async () => {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (calls.length === 1) {
        return {
          rows: [{
            id: 14,
            wire: 'oss',
            name: 'Deadline text target',
            description: 'A sufficiently descriptive test entry',
            source_url: 'https://example.org/deadline-text-target',
            deadline: 'Rolling',
          }],
        };
      }
      if (calls.length === 2) return { rows: [] };
      return { rows: [{ id: 14 }], rowCount: 1 };
    },
  };

  const stats = await runDecidedRecheckForIds(pool, [14]);
  assert.equal(stats.checked, 1);
  assert.match(calls[2].sql, /deadline IS NOT DISTINCT FROM \$6::text/);
  assert.doesNotMatch(calls[2].sql, /\$6::date/);
  assert.equal(calls[2].params[5], 'Rolling');
});

test('a targeted recheck skips instead of waiting behind an active run', async () => {
  let releaseFirstQuery;
  let firstQueryStarted;
  const started = new Promise(resolve => { firstQueryStarted = resolve; });
  const gate = new Promise(resolve => { releaseFirstQuery = resolve; });
  let queryCount = 0;
  const pool = {
    query: async () => {
      queryCount++;
      firstQueryStarted();
      await gate;
      return { rows: [] };
    },
  };

  const first = runDecidedRecheckForIds(pool, [21]);
  await started;
  const second = await runDecidedRecheckForIds(pool, [22]);
  assert.deepEqual(second, { checked: 0, duplicates: 0, updates: 0, distinct: 0, held: 0, errors: 0 });
  assert.equal(queryCount, 1);
  releaseFirstQuery();
  await first;
});

test('targeted recheck is a no op for an empty id list', async () => {
  let queried = false;
  const pool = {
    query: async () => {
      queried = true;
      return { rows: [] };
    },
  };

  await runDecidedRecheckForIds(pool, []);
  assert.equal(queried, false);
});
