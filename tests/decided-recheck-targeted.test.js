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
  assert.deepEqual(stats, { checked: 0, duplicates: 0, updates: 0, distinct: 0, errors: 0 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /id = ANY\(\$1::bigint\[\]\)/);
  assert.deepEqual(calls[0].params, [[12, 13]]);
});

test('targeted rechecks serialize to avoid racing the scheduled sweep', async () => {
  let activeQueries = 0;
  let maxActiveQueries = 0;
  const pool = {
    query: async () => {
      activeQueries++;
      maxActiveQueries = Math.max(maxActiveQueries, activeQueries);
      await new Promise(resolve => setTimeout(resolve, 20));
      activeQueries--;
      return { rows: [] };
    },
  };

  await Promise.all([
    runDecidedRecheckForIds(pool, [21]),
    runDecidedRecheckForIds(pool, [22]),
  ]);
  assert.equal(maxActiveQueries, 1);
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
