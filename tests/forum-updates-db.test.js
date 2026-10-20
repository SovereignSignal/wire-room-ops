require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
if (!process.env.DATABASE_URL) {
  console.log('Skipping forum update DB tests: DATABASE_URL not set');
  process.exit(0);
}
const { getPool, closePool } = require('../src/db');
const { grantsFeedItemToRaw, prepareForumObservations, captureForumObservation } = require('../src/services/forum');
const { forumIntakeMetadata, trustedForumObservation, stampForumObservation } = require('../src/services/forum-seen');
const { runDailyIntake } = require('../src/jobs/daily-intake');
const { registerSeen, checkDuplicate, finalizeExistingEntryDedup } = require('../src/services/dedup');
const { processRawEntries } = require('../src/jobs/process-raw');
const { runDecidedRecheckForIds, applyVerdict } = require('../src/jobs/decided-recheck');

test('material forum update survives locked URL/name dedup, replay, raw-worker resume and decided recheck', async () => {
  const pool = getPool();
  const url = `https://forum-update-${process.pid}.example.org/t/builder-grants/700`;
  const name = `Builder Grants Round 7 ${process.pid}`;
  const original = '2026-08-01T12:00:00Z';
  const ids = [];
  const feed = (excerpt, lastActivityAt) => grantsFeedItemToRaw({
    title: name, url, program: name, excerpt, topicCreatedAt: original, lastActivityAt, status: 'open',
  });
  const submission = raw => ({ wire: 'crypto', promptVariant: 'N', scanDate: '2026-10-15', source: 'forum', submittedBy: 'forum:discuss.watch', results: [raw] });
  const findLatest = async () => (await pool.query('SELECT * FROM scan_entries WHERE source_url = $1 ORDER BY id DESC LIMIT 1', [url])).rows[0];
  try {
    const baseline = feed('Applications close October 20; available grant awards are $10,000.', '2026-10-12T12:00:00Z');
    const prior = await pool.query(
      `INSERT INTO scan_entries (name,description,source_url,wire,prompt_variant,scan_source,scan_date,status,submitted_by,metadata,source_published_at)
       VALUES ($1,$2,$3,'crypto','N','forum','2026-10-12','approved','forum:discuss.watch',$4::jsonb,$5) RETURNING id`,
      [name, baseline.description, url, JSON.stringify(forumIntakeMetadata(baseline, 'forum', 'forum:discuss.watch')), original]);
    const priorId = prior.rows[0].id; ids.push(priorId);
    await registerSeen(pool, { id: priorId, sourceUrl: url, name, wire: 'crypto', scanDate: '2026-10-12' });
    assert.equal((await checkDuplicate(pool, { sourceUrl: url, name, wire: 'crypto' })).isDuplicate, true);

    const prepared = await prepareForumObservations(pool, [], [feed('Deadline extended to November 15 and grant awards increased to $25,000.', '2026-10-13T12:00:00Z')], { remaining: 0 });
    assert.equal(prepared.updates.length, 1);
    const update = prepared.updates[0];
    assert.equal(trustedForumObservation(update).priorEntryId, priorId);
    const summary = await runDailyIntake(pool, [submission(update)], { insertOnly: true });
    assert.equal(summary.totalIngested, 1);
    const child = await findLatest(); ids.push(child.id);
    assert.equal(child.status, 'raw');
    assert.equal(child.metadata.forum_observation.priorEntryId, priorId);
    assert.equal(new Date(child.source_published_at).toISOString(), new Date(original).toISOString());

    const outcome = await finalizeExistingEntryDedup(pool, {
      id: child.id, sourceUrl: url, name, wire: 'crypto', scanDate: '2026-10-15', expectedStatus: 'raw',
    }, 180, { programGate: true });
    assert.equal(outcome.outcome, 'forum-update');
    const reviewed = await findLatest();
    assert.equal(reviewed.status, 'queued');
    assert.equal(reviewed.classification, 'UNCHECKED');
    assert.equal(reviewed.quality_score, null);
    assert.equal(reviewed.metadata.operator_route, 'source_check');
    assert.equal(reviewed.duplicate_of_id, null);
    assert.equal(reviewed.distributable, false);
    assert.match(reviewed.operator_notes, new RegExp('Possible forum update to #' + priorId));
    assert.equal((await pool.query('SELECT first_seen_entry_id FROM seen_urls WHERE first_seen_entry_id = $1', [priorId])).rows.length, 1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM publication_queue WHERE entry_id = $1', [child.id])).rows[0].n, 0);

    const recheck = await runDecidedRecheckForIds(pool, [child.id]);
    assert.equal(recheck.checked, 0);
    // Also exercise the locked mutation door, so an in-flight same-listing
    // model response cannot defeat the persisted source-change review hold.
    const verdict = await applyVerdict(pool, {
      id: child.id, wire: 'crypto', name, description: reviewed.description, source_url: url, deadline: null,
    }, [{ id: priorId, wire: 'crypto', name, status: 'approved', source_url: url, resolve_to: null }], {
      matched_id: priorId, verdict: 'same_listing', confidence: 0.99, reason: 'same program URL',
    });
    assert.equal(verdict, 'stale');
    assert.equal((await findLatest()).status, 'queued');

    const repeat = await runDailyIntake(pool, [submission(update)], { insertOnly: true });
    assert.equal(repeat.totalIngested, 0);
    assert.equal(repeat.skippedAlreadySeen, 1);

    // A model/agent can serialize all visible metadata and spoof the submitter
    // name. It still cannot obtain the in-process collector capability.
    const forged = JSON.parse(JSON.stringify({ ...update, metadata: { forum_observation: { ...reviewed.metadata.forum_observation, fingerprint: 'f'.repeat(64) } } }));
    assert.equal((await runDailyIntake(pool, [submission(forged)], { insertOnly: true })).totalIngested, 0);

    // A subsequent event is inserted raw, then handled by the ordinary worker
    // after a simulated restart (only persisted DB metadata is available).
    const second = await prepareForumObservations(pool, [], [feed('Applications reopened; the new grant budget is $50,000 and closes November 30.', '2026-10-14T12:00:00Z')], { remaining: 0 });
    await runDailyIntake(pool, [submission(second.updates[0])], { insertOnly: true });
    const resumed = await findLatest(); ids.push(resumed.id);
    await pool.query(`UPDATE scan_entries SET created_at = NOW() - INTERVAL '3 minutes' WHERE id = $1`, [resumed.id]);
    await processRawEntries(pool);
    const afterResume = await findLatest();
    assert.equal(afterResume.status, 'queued');
    assert.equal(afterResume.metadata.operator_route, 'source_check');
    assert.equal(afterResume.classification, 'UNCHECKED');
    assert.equal(afterResume.metadata.forum_observation.priorEntryId, child.id);

    // A competing worker that already inserted the same observation is
    // suppressed again under the graph lock rather than reopening the queue.
    const replay = await pool.query(
      `INSERT INTO scan_entries (name,description,source_url,wire,prompt_variant,scan_source,scan_date,status,submitted_by,metadata)
       VALUES ($1,$2,$3,'crypto','N','forum','2026-10-15','raw','forum:discuss.watch',$4::jsonb) RETURNING id`,
      [name, afterResume.description, url, JSON.stringify(afterResume.metadata)]);
    const replayId = replay.rows[0].id; ids.push(replayId);
    const replayOutcome = await finalizeExistingEntryDedup(pool, { id: replayId, sourceUrl: url, name, wire: 'crypto', scanDate: '2026-10-15', expectedStatus: 'raw' }, 180);
    assert.equal(replayOutcome.outcome, 'duplicate');
    assert.equal((await pool.query('SELECT status FROM scan_entries WHERE id = $1', [replayId])).rows[0].status, 'archived');

    // A return to the original terms is a new event, not a replay of the first
    // fingerprint. Suppressed worker replays must not become the new baseline.
    const reverted = await prepareForumObservations(pool, [], [feed('Applications close October 20; available grant awards are $10,000.', '2026-10-15T12:00:00Z')], { remaining: 0 });
    assert.equal(reverted.updates.length, 1);
    assert.equal(trustedForumObservation(reverted.updates[0]).priorEntryId, resumed.id);
    assert.equal((await runDailyIntake(pool, [submission(reverted.updates[0])], { insertOnly: true })).totalIngested, 1);
    const reversal = await findLatest(); ids.push(reversal.id);
    assert.equal((await finalizeExistingEntryDedup(pool, { id: reversal.id, sourceUrl: url, name, wire: 'crypto', scanDate: '2026-10-15', expectedStatus: 'raw' }, 180)).outcome, 'forum-update');
    assert.equal((await findLatest()).status, 'queued');
    assert.equal((await runDailyIntake(pool, [submission(reverted.updates[0])], { insertOnly: true })).totalIngested, 0);
    assert.equal((await runDailyIntake(pool, [submission(update)], { insertOnly: true })).totalIngested, 0, 'a persisted older extension cannot reopen the reversal');
    const staleReplay = await pool.query(
      `INSERT INTO scan_entries (name,description,source_url,wire,prompt_variant,scan_source,scan_date,status,submitted_by,metadata)
       VALUES ($1,$2,$3,'crypto','N','forum','2026-10-15','raw','forum:discuss.watch',$4::jsonb) RETURNING id`,
      [name, reviewed.description, url, JSON.stringify(reviewed.metadata)]);
    ids.push(staleReplay.rows[0].id);
    assert.equal((await finalizeExistingEntryDedup(pool, { id: staleReplay.rows[0].id, sourceUrl: url, name, wire: 'crypto', scanDate: '2026-10-15', expectedStatus: 'raw' }, 180)).outcome, 'duplicate');
  } finally {
    await pool.query('DELETE FROM seen_names WHERE entry_id = ANY($1::bigint[])', [ids]);
    await pool.query('DELETE FROM seen_urls WHERE first_seen_entry_id = ANY($1::bigint[])', [ids]);
    await pool.query('DELETE FROM scan_entries WHERE id = ANY($1::bigint[])', [ids]);
  }
});
test('intake drops a reply-only forum update once the prior entry is declined', async () => {
  const pool = getPool();
  const url = `https://forum-decline-${process.pid}.example.org/t/delegate-thread/900`;
  const name = `Delegate thread ${process.pid}`;
  const ids = [];
  const candidate = { title: name, url, forumName: 'Example', createdAt: '2026-08-01T12:00:00Z', lastActivityAt: '2026-10-12T12:00:00Z', replies: 0, views: 5, source: 'allowlist' };
  const opening = { id: 901, postNumber: 1, content: '<p>Delegates are paid from the incentive budget.</p>' };
  const detail = posts => ({ topic: { id: 900, title: name, postsCount: posts.length, posts } });
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: true, json: async () => detail([opening]) });
    const baseline = await captureForumObservation(candidate, { remaining: 1 });
    const raw = stampForumObservation({ name, description: name, sourceUrl: url }, baseline);
    const prior = await pool.query(
      `INSERT INTO scan_entries (name,description,source_url,wire,prompt_variant,scan_source,scan_date,status,submitted_by,metadata)
       VALUES ($1,$1,$2,'crypto','N','forum','2026-10-12','approved','forum:discuss.watch',$3::jsonb) RETURNING id`,
      [name, url, JSON.stringify(forumIntakeMetadata(raw, 'forum', 'forum:discuss.watch'))]);
    ids.push(prior.rows[0].id);

    global.fetch = async () => ({ ok: true, json: async () => detail([opening, { id: 902, postNumber: 2, content: '<p>When are payouts?</p>' }]) });
    const prepared = await prepareForumObservations(pool, [{ ...candidate, lastActivityAt: '2026-10-14T12:00:00Z', replies: 1 }], [], { remaining: 1 });
    assert.equal(prepared.updates.length, 1);

    await pool.query(`UPDATE scan_entries SET status = 'declined' WHERE id = $1`, [prior.rows[0].id]);
    const summary = await runDailyIntake(pool, [{ wire: 'crypto', promptVariant: 'N', scanDate: '2026-10-15', source: 'forum', submittedBy: 'forum:discuss.watch', results: prepared.updates }], { insertOnly: true });
    assert.equal(summary.totalIngested, 0);
    assert.equal(summary.skippedAlreadySeen, 1);
  } finally {
    global.fetch = originalFetch;
    await pool.query('DELETE FROM scan_entries WHERE id = ANY($1::bigint[]) OR source_url = $2', [ids, url]);
  }
});

test.after(closePool);
