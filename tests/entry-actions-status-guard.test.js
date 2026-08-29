require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { eligibleStatusesForAction } = require('../src/services/entry-actions');

test('approve only leaves queued; decline also accepts skipped', () => {
  assert.deepEqual([...eligibleStatusesForAction('approve')], ['queued']);
  assert.deepEqual([...eligibleStatusesForAction('decline')], ['queued', 'skipped']);
  assert.deepEqual([...eligibleStatusesForAction('reviewlater')], ['queued']);
  assert.equal(eligibleStatusesForAction('restore'), null);
});

test('status updates are fenced to eligible rows so re-approve cannot republish', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/entry-actions.ts'), 'utf8');
  const dbSource = fs.readFileSync(path.join(__dirname, '../src/db/index.ts'), 'utf8');
  assert.match(source, /AND \(\$6::text\[\] IS NULL OR status = ANY\(\$6\)\)/);
  assert.match(source, /Cannot \$\{action\} entry/);
  assert.match(source, /scanEntryId: row\.id/);
  assert.match(dbSource, /entities->>'scan_entry_id'/);
  assert.match(dbSource, /entities->>'source_url'/);
});
