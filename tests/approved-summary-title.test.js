// Approved names longer than summaries.title varchar(100) must still be recorded.
process.env.DEV_MODE = 'true';
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
if (!process.env.DATABASE_URL) {
  console.log('Skipping approved-summary title tests: DATABASE_URL not set');
  process.exit(0);
}

const schema = `summary_title_${process.pid}_${Date.now()}`;
process.env.PGOPTIONS = `-c search_path=${schema}`;
const admin = new Pool({ connectionString: process.env.DATABASE_URL, options: '' });
const db = require('../src/db');
const pool = db.getPool();

test.before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`
    CREATE TABLE summaries (
      id SERIAL PRIMARY KEY,
      title VARCHAR(100),
      summary TEXT,
      wire TEXT,
      processing_status TEXT,
      data_quality VARCHAR(20),
      confidence TEXT,
      entities JSONB,
      message_id INTEGER,
      category_id INTEGER
    )
  `);
});

test.after(async () => {
  await db.closePool();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

function summaryInput(title, scanEntryId, sourceUrl) {
  return {
    title,
    summary: 'Approved grant summary',
    wire: 'ai',
    qualityScore: 80,
    scanEntryId,
    entities: {
      amounts: [],
      deadlines: [],
      source_url: sourceUrl,
      orgs: [],
    },
  };
}

test('a 250-character approved name is saved on the summary record', async () => {
  const name = 'N'.repeat(250);
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => { logs.push(args.map(String).join(' ')); };
  let overflowId;
  try {
    overflowId = await db.insertApprovedSummary(summaryInput(name, 19001, 'https://example.invalid/overflow-name'));
  } finally {
    console.error = originalError;
  }

  assert.ok(overflowId, 'an overflow must still return a summary id');
  assert.match(logs.join('\n'), /insertApprovedSummary overflow/);
  const shortened = (await pool.query('SELECT title FROM summaries WHERE id = $1', [overflowId])).rows[0];
  assert.equal(shortened.title, name.slice(0, 100));

  const { ensureSummaryTitleColumn } = require('../src/db/summary-title');
  await ensureSummaryTitleColumn();
  await ensureSummaryTitleColumn();
  const column = (await pool.query(
    `SELECT data_type, character_maximum_length
     FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'summaries' AND column_name = 'title'`,
  )).rows[0];
  assert.equal(column.data_type, 'text');
  assert.equal(column.character_maximum_length, null);

  const fullId = await db.insertApprovedSummary(summaryInput(name, 19002, 'https://example.invalid/full-name'));
  assert.ok(fullId);
  assert.notEqual(fullId, overflowId);
  const stored = (await pool.query('SELECT title FROM summaries WHERE id = $1', [fullId])).rows[0];
  assert.equal(stored.title, name);
  assert.equal(stored.title.length, 250);
});
