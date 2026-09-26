require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const db = require('../src/db');
const { ensureOrgMetrics } = require('../src/db/org-metrics');
const { upsertOrgProfile, linkEntryToOrg } = require('../src/services/org-extractor');
const { computeDerivedFields } = require('../src/services/org-enricher');
const { mergeOrgs } = require('../src/services/org-merge');
if (!process.env.DATABASE_URL) { console.log('Skipping org metric DB tests: DATABASE_URL not set'); process.exit(0); }
const schema = `org_metrics_${process.pid}_${Date.now()}`;
const role = `${schema}_writer`;
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema} -c statement_timeout=5000` });
const original = db.getPool;
test.before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`CREATE TABLE org_profiles (
    id serial PRIMARY KEY, name text UNIQUE, slug text, wires text[], aliases text[],
    first_seen date, last_seen date, parent_org_id integer,
    entry_count integer DEFAULT 0, avg_quality_score numeric(5,1), tier text, updated_at timestamptz DEFAULT now());
    CREATE TABLE scan_entries (id serial PRIMARY KEY, org_id integer REFERENCES org_profiles(id),
      status text, quality_score integer, program_id integer, description text, operator_notes text, action_reason text);`);
  db.getPool = () => pool;
  await ensureOrgMetrics();
  await admin.query(`CREATE ROLE ${role}; GRANT USAGE ON SCHEMA ${schema} TO ${role};
    GRANT SELECT, UPDATE ON ${schema}.scan_entries TO ${role}`);
  await ensureOrgMetrics(); // installing the same trigger contract is safe
});
test.after(async () => { db.getPool = original; await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.query(`DROP ROLE ${role}`); await admin.end(); });
test.beforeEach(async () => { await pool.query('TRUNCATE scan_entries, org_profiles RESTART IDENTITY CASCADE'); });
async function metrics(id = 1) {
  return (await pool.query('SELECT entry_count,avg_quality_score,tier FROM org_profiles WHERE id=$1', [id])).rows[0];
}
const expected = (entry_count, avg_quality_score, tier = 'Tier 2 - Secondary') => ({ entry_count, avg_quality_score, tier });
test('profile upsert and repeated real linking never count sightings twice', async () => {
  const id = await upsertOrgProfile('Example Foundation', 'ai');
  await upsertOrgProfile('Example Foundation', 'oss');
  assert.deepEqual(await metrics(id), expected(0, null, 'Tier 3 - Monitor'));
  await pool.query("INSERT INTO scan_entries(status,quality_score) VALUES ('approved',80)");
  await linkEntryToOrg(1, id); await linkEntryToOrg(1, id);
  assert.deepEqual(await metrics(id), expected(1, '80.0'));
  const before = (await pool.query('SELECT updated_at FROM org_profiles WHERE id=$1', [id])).rows[0];
  assert.equal((await computeDerivedFields()).updated, 0);
  assert.deepEqual((await pool.query('SELECT updated_at FROM org_profiles WHERE id=$1', [id])).rows[0], before);
});
test('insert, status, score, reassignment, unlink and delete maintain the same definition', async () => {
  await pool.query("INSERT INTO org_profiles(name) VALUES ('One'),('Two'); INSERT INTO scan_entries(org_id,status,quality_score) VALUES (1,'approved',80),(1,'queued',60),(1,'duplicate',100),(1,'declined',100)");
  assert.deepEqual(await metrics(), expected(2, '70.0'));
  await pool.query("UPDATE scan_entries SET status='archived' WHERE id=1");
  assert.deepEqual(await metrics(), expected(1, '60.0'));
  await pool.query('UPDATE scan_entries SET quality_score=20 WHERE id=2');
  assert.deepEqual(await metrics(), expected(1, '20.0', 'Tier 3 - Monitor'));
  await pool.query('UPDATE scan_entries SET org_id=2 WHERE id=2');
  assert.deepEqual(await metrics(), expected(0, null, 'Tier 3 - Monitor'));
  assert.deepEqual(await metrics(2), expected(1, '20.0', 'Tier 3 - Monitor'));
  await pool.query('UPDATE scan_entries SET org_id=NULL WHERE id=2');
  assert.deepEqual(await metrics(2), expected(0, null, 'Tier 3 - Monitor'));
  await pool.query("INSERT INTO scan_entries(org_id,status,quality_score) VALUES(2,'approved',90); DELETE FROM scan_entries WHERE org_id=2");
  assert.deepEqual(await metrics(2), expected(0, null, 'Tier 3 - Monitor'));
});
test('null scores, tier thresholds and direct derived-field writes remain source-backed', async () => {
  await pool.query("INSERT INTO org_profiles(name,entry_count,tier) VALUES ('One',99,'Invented'); INSERT INTO scan_entries(org_id,status,quality_score) VALUES (1,'queued',NULL),(1,'approved',60),(1,'approved',60),(1,'queued',60),(1,'approved',60)");
  assert.deepEqual(await metrics(), expected(5, '60.0', 'Tier 1 - Official'));
  await pool.query("UPDATE org_profiles SET entry_count=999,avg_quality_score=99,tier='Invented'");
  assert.deepEqual(await metrics(), expected(5, '60.0', 'Tier 1 - Official'));
  await pool.query('UPDATE scan_entries SET quality_score=NULL');
  assert.deepEqual(await metrics(), expected(5, null));
  await pool.query('TRUNCATE scan_entries');
  assert.deepEqual(await metrics(), expected(0, null, 'Tier 3 - Monitor'));
});
test('actual merge excludes historical statuses and recomputes average and tier', async () => {
  await pool.query("INSERT INTO org_profiles(name) VALUES ('Source'),('Target'); INSERT INTO scan_entries(org_id,status,quality_score) VALUES (1,'approved',80),(1,'duplicate',100),(2,'queued',40),(2,'declined',100)");
  const result = await mergeOrgs(1, 2, { archiveNotion: false });
  assert.equal(result.entriesRelinked, 2);
  assert.deepEqual(await metrics(2), expected(2, '60.0'));
});
test('failed metric maintenance rolls back its entry mutation; metadata-only edits do not touch metrics', async () => {
  await pool.query("INSERT INTO org_profiles(name) VALUES ('One'); INSERT INTO scan_entries(org_id,status,quality_score) VALUES (1,'queued',60)");
  const before = (await pool.query('SELECT * FROM org_profiles')).rows;
  await pool.query("UPDATE scan_entries SET description='new source text'");
  assert.deepEqual((await pool.query('SELECT * FROM org_profiles')).rows, before);
  await pool.query('ALTER TABLE org_profiles ADD CONSTRAINT reject_empty CHECK(entry_count>0)');
  try { await assert.rejects(pool.query("UPDATE scan_entries SET status='declined'"), /reject_empty/); }
  finally { await pool.query('ALTER TABLE org_profiles DROP CONSTRAINT reject_empty'); }
  assert.equal((await pool.query('SELECT status FROM scan_entries')).rows[0].status, 'queued');
  assert.deepEqual((await pool.query('SELECT * FROM org_profiles')).rows, before);
});
test('concurrent writers serialize without FK lock upgrades and include committed changes', async () => {
  await pool.query("INSERT INTO org_profiles(name) VALUES ('One'),('Two'); INSERT INTO scan_entries(org_id,status,quality_score) VALUES (1,'queued',80),(2,'queued',40)");
  const a = await pool.connect(), b = await pool.connect();
  let pending;
  try {
    await a.query('BEGIN'); await b.query('BEGIN');
    const pid = (await b.query('SELECT pg_backend_pid() id')).rows[0].id;
    await a.query('UPDATE scan_entries SET org_id=2 WHERE id=1');
    pending = b.query('UPDATE scan_entries SET org_id=1 WHERE id=2');
    // Observe an actual lock wait rather than assuming a sleep proves concurrency.
    let waiting = false;
    for (let n = 0; n < 100; n++) {
      waiting = (await admin.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.waiting;
      if (waiting) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true);
    await a.query('COMMIT'); await pending; await b.query('COMMIT');
    assert.deepEqual(await metrics(1), expected(1, '40.0', 'Tier 3 - Monitor'));
    assert.deepEqual(await metrics(2), expected(1, '80.0'));
  } finally { await a.query('ROLLBACK'); if (pending) await pending.catch(() => {}); await b.query('ROLLBACK'); a.release(); b.release(); }
});

test('restricted entry writers maintain metrics without profile grants or temporary-object hijacking', async () => {
  await pool.query("INSERT INTO org_profiles(name) VALUES ('One'); INSERT INTO scan_entries(org_id,status,quality_score) VALUES (1,'queued',80)");
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    // A caller-controlled temporary object must never shadow trusted tables.
    await client.query('CREATE TEMP TABLE org_profiles (id integer); CREATE TEMP TABLE scan_entries (id integer)');
    await client.query(`UPDATE ${schema}.scan_entries SET status='declined' WHERE id=1`);
    assert.deepEqual(await metrics(), expected(1, '80.0')); // transaction is still private
    await client.query('COMMIT');
    assert.deepEqual(await metrics(), expected(0, null, 'Tier 3 - Monitor'));
    await client.query('BEGIN'); await client.query(`SET LOCAL ROLE ${role}`);
    await assert.rejects(client.query(`UPDATE ${schema}.org_profiles SET name='Forbidden' WHERE id=1`), /permission denied/);
    await client.query('ROLLBACK');
    await client.query('BEGIN'); await client.query(`SET LOCAL ROLE ${role}`);
    await assert.rejects(client.query(`CREATE TRIGGER hijack AFTER INSERT ON pg_temp.scan_entries FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.wro_entry_org_metrics()`), /permission denied/);
  } finally { await client.query('ROLLBACK'); await client.query('DROP TABLE IF EXISTS pg_temp.org_profiles, pg_temp.scan_entries'); client.release(); }
});

test('profile creation and direct automatic linking refuse program identities without changing rows', async () => {
  await assert.rejects(upsertOrgProfile('Example Research Grants', 'ai'), /requires review/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM org_profiles')).rows[0].n, 0);
  await pool.query("INSERT INTO org_profiles(name) VALUES ('Example Scholar Program'); INSERT INTO scan_entries(status,quality_score) VALUES('approved',80)");
  await assert.rejects(linkEntryToOrg(1, 1), /identity review/);
  assert.equal((await pool.query('SELECT org_id FROM scan_entries')).rows[0].org_id, null);
  assert.deepEqual(await metrics(), expected(0, null, 'Tier 3 - Monitor'));
});

test('automatic linking preserves existing curator links and both hold fields', async () => {
  await pool.query("INSERT INTO org_profiles(name) VALUES ('First Foundation'),('Second Foundation'); INSERT INTO scan_entries(org_id,status,operator_notes,action_reason) VALUES(1,'approved',NULL,NULL),(NULL,'approved','HOLD: verify funder',NULL),(NULL,'approved',NULL,'hold pending review')");
  const before=(await pool.query('SELECT * FROM scan_entries ORDER BY id')).rows;
  assert.equal(await linkEntryToOrg(1, 2), false);
  assert.equal(await linkEntryToOrg(2, 2), false);
  assert.equal(await linkEntryToOrg(3, 2), false);
  assert.deepEqual((await pool.query('SELECT * FROM scan_entries ORDER BY id')).rows, before);
});

test('a curator link committed while extraction waits wins over automatic linking', async () => {
  await pool.query("INSERT INTO org_profiles(name) VALUES ('First Foundation'),('Second Foundation'); INSERT INTO scan_entries(status) VALUES('approved')");
  const curator=await pool.connect();let pending;
  try {
    await curator.query('BEGIN');
    await curator.query('UPDATE scan_entries SET org_id=1 WHERE id=1');
    pending=linkEntryToOrg(1,2);
    let waiting=false;
    for(let n=0;n<100;n++) {
      waiting=(await admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%AS held%') waiting")).rows[0].waiting;
      if(waiting) break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(waiting,true);
    await curator.query('COMMIT');
    assert.equal(await pending,false);
    assert.equal((await pool.query('SELECT org_id FROM scan_entries')).rows[0].org_id,1);
  } finally { await curator.query('ROLLBACK'); if(pending)await pending.catch(()=>{}); curator.release(); }
});
