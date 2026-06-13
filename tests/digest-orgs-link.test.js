require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureDigestItemOrgsTable, linkDigestItemToOrg } = require('../src/services/digest-orgs');

function stubPool() {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } };
}

test('ensureDigestItemOrgsTable creates table with unique (summary_id,item_index,org_id)', async () => {
  const pool = stubPool();
  await ensureDigestItemOrgsTable(pool);
  const sql = pool.calls[0].sql;
  assert.match(sql, /CREATE TABLE IF NOT EXISTS digest_item_orgs/);
  assert.match(sql, /UNIQUE\s*\(\s*summary_id\s*,\s*item_index\s*,\s*org_id\s*\)/);
});

test('linkDigestItemToOrg upserts idempotently (ON CONFLICT DO NOTHING)', async () => {
  const pool = stubPool();
  await linkDigestItemToOrg(pool, 4159, 0, 77);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /INSERT INTO digest_item_orgs/);
  assert.match(sql, /ON CONFLICT .* DO NOTHING/);
  assert.deepEqual(params, [4159, 0, 77]);
});
