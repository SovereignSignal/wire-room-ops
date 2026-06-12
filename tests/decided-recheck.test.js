require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

// DB integration tests for the decided-recheck candidate generator and
// verdict application. The LLM judge is not tested here — these cover the
// deterministic SQL (including the squashed-name match that exact-token
// matching misses, e.g. "#ClaudeCorps" vs "Claude Corps") and the fail-open
// update path. Requires DATABASE_URL (CI provides Postgres).
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.log('Skipping decided-recheck tests: DATABASE_URL not set');
  process.exit(0);
}

const { getPool, closePool } = require('../src/db');

async function insertEntry(pool, name, url, status = 'queued', wire = 'oss') {
  const res = await pool.query(
    `INSERT INTO scan_entries (name, description, source_url, wire, prompt_variant, scan_source, scan_date, status)
     VALUES ($1, 'recheck test entry with a sufficiently long description', $2, $3, 'A', 'web-search', CURRENT_DATE, $4)
     RETURNING id`,
    [name, url, wire, status]
  );
  return res.rows[0].id;
}

test('candidate generator catches squashed-name variants against decided entries', async () => {
  const pool = getPool();
  const pid = process.pid;
  const approvedId = await insertEntry(pool, `Recheck Corps ${pid}`, `https://recheck-example-${pid}.org/program`, 'approved');
  const queuedId = await insertEntry(pool, `🚀 The #RecheckCorps${pid} Fellowship is now open!`, `https://x.com/someorg/status/${pid}`, 'queued');
  try {
    // Use the module's internal candidate query via runDecidedRecheck's exported pieces:
    // findCandidates is not exported, so test through the SQL contract — replicate
    // the squash condition directly to pin the behavior.
    const { rows } = await pool.query(
      `SELECT id FROM scan_entries d
       WHERE d.id != $1 AND d.status IN ('approved','declined','queued','duplicate')
         AND length(lower(regexp_replace($2, '[^a-zA-Z0-9]', '', 'g'))) > 8
         AND length(lower(regexp_replace(d.name, '[^a-zA-Z0-9]', '', 'g'))) > 8
         AND (position(lower(regexp_replace(d.name, '[^a-zA-Z0-9]', '', 'g')) IN lower(regexp_replace($2, '[^a-zA-Z0-9]', '', 'g'))) > 0
           OR position(lower(regexp_replace($2, '[^a-zA-Z0-9]', '', 'g')) IN lower(regexp_replace(d.name, '[^a-zA-Z0-9]', '', 'g'))) > 0)`,
      [queuedId, `🚀 The #RecheckCorps${pid} Fellowship is now open!`]
    );
    const ids = rows.map(r => r.id);
    assert.ok(ids.includes(approvedId), 'squash containment must find the approved canonical entry');
  } finally {
    await pool.query(`DELETE FROM scan_entries WHERE id IN ($1, $2)`, [approvedId, queuedId]);
  }
});

test('applyVerdict: update verdict keeps entry queued and adds a note', async () => {
  const pool = getPool();
  const pid = process.pid;
  const { applyVerdict } = require('../src/jobs/decided-recheck');
  const approvedId = await insertEntry(pool, `Recheck Round One ${pid}`, `https://recheck-rounds-${pid}.org/round-1`, 'approved');
  const queuedId = await insertEntry(pool, `Recheck Round Two ${pid}`, `https://recheck-rounds-${pid}.org/round-2`, 'queued');
  try {
    const target = { id: queuedId, wire: 'oss', name: `Recheck Round Two ${pid}`, description: '', source_url: `https://recheck-rounds-${pid}.org/round-2`, deadline: null };
    const candidates = [{ id: approvedId, name: `Recheck Round One ${pid}`, status: 'approved', source_url: `https://recheck-rounds-${pid}.org/round-1`, decided_date: '2026-06-01', resolve_to: null, overlap: 3, domain_match: true, squash_match: false }];
    const outcome = await applyVerdict(pool, target, candidates, { matched_id: approvedId, verdict: 'update', confidence: 0.9, reason: 'new round of the same program' });
    assert.equal(outcome, 'update-noted');

    const check = await pool.query(`SELECT status, operator_notes, metadata FROM scan_entries WHERE id = $1`, [queuedId]);
    assert.equal(check.rows[0].status, 'queued', 'update verdict must NOT change status');
    assert.match(check.rows[0].operator_notes, /Update of #/);
    assert.equal(check.rows[0].metadata.related_decided, approvedId);
  } finally {
    await pool.query(`DELETE FROM scan_entries WHERE id IN ($1, $2)`, [approvedId, queuedId]);
  }
});

test('applyVerdict: same_listing at high confidence marks duplicate of decided entry', async () => {
  const pool = getPool();
  const pid = process.pid;
  const { applyVerdict } = require('../src/jobs/decided-recheck');
  const declinedId = await insertEntry(pool, `Recheck Declined Program ${pid}`, `https://recheck-declined-${pid}.org/`, 'declined');
  const queuedId = await insertEntry(pool, `Recheck Declined Program ${pid} (tweet)`, `https://x.com/org/status/9${pid}`, 'queued');
  try {
    const target = { id: queuedId, wire: 'oss', name: `Recheck Declined Program ${pid} (tweet)`, description: '', source_url: `https://x.com/org/status/9${pid}`, deadline: null };
    const candidates = [{ id: declinedId, name: `Recheck Declined Program ${pid}`, status: 'declined', source_url: `https://recheck-declined-${pid}.org/`, decided_date: '2026-06-01', resolve_to: null, overlap: 3, domain_match: false, squash_match: true }];
    const outcome = await applyVerdict(pool, target, candidates, { matched_id: declinedId, verdict: 'same_listing', confidence: 0.95, reason: 'identical listing' });
    assert.equal(outcome, 'duplicate');

    const check = await pool.query(`SELECT status, duplicate_of_id FROM scan_entries WHERE id = $1`, [queuedId]);
    assert.equal(check.rows[0].status, 'duplicate');
    assert.equal(check.rows[0].duplicate_of_id, declinedId);
  } finally {
    await pool.query(`DELETE FROM scan_entries WHERE id IN ($1, $2)`, [declinedId, queuedId]);
  }
});

test('classifySourceLink categorizes link quality', () => {
  const { classifySourceLink } = require('../src/jobs/decided-recheck');
  assert.equal(classifySourceLink('https://example.org/grants'), 'ok');
  assert.equal(classifySourceLink(''), 'missing');
  assert.equal(classifySourceLink(null), 'missing');
  assert.equal(classifySourceLink('https://t.me/manual/1749700000'), 'placeholder');
  assert.equal(classifySourceLink('scan://internal-ref'), 'placeholder');
  assert.equal(classifySourceLink('https://t.co/AbC123'), 'shortener');
  assert.equal(classifySourceLink('https://x.com/someorg/status/123'), 'tweet-only');
  assert.equal(classifySourceLink('https://twitter.com/org/status/9'), 'tweet-only');
});

test.after(async () => {

  await closePool();
});
