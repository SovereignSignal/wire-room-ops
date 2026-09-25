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
