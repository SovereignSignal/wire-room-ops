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
const { restoreEntryRows, EntryActionConflictError } = require('../src/services/entry-actions');
const { insertIntakeEntryWithClaim } = require('../src/services/intake-core');
const { rewriteEntryWires, linkEntryDuplicate, EntryMaintenanceError } = require('../src/services/entry-maintenance');

async function insertEntry(pool, name, url, status = 'raw') {
  const res = await pool.query(
    `INSERT INTO scan_entries (name, description, source_url, wire, prompt_variant, scan_source, scan_date, status)
     VALUES ($1, 'test entry', $2, 'oss', 'A', 'web-search', CURRENT_DATE, $3)
     RETURNING id`,
    [name, url, status]
  );
  return res.rows[0].id;
}

test('annotateAlternateSource writes operator_notes without 42P18', async () => {
  const pool = getPool();
  const sourceUrl = 'https://example.com/regression-a-' + process.pid;
  const id = await insertEntry(pool, 'Regression Test Program A', sourceUrl, 'deduped');
  try {
    // This UPDATE used to fail with "could not determine data type of
    // parameter" because CONCAT_WS is variadic "any" — the ::text cast is
    // load-bearing.
    await annotateAlternateSource(pool, id, sourceUrl, {
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

test('archived URL ownership transfers atomically to a fresh entry for reconsideration', async () => {
  const pool = getPool();
  const url = 'https://example.com/archived-reconsideration-' + process.pid;
  const archived = await insertEntry(pool, 'Archived Signal', url, 'archived');
  const fresh = await insertEntry(pool, 'Fresh Signal', url, 'raw');
  try {
    const first = await registerSeen(pool, { id: archived, sourceUrl: url, name: 'Archived Signal', wire: 'oss', scanDate: '2026-06-10' });
    assert.equal(first.urlConflict, false);

    const reconsidered = await registerSeen(pool, { id: fresh, sourceUrl: url, name: 'Fresh Signal', wire: 'oss', scanDate: '2026-08-22' });
    assert.deepEqual(reconsidered, { urlConflict: false, conflictEntryId: null });
    const owner = await pool.query(
      `SELECT first_seen_entry_id FROM seen_urls WHERE normalized_url = $1 AND wire = 'oss'`,
      [url],
    );
    assert.equal(Number(owner.rows[0].first_seen_entry_id), fresh);
  } finally {
    await pool.query(`DELETE FROM seen_names WHERE entry_id IN ($1, $2)`, [archived, fresh]);
    await pool.query(`DELETE FROM seen_urls WHERE first_seen_entry_id IN ($1, $2)`, [archived, fresh]);
    await pool.query(`DELETE FROM scan_entries WHERE id IN ($1, $2)`, [archived, fresh]);
  }
});

test('archived-owner transfer and x-monitor restore serialize without split ownership', async () => {
  const pool = getPool();
  const url = 'https://example.com/restore-transfer-race-' + process.pid + '-' + Date.now();
  const archived = await insertEntry(pool, 'Archived Race Signal', url, 'archived');
  const fresh = await insertEntry(pool, 'Fresh Race Signal', url, 'raw');
  try {
    await pool.query(
      `UPDATE scan_entries
       SET scan_source = 'x-monitor', classification = 'GRANT',
           metadata = jsonb_build_object('operator_route', 'publish')
       WHERE id = $1`,
      [archived],
    );
    const first = await registerSeen(pool, { id: archived, sourceUrl: url, name: 'Archived Race Signal', wire: 'oss', scanDate: '2026-06-10' });
    assert.equal(first.urlConflict, false);

    const [claimResult, restoreResult] = await Promise.allSettled([
      registerSeen(pool, { id: fresh, sourceUrl: url, name: 'Fresh Race Signal', wire: 'oss', scanDate: '2026-08-22' }),
      restoreEntryRows(pool, [archived], { actor: 'integration-test', reason: 'race proof' }),
    ]);

    assert.equal(claimResult.status, 'fulfilled');
    const state = await pool.query(
      `SELECT se.status, su.first_seen_entry_id
       FROM scan_entries se
       JOIN seen_urls su ON su.normalized_url = $2 AND su.wire = 'oss'
       WHERE se.id = $1`,
      [archived, url],
    );
    const owner = Number(state.rows[0].first_seen_entry_id);
    if (restoreResult.status === 'fulfilled') {
      assert.equal(state.rows[0].status, 'queued');
      assert.equal(owner, archived, 'a restored archived row must retain URL ownership');
      assert.equal(claimResult.value.urlConflict, true);
    } else {
      assert.ok(restoreResult.reason instanceof EntryActionConflictError);
      assert.equal(state.rows[0].status, 'archived');
      assert.equal(owner, fresh, 'a transferred URL must keep the archived row inactive');
      assert.equal(claimResult.value.urlConflict, false);
    }
  } finally {
    await pool.query(`DELETE FROM seen_names WHERE entry_id IN ($1, $2)`, [archived, fresh]);
    await pool.query(`DELETE FROM seen_urls WHERE first_seen_entry_id IN ($1, $2)`, [archived, fresh]);
    await pool.query(`DELETE FROM scan_entries WHERE id IN ($1, $2)`, [archived, fresh]);
  }
});

test('Wire rewrite moves primary and alternate URL ownership to the new dedup scope', async () => {
  const pool = getPool();
  const suffix = process.pid + '-' + Date.now();
  const url = 'https://example.com/wire-move-' + suffix;
  const aliasUrl = 'https://example.org/wire-alias-' + suffix;
  const entryId = await insertEntry(pool, 'Atomic Wire Move', url, 'queued');
  try {
    const claim = await registerSeen(pool, { id: entryId, sourceUrl: url, name: 'Atomic Wire Move', wire: 'oss', scanDate: '2026-08-22' });
    assert.equal(claim.urlConflict, false);
    await pool.query(
      `INSERT INTO seen_urls (url, normalized_url, first_seen_entry_id, first_seen_date, wire)
       VALUES ($1, $1, $2, CURRENT_DATE, 'oss')`,
      [aliasUrl, entryId],
    );

    const moved = await rewriteEntryWires(pool, entryId, {
      wires: ['ai', 'oss'],
      actor: 'integration-test',
      reason: 'atomic scope proof',
    });
    assert.equal(moved.wire, 'ai');

    const entryState = await pool.query(`SELECT wire, wires FROM scan_entries WHERE id = $1`, [entryId]);
    assert.equal(entryState.rows[0].wire, 'ai');
    assert.deepEqual(entryState.rows[0].wires, ['ai', 'oss']);

    const registry = await pool.query(
      `SELECT url, wire, first_seen_entry_id
       FROM seen_urls
       WHERE first_seen_entry_id = $1
       ORDER BY url`,
      [entryId],
    );
    assert.equal(registry.rows.length, 2);
    assert.deepEqual(registry.rows.map(row => row.url), [url, aliasUrl].sort());
    assert.ok(registry.rows.every(row => row.wire === 'ai'));
    assert.ok(registry.rows.every(row => Number(row.first_seen_entry_id) === entryId));
  } finally {
    await pool.query(`DELETE FROM seen_names WHERE entry_id = $1`, [entryId]);
    await pool.query(`DELETE FROM seen_urls WHERE first_seen_entry_id = $1`, [entryId]);
    await pool.query(`DELETE FROM scan_entries WHERE id = $1`, [entryId]);
  }
});

test('seed-only seen URL remains a conflict and cannot enter the live queue', async () => {
  const pool = getPool();
  const url = `https://example.com/seed-history-${process.pid}-${Date.now()}`;
  await pool.query(
    `INSERT INTO seen_urls (url, normalized_url, first_seen_entry_id, first_seen_date, wire)
     VALUES ($1, $1, NULL, CURRENT_DATE, 'oss')`,
    [url],
  );

  let insertedId;
  try {
    const inserted = await insertIntakeEntryWithClaim(pool, {
      name: 'Seed History Regression Program',
      description: 'must remain blocked by the seed-only URL registry',
      sourceUrl: url,
      wire: 'oss',
      scanDate: '2026-07-10',
      submittedBy: 'integration-test',
      scanSource: 'manual-intake',
      status: 'queued',
    });
    insertedId = inserted.id;
    assert.equal(inserted.urlConflict, true);
    assert.equal(inserted.conflictEntryId, null);

    const row = await pool.query(
      `SELECT status, duplicate_of_id, distributable FROM scan_entries WHERE id = $1`,
      [insertedId],
    );
    assert.equal(row.rows[0].status, 'deduped');
    assert.equal(row.rows[0].duplicate_of_id, null);
    assert.equal(row.rows[0].distributable, false);

    const registry = await pool.query(
      `SELECT first_seen_entry_id FROM seen_urls WHERE normalized_url = $1 AND wire = 'oss'`,
      [url],
    );
    assert.equal(registry.rows[0].first_seen_entry_id, null);
  } finally {
    if (insertedId) {
      await pool.query(`DELETE FROM seen_names WHERE entry_id = $1`, [insertedId]);
      await pool.query(`DELETE FROM scan_entries WHERE id = $1`, [insertedId]);
    }
    await pool.query(`DELETE FROM seen_urls WHERE normalized_url = $1 AND wire = 'oss'`, [url]);
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

test('concurrent intake claims leave only the exact-URL winner queued', async () => {
  const pool = getPool();
  const url = `https://example.com/intake-claim-race-${process.pid}-${Date.now()}`;
  const scanDate = '2026-07-10';
  const common = {
    description: 'concurrent exact URL claim regression',
    sourceUrl: url,
    wire: 'oss',
    scanDate,
    submittedBy: 'integration-test',
    scanSource: 'manual-intake',
    status: 'queued',
  };
  const results = await Promise.all([
    insertIntakeEntryWithClaim(pool, { ...common, name: 'Concurrent Claim Alpha' }),
    insertIntakeEntryWithClaim(pool, { ...common, name: 'Concurrent Claim Beta' }),
  ]);
  const ids = results.map(result => result.id);
  try {
    const winners = results.filter(result => result.conflictEntryId === null);
    const losers = results.filter(result => result.conflictEntryId !== null);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(losers[0].conflictEntryId, winners[0].id);

    const rows = await pool.query(
      `SELECT id, status, duplicate_of_id FROM scan_entries WHERE id = ANY($1::bigint[]) ORDER BY id`,
      [ids],
    );
    const winner = rows.rows.find(row => Number(row.id) === winners[0].id);
    const loser = rows.rows.find(row => Number(row.id) === losers[0].id);
    assert.equal(winner.status, 'queued');
    assert.equal(winner.duplicate_of_id, null);
    assert.equal(loser.status, 'duplicate');
    assert.equal(Number(loser.duplicate_of_id), winners[0].id);

    const registry = await pool.query(
      `SELECT first_seen_entry_id FROM seen_urls WHERE normalized_url = $1 AND wire = 'oss'`,
      [url],
    );
    assert.equal(Number(registry.rows[0].first_seen_entry_id), winners[0].id);
  } finally {
    await pool.query(`DELETE FROM seen_names WHERE entry_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM seen_urls WHERE first_seen_entry_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM scan_entries WHERE id = ANY($1::bigint[])`, [ids]);
  }
});

test('opposite concurrent duplicate links cannot create a two-entry cycle', async () => {
  const pool = getPool();
  const suffix = `${process.pid}-${Date.now()}`;
  const urlA = `https://example.com/cycle-a-${suffix}`;
  const urlB = `https://example.com/cycle-b-${suffix}`;
  const a = await insertEntry(pool, `Cycle Alpha ${suffix}`, urlA, 'queued');
  const b = await insertEntry(pool, `Cycle Beta ${suffix}`, urlB, 'queued');
  try {
    const [ab, ba] = await Promise.allSettled([
      linkEntryDuplicate(pool, a, {
        expectedStatus: 'queued', expectedSourceUrl: urlA, duplicateOfId: b,
        actor: 'integration-test', reason: 'concurrent cycle regression A to B',
      }),
      linkEntryDuplicate(pool, b, {
        expectedStatus: 'queued', expectedSourceUrl: urlB, duplicateOfId: a,
        actor: 'integration-test', reason: 'concurrent cycle regression B to A',
      }),
    ]);
    const fulfilled = [ab, ba].filter(result => result.status === 'fulfilled');
    const rejected = [ab, ba].filter(result => result.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof EntryMaintenanceError);
    assert.equal(rejected[0].reason.statusCode, 409);

    const rows = await pool.query(
      `SELECT id, status, duplicate_of_id FROM scan_entries WHERE id = ANY($1::bigint[])`,
      [[a, b]],
    );
    const rowA = rows.rows.find(row => Number(row.id) === a);
    const rowB = rows.rows.find(row => Number(row.id) === b);
    assert.equal(Number(rowA.duplicate_of_id) === b && Number(rowB.duplicate_of_id) === a, false);
    assert.equal(rows.rows.filter(row => row.status === 'duplicate').length, 1);
  } finally {
    await pool.query(`DELETE FROM seen_names WHERE entry_id IN ($1, $2)`, [a, b]);
    await pool.query(`DELETE FROM seen_urls WHERE first_seen_entry_id IN ($1, $2)`, [a, b]);
    await pool.query(`DELETE FROM scan_entries WHERE id IN ($1, $2)`, [a, b]);
  }
});

test('findRelatedOpportunity SQL matches the same EU topic and skips a fellowship with the same words', async () => {
  const pool = getPool();
  const { findRelatedOpportunity } = require('../src/services/dedup');
  const pid = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const topic = 'HORIZON-BRIDGING-2027-01-13';
  const otherTopic = 'HORIZON-BRIDGING-2027-01-12';
  const fellowshipId = await insertEntry(pool, 'Horizon Bridging Fellowship Programme 2026', `https://fellowship-${pid}.example/2026`, 'approved');
  const topicId = await insertEntry(pool, `Commission note ${topic}`, `https://notes-${pid}.example/brief`, 'queued');
  const otherId = await insertEntry(pool, `${otherTopic} briefing`, `https://notes-${pid}.example/other`, 'approved');
  await pool.query(
    `INSERT INTO seen_names (name_original, name_normalized, name_tokens, entry_id, wire, first_seen)
     VALUES
       ($1, 'bridging fellowship horizon', $2::text[], $3, 'oss', CURRENT_DATE),
       ($4, 'commission note', $5::text[], $6, 'oss', CURRENT_DATE),
       ($7, 'bridging horizon', $8::text[], $9, 'oss', CURRENT_DATE)`,
    [
      'Horizon Bridging Fellowship Programme 2026', ['horizon', 'bridging', '2026'], fellowshipId,
      `Commission note ${topic}`, ['commission', 'note'], topicId,
      `${otherTopic} briefing`, ['horizon', 'bridging'], otherId,
    ],
  );
  try {
    const same = await findRelatedOpportunity(pool, {
      sourceUrl: `https://ec.europa.eu/topic-details/${topic.toLowerCase()}`,
      name: topic,
      wire: 'oss',
    });
    assert.equal(same.isRelated, true);
    assert.equal(Number(same.matchedEntryId), topicId);
    assert.equal(same.confidence, 1);
    assert.match(same.reason, new RegExp(topic));

    const absent = await findRelatedOpportunity(pool, {
      sourceUrl: 'https://ec.europa.eu/topic-details/horizon-bridging-2027-01-14',
      name: 'HORIZON-BRIDGING-2027-01-14',
      wire: 'oss',
    });
    assert.equal(absent.isRelated, false, 'a different topic id and a fellowship are not alternate sources');
    assert.equal(absent.matchedEntryId, null);
  } finally {
    await pool.query(`DELETE FROM seen_names WHERE entry_id IN ($1, $2, $3)`, [fellowshipId, topicId, otherId]);
    await pool.query(`DELETE FROM scan_entries WHERE id IN ($1, $2, $3)`, [fellowshipId, topicId, otherId]);
  }
});

test.after(async () => {
  await closePool();
});
