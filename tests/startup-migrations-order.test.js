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
