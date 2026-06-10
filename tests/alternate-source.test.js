require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

// DB integration tests — regression coverage for the alternate-source
// annotation (CONCAT_WS parameter typing, error 42P18) and the concurrent
// URL claim in registerSeen. Requires DATABASE_URL (CI provides Postgres).
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.log('Skipping alternate-source tests: DATABASE_URL not set');
  process.exit(0);
}

const { getPool, closePool } = require('../src/db');
const { annotateAlternateSource, registerSeen, checkDuplicate } = require('../src/services/dedup');

async function insertEntry(pool, name, url) {
  const res = await pool.query(
    `INSERT INTO scan_entries (name, description, source_url, wire, prompt_variant, scan_source, scan_date, status)
     VALUES ($1, 'test entry', $2, 'oss', 'A', 'web-search', CURRENT_DATE, 'raw')
     RETURNING id`,
    [name, url]
  );
  return res.rows[0].id;
}

test('annotateAlternateSource writes operator_notes without 42P18', async () => {
  const pool = getPool();
  const id = await insertEntry(pool, 'Regression Test Program A', 'https://example.com/regression-a-' + process.pid);
  try {
    // This UPDATE used to fail with "could not determine data type of
    // parameter" because CONCAT_WS is variadic "any" — the ::text cast is
    // load-bearing.
    await annotateAlternateSource(pool, id, {
      isRelated: true,
      relationType: 'alternate_source',
      matchedEntryId: 12345,
      matchedEntryName: 'Some Matched Program',
      matchedSourceUrl: 'https://example.com/matched',
      matchedStatus: 'approved',
      confidence: 0.8,
      reason: 'regression test',
    });
    const check = await pool.query(`SELECT status, operator_notes FROM scan_entries WHERE id = $1`, [id]);
    assert.equal(check.rows[0].status, 'deduped');
    assert.match(check.rows[0].operator_notes, /alternate source/i);
  } finally {
    await pool.query(`DELETE FROM scan_entries WHERE id = $1`, [id]);
  }
});

test('registerSeen reports a conflict when another entry owns the URL', async () => {
  const pool = getPool();
  const url = 'https://example.com/claim-race-' + process.pid;
  const first = await insertEntry(pool, 'Claim Race Winner', url);
  const second = await insertEntry(pool, 'Claim Race Loser', url);
  try {
    const win = await registerSeen(pool, { id: first, sourceUrl: url, name: 'Claim Race Winner', wire: 'oss', scanDate: '2026-06-10' });
    assert.equal(win.urlConflict, false, 'first registration should win');

    const lose = await registerSeen(pool, { id: second, sourceUrl: url, name: 'Claim Race Loser', wire: 'oss', scanDate: '2026-06-10' });
    assert.equal(lose.urlConflict, true, 'second registration should conflict');
    assert.equal(lose.conflictEntryId, first, 'conflict should point at the winner');

    // Re-registering the same entry is idempotent, not a conflict
    const again = await registerSeen(pool, { id: first, sourceUrl: url, name: 'Claim Race Winner', wire: 'oss', scanDate: '2026-06-10' });
    assert.equal(again.urlConflict, false, 're-registration of the owner is not a conflict');
  } finally {
    await pool.query(`DELETE FROM seen_names WHERE entry_id IN ($1, $2)`, [first, second]);
    await pool.query(`DELETE FROM seen_urls WHERE first_seen_entry_id IN ($1, $2)`, [first, second]);
    await pool.query(`DELETE FROM scan_entries WHERE id IN ($1, $2)`, [first, second]);
  }
});

test('checkDuplicate does not match an entry against its own raw row', async () => {
  const pool = getPool();
  const name = 'Self Dedup Regression Program ' + process.pid;
  const url = 'https://example.com/self-dedup-' + process.pid;
  const id = await insertEntry(pool, name, url);
  try {
    // The exact-name layer matches scan_entries including status 'raw'.
    // Insert-first callers (daily-intake, process-raw) must exclude the
    // entry's own id or every new unique name is a duplicate of itself.
    const withExclusion = await checkDuplicate(pool, { sourceUrl: url, name, wire: 'oss', excludeEntryId: id }, 180);
    assert.equal(withExclusion.isDuplicate, false, 'own row must not count as a duplicate');

    // A genuinely different entry with the same name must still match.
    const secondId = await insertEntry(pool, name, url + '-other');
    const secondCheck = await checkDuplicate(pool, { sourceUrl: url + '-other', name, wire: 'oss', excludeEntryId: secondId }, 180);
    assert.equal(secondCheck.isDuplicate, true, 'a distinct same-name entry must match');
    assert.equal(secondCheck.matchedEntryId, id, 'match should point at the first entry');
    await pool.query(`DELETE FROM scan_entries WHERE id = $1`, [secondId]);
  } finally {
    await pool.query(`DELETE FROM scan_entries WHERE id = $1`, [id]);
  }
});

test.after(async () => {
  await closePool();
});
