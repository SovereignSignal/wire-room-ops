require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getStartupMigrationHealth } = require('../src/db/startup-migrations');

test('startup migration health starts clean before a run', () => {
  const health = getStartupMigrationHealth();
  assert.equal(typeof health.ran, 'boolean');
  assert.equal(typeof health.failed, 'number');
  assert.ok(Array.isArray(health.errors));
});

test('/ready fails when startup migrations failed', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/server.ts'), 'utf8');
  assert.match(source, /getStartupMigrationHealth/);
  assert.match(source, /startupMigrations: migrations\.ran && migrations\.failed === 0/);
  assert.match(source, /checks\.db && checks\.startupMigrations/);
  assert.match(source, /migrationErrors/);
});

test('runStartupMigrations records failed step names', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/db/startup-migrations.ts'), 'utf8');
  assert.match(source, /lastStartupMigrationHealth/);
  assert.match(source, /errors\.push\(`\$\{m\.name\}: \$\{message\}`\)/);
  assert.match(source, /export function getStartupMigrationHealth/);
});

test('deployment readiness rejects incomplete migrations, scheduler startup failure, and DB failure', async (t) => {
  const db = require('../src/db');
  const migrations = require('../src/db/startup-migrations');
  const scheduler = require('../src/services/scheduler');
  let ran = false, failed = 0, initialized = false, dbOk = true;
  t.mock.method(db, 'getPool', () => ({ query: async () => { if (!dbOk) throw new Error('fixture unavailable'); return { rows: [] }; } }));
  t.mock.method(migrations, 'getStartupMigrationHealth', () => ({ ran, failed, errors: [] }));
  t.mock.method(scheduler, 'getSchedulerStatus', () => ({ initialized, totalSchedules: 0 }));
  const { app } = require('../src/server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const status = async path => { const res = await fetch(base + path); await res.text(); return res.status; };
  try {
    assert.equal(await status('/health'), 200);
    assert.equal(await status('/ready'), 503);
    ran = true; assert.equal(await status('/ready'), 503);
    initialized = true; assert.equal(await status('/ready'), 200, 'initialized zero-schedule setup is valid');
    failed = 1; assert.equal(await status('/ready'), 503);
    failed = 0; dbOk = false; assert.equal(await status('/ready'), 503);
    assert.equal(JSON.parse(fs.readFileSync(path.join(__dirname, '../railway.json'))).deploy.healthcheckPath, '/ready');
    const assets = fs.readdirSync(path.join(__dirname, '../dist/client/assets')).filter(name => name.endsWith('.js'));
    const asset = await fetch(base + '/assets/' + assets[0]);
    assert.match(asset.headers.get('cache-control'), /immutable/); await asset.text();
  } finally { await new Promise(resolve => server.close(resolve)); }
});
