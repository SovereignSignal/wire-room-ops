require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  demoteEntryToDuplicateInTransaction,
} = require('../src/services/duplicate-chain');

function fakeDb(overrides = {}) {
  const calls = [];
  let resolutionCalls = 0;
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/pg_advisory_xact_lock/.test(sql)) return { rows: [], rowCount: 1 };
      if (/WHERE id = ANY\(\$1::bigint\[\]\)/.test(sql)) {
        const rows = overrides.endpointRows || [
          { id: 10, status: 'raw', source_url: 'https://example.org/new', duplicate_of_id: null },
          { id: 20, status: 'duplicate', source_url: 'https://example.org/old', duplicate_of_id: 30 },
        ];
        return { rows, rowCount: rows.length };
      }
      if (/WITH RECURSIVE duplicate_chain/.test(sql)) {
        resolutionCalls += 1;
        const row = overrides.resolutionRow || {
          id: 30,
          status: 'approved',
          duplicate_of_id: null,
          depth: 1,
          cycle: false,
        };
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (/SELECT id, status, duplicate_of_id[\s\S]*WHERE id = \$1[\s\S]*FOR UPDATE/.test(sql)) {
        const row = overrides.terminalRow === undefined
          ? { id: 30, status: 'approved', duplicate_of_id: null }
          : overrides.terminalRow;
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (/UPDATE scan_entries AS target/.test(sql)) {
        const rowCount = overrides.updateRowCount ?? 1;
        return { rows: rowCount ? [{ id: 10 }] : [], rowCount };
      }
      if (/UPDATE seen_urls/.test(sql)) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    get resolutionCalls() { return resolutionCalls; },
  };
}

const INPUT = {
  targetId: 10,
  requestedParentId: 20,
  expectedStatus: 'raw',
  expectedSourceUrl: 'https://example.org/new',
  reason: 'same listing',
  actor: 'daily-intake',
};

test('duplicate demotion serializes the graph, resolves and revalidates the terminal parent, then transfers URL ownership', async () => {
  const db = fakeDb();
  const result = await demoteEntryToDuplicateInTransaction(db, INPUT);

  assert.deepEqual(result, { outcome: 'linked', canonicalParentId: 30 });
  assert.equal(db.resolutionCalls, 2, 'parent chain must be checked again after row locks');
  assert.match(db.calls[0].sql, /pg_advisory_xact_lock/);
  const endpointLock = db.calls.find(call => /WHERE id = ANY/.test(call.sql));
  assert.deepEqual(endpointLock.params, [[10, 20]], 'endpoint locks use deterministic id order');
  const update = db.calls.find(call => /UPDATE scan_entries AS target/.test(call.sql));
  assert.deepEqual(update.params, [10, 30, 'same listing', 'daily-intake', 'raw', 'https://example.org/new']);
  const ownership = db.calls.find(call => /UPDATE seen_urls/.test(call.sql));
  assert.deepEqual(ownership.params, [10, 30]);
});

test('duplicate demotion loses compare and set cleanly when target source or status changed', async () => {
  const db = fakeDb({
    endpointRows: [
      { id: 10, status: 'approved', source_url: 'https://operator.example/edit', duplicate_of_id: null },
      { id: 20, status: 'duplicate', source_url: 'https://example.org/old', duplicate_of_id: 30 },
    ],
  });
  const result = await demoteEntryToDuplicateInTransaction(db, INPUT);

  assert.deepEqual(result, { outcome: 'stale', canonicalParentId: null });
  assert.equal(db.calls.some(call => /UPDATE scan_entries AS target/.test(call.sql)), false);
  assert.equal(db.calls.some(call => /UPDATE seen_urls/.test(call.sql)), false);
});

test('duplicate demotion rejects self links before acquiring graph locks', async () => {
  const db = fakeDb();
  await assert.rejects(
    demoteEntryToDuplicateInTransaction(db, { ...INPUT, requestedParentId: INPUT.targetId }),
    /cannot duplicate itself/,
  );
  assert.equal(db.calls.length, 0);
});
