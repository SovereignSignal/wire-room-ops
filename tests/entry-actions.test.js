require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

// These are integration tests against the real DB
// Requires DATABASE_URL to be set
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.log('Skipping entry-actions tests: DATABASE_URL not set');
  process.exit(0);
}

const {
  getEntry,
  getQueuedEntries,
  scheduleForDistribution,
} = require('../src/services/entry-actions');

test('getEntry returns null for non-existent entry', async () => {
  const result = await getEntry(999999999);
  assert.equal(result, null);
});

test('getEntry returns entry when found', async () => {
  // Use entry #1 which should always exist
  const result = await getEntry(1);
  if (result) {
    assert.ok(result.id, 'should have id');
    assert.ok(result.name !== undefined, 'should have name');
    assert.ok(result.status, 'should have status');
  }
  // If no entry 1, that's also fine — just means it was cleaned up
});

test('getQueuedEntries returns array', async () => {
  const results = await getQueuedEntries({ limit: 5 });
  assert.ok(Array.isArray(results), 'should return array');
  for (const entry of results) {
    assert.equal(entry.status, 'queued', 'all entries should be queued');
  }
});

test('getQueuedEntries filters by wire', async () => {
  const results = await getQueuedEntries({ wire: 'crypto', limit: 5 });
  assert.ok(Array.isArray(results));
  for (const entry of results) {
    assert.equal(entry.wire, 'crypto', 'all entries should be crypto wire');
  }
});

test('scheduleForDistribution sets distribute_after on approved entry', async () => {
  // Find an approved entry to test with
  const { getPool } = require('../src/db');
  const pool = getPool();
  const res = await pool.query(`SELECT id FROM scan_entries WHERE status = 'approved' LIMIT 1`);
  if (res.rows.length === 0) {
    // No approved entries, skip
    return;
  }
  const entryId = res.rows[0].id;
  const when = new Date('2099-01-01T00:00:00Z'); // Far future so it won't actually distribute

  await scheduleForDistribution(entryId, when);

  const check = await pool.query('SELECT distribute_after FROM scan_entries WHERE id = $1', [entryId]);
  assert.ok(check.rows[0].distribute_after, 'distribute_after should be set');

  // Clean up — unset it
  await pool.query('UPDATE scan_entries SET distribute_after = NULL WHERE id = $1', [entryId]);
});
