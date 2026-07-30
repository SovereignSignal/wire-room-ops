require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const { purgeSourceEntries } = require('../src/services/source-purge');

function purgePool(options = {}) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT id, program_id\s+FROM scan_entries\s+WHERE scan_source/.test(sql)) {
        return { rows: options.victims ?? [{ id: 1, program_id: 10 }, { id: 2, program_id: 10 }] };
      }
      if (/WHERE duplicate_of_id = ANY/.test(sql) && /FOR UPDATE/.test(sql)) {
        return { rows: options.referrers ?? [{ id: 3, program_id: 10 }] };
      }
      if (/DELETE FROM seen_names/.test(sql)) return { rows: [{ entry_id: 1 }] };
      if (/DELETE FROM seen_urls/.test(sql)) return { rows: [{ first_seen_entry_id: 1 }] };
      if (/DELETE FROM distribution_logs/.test(sql)) return { rows: [{ entry_id: 1 }] };
      if (/UPDATE scan_entries SET duplicate_of_id = NULL/.test(sql)) return { rows: [{ id: 3 }] };
      if (/DELETE FROM scan_entries/.test(sql)) return { rows: [{ id: 1 }, { id: 2 }] };
      if (/WITH target AS/.test(sql) && /UPDATE programs p SET/.test(sql)) {
        if (options.failRefresh) throw new Error('refresh failed');
        return { rows: [{ id: 10 }] };
      }
      if (/SELECT orphan\.id AS orphan_id/.test(sql)) {
        return { rows: options.pointerPlan ?? [{ orphan_id: 3, target_id: 4 }] };
      }
      if (/UPDATE seen_urls seen SET/.test(sql)) return { rows: [{ id: 9 }] };
      if (/UPDATE scan_entries orphan SET/.test(sql)) return { rows: [{ id: 3 }] };
      return { rows: [] };
    },
    release() { calls.push({ sql: 'RELEASE', params: [] }); },
  };
  return {
    calls,
    async query(sql, params) { return client.query(sql, params); },
    async connect() { return client; },
  };
}

test('purgeSourceEntries repairs program state and duplicate pointers atomically', async () => {
  const pool = purgePool();
  const result = await purgeSourceEntries(pool, 'forum');
  assert.deepEqual(result, {
    deleted: 2,
    seenNamesRemoved: 1,
    seenUrlsRemoved: 1,
    distributionLogsRemoved: 1,
    orphanPointersCleared: 1,
    orphanPointersRepointed: 1,
    seenUrlOwnersReassigned: 1,
    programsRepaired: 1,
  });
  const graphLock = pool.calls.findIndex(call => /duplicate-graph/.test(String(call.params?.[0])));
  const victimLock = pool.calls.findIndex(call => /WHERE scan_source/.test(call.sql));
  const deletion = pool.calls.findIndex(call => /DELETE FROM scan_entries/.test(call.sql));
  const programRepair = pool.calls.findIndex(call => /UPDATE programs p SET/.test(call.sql));
  const pointerRepair = pool.calls.findIndex(call => /UPDATE scan_entries orphan SET/.test(call.sql));
  assert.ok(graphLock >= 0 && graphLock < victimLock);
  assert.ok(deletion >= 0 && deletion < programRepair && programRepair < pointerRepair);
  assert.ok(pool.calls.some(call => call.sql === 'COMMIT'));
  assert.equal(pool.calls.at(-1).sql, 'RELEASE');
});

test('purgeSourceEntries leaves an empty source untouched', async () => {
  const pool = purgePool({ victims: [] });
  const result = await purgeSourceEntries(pool, 'missing');
  assert.equal(result.deleted, 0);
  assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
  assert.equal(pool.calls.some(call => /DELETE FROM scan_entries/.test(call.sql)), false);
  assert.equal(pool.calls.some(call => call.sql === 'COMMIT'), false);
});

test('purgeSourceEntries rolls every delete back when program repair fails', async () => {
  const pool = purgePool({ failRefresh: true });
  await assert.rejects(purgeSourceEntries(pool, 'forum'), /refresh failed/);
  assert.ok(pool.calls.some(call => /DELETE FROM scan_entries/.test(call.sql)));
  assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
  assert.equal(pool.calls.some(call => call.sql === 'COMMIT'), false);
  assert.equal(pool.calls.at(-1).sql, 'RELEASE');
});

test('purgeSourceEntries leaves pointerless duplicates alone without a valid canonical', async () => {
  const pool = purgePool({ pointerPlan: [] });
  const result = await purgeSourceEntries(pool, 'forum');
  assert.equal(result.orphanPointersCleared, 1);
  assert.equal(result.orphanPointersRepointed, 0);
  assert.equal(result.seenUrlOwnersReassigned, 0);
  assert.equal(pool.calls.some(call => /UPDATE scan_entries orphan SET/.test(call.sql)), false);
});
