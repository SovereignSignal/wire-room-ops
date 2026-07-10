require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  rewriteEntrySource,
  linkEntryDuplicate,
  EntryMaintenanceError,
} = require('../src/services/entry-maintenance');

function fakePool(options = {}) {
  const calls = [];
  const entry = options.entry || {
    id: 11106,
    status: 'queued',
    source_url: 'https://manual/needs-source/11106',
    wire: 'ai',
    scan_date: '2026-07-10',
  };
  const client = {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/pg_advisory_xact_lock/.test(sql)) {
        return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
      }
      if (/WHERE id = ANY\(\$1::bigint\[\]\)/.test(sql)) {
        const rows = options.endpointRows || [
          entry,
          { id: 10431, status: 'duplicate', source_url: 'https://example.com/parent', duplicate_of_id: 10355 },
        ];
        return { rows, rowCount: rows.length };
      }
      if (/SELECT id, status, source_url, wire, scan_date/.test(sql)) {
        return { rows: entry ? [entry] : [], rowCount: entry ? 1 : 0 };
      }
      if (/SELECT id, status, source_url\s+FROM scan_entries/.test(sql)) {
        return { rows: entry ? [entry] : [], rowCount: entry ? 1 : 0 };
      }
      if (/SELECT id, status, duplicate_of_id\s+FROM scan_entries WHERE id = \$1 FOR UPDATE/.test(sql)) {
        const terminal = (options.chainRows || [{ id: 10699, status: 'approved', duplicate_of_id: null, depth: 1, cycle: false }])[0];
        return { rows: terminal ? [terminal] : [], rowCount: terminal ? 1 : 0 };
      }
      if (/SELECT first_seen_entry_id FROM seen_urls/.test(sql)) {
        const rows = options.conflictRows || [];
        return { rows, rowCount: rows.length };
      }
      if (/WITH RECURSIVE duplicate_chain/.test(sql)) {
        const rows = options.chainRows || [{ id: 10699, status: 'approved', duplicate_of_id: null, depth: 1, cycle: false }];
        return { rows, rowCount: rows.length };
      }
      if (/UPDATE scan_entries SET/.test(sql)) {
        const rowCount = options.updateRowCount ?? 1;
        return { rows: rowCount ? [{ id: entry.id, status: entry.status }] : [], rowCount };
      }
      if (/INSERT INTO seen_urls/.test(sql)) {
        const rowCount = options.registryRowCount ?? 1;
        return { rows: rowCount ? [{ first_seen_entry_id: entry.id }] : [], rowCount };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {
      calls.push({ sql: 'RELEASE', params: [] });
    },
  };
  return {
    calls,
    async connect() { return client; },
  };
}

const sourceOptions = {
  expectedStatus: 'queued',
  expectedSourceUrl: 'https://manual/needs-source/11106',
  newSourceUrl: 'https://www.wlu.ca/news/spotlights/2026/july/nserc-award.html',
  actor: 'stringer',
  reason: 'Verified first-party source',
};

test('source rewrite dry run validates guards and rolls back without mutation', async () => {
  const pool = fakePool();
  const result = await rewriteEntrySource(pool, 11106, { ...sourceOptions, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
  assert.equal(pool.calls.some(call => /UPDATE scan_entries SET/.test(call.sql)), false);
});

test('source rewrite commits entry and seen_urls registry atomically', async () => {
  const pool = fakePool();
  const result = await rewriteEntrySource(pool, 11106, sourceOptions);
  assert.equal(result.newSourceUrl, sourceOptions.newSourceUrl);
  assert.ok(pool.calls.some(call => /source_rewrites/.test(call.sql)));
  assert.ok(pool.calls.some(call => /DELETE FROM seen_urls/.test(call.sql)));
  assert.ok(pool.calls.some(call => /INSERT INTO seen_urls/.test(call.sql)));
  assert.ok(pool.calls.some(call => call.sql === 'COMMIT'));
});

test('source rewrite rejects placeholders before opening a transaction', async () => {
  const pool = fakePool();
  await assert.rejects(
    rewriteEntrySource(pool, 11106, { ...sourceOptions, newSourceUrl: 'https://manual/needs-source/other' }),
    error => error instanceof EntryMaintenanceError && error.statusCode === 400,
  );
  assert.equal(pool.calls.length, 0);
});

test('source rewrite refuses a canonical URL owned by another entry', async () => {
  const pool = fakePool({ conflictRows: [{ first_seen_entry_id: 10699 }] });
  await assert.rejects(
    rewriteEntrySource(pool, 11106, sourceOptions),
    error => error instanceof EntryMaintenanceError && error.statusCode === 409,
  );
  assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
  assert.equal(pool.calls.some(call => /UPDATE scan_entries SET/.test(call.sql)), false);
});

const duplicateOptions = {
  expectedStatus: 'queued',
  expectedSourceUrl: 'https://manual/needs-source/11106',
  duplicateOfId: 10431,
  actor: 'stringer',
  reason: 'Verified same listing',
};

test('explicit duplicate link resolves the requested parent to its terminal canonical row', async () => {
  const pool = fakePool({
    chainRows: [{ id: 10355, status: 'approved', duplicate_of_id: null, depth: 1, cycle: false }],
  });
  const result = await linkEntryDuplicate(pool, 11106, duplicateOptions);
  assert.equal(result.duplicateOfId, 10355);
  const update = pool.calls.find(call => /^\s*UPDATE scan_entries SET[\s\S]*status = 'duplicate'/.test(call.sql));
  assert.equal(update.params[1], 10355);
  assert.match(update.sql, /explicit_duplicate_links/);
  const registryUpdate = pool.calls.find(call => /UPDATE seen_urls/.test(call.sql));
  assert.deepEqual(registryUpdate.params, [11106, 10355]);
  assert.ok(pool.calls.some(call => call.sql === 'COMMIT'));
});

test('explicit duplicate link refuses a dead-end parent chain', async () => {
  const pool = fakePool({
    chainRows: [{ id: 8416, status: 'duplicate', duplicate_of_id: null, depth: 1, cycle: false }],
  });
  await assert.rejects(
    linkEntryDuplicate(pool, 11106, duplicateOptions),
    error => error instanceof EntryMaintenanceError && error.statusCode === 409,
  );
  assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
  assert.equal(pool.calls.some(call => /^\s*UPDATE scan_entries SET[\s\S]*status = 'duplicate'/.test(call.sql)), false);
});

test('explicit duplicate link refuses a non-reviewable terminal parent', async () => {
  const pool = fakePool({
    chainRows: [{ id: 10355, status: 'archived', duplicate_of_id: null, depth: 0, cycle: false }],
  });
  await assert.rejects(
    linkEntryDuplicate(pool, 11106, duplicateOptions),
    error => error instanceof EntryMaintenanceError && /invalid-status/.test(error.message),
  );
  assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
});
