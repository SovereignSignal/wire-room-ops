require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { isDatabaseUrlChangeAllowed } = require('../src/config/db-config');

test('DATABASE_URL changes are locked only in production', () => {
  assert.equal(isDatabaseUrlChangeAllowed({ NODE_ENV: 'production' }), false);
  assert.equal(isDatabaseUrlChangeAllowed({ NODE_ENV: 'development' }), true);
  assert.equal(isDatabaseUrlChangeAllowed({}), true);
});

test('database routes reject URL test/save in production', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/database.ts'), 'utf8');
  assert.match(source, /isDatabaseUrlChangeAllowed/);
  assert.match(source, /rejectUrlChangeInProduction/);
  assert.match(source, /DATABASE_URL cannot be changed in production/);
  assert.equal((source.match(/rejectUrlChangeInProduction\(res\)/g) || []).length, 2);
});

test('production ignores a saved dashboard URL when the runtime credential changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wro-db-config-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'db-config.json'), JSON.stringify({ databaseUrl: 'postgres://old-owner@localhost/old' }));
    const result = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', `
      const assert = require('node:assert/strict');
      const db = require('./src/config/db-config');
      assert.equal(db.getEffectiveDbUrl(), process.env.DATABASE_URL);
      assert.equal(db.getDbConfigMeta().source, 'env_var');
    `], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATA_DIR: dir, NODE_ENV: 'production', DATABASE_URL: 'postgres://runtime@localhost/current' }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
