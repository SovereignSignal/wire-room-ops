process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'test-internal-key';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://x:***@127.0.0.1:1/x';
process.env.NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL || 'test@example.com';

require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');

const { STARTUP_MIGRATIONS } = require('../src/db/startup-migrations');

test('Telegram receipt indexes run only after scan_entries metadata exists', () => {
  const names = STARTUP_MIGRATIONS.map(migration => migration.name);
  assert.ok(names.indexOf('scan-tables') < names.indexOf('classification-columns'));
  assert.ok(names.indexOf('classification-columns') < names.indexOf('telegram-intake-receipts'));
});

test('a version 2 upgrade runs only newer contracts and retries failures', async () => {
  const { runStartupMigrations, getStartupMigrationHealth } = require('../src/db/startup-migrations');
  const originals=STARTUP_MIGRATIONS.map(m => m.run);
  const seen=[];
  try {
    for(const m of STARTUP_MIGRATIONS) m.run=async()=>{ seen.push(m.name); };
    const metrics=STARTUP_MIGRATIONS.find(m=>m.name==='program-metrics');
    metrics.run=async()=>{ throw new Error('injected upgrade failure'); };
    await assert.rejects(runStartupMigrations({ fatal:true,fromVersion:2 }), /injected upgrade failure/);
    assert.deepEqual(seen, []);
    assert.equal(getStartupMigrationHealth().failed,1);
    metrics.run=async()=>{ seen.push(metrics.name); };
    await runStartupMigrations({ fatal:true,fromVersion:2 });
    assert.deepEqual(seen, ['program-metrics','program-decisions','paced-distribution','watch-surface-repairs','api-usage-job','publication-post-text','acknowledged-distribution','wire-area']);
    assert.equal(getStartupMigrationHealth().failed,0);
  } finally { STARTUP_MIGRATIONS.forEach((m,i)=>{m.run=originals[i];}); }
});
