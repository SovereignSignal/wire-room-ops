require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const db = require('../src/db');
const { config } = require('../src/config');
const { getUsageSummary } = require('../src/services/api-usage');
const { getDiscoveryCoverage } = require('../src/services/discovery-coverage');
if (!process.env.DATABASE_URL) { console.log('Skipping usage coverage DB tests: DATABASE_URL not set'); process.exit(0); }
const schema = `usage_coverage_${process.pid}_${Date.now()}`;
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });
const original = db.getPool;
const watchtower = { ...config.watchtower };
test.before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`CREATE TABLE watch_surfaces(status text,surface_type text,tier text,last_checked_at timestamptz);
    CREATE TABLE monitored_accounts(enabled boolean,last_checked_at timestamptz);
    CREATE TABLE schedules(schedule_type text,enabled boolean);
    CREATE TABLE api_usage_log(provider text,model text,purpose text,job text,tokens_in int,tokens_out int,estimated_cost_usd numeric,success boolean,created_at timestamptz DEFAULT now());
    INSERT INTO watch_surfaces VALUES ('active','rss','Tier 1',null),('active','application','Tier 2',now()),('active','social','Tier 1',null),('archived','rss','Tier 1',now());
    INSERT INTO monitored_accounts VALUES (true,null),(true,now()),(false,null);
    INSERT INTO schedules VALUES ('account-monitor',false),('daily-digest',true),('source-feeds',false);
    INSERT INTO api_usage_log(provider,model,purpose,tokens_in,tokens_out,estimated_cost_usd,success) VALUES
      ('configured-slot','vendor-a-model','summary',10,2,0.5,true),('configured-slot','vendor-b-model','summary',20,4,null,true),('configured-slot',null,'summary',null,null,null,false);`);
  db.getPool = () => pool;
});
test.after(async () => {
  db.getPool = original; Object.assign(config.watchtower,watchtower);
  await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
});
test('coverage distinguishes eligible surfaces, historical checks, dry-run and disabled account polling', async () => {
  config.watchtower.registryTiers='1'; config.watchtower.registryWatchEnabled=true; config.watchtower.registryWatchDryRun=true;
  let result=await getDiscoveryCoverage(pool);
  assert.equal(result.registry.catalog,4); assert.equal(result.registry.active,3); assert.equal(result.registry.eligible,1);
  assert.equal(result.registry.checked_ever,2); assert.equal(result.registry.mode,'dry-run'); assert.equal(result.registry.enabled_schedules,1);
  assert.equal(result.accounts.enabled,2); assert.equal(result.accounts.checked_ever,1); assert.equal(result.accounts.enabled_schedules,0);
  config.watchtower.registryWatchEnabled=false;
  assert.equal((await getDiscoveryCoverage(pool)).registry.mode,'disabled');
});
test('summary retains mixed recorded models and unknown costs without inventing a vendor', async () => {
  const [row]=await getUsageSummary({days:1});
  assert.equal(row.provider,'configured-slot'); assert.deepEqual(new Set(row.models),new Set(['vendor-a-model','vendor-b-model',null]));
  assert.equal(row.calls,3); assert.equal(row.unpriced_calls,2); assert.equal(row.estimated_cost_usd,0.5); assert.equal(row.errors,1);
});
