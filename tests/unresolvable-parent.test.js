require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

// DB integration tests for the July 2026 "unresolvable duplicate parent" class.
//
// When a new entry's URL is owned (in seen_urls) by an existing entry that sits
// in a status the duplicate resolver does not accept as a canonical reference,
// the demotion cannot succeed. That is a PERMANENT data condition — retrying the
// identical demotion can never work. PR #86 spot-fixed the one status seen in
// production ('archived'); this suite pins the general contract: the automatic
// intake/dedup paths must make forward progress (surface the entry for review)
// instead of throwing, because a thrown demotion is treated as retryable and
// spins the Telegram webhook / process-raw loop forever.
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.log('Skipping unresolvable-parent tests: DATABASE_URL not set');
  process.exit(0);
}

const { getPool, closePool } = require('../src/db');
const { registerSeen, finalizeExistingEntryDedup } = require('../src/services/dedup');
const { insertIntakeEntryWithClaim } = require('../src/services/intake-core');

// 'skipped' is a valid, stable, non-canonical status (review-later): it is not in
// the resolver's canonical set (approved/declined/queued/archived), so a URL owner
// in this state reproduces the class without depending on archived (which #86
// already handles).
const NON_CANONICAL_STATUS = 'skipped';

async function insertEntry(pool, name, url, status) {
  const res = await pool.query(
    `INSERT INTO scan_entries (name, description, source_url, wire, prompt_variant, scan_source, scan_date, status)
     VALUES ($1, 'unresolvable-parent regression', $2, 'oss', 'A', 'web-search', CURRENT_DATE, $3)
     RETURNING id`,
    [name, url, status],
  );
  return res.rows[0].id;
}

async function cleanup(pool, ids) {
  await pool.query(`DELETE FROM seen_names WHERE entry_id = ANY($1::bigint[])`, [ids]);
  await pool.query(`DELETE FROM seen_urls WHERE first_seen_entry_id = ANY($1::bigint[])`, [ids]);
  await pool.query(`DELETE FROM scan_entries WHERE id = ANY($1::bigint[])`, [ids]);
}

test('process-raw path: finalizeExistingEntryDedup surfaces (not loops) a raw entry whose URL is owned by a non-canonical entry', async () => {
  const pool = getPool();
  const url = `https://example.com/unresolvable-finalize-${process.pid}-${Date.now()}`;
  // Owner sits in a non-canonical status and owns the URL in seen_urls.
  const owner = await insertEntry(pool, `Unresolvable Owner ${process.pid}`, url, NON_CANONICAL_STATUS);
  await registerSeen(pool, { id: owner, sourceUrl: url, name: `Unresolvable Owner ${process.pid}`, wire: 'oss', scanDate: '2026-07-12' });
  // A distinct raw entry arrives on the same URL (different name → not a name match).
  const child = await insertEntry(pool, `Unresolvable Child ${process.pid}`, url, 'raw');
  try {
    const outcome = await finalizeExistingEntryDedup(pool, {
      id: child,
      sourceUrl: url,
      name: `Unresolvable Child ${process.pid}`,
      wire: 'oss',
      scanDate: '2026-07-12',
      expectedStatus: 'raw',
    }, 180);

    // Must NOT be 'stale' (which process-raw retries forever) and must NOT throw.
    assert.equal(outcome.outcome, 'unresolved-parent');
    // Row advanced to 'deduped' → process-raw/daily-intake will queue it for review.
    const row = await pool.query(`SELECT status FROM scan_entries WHERE id = $1`, [child]);
    assert.equal(row.rows[0].status, 'deduped', 'entry must move forward out of raw, not stay stuck');
  } finally {
    await cleanup(pool, [owner, child]);
  }
});

test('telegram/batch path: insertIntakeEntryWithClaim keeps the entry visible (no throw, no retry) when the URL owner is non-canonical', async () => {
  const pool = getPool();
  const url = `https://example.com/unresolvable-intake-${process.pid}-${Date.now()}`;
  const owner = await insertEntry(pool, `Unresolvable Owner B ${process.pid}`, url, NON_CANONICAL_STATUS);
  await registerSeen(pool, { id: owner, sourceUrl: url, name: `Unresolvable Owner B ${process.pid}`, wire: 'oss', scanDate: '2026-07-12' });
  let childId;
  try {
    // This is exactly the batch-item shape that spun 44+ Telegram retries in prod.
    const inserted = await insertIntakeEntryWithClaim(pool, {
      name: `Unresolvable Intake ${process.pid}`,
      description: 'must not throw a retryable persistence error',
      sourceUrl: url,
      wire: 'oss',
      scanDate: '2026-07-12',
      submittedBy: 'integration-test',
      scanSource: 'manual-intake',
      status: 'queued',
    });
    childId = inserted.id;

    // The claim could not resolve to a canonical parent — but that is permanent,
    // so the call must RETURN (not throw) and flag it, leaving the entry visible.
    assert.equal(inserted.unresolvedParent, true, 'must report an unresolvable parent, not a retryable failure');
    const row = await pool.query(`SELECT status FROM scan_entries WHERE id = $1`, [childId]);
    assert.equal(row.rows[0].status, 'queued', 'entry stays in the review queue, not stuck or lost');
  } finally {
    const ids = childId ? [owner, childId] : [owner];
    await cleanup(pool, ids);
  }
});

test.after(async () => {
  await closePool();
});
