require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
if (!process.env.DATABASE_URL) { console.log('Skipping pace migration tests: DATABASE_URL not set'); process.exit(0); }

const schema = `pace_mig_${process.pid}_${Date.now()}`;
process.env.PGOPTIONS = `-c search_path=${schema}`;
const admin = new Pool({ connectionString: process.env.DATABASE_URL, options: '' });
const db = require('../src/db');
const { ensurePacedDistribution } = require('../src/db/paced-distribution');
const pool = db.getPool();

test.before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`
    CREATE TABLE scan_entries (id integer PRIMARY KEY, name text, wire text, status text, updated_at timestamptz DEFAULT now());
    INSERT INTO scan_entries (id, name, wire, status, updated_at) VALUES
      (1, 'Queued', 'crypto', 'approved', '2024-01-01'),
      (2, 'Running', 'crypto', 'approved', '2024-01-01'),
      (3, 'Done', 'crypto', 'approved', '2024-01-01'),
      (4, 'Review', 'crypto', 'approved', '2024-01-01'),
      (5, 'Withheld', 'crypto', 'approved', '2024-01-01'),
      (6, 'Bogus', 'crypto', 'approved', '2024-01-01');
    CREATE TABLE publication_queue (
      entry_id integer PRIMARY KEY REFERENCES scan_entries(id),
      status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'review')),
      attempts integer NOT NULL DEFAULT 0,
      lease_token uuid,
      lease_expires_at timestamptz,
      available_at timestamptz NOT NULL DEFAULT now(),
      error_message text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO publication_queue (entry_id, status, available_at, updated_at) VALUES
      (1, 'queued', '2024-06-01', '2024-06-01'),
      (2, 'running', '2024-06-01', '2024-06-01'),
      (3, 'done', '2024-06-01', '2024-06-01'),
      (4, 'review', '2024-06-01', '2024-06-01');
    CREATE TABLE distribution_logs (
      id serial PRIMARY KEY,
      entry_id integer NOT NULL REFERENCES scan_entries(id),
      channel text NOT NULL,
      wire text NOT NULL,
      status text NOT NULL,
      external_id text,
      created_at timestamptz DEFAULT now()
    );
    INSERT INTO distribution_logs (entry_id, channel, wire, status, external_id, created_at)
    VALUES (3, 'telegram', 'crypto', 'success', '99', '2024-06-01');
  `);
});

test.after(async () => {
  await db.closePool();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

test('version 5 adds columns without rewriting existing delivery rows', async () => {
  const before = (await pool.query(`SELECT entry_id, status, available_at, updated_at FROM publication_queue ORDER BY entry_id`)).rows;
  const receipt = (await pool.query(`SELECT external_id, created_at FROM distribution_logs WHERE entry_id = 3`)).rows[0];
  await ensurePacedDistribution();

  const queue = (await pool.query(`SELECT entry_id, status, available_at, updated_at, created_at FROM publication_queue ORDER BY entry_id`)).rows;
  assert.deepEqual(queue.map(row => row.status), ['queued', 'running', 'done', 'review']);
  for (const row of queue) {
    const prior = before.find(item => item.entry_id === row.entry_id);
    assert.equal(new Date(row.available_at).toISOString(), new Date(prior.available_at).toISOString());
    assert.equal(new Date(row.updated_at).toISOString(), new Date(prior.updated_at).toISOString());
    assert.ok(row.created_at instanceof Date);
  }
  const log = (await pool.query(`SELECT external_id, created_at, sent_at FROM distribution_logs WHERE entry_id = 3`)).rows[0];
  assert.equal(log.external_id, '99');
  assert.equal(new Date(log.created_at).toISOString(), new Date(receipt.created_at).toISOString());
  assert.equal(log.sent_at, null);

  await pool.query(`UPDATE publication_queue SET created_at = '2020-01-01T00:00:00Z' WHERE entry_id = 1`);
  await ensurePacedDistribution();
  const kept = (await pool.query(`SELECT created_at FROM publication_queue WHERE entry_id = 1`)).rows[0];
  assert.equal(kept.created_at.toISOString(), '2020-01-01T00:00:00.000Z');
  assert.equal((await pool.query(`SELECT sent_at FROM distribution_logs WHERE entry_id = 3`)).rows[0].sent_at, null);

  await pool.query(`INSERT INTO publication_queue (entry_id, status) VALUES (5, 'withheld')`);
  await assert.rejects(pool.query(`INSERT INTO publication_queue (entry_id, status) VALUES (6, 'paused')`));
  const index = await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_publication_queue_due'`);
  assert.equal(index.rows.length, 1);
});
