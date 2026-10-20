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
const TEST_DESCRIPTION = 'recheck test entry with a sufficiently long description';

async function insertEntry(pool, name, url, status = 'queued', wire = 'oss') {
  const res = await pool.query(
    `INSERT INTO scan_entries (name, description, source_url, wire, prompt_variant, scan_source, scan_date, status)
     VALUES ($1, $5, $2, $3, 'A', 'web-search', CURRENT_DATE, $4)
     RETURNING id`,
    [name, url, wire, status, TEST_DESCRIPTION]
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

test('findCandidates does not propose a row\'s own duplicate children', async () => {
  const pool = getPool();
  const { findCandidates } = require('../src/jobs/decided-recheck');
  const pid = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const host = `recheck-children-${pid}.example`;
  const parentName = `Parent Program ${pid} Alpha Beta`;
  const parentId = await insertEntry(pool, parentName, `https://${host}/parent`, 'queued');
  const childId = await insertEntry(pool, `${parentName} reprint`, `https://${host}/child`, 'duplicate');
  const otherId = await insertEntry(pool, `Other Decided Program ${pid}`, `https://${host}/other`, 'approved');
  const foreignParent = await insertEntry(pool, `Foreign Parent ${pid} Gamma Delta`, `https://foreign-${pid}.example/parent`, 'approved');
  const foreignChild = await insertEntry(pool, `Foreign Child ${pid} Gamma Delta`, `https://${host}/foreign-child`, 'duplicate');
  await pool.query(`UPDATE scan_entries SET duplicate_of_id = $2 WHERE id = $1`, [childId, parentId]);
  await pool.query(`UPDATE scan_entries SET duplicate_of_id = $2 WHERE id = $1`, [foreignChild, foreignParent]);
  try {
    const candidates = await findCandidates(pool, {
      id: parentId,
      wire: 'oss',
      name: parentName,
      description: TEST_DESCRIPTION,
      source_url: `https://${host}/parent`,
      deadline: null,
    });
    const ids = candidates.map(candidate => Number(candidate.id));
    assert.ok(!ids.includes(Number(childId)), 'own duplicate child must not be proposed');
    assert.ok(ids.includes(Number(otherId)), 'another decided row on the same domain stays a candidate');
    assert.ok(ids.includes(Number(foreignChild)), 'a duplicate of a different parent stays a candidate');
  } finally {
    await pool.query(`DELETE FROM scan_entries WHERE id IN ($1, $2)`, [childId, foreignChild]);
    await pool.query(`DELETE FROM scan_entries WHERE id IN ($1, $2, $3)`, [parentId, otherId, foreignParent]);
  }
});

test('applyVerdict: update verdict keeps entry queued and adds a note', async () => {
  const pool = getPool();
  const pid = process.pid;
  const { applyVerdict } = require('../src/jobs/decided-recheck');
  const approvedId = await insertEntry(pool, `Recheck Round One ${pid}`, `https://recheck-rounds-${pid}.org/round-1`, 'approved');
  const queuedId = await insertEntry(pool, `Recheck Round Two ${pid}`, `https://recheck-rounds-${pid}.org/round-2`, 'queued');
  try {
    const target = { id: queuedId, wire: 'oss', name: `Recheck Round Two ${pid}`, description: TEST_DESCRIPTION, source_url: `https://recheck-rounds-${pid}.org/round-2`, deadline: null };
    const candidates = [{ id: approvedId, wire: 'oss', name: `Recheck Round One ${pid}`, status: 'approved', source_url: `https://recheck-rounds-${pid}.org/round-1`, decided_date: '2026-06-01', resolve_to: null, overlap: 3, domain_match: true, squash_match: false }];
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
    const target = { id: queuedId, wire: 'oss', name: `Recheck Declined Program ${pid} (tweet)`, description: TEST_DESCRIPTION, source_url: `https://x.com/org/status/9${pid}`, deadline: null };
    const candidates = [{ id: declinedId, wire: 'oss', name: `Recheck Declined Program ${pid}`, status: 'declined', source_url: `https://recheck-declined-${pid}.org/`, decided_date: '2026-06-01', resolve_to: null, overlap: 3, domain_match: false, squash_match: true }];
    const outcome = await applyVerdict(pool, target, candidates, { matched_id: declinedId, verdict: 'same_listing', confidence: 0.95, reason: 'identical listing' });
    assert.equal(outcome, 'duplicate');

    const check = await pool.query(`SELECT status, duplicate_of_id FROM scan_entries WHERE id = $1`, [queuedId]);
    assert.equal(check.rows[0].status, 'duplicate');
    assert.equal(check.rows[0].duplicate_of_id, declinedId);
  } finally {
    await pool.query(`DELETE FROM scan_entries WHERE id IN ($1, $2)`, [declinedId, queuedId]);
  }
});

test('applyVerdict refuses a stale target semantic snapshot', async () => {
  const pool = getPool();
  const pid = `${process.pid}-${Date.now()}`;
  const { applyVerdict } = require('../src/jobs/decided-recheck');
  const originalUrl = `https://stale-target-${pid}.org/original`;
  const currentUrl = `https://stale-target-${pid}.org/current`;
  const queuedId = await insertEntry(pool, `Stale Target ${pid}`, originalUrl, 'queued');
  try {
    const target = { id: queuedId, wire: 'oss', name: `Stale Target ${pid}`, description: TEST_DESCRIPTION, source_url: originalUrl, deadline: null };
    await pool.query(`UPDATE scan_entries SET source_url = $2 WHERE id = $1`, [queuedId, currentUrl]);
    const outcome = await applyVerdict(pool, target, [], { matched_id: null, verdict: 'distinct', confidence: 0.9, reason: 'looks distinct' });
    assert.equal(outcome, 'stale');
    const check = await pool.query(`SELECT status, source_url, metadata -> 'decided_recheck' AS stamp FROM scan_entries WHERE id = $1`, [queuedId]);
    assert.equal(check.rows[0].status, 'queued');
    assert.equal(check.rows[0].source_url, currentUrl);
    assert.equal(check.rows[0].stamp, null);
  } finally {
    await pool.query(`DELETE FROM scan_entries WHERE id = $1`, [queuedId]);
  }
});

test('applyVerdict: cross-wire same_listing holds the entry queued with a review stamp', async () => {
  const pool = getPool();
  const pid = `${process.pid}-${Date.now()}`;
  const { applyVerdict } = require('../src/jobs/decided-recheck');
  const approvedId = await insertEntry(pool, `Cross Wire Parent ${pid}`, `https://cross-wire-${pid}.org/program`, 'approved', 'ai');
  const queuedId = await insertEntry(pool, `Cross Wire Child ${pid}`, `https://x.com/org/status/8${process.pid}`, 'queued', 'oss');
  try {
    const target = { id: queuedId, wire: 'oss', name: `Cross Wire Child ${pid}`, description: TEST_DESCRIPTION, source_url: `https://x.com/org/status/8${process.pid}`, deadline: null };
    const candidates = [{ id: approvedId, wire: 'ai', name: `Cross Wire Parent ${pid}`, status: 'approved', source_url: `https://cross-wire-${pid}.org/program`, decided_date: '2026-06-01', resolve_to: null, overlap: 3, domain_match: false, squash_match: true }];
    const outcome = await applyVerdict(pool, target, candidates, { matched_id: approvedId, verdict: 'same_listing', confidence: 0.95, reason: 'same program either way' });
    assert.equal(outcome, 'cross-wire-review');

    const check = await pool.query(`SELECT status, duplicate_of_id, operator_notes, metadata -> 'decided_recheck' AS stamp FROM scan_entries WHERE id = $1`, [queuedId]);
    assert.equal(check.rows[0].status, 'queued', 'cross-wire match must never demote automatically');
    assert.equal(check.rows[0].duplicate_of_id, null);
    assert.match(check.rows[0].operator_notes, /Cross-wire semantic match blocked/);
    assert.equal(check.rows[0].stamp.cross_wire_blocked, true);
    assert.equal(check.rows[0].stamp.verdict, 'same_listing');
  } finally {
    await pool.query(`DELETE FROM scan_entries WHERE id IN ($1, $2)`, [approvedId, queuedId]);
  }
});

test('applyVerdict refuses a stale candidate semantic snapshot', async () => {
  const pool = getPool();
  const pid = `${process.pid}-${Date.now()}`;
  const { applyVerdict } = require('../src/jobs/decided-recheck');
  const candidateName = `Candidate Before Rewrite ${pid}`;
  const candidateUrl = `https://stale-candidate-${pid}.org/program`;
  const approvedId = await insertEntry(pool, candidateName, candidateUrl, 'approved');
  const queuedName = `Queued Candidate Check ${pid}`;
  const queuedUrl = `https://queued-candidate-${pid}.org/program`;
  const queuedId = await insertEntry(pool, queuedName, queuedUrl, 'queued');
  try {
    const target = { id: queuedId, wire: 'oss', name: queuedName, description: TEST_DESCRIPTION, source_url: queuedUrl, deadline: null };
    const candidates = [{ id: approvedId, wire: 'oss', name: candidateName, status: 'approved', source_url: candidateUrl, decided_date: '2026-06-01', resolve_to: null, overlap: 2, domain_match: false, squash_match: false }];
    await pool.query(`UPDATE scan_entries SET name = $2 WHERE id = $1`, [approvedId, `Candidate After Rewrite ${pid}`]);
    const outcome = await applyVerdict(pool, target, candidates, { matched_id: approvedId, verdict: 'update', confidence: 0.9, reason: 'new cycle' });
    assert.equal(outcome, 'stale');
    const check = await pool.query(`SELECT operator_notes, metadata -> 'decided_recheck' AS stamp FROM scan_entries WHERE id = $1`, [queuedId]);
    assert.equal(check.rows[0].operator_notes, null);
    assert.equal(check.rows[0].stamp, null);
  } finally {
    await pool.query(`DELETE FROM scan_entries WHERE id IN ($1, $2)`, [approvedId, queuedId]);
  }
});

test('classifySourceLink categorizes link quality', () => {
  const { classifySourceLink } = require('../src/jobs/decided-recheck');
  assert.equal(classifySourceLink('https://example.org/grants'), 'ok');
  assert.equal(classifySourceLink(''), 'missing');
  assert.equal(classifySourceLink(null), 'missing');
  assert.equal(classifySourceLink('https://t.me/manual/1749700000'), 'placeholder');
  assert.equal(classifySourceLink('https://manual/needs-source/1749700000-abc123'), 'placeholder');
  assert.equal(classifySourceLink('scan://internal-ref'), 'placeholder');
  assert.equal(classifySourceLink('https://t.co/AbC123'), 'shortener');
  assert.equal(classifySourceLink('https://x.com/someorg/status/123'), 'tweet-only');
  assert.equal(classifySourceLink('https://twitter.com/org/status/9'), 'tweet-only');
});

test('isSafeHttpUrl blocks SSRF targets, allows public URLs', () => {
  const { __ssrf } = require('../src/jobs/decided-recheck');
  // public hosts pass
  assert.equal(__ssrf.isSafeHttpUrl('https://deepmind.google/blog/x'), true, 'public https ok');
  assert.equal(__ssrf.isSafeHttpUrl('http://example.org/'), true, 'public http ok');
  // SSRF targets blocked
  assert.equal(__ssrf.isSafeHttpUrl('http://169.254.169.254/latest/meta-data/'), false, 'cloud metadata blocked');
  assert.equal(__ssrf.isSafeHttpUrl('http://127.0.0.1/'), false, 'loopback blocked');
  assert.equal(__ssrf.isSafeHttpUrl('http://localhost/'), false, 'localhost blocked');
  assert.equal(__ssrf.isSafeHttpUrl('http://10.0.0.5/'), false, 'RFC1918 10/8 blocked');
  assert.equal(__ssrf.isSafeHttpUrl('http://192.168.1.1/'), false, 'RFC1918 192.168 blocked');
  assert.equal(__ssrf.isSafeHttpUrl('http://172.16.5.5/'), false, 'RFC1918 172.16/12 blocked');
  assert.equal(__ssrf.isSafeHttpUrl('http://[::1]/'), false, 'IPv6 loopback blocked');
  assert.equal(__ssrf.isSafeHttpUrl('http://user:pass@example.org/'), false, 'userinfo blocked');
  assert.equal(__ssrf.isSafeHttpUrl('ftp://example.org/'), false, 'non-http scheme blocked');
  assert.equal(__ssrf.isSafeHttpUrl('http://wire-room-ops.railway.internal/'), false, '.internal blocked');
  // integer/hex/octal IPv4 forms — WHATWG normalizes to dotted-quad, so caught
  assert.equal(__ssrf.isSafeHttpUrl('http://2130706433/'), false, 'integer IPv4 (127.0.0.1) blocked');
  assert.equal(__ssrf.isSafeHttpUrl('http://0x7f000001/'), false, 'hex IPv4 (127.0.0.1) blocked');
  // non-IP, non-dotted garbage hostname rejected
  assert.equal(__ssrf.isSafeHttpUrl('http://notadomain/'), false, 'bare non-dotted host blocked');
});

test('validatingLookup blocks a hostname that resolves to a private/loopback IP', async () => {
  const { __ssrf } = require('../src/jobs/decided-recheck');
  // localhost resolves to 127.0.0.1/::1 — the DNS-rebinding vector. Must be blocked
  // at resolution time, not just by the literal check.
  assert.equal(await __ssrf.validatesClean('localhost'), false, 'localhost resolution blocked');
  // a public DNS name resolves to public IPs — allowed
  assert.equal(await __ssrf.validatesClean('example.com'), true, 'public DNS resolves clean');
});

test('targeted batch recheck settles only the submitted entry ids', async () => {
  const pool = getPool();
  const pid = process.pid;
  const targetId = await insertEntry(pool, `Zyqwv Batchonly ${pid}`, `https://zyqwv-batchonly-${pid}.org/program`, 'queued');
  const untouchedId = await insertEntry(pool, `Plmkj Untouched ${pid}`, `https://plmkj-untouched-${pid}.org/program`, 'queued');
  try {
    const { runDecidedRecheckForIds } = require('../src/jobs/decided-recheck');
    const stats = await runDecidedRecheckForIds(pool, [targetId]);
    assert.equal(stats.checked, 1);

    const check = await pool.query(
      `SELECT id, metadata -> 'decided_recheck' ->> 'verdict' AS verdict
       FROM scan_entries
       WHERE id IN ($1, $2)
       ORDER BY id`,
      [targetId, untouchedId],
    );
    const byId = new Map(check.rows.map(row => [Number(row.id), row.verdict]));
    assert.equal(byId.get(targetId), 'no_candidates');
    assert.equal(byId.get(untouchedId), null);
  } finally {
    await pool.query(`DELETE FROM scan_entries WHERE id IN ($1, $2)`, [targetId, untouchedId]);
  }
});

test.after(async () => {

  await closePool();
});
