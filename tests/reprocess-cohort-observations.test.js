require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCohortReplayArgs, reprocessCohortObservations } = require('../src/scripts/reprocess-cohort-observations');

const observation = (overrides = {}) => ({
  id: 1, run_id: 'cohort-test', title: 'Programme homepage', wire: 'crypto',
  source_record_id: 'page-1', status: 'Deferred', routing: 'raw_only',
  description: 'Needs review: Deadline, eligibility and payout terms remain unverified.',
  url: 'https://programme.example.org/', deadline: null, matched_scan_entry_id: null,
  raw_payload: { notion_page_id: 'page-1', section: 'Deferred', date_found: '2026-10-09' },
  ...overrides,
});

function fakePool(rows, existing = []) {
  const calls = [];
  const client = {
    release() { calls.push({ sql: 'release' }); },
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM opportunity_observations')) return { rows };
      if (sql.includes('FROM scan_entries')) return { rows: existing };
      return { rows: [], rowCount: 0 };
    },
  };
  return { calls, connect: async () => client };
}

test('cohort replay requires an explicit bounded set and defaults to dry run', () => {
  assert.deepEqual(parseCohortReplayArgs(['--ids', '1,2']), { ids: [1, 2], apply: false });
  assert.equal(parseCohortReplayArgs(['--ids', '1', '--apply']).apply, true);
  for (const args of [[], ['--apply'], ['--ids', '1,1'], ['--ids', '0'],
    ['--ids', '1', '--limit', '1'], ['--ids', '1', '--apply', '--dry-run']]) {
    assert.throws(() => parseCohortReplayArgs(args));
  }
});

test('dry run preserves the held evidence and never calls intake', async () => {
  const pool = fakePool([observation()]);
  const result = await reprocessCohortObservations(pool, { ids: [1], apply: false },
    async () => { throw new Error('must not call intake in dry run'); });
  assert.equal(result.selected[0].row.summary, observation().description);
  assert.equal(result.selected[0].row.deadline, null);
  assert.deepEqual(result.inserted, []);
  assert.equal(pool.calls[0].sql, 'BEGIN READ ONLY');
  assert.deepEqual(pool.calls.find(c => c.sql.includes('FROM opportunity_observations')).params,
    [[1], 'COHORT', 'claude-cohort-notion']);
  assert.equal(pool.calls.some(c => /INSERT|UPDATE|COMMIT/.test(c.sql)), false);
});

test('replay skips linked, unmarked, invalid and already submitted observations', async () => {
  for (const row of [observation({ matched_scan_entry_id: 42 }),
    observation({ routing: 'wire_queue_candidate' }),
    observation({ description: 'Watch only; no review requested.' }),
    observation({ url: 'https://localhost/' })]) {
    const result = await reprocessCohortObservations(fakePool([row]), { ids: [1], apply: true },
      async () => { throw new Error('must not replay ineligible observations'); });
    assert.equal(result.selected.length, 0);
    assert.equal(result.skipped.length, 1);
  }
  const result = await reprocessCohortObservations(fakePool([observation()], [{ id: 42 }]),
    { ids: [1], apply: false });
  assert.match(result.skipped[0].reason, /already submitted as entry 42/);
});

test('missing IDs abort the entire replay and release the transaction', async () => {
  const pool = fakePool([observation()]);
  await assert.rejects(reprocessCohortObservations(pool, { ids: [1, 2], apply: true }), /missing/);
  assert.deepEqual(pool.calls.slice(-2).map(c => c.sql), ['ROLLBACK', 'release']);
});

test('intake errors roll back and release locked observations', async () => {
  const pool = fakePool([observation()]);
  await assert.rejects(reprocessCohortObservations(pool, { ids: [1], apply: true }, async () => {
    throw new Error('intake failed');
  }), /intake failed/);
  assert.match(pool.calls.find(c => c.sql.includes('FROM opportunity_observations')).sql, /FOR UPDATE/);
  assert.deepEqual(pool.calls.slice(-2).map(c => c.sql), ['ROLLBACK', 'release']);
});

const dbUrl = process.env.DATABASE_URL;
const localDb = dbUrl && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(dbUrl).hostname);
test('real intake replay is atomic, preserves caveats, and cannot insert twice', { skip: !localDb }, async (t) => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: dbUrl });
  const client = await pool.connect();
  const boundPool = { connect: async () => ({ query: client.query.bind(client), release() {} }) };
  t.mock.method(require('../src/db'), 'seedSeenUrlsFromMessages', async () => 0);
  try {
    await client.query('CREATE TEMP TABLE scan_entries (LIKE public.scan_entries INCLUDING DEFAULTS INCLUDING CONSTRAINTS)');
    await client.query('CREATE TEMP TABLE opportunity_observations (LIKE public.opportunity_observations INCLUDING DEFAULTS INCLUDING CONSTRAINTS)');
    const row = observation();
    await client.query(`INSERT INTO opportunity_observations
      (id, run_id, track, source_name, source_record_id, title, wire, status, description,
       url, deadline, raw_payload, routing, dedupe_key)
      VALUES (1, $1, 'COHORT', 'claude-cohort-notion', $2, $3, $4, $5, $6, $7, $8, $9, $10, $7)`,
      [row.run_id, row.source_record_id, row.title, row.wire, row.status, row.description,
        row.url, row.deadline, row.raw_payload, row.routing]);
    const dry = await reprocessCohortObservations(boundPool, { ids: [1], apply: false });
    assert.equal(dry.selected.length, 1);
    assert.equal((await client.query('SELECT * FROM scan_entries')).rows.length, 0);

    // A failure after the INSERT must roll back the entry as well as the link.
    const { runDailyIntake } = require('../src/jobs/daily-intake');
    await assert.rejects(reprocessCohortObservations(boundPool, { ids: [1], apply: true }, async (...args) => {
      await runDailyIntake(...args);
      throw new Error('simulated failure after insert');
    }), /simulated failure/);
    assert.equal((await client.query('SELECT * FROM scan_entries')).rows.length, 0);
    assert.equal((await client.query('SELECT * FROM opportunity_observations')).rows[0].routing, 'raw_only');

    const result = await reprocessCohortObservations(boundPool, { ids: [1], apply: true });
    assert.equal(result.inserted.length, 1);
    const entry = (await client.query('SELECT * FROM scan_entries')).rows[0];
    assert.equal(entry.status, 'raw');
    assert.equal(entry.description, row.description);
    assert.equal(entry.source_url, row.url);
    assert.equal(entry.deadline, null);
    assert.equal(entry.metadata.cohort_bridge.section, 'Deferred');
    assert.equal(entry.metadata.cohort_bridge.run_id, row.run_id);
    assert.equal(entry.metadata.cohort_bridge.notion_page_id, row.source_record_id);
    const linked = (await client.query('SELECT * FROM opportunity_observations')).rows[0];
    assert.equal(Number(linked.matched_scan_entry_id), Number(entry.id));
    assert.equal(linked.routing, 'wire_queue_candidate');
    assert.equal(linked.raw_payload.section, 'Deferred');
    const retry = await reprocessCohortObservations(boundPool, { ids: [1], apply: true });
    assert.equal(retry.inserted.length, 0);
    assert.equal((await client.query('SELECT * FROM scan_entries')).rows.length, 1);
  } finally {
    client.release();
    await pool.end();
  }
});
