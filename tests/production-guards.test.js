require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertProductionAuthSafety } = require('../src/config/production-guards');

test('production refuses DEV_MODE and missing Privy credentials', () => {
  assert.throws(
    () => assertProductionAuthSafety({ NODE_ENV: 'production', DEV_MODE: 'true', PRIVY_APP_ID: 'x' }),
    /DEV_MODE=true is forbidden/,
  );
  assert.throws(
    () => assertProductionAuthSafety({ NODE_ENV: 'production' }),
    /PRIVY_APP_ID is not set/,
  );
  assert.doesNotThrow(() => assertProductionAuthSafety({ NODE_ENV: 'production', PRIVY_APP_ID: 'app' }));
  assert.doesNotThrow(() => assertProductionAuthSafety({ NODE_ENV: 'development', DEV_MODE: 'true' }));
});

test('boot entrypoint uses the production auth safety helper', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8');
  assert.match(source, /assertProductionAuthSafety/);
  assert.doesNotMatch(source, /DEV_MODE === 'true'[\s\S]*process\.exit/);
});
