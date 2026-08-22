require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const { restoreEntryRows, EntryActionConflictError } = require('../src/services/entry-actions');

function fakePool(rows, owners = new Map()) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/SELECT id, status, scan_source, classification/.test(sql)) return { rows, rowCount: rows.length };
      if (/SELECT first_seen_entry_id/.test(sql)) {
        const row = rows.find(candidate => candidate.wire === params[1]);
        const owner = row ? owners.get(row.id) : undefined;
        return owner === undefined ? { rows: [], rowCount: 0 } : { rows: [{ first_seen_entry_id: owner }], rowCount: 1 };
      }
      if (/UPDATE scan_entries/.test(sql)) {
        const restored = rows.filter(row => params[0].includes(row.id)).map(row => ({ ...row, status: 'queued', distributable: false }));
        return { rows: restored, rowCount: restored.length };
      }
      return { rows: [], rowCount: 0 };
    },
    release() { calls.push({ sql: 'RELEASE', params: [] }); },
  };
  return {
    calls,
    async connect() { return client; },
  };
}

function xMonitor(overrides = {}) {
  return {
    id: 101,
    status: 'raw',
    scan_source: 'x-monitor',
    classification: 'UNCHECKED',
    metadata: { operator_route: null },
    source_url: 'https://example.org/program',
    wire: 'ai',
    program_id: null,
    ...overrides,
  };
}

test('restore cannot queue a raw x-monitor row', async () => {
  const pool = fakePool([xMonitor()]);

  await assert.rejects(
    restoreEntryRows(pool, [101], { actor: 'sov', reason: 'restore' }),
    error => error instanceof EntryActionConflictError && /cannot restore from status raw/.test(error.message),
  );

  assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
  assert.ok(!pool.calls.some(call => /UPDATE scan_entries/.test(call.sql)));
});

test('restore cannot queue an archived UNCHECKED x-monitor row', async () => {
  const pool = fakePool([xMonitor({ status: 'archived' })]);

  await assert.rejects(
    restoreEntryRows(pool, [101], { actor: 'sov', reason: 'restore' }),
    error => error instanceof EntryActionConflictError && /must settle/.test(error.message),
  );

  assert.ok(!pool.calls.some(call => /UPDATE scan_entries/.test(call.sql)));
});

test('restore rejects an archived x-monitor row after URL ownership transferred', async () => {
  const row = xMonitor({
    status: 'archived',
    classification: 'GRANT',
    metadata: { operator_route: 'publish' },
  });
  const pool = fakePool([row], new Map([[101, 202]]));

  await assert.rejects(
    restoreEntryRows(pool, [101], { actor: 'sov', reason: 'restore' }),
    error => error instanceof EntryActionConflictError && /no longer owns/.test(error.message),
  );

  assert.ok(!pool.calls.some(call => /UPDATE scan_entries/.test(call.sql)));
});

test('restore queues a settled x-monitor owner under the lifecycle lock and keeps it non-distributable', async () => {
  const row = xMonitor({
    status: 'archived',
    classification: 'GRANT',
    metadata: { operator_route: 'source_check' },
  });
  const pool = fakePool([row], new Map([[101, 101]]));

  const restored = await restoreEntryRows(pool, [101], { actor: 'sov', reason: 'verified restore' });

  assert.equal(restored[0].status, 'queued');
  assert.equal(restored[0].distributable, false);
  const lifecycleLock = pool.calls.findIndex(call => /pg_advisory_xact_lock/.test(call.sql));
  const entryLock = pool.calls.findIndex(call => /SELECT id, status, scan_source/.test(call.sql));
  const registryLock = pool.calls.findIndex(call => /SELECT first_seen_entry_id/.test(call.sql));
  const update = pool.calls.findIndex(call => /UPDATE scan_entries/.test(call.sql));
  assert.ok(lifecycleLock >= 0 && lifecycleLock < entryLock && entryLock < registryLock && registryLock < update);
  assert.ok(pool.calls.some(call => call.sql === 'COMMIT'));
});

test('manual restore retains the existing wide-net queue behavior', async () => {
  const row = xMonitor({ id: 303, scan_source: 'manual-intake', status: 'skipped' });
  const pool = fakePool([row]);

  const restored = await restoreEntryRows(pool, [303], { actor: 'sov', reason: 'restore' });

  assert.equal(restored[0].status, 'queued');
  assert.ok(!pool.calls.some(call => /SELECT first_seen_entry_id/.test(call.sql)));
});
