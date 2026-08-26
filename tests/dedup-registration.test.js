require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerSeenInTransaction } = require('../src/services/dedup');

function cycleRegistrationDb(owner, siblings = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO seen_urls')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT su.first_seen_entry_id')) return { rows: [owner], rowCount: 1 };
      if (sql.includes("status IN ('raw', 'deduped', 'queued', 'approved', 'declined')")) {
        return { rows: siblings, rowCount: siblings.length };
      }
      if (sql.includes('INSERT INTO seen_names')) return { rows: [{ entry_id: 202 }], rowCount: 1 };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

function registrationDb(owner) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO seen_urls')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT su.first_seen_entry_id')) return { rows: [owner], rowCount: 1 };
      if (sql.includes('UPDATE seen_urls')) return { rows: [{ id: 7 }], rowCount: 1 };
      if (sql.includes('INSERT INTO seen_names')) return { rows: [{ entry_id: 202 }], rowCount: 1 };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

const incoming = {
  id: 202,
  sourceUrl: 'https://example.org/reconsidered-program',
  name: 'Reconsidered Program',
  wire: 'ai',
  scanDate: '2026-08-22',
};

test('atomic URL claim transfers ownership from an archived entry to the fresh entry', async () => {
  const db = registrationDb({ first_seen_entry_id: 101, name: 'Archived Program', status: 'archived' });

  const result = await registerSeenInTransaction(db, incoming);

  assert.deepEqual(result, { urlConflict: false, conflictEntryId: null });
  const ownerRead = db.calls.find(call => call.sql.includes('SELECT su.first_seen_entry_id'));
  assert.match(ownerRead.sql, /se\.status/);
  assert.match(ownerRead.sql, /FOR UPDATE OF su/);
  const transfer = db.calls.find(call => call.sql.includes('UPDATE seen_urls'));
  assert.ok(transfer, 'archived URL ownership was not transferred');
  assert.deepEqual(transfer.params, [
    incoming.sourceUrl,
    incoming.id,
    incoming.scanDate,
    incoming.sourceUrl,
    incoming.wire,
    101,
  ]);
  assert.ok(db.calls.some(call => call.sql.includes('INSERT INTO seen_names')), 'fresh owner name was not registered');
});

test('atomic URL claim still conflicts with an active owner', async () => {
  const db = registrationDb({ first_seen_entry_id: 101, name: 'Active Program', status: 'queued' });

  const result = await registerSeenInTransaction(db, incoming);

  assert.deepEqual(result, { urlConflict: true, conflictEntryId: 101 });
  assert.ok(!db.calls.some(call => call.sql.includes('UPDATE seen_urls')), 'active ownership must not transfer');
  assert.ok(!db.calls.some(call => call.sql.includes('INSERT INTO seen_names')), 'conflicting claimant name must not register');
});

test('atomic URL claim shares an official page when the incoming name is a new cycle', async () => {
  const db = cycleRegistrationDb(
    { first_seen_entry_id: 15496, name: 'Wikimedia Rapid Grants Cycle 2 2026', status: 'approved', deadline: null },
    [{ id: 15496, name: 'Wikimedia Rapid Grants Cycle 2 2026', deadline: null, status: 'approved' }],
  );

  const result = await registerSeenInTransaction(db, {
    id: 15775,
    sourceUrl: 'https://meta.wikimedia.org/wiki/Grants:Project/Rapid',
    name: 'Wikimedia Rapid Funds Cycle 3 FY2026-27',
    wire: 'oss',
    scanDate: '2026-08-26',
  });

  assert.deepEqual(result, { urlConflict: false, conflictEntryId: null });
  assert.ok(db.calls.some(call => call.sql.includes('INSERT INTO seen_names')), 'new cycle must still register its name');
  assert.ok(!db.calls.some(call => call.sql.includes('UPDATE seen_urls')), 'first-seen owner stays put');
});

test('atomic URL claim still conflicts when the same cycle already owns the official page', async () => {
  const db = cycleRegistrationDb(
    { first_seen_entry_id: 15496, name: 'Wikimedia Rapid Grants Cycle 2 2026', status: 'approved', deadline: null },
    [
      { id: 15496, name: 'Wikimedia Rapid Grants Cycle 2 2026', deadline: null, status: 'approved' },
      { id: 15775, name: 'Wikimedia Rapid Funds Cycle 3 FY2026-27', deadline: null, status: 'queued' },
    ],
  );

  const result = await registerSeenInTransaction(db, {
    id: 15780,
    sourceUrl: 'https://meta.wikimedia.org/wiki/Grants:Project/Rapid',
    name: 'Wikimedia Rapid Funds Cycle 3 FY2026-27',
    wire: 'oss',
    scanDate: '2026-08-26',
  });

  assert.deepEqual(result, { urlConflict: true, conflictEntryId: 15775 });
  assert.ok(!db.calls.some(call => call.sql.includes('INSERT INTO seen_names')), 'same-cycle claimant must not register');
});
