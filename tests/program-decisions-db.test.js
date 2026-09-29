require('ts-node/register/transpile-only');
const test=require('node:test'),assert=require('node:assert/strict'),{Pool}=require('pg');
const db=require('../src/db');
const {ensureProgramDecisions}=require('../src/db/program-decisions');
const {ensureProgramMetrics}=require('../src/db/program-metrics');
if(!process.env.DATABASE_URL){console.log('Skipping decision DB tests: DATABASE_URL not set');process.exit(0);}
const schema=`program_decisions_${process.pid}_${Date.now()}`,role=`${schema}_writer`;
const admin=new Pool({connectionString:process.env.DATABASE_URL});
const pool=new Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema} -c statement_timeout=5000`});
const original=db.getPool;
test.before(async()=>{
 await admin.query(`CREATE SCHEMA ${schema}`);
 await pool.query(`CREATE TABLE programs(id serial PRIMARY KEY,name text,entry_count integer DEFAULT 0,approved_count integer DEFAULT 0,declined_count integer DEFAULT 0,last_decision text,updated_at timestamptz DEFAULT now());
 CREATE TABLE scan_entries(id serial PRIMARY KEY,program_id integer REFERENCES programs(id),status text,metadata jsonb,updated_at timestamptz DEFAULT now());
 INSERT INTO programs(name,last_decision) VALUES('Historical','approved 2020-01-01'); INSERT INTO scan_entries(program_id,status,updated_at) VALUES(1,'approved','2020-01-01');`);
 db.getPool=()=>pool;await ensureProgramMetrics();await ensureProgramDecisions();await ensureProgramDecisions();
 assert.equal((await pool.query('SELECT decision_at FROM scan_entries')).rows[0].decision_at,null);
 assert.deepEqual((await pool.query('SELECT last_decision,legacy_last_decision FROM programs')).rows[0],{last_decision:null,legacy_last_decision:'approved 2020-01-01'});
 await admin.query(`CREATE ROLE ${role}; GRANT USAGE ON SCHEMA ${schema} TO ${role}; GRANT SELECT,UPDATE ON ${schema}.scan_entries TO ${role}`);
});
test.after(async()=>{db.getPool=original;await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.query(`DROP ROLE ${role}`);await admin.end();});
test.beforeEach(async()=>{await pool.query("TRUNCATE scan_entries,programs RESTART IDENTITY CASCADE; INSERT INTO programs(name) VALUES('One'),('Two')");});
async function row(id=1){return (await pool.query('SELECT * FROM scan_entries WHERE id=$1',[id])).rows[0];}
async function label(id=1){return (await pool.query('SELECT last_decision FROM programs WHERE id=$1',[id])).rows[0].last_decision;}
test('only status transitions stamp decisions; general edits and forged dates cannot rewrite them',async()=>{
 await pool.query("INSERT INTO scan_entries(program_id,status,decision_at) VALUES(1,'queued','2000-01-01')");assert.equal((await row()).decision_at,null);
 await pool.query("UPDATE scan_entries SET status='approved',updated_at='2000-01-01' WHERE id=1");
 const first=await row();assert.ok(first.decision_at instanceof Date);assert.equal(await label(),`approved ${first.decision_at.toISOString().slice(0,10)}`);
 await pool.query("UPDATE scan_entries SET metadata='{}',updated_at='2099-01-01',decision_at='1990-01-01',status='approved' WHERE id=1");
 assert.deepEqual((await row()).decision_at,first.decision_at);assert.equal(await label(),`approved ${first.decision_at.toISOString().slice(0,10)}`);
 await pool.query("UPDATE programs SET last_decision='approved 2099-01-01'");assert.equal(await label(),`approved ${first.decision_at.toISOString().slice(0,10)}`);
 await pool.query("UPDATE scan_entries SET status='declined' WHERE id=1");assert.ok((await row()).decision_at>=first.decision_at);assert.match(await label(),/^declined /);
 await pool.query("UPDATE scan_entries SET status='duplicate' WHERE id=1");assert.equal((await row()).decision_at,null);assert.equal(await label(),null);
});
test('inserted decisions, reassignment, unlink, delete and truncate update the recorded summary',async()=>{
 await pool.query("INSERT INTO scan_entries(program_id,status) VALUES(1,'approved'),(1,'declined')");assert.match(await label(),/^declined /);
 await pool.query('UPDATE scan_entries SET program_id=2 WHERE id=2');assert.match(await label(),/^approved /);assert.match(await label(2),/^declined /);
 await pool.query('UPDATE scan_entries SET program_id=NULL WHERE id=2');assert.equal(await label(2),null);
 await pool.query('DELETE FROM scan_entries WHERE id=1');assert.equal(await label(),null);
 await pool.query("INSERT INTO scan_entries(program_id,status) VALUES(1,'approved'); TRUNCATE scan_entries");assert.equal(await label(),null);
});
test('restricted writer updates the date through trusted objects and UTC output ignores session timezone',async()=>{
 await pool.query("INSERT INTO scan_entries(program_id,status) VALUES(1,'queued')");const c=await pool.connect();
 try{
 await c.query('BEGIN');await c.query(`SET LOCAL ROLE ${role}`);await c.query("SET LOCAL TIME ZONE 'Pacific/Kiritimati'");
 await c.query('CREATE TEMP TABLE programs(id integer); CREATE TEMP TABLE scan_entries(id integer)');
 await c.query(`UPDATE ${schema}.scan_entries SET status='approved'`);await c.query('COMMIT');
 assert.equal(await label(),`approved ${(await row()).decision_at.toISOString().slice(0,10)}`);
 await c.query('BEGIN');await c.query(`SET LOCAL ROLE ${role}`);
 await assert.rejects(c.query(`CREATE TRIGGER hijack AFTER INSERT ON pg_temp.scan_entries FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.wro_entry_program_decisions()`),/permission denied/);
 }finally{await c.query('ROLLBACK');await c.query('DROP TABLE IF EXISTS pg_temp.programs,pg_temp.scan_entries');c.release();}
});
test('failed summary maintenance rolls back both status and timestamp',async()=>{
 await pool.query("INSERT INTO scan_entries(program_id,status) VALUES(1,'queued'); ALTER TABLE programs ADD CONSTRAINT reject_decision CHECK(last_decision IS NULL)");
 try{await assert.rejects(pool.query("UPDATE scan_entries SET status='approved'"),/reject_decision/);}finally{await pool.query('ALTER TABLE programs DROP CONSTRAINT reject_decision');}
 assert.equal((await row()).status,'queued');assert.equal((await row()).decision_at,null);
});
test('concurrent writers serialize with counter triggers and use a fresh committed snapshot',async()=>{
 await pool.query("INSERT INTO scan_entries(program_id,status) VALUES(1,'approved'),(2,'declined')");const a=await pool.connect(),b=await pool.connect();let pending;
 try{
 await a.query('BEGIN');await b.query('BEGIN');const pid=(await b.query('SELECT pg_backend_pid() id')).rows[0].id;
 await a.query('UPDATE scan_entries SET program_id=2 WHERE id=1');pending=b.query('UPDATE scan_entries SET program_id=1 WHERE id=2');
 let waiting=false;for(let i=0;i<100;i++){waiting=(await admin.query("SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.waiting;if(waiting)break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(waiting,true);await a.query('COMMIT');await pending;await b.query('COMMIT');assert.match(await label(),/^declined /);assert.match(await label(2),/^approved /);
 }finally{await a.query('ROLLBACK');if(pending)await pending.catch(()=>{});await b.query('ROLLBACK');a.release();b.release();}
});
