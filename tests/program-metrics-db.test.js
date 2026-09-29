require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const db = require('../src/db');
const { ensureProgramMetrics } = require('../src/db/program-metrics');
if (!process.env.DATABASE_URL) { console.log('Skipping program metrics DB tests: DATABASE_URL not set'); process.exit(0); }
const schema = `program_metrics_${process.pid}_${Date.now()}`;
const role = `${schema}_writer`;
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema} -c statement_timeout=5000` });
const original = db.getPool;
test.before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`CREATE TABLE programs(id serial PRIMARY KEY, name text,
    entry_count integer DEFAULT 0, approved_count integer DEFAULT 0, declined_count integer DEFAULT 0,
    canonical_entry_id integer, org_id integer, updated_at timestamptz DEFAULT now());
    CREATE TABLE scan_entries(id serial PRIMARY KEY, program_id integer REFERENCES programs(id),
      status text, operator_notes text, action_reason text, metadata jsonb, duplicate_of_id integer);`);
  db.getPool = () => pool;
  await ensureProgramMetrics(); await ensureProgramMetrics();
  await admin.query(`CREATE ROLE ${role}; GRANT USAGE ON SCHEMA ${schema} TO ${role};
    GRANT SELECT, UPDATE ON ${schema}.scan_entries TO ${role}`);
});
test.after(async () => { db.getPool = original; await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.query(`DROP ROLE ${role}`); await admin.end(); });
test.beforeEach(async () => {
  await pool.query("TRUNCATE scan_entries, programs RESTART IDENTITY CASCADE; INSERT INTO programs(name) VALUES('One'),('Two')");
});
async function metrics(id = 1) { return (await pool.query('SELECT entry_count, approved_count, declined_count FROM programs WHERE id=$1', [id])).rows[0]; }
const expected = (entry_count, approved_count, declined_count) => ({ entry_count, approved_count, declined_count });
test('direct producer writes, reassignment, unlink, delete and truncate keep every count current', async () => {
  await pool.query("INSERT INTO scan_entries(program_id,status) VALUES(1,'queued'),(1,'approved'),(1,'duplicate'),(1,'declined'),(1,'archived')");
  assert.deepEqual(await metrics(), expected(5,1,1));
  await pool.query("UPDATE scan_entries SET status='declined' WHERE id=1");
  assert.deepEqual(await metrics(), expected(5,1,2));
  await pool.query('UPDATE scan_entries SET program_id=2 WHERE id IN(1,2)');
  assert.deepEqual(await metrics(), expected(3,0,1)); assert.deepEqual(await metrics(2), expected(2,1,1));
  await pool.query('UPDATE scan_entries SET program_id=NULL WHERE id=2');
  assert.deepEqual(await metrics(2), expected(1,0,1));
  await pool.query('DELETE FROM scan_entries WHERE id=1');
  assert.deepEqual(await metrics(2), expected(0,0,0));
  await pool.query('TRUNCATE scan_entries');
  assert.deepEqual(await metrics(), expected(0,0,0));
});
test('held and duplicate entries still count, and identity and editorial fields are preserved', async () => {
  await pool.query("INSERT INTO scan_entries(program_id,status,operator_notes,metadata,duplicate_of_id) VALUES(1,'approved','HOLD: review','{\"decided_recheck\":{\"cross_wire_blocked\":true}}',NULL),(1,'duplicate',NULL,NULL,1)");
  await pool.query('UPDATE programs SET canonical_entry_id=1,org_id=99 WHERE id=1');
  const entries=(await pool.query('SELECT * FROM scan_entries ORDER BY id')).rows;
  await pool.query('UPDATE programs SET entry_count=999,approved_count=999,declined_count=999 WHERE id=1');
  assert.deepEqual(await metrics(), expected(2,1,0));
  assert.deepEqual((await pool.query('SELECT * FROM scan_entries ORDER BY id')).rows, entries);
  assert.deepEqual((await pool.query('SELECT canonical_entry_id,org_id FROM programs WHERE id=1')).rows[0], { canonical_entry_id:1,org_id:99 });
  const before=(await pool.query('SELECT * FROM programs ORDER BY id')).rows;
  await pool.query("UPDATE scan_entries SET action_reason='Human review required',metadata='{}'");
  assert.deepEqual((await pool.query('SELECT * FROM programs ORDER BY id')).rows, before);
  await pool.query('UPDATE scan_entries SET program_id=program_id,status=status');
  assert.deepEqual((await pool.query('SELECT * FROM programs ORDER BY id')).rows, before);
});
test('failed counter maintenance rolls back the producer decision', async () => {
  await pool.query("INSERT INTO scan_entries(program_id,status) VALUES(1,'queued'); ALTER TABLE programs ADD CONSTRAINT reject_declined CHECK(declined_count=0)");
  try { await assert.rejects(pool.query("UPDATE scan_entries SET status='declined'"), /reject_declined/); }
  finally { await pool.query('ALTER TABLE programs DROP CONSTRAINT reject_declined'); }
  assert.equal((await pool.query('SELECT status FROM scan_entries')).rows[0].status, 'queued');
  assert.deepEqual(await metrics(), expected(1,0,0));
});
test('restricted direct writer needs no program grant and cannot hijack the owner trigger', async () => {
  await pool.query("INSERT INTO scan_entries(program_id,status) VALUES(1,'queued')");
  const c=await pool.connect();
  try {
    await c.query('BEGIN'); await c.query(`SET LOCAL ROLE ${role}`);
    await c.query('CREATE TEMP TABLE programs(id integer); CREATE TEMP TABLE scan_entries(id integer)');
    await c.query(`UPDATE ${schema}.scan_entries SET status='declined'`);
    await c.query('COMMIT');
    assert.deepEqual(await metrics(), expected(1,0,1));
    await c.query('BEGIN'); await c.query(`SET LOCAL ROLE ${role}`);
    await assert.rejects(c.query(`UPDATE ${schema}.programs SET name='Forbidden'`), /permission denied/);
    await c.query('ROLLBACK'); await c.query('BEGIN'); await c.query(`SET LOCAL ROLE ${role}`);
    await assert.rejects(c.query(`CREATE TRIGGER hijack AFTER INSERT ON pg_temp.scan_entries FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.wro_entry_program_metrics()`), /permission denied/);
  } finally { await c.query('ROLLBACK'); await c.query('DROP TABLE IF EXISTS pg_temp.programs,pg_temp.scan_entries'); c.release(); }
});
test('concurrent opposite reassignments wait and include the committed writer', async () => {
  await pool.query("INSERT INTO scan_entries(program_id,status) VALUES(1,'approved'),(2,'declined')");
  const a=await pool.connect(),b=await pool.connect();let pending;
  try {
    await a.query('BEGIN');await b.query('BEGIN');
    const pid=(await b.query('SELECT pg_backend_pid() id')).rows[0].id;
    await a.query('UPDATE scan_entries SET program_id=2 WHERE id=1');
    pending=b.query('UPDATE scan_entries SET program_id=1 WHERE id=2');
    let waiting=false;
    for(let n=0;n<100;n++) {
      waiting=(await admin.query("SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.waiting;
      if(waiting)break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(waiting,true);
    await a.query('COMMIT');await pending;await b.query('COMMIT');
    assert.deepEqual(await metrics(), expected(1,0,1));assert.deepEqual(await metrics(2), expected(1,1,0));
  } finally { await a.query('ROLLBACK');if(pending)await pending.catch(()=>{});await b.query('ROLLBACK');a.release();b.release(); }
});
