require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
