require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

// The pure rules live in dedup-premature-decline.test.js. This file checks that
// finalizeExistingEntryDedup actually queues the operator note onto the row.
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.log('Skipping premature-decline dedup DB test: DATABASE_URL not set');
  process.exit(0);
}

const { getPool, closePool } = require('../src/db');
const { registerSeen, finalizeExistingEntryDedup } = require('../src/services/dedup');

const RATIONALE = 'No official 2026 Round 2 announcement, September 19 opening, or October 17 deadline was found…';

async function cleanup(pool, ids) {
  await pool.query(`DELETE FROM seen_names WHERE entry_id = ANY($1::bigint[])`, [ids]);
  await pool.query(`DELETE FROM seen_urls WHERE first_seen_entry_id = ANY($1::bigint[])`, [ids]);
  await pool.query(`DELETE FROM scan_entries WHERE id = ANY($1::bigint[])`, [ids]);
}

test('finalizeExistingEntryDedup writes the premature-decline note and does not demote #18508', async () => {
  const pool = getPool();
  const url = `https://numfocus.org/programs/small-development-grants/premature-${process.pid}-${Date.now()}`;
  const priorName = 'NumFOCUS Small Development Grants — 2026 Round 2';
  const incomingName = 'NumFOCUS SDG 2026 Round 2 — CFP open (due Oct 17)';
  const prior = await pool.query(
    `INSERT INTO scan_entries (name, description, source_url, wire, prompt_variant, scan_source, scan_date, status, deadline, deadline_parsed)
     VALUES ($1, 'premature decline fixture', $2, 'oss', 'N', 'web-search', '2026-08-11', 'raw', '2026-10-17', '2026-10-17')
     RETURNING id`,
    [priorName, url],
  );
  const priorId = prior.rows[0].id;
  let childId;
  try {
    await pool.query(
      `UPDATE scan_entries
       SET status = 'declined',
           metadata = $2::jsonb
       WHERE id = $1`,
      [priorId, JSON.stringify({
        curator: {
          route: 'decline',
          confidence: 'med',
          rationale: RATIONALE,
          by: 'stringer',
          at: '2026-08-11T15:04:00.000Z',
        },
      })],
    );
    await registerSeen(pool, {
      id: priorId,
      sourceUrl: url,
      name: priorName,
      wire: 'oss',
      scanDate: '2026-08-11',
      deadline: '2026-10-17',
    });

    const child = await pool.query(
      `INSERT INTO scan_entries (name, description, source_url, wire, prompt_variant, scan_source, scan_date, status, deadline, deadline_parsed)
       VALUES ($1, 'real CFP', $2, 'oss', 'N', 'web-search', '2026-10-02', 'raw', '2026-10-17', '2026-10-17')
       RETURNING id`,
      [incomingName, url],
    );
    childId = child.rows[0].id;
    // The decline trigger stamps decision_at at update time. Put the new row
    // strictly after that instant; curator.at alone is 2026-08-11.
    await pool.query(
      `UPDATE scan_entries SET created_at = clock_timestamp() + interval '1 hour' WHERE id = $1`,
      [childId],
    );

    const outcome = await finalizeExistingEntryDedup(pool, {
      id: childId,
      sourceUrl: url,
      name: incomingName,
      wire: 'oss',
      scanDate: '2026-10-02',
      expectedStatus: 'raw',
      deadline: '2026-10-17',
    }, 180);

    assert.equal(outcome.outcome, 'unique');
    assert.equal(outcome.priorCycle ?? null, null);
    const row = await pool.query(
      `SELECT status, duplicate_of_id, operator_notes FROM scan_entries WHERE id = $1`,
      [childId],
    );
    assert.equal(row.rows[0].status, 'deduped');
    assert.equal(row.rows[0].duplicate_of_id, null);
    assert.equal(
      row.rows[0].operator_notes,
      `Re-surfaced after premature decline of #${priorId}: "${RATIONALE}"`,
    );
  } finally {
    await cleanup(pool, childId ? [priorId, childId] : [priorId]);
  }
});

test.after(async () => {
  await closePool();
});
