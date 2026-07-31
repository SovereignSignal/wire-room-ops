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
        // resolutionRows (plural) lets a test return a DIFFERENT resolution on the
        // second call — simulating a genuine race between the first resolution and
        // the revalidation after the row locks. resolutionRow (singular) is the
        // common case: every call sees the same stable row.
        const row = overrides.resolutionRows
          ? overrides.resolutionRows[Math.min(resolutionCalls, overrides.resolutionRows.length) - 1]
          : (overrides.resolutionRow || {
              id: 30,
              status: 'approved',
              duplicate_of_id: null,
              depth: 1,
              cycle: false,
            });
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

test('duplicate demotion succeeds when canonical parent is archived', async () => {
  const db = fakeDb({
    resolutionRow: { id: 30, status: 'archived', duplicate_of_id: null, depth: 1, cycle: false },
    terminalRow: { id: 30, status: 'archived', duplicate_of_id: null },
  });
  const result = await demoteEntryToDuplicateInTransaction(db, INPUT);

  assert.deepEqual(result, { outcome: 'linked', canonicalParentId: 30 });
});

// ── Permanent, non-retryable parent conditions ──────────────────────────────
// A parent chain that resolves to a stable-but-non-canonical state is a
// PERMANENT data condition: retrying the exact same demotion can never make it
// succeed. It must NOT throw (a throw is treated as retryable by every automatic
// caller, producing the infinite Telegram webhook retry / 5-min process-raw loop
// that PR #86 spot-fixed for `archived` only). Instead the demotion reports an
// 'unresolvable' outcome so callers can make forward progress. See the July 2026
// "OpenClaw Foundation Launch" incident (invalid-status → 44+ webhook retries).

test('duplicate demotion is unresolvable (not thrown) when the parent chain ends in a non-canonical status', async () => {
  const db = fakeDb({
    // A parent that terminates in 'skipped' is not an allowed canonical status,
    // exactly like 'archived' was before #86 — but the class is open-ended.
    resolutionRow: { id: 30, status: 'skipped', duplicate_of_id: null, depth: 1, cycle: false },
  });
  const result = await demoteEntryToDuplicateInTransaction(db, INPUT);

  assert.deepEqual(result, { outcome: 'unresolvable', canonicalParentId: null, unresolvableReason: 'invalid-status' });
  assert.equal(db.calls.some(call => /UPDATE scan_entries AS target/.test(call.sql)), false, 'must not mutate the target');
  assert.equal(db.calls.some(call => /UPDATE seen_urls/.test(call.sql)), false, 'must not reassign URL ownership');
});

test('duplicate demotion is unresolvable when the parent chain dead-ends', async () => {
  const db = fakeDb({
    resolutionRow: { id: 30, status: 'duplicate', duplicate_of_id: null, depth: 1, cycle: false },
  });
  const result = await demoteEntryToDuplicateInTransaction(db, INPUT);

  assert.deepEqual(result, { outcome: 'unresolvable', canonicalParentId: null, unresolvableReason: 'dead-end' });
});

test('duplicate demotion is unresolvable when the parent chain cycles', async () => {
  const db = fakeDb({
    resolutionRow: { id: 30, status: 'queued', duplicate_of_id: 20, depth: 3, cycle: true },
  });
  const result = await demoteEntryToDuplicateInTransaction(db, INPUT);

  assert.deepEqual(result, { outcome: 'unresolvable', canonicalParentId: null, unresolvableReason: 'cycle' });
});

test('duplicate demotion is unresolvable when the chain resolves back to the target itself', async () => {
  const db = fakeDb({
    resolutionRow: { id: 10, status: 'approved', duplicate_of_id: null, depth: 2, cycle: false },
  });
  const result = await demoteEntryToDuplicateInTransaction(db, INPUT);

  assert.deepEqual(result, { outcome: 'unresolvable', canonicalParentId: null, unresolvableReason: 'self-cycle' });
});

// ── The 2026-07-31 incident: a terminal the resolver calls canonical, but isn't ────────────
// resolveDuplicateChain's recursive walk stops at the first row whose status isn't
// 'duplicate' — it does not check whether that row still carries its own
// duplicate_of_id. demoteEntryToDuplicateInTransaction re-reads the same row under
// FOR UPDATE and rejects it when duplicate_of_id is non-null. Both reads see the exact
// same row every time: the resolver always calls it canonical, the guard always rejects
// it. That contradiction is a STABLE property of the row (entry 8825: archived,
// duplicate_of_id=7645), not a race — so it must return `unresolvable`, not throw. A
// throw here is what stranded entry 13172 in an infinite process-raw retry loop.

test('a terminal that is archived AND still points at a parent is unresolvable, not a retryable throw', async () => {
  const db = fakeDb({
    resolutionRow: { id: 30, status: 'archived', duplicate_of_id: 7645, depth: 1, cycle: false },
    terminalRow: { id: 30, status: 'archived', duplicate_of_id: 7645 },
  });
  const result = await demoteEntryToDuplicateInTransaction(db, INPUT);

  assert.deepEqual(result, { outcome: 'unresolvable', canonicalParentId: null, unresolvableReason: 'non-canonical-terminal' });
  assert.equal(db.resolutionCalls, 1, 'must not reach the revalidation resolve — this is not the race check');
  assert.equal(db.calls.some(call => /UPDATE scan_entries AS target/.test(call.sql)), false, 'must not mutate the target');
  assert.equal(db.calls.some(call => /UPDATE seen_urls/.test(call.sql)), false, 'must not reassign URL ownership');
});

test('duplicate demotion is unresolvable (not thrown) when the terminal row is gone by the time it is re-read under lock', async () => {
  const db = fakeDb({
    resolutionRow: { id: 30, status: 'approved', duplicate_of_id: null, depth: 1, cycle: false },
    terminalRow: null,
  });
  const result = await demoteEntryToDuplicateInTransaction(db, INPUT);

  assert.deepEqual(result, { outcome: 'unresolvable', canonicalParentId: null, unresolvableReason: 'terminal-missing' });
});

test('duplicate demotion still throws when revalidation resolves to a different parent than the first resolution (genuine race)', async () => {
  const db = fakeDb({
    resolutionRows: [
      { id: 30, status: 'approved', duplicate_of_id: null, depth: 1, cycle: false },
      { id: 40, status: 'approved', duplicate_of_id: null, depth: 1, cycle: false },
    ],
    terminalRow: { id: 30, status: 'approved', duplicate_of_id: null },
  });
  await assert.rejects(
    demoteEntryToDuplicateInTransaction(db, INPUT),
    /Duplicate parent changed before write/,
  );
  assert.equal(db.resolutionCalls, 2, 'the race is only detectable because both resolutions ran');
  assert.equal(db.calls.some(call => /UPDATE scan_entries AS target/.test(call.sql)), false, 'must not mutate the target');
});

test('duplicate demotion still returns linked for a clean canonical terminal with no parent of its own (happy path unchanged)', async () => {
  const db = fakeDb({
    resolutionRow: { id: 30, status: 'declined', duplicate_of_id: null, depth: 1, cycle: false },
    terminalRow: { id: 30, status: 'declined', duplicate_of_id: null },
  });
  const result = await demoteEntryToDuplicateInTransaction(db, INPUT);

  assert.deepEqual(result, { outcome: 'linked', canonicalParentId: 30 });
});
