require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  auditProgramIntegrity,
  buildProgramIntegrityPlan,
  countEligibleUnlinkedClusters,
  runProgramIntegrityRepair,
} = require('../src/services/program-integrity');
const { parseProgramRepairArgs } = require('../src/scripts/program-integrity-repair');

const dirtyAudit = {
  programs_scanned: 1,
  counter_mismatches: 1,
  timeline_mismatches: 1,
  canonical_missing: 1,
  canonical_invalid: 0,
  orphan_duplicates: 1,
  actionable_orphans: 1,
  linked_synthetic_entries: 0,
};

const cleanAudit = {
  ...dirtyAudit,
  counter_mismatches: 0,
  timeline_mismatches: 0,
  canonical_missing: 0,
  orphan_duplicates: 0,
  actionable_orphans: 0,
};

const dirtyProgramRow = {
  program_id: 10,
  entry_count: 2,
  approved_count: 0,
  declined_count: 0,
  first_seen: '2026-07-01',
  last_seen: '2026-07-01',
  last_decision: null,
  canonical_entry_id: null,
  expected_entry_count: 1,
  expected_approved_count: 1,
  expected_declined_count: 0,
  expected_first_seen: '2026-07-02',
  expected_last_seen: '2026-07-02',
  expected_last_decision: 'approved 2026-07-02',
  expected_canonical_id: 4,
};

function integrityPool(options = {}) {
  const state = { applied: false };
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/pg_try_advisory_xact_lock/.test(sql)) return { rows: [{ locked: true }] };
      if (/AS programs_scanned/.test(sql)) return { rows: [state.applied ? cleanAudit : { ...dirtyAudit, linked_synthetic_entries: options.linkedSynthetic ? 1 : 0 }] };
      if (/WHERE program_id IS NULL AND name IS NOT NULL/.test(sql)) {
        return { rows: [{ name: 'Alpha Grants Round 1', status: 'queued' }, { name: 'Alpha Grants Round 2', status: 'queued' }] };
      }
      if (/SELECT program_id,/.test(sql)) return { rows: state.applied ? [] : [dirtyProgramRow] };
      if (/SELECT orphan\.id AS orphan_id/.test(sql)) {
        return { rows: state.applied ? [] : [{ orphan_id: 3, program_id: 10, target_id: 4 }] };
      }
      if (/SELECT id, first_seen_entry_id FROM seen_urls/.test(sql)) return { rows: [{ id: 8, first_seen_entry_id: 3 }] };
      if (/WITH target AS/.test(sql) && /UPDATE programs p SET/.test(sql)) {
        return { rows: options.refreshCasMiss ? [] : [{ id: 10 }] };
      }
      if (/UPDATE seen_urls seen SET/.test(sql)) return { rows: [{ id: 8 }] };
      if (/UPDATE scan_entries orphan SET/.test(sql)) {
        state.applied = true;
        return { rows: [{ id: 3 }] };
      }
      return { rows: [] };
    },
    release() { calls.push({ sql: 'RELEASE', params: [] }); },
  };
  return {
    calls,
    state,
    async query(sql, params) { return client.query(sql, params); },
    async connect() {
      if (options.rejectConnect) throw new Error('dry run opened a transaction');
      return client;
    },
  };
}

test('program repair CLI defaults to dry-run and gates apply on an exact hash', () => {
  assert.deepEqual(parseProgramRepairArgs([]), { apply: false, expectedPlanHash: undefined });
  assert.deepEqual(parseProgramRepairArgs(['--dry-run']), { apply: false, expectedPlanHash: undefined });
  const hash = 'a'.repeat(64);
  assert.deepEqual(parseProgramRepairArgs(['--apply', '--expect-plan-hash', hash]), { apply: true, expectedPlanHash: hash });
  assert.throws(() => parseProgramRepairArgs(['--apply']), /requires --expect-plan-hash/);
  assert.throws(() => parseProgramRepairArgs(['--apply', '--dry-run', '--expect-plan-hash', hash]), /cannot be combined/);
  assert.throws(() => parseProgramRepairArgs(['--wat']), /Unknown argument/);
});

test('eligible unlinked cluster count excludes synthetic and singleton noise', () => {
  assert.equal(countEligibleUnlinkedClusters([
    { name: 'Alpha Grants Round 1', status: 'queued' },
    { name: 'Alpha Grants Round 2', status: 'queued' },
    { name: 'Singleton', status: 'queued' },
    { name: 'Decided Singleton', status: 'approved' },
    { name: 'Test Program Round 1', status: 'approved' },
  ]), 2);
});

test('audit includes empty-program, orphan, synthetic, and unlinked-cluster checks', async () => {
  const pool = integrityPool();
  const snapshot = await auditProgramIntegrity(pool);
  assert.equal(snapshot.counterMismatches, 1);
  assert.equal(snapshot.timelineMismatches, 1);
  assert.equal(snapshot.canonicalMissing, 1);
  assert.equal(snapshot.actionableOrphans, 1);
  assert.equal(snapshot.eligibleUnlinkedClusters, 1);
  assert.match(pool.calls[0].sql, /LEFT JOIN scan_entries/);
  assert.match(pool.calls[0].sql, /duplicate_of_id IS NULL/);
});

test('program integrity dry-run is deterministic and opens no write transaction', async () => {
  const firstPool = integrityPool({ rejectConnect: true });
  const secondPool = integrityPool({ rejectConnect: true });
  const first = await runProgramIntegrityRepair(firstPool);
  const second = await runProgramIntegrityRepair(secondPool, { apply: false });
  assert.equal(first.mode, 'dry-run');
  assert.match(first.planHash, /^[a-f0-9]{64}$/);
  assert.equal(first.planHash, second.planHash);
  assert.equal(first.planned.programRows.length, 1);
  assert.equal(first.planned.orphanLinks.length, 1);
  assert.equal(first.applied.programRows, 0);
  assert.equal(firstPool.calls.some(call => /BEGIN|UPDATE|DELETE|INSERT/.test(call.sql)), false);
});

test('program integrity apply commits only the reviewed unchanged plan', async () => {
  const previewPool = integrityPool({ rejectConnect: true });
  const preview = await buildProgramIntegrityPlan(previewPool);
  const pool = integrityPool();
  const receipt = await runProgramIntegrityRepair(pool, { apply: true, expectedPlanHash: preview.planHash });
  assert.equal(receipt.mode, 'apply');
  assert.deepEqual(receipt.applied, { programRows: 1, orphanLinks: 1, seenUrlOwnerRows: 1 });
  assert.equal(receipt.residual.counterMismatches, 0);
  assert.equal(receipt.residual.actionableOrphans, 0);
  assert.ok(pool.calls.some(call => /LOCK TABLE scan_entries, programs, seen_urls/.test(call.sql)));
  assert.ok(pool.calls.some(call => call.sql === 'COMMIT'));
  assert.equal(pool.calls.at(-1).sql, 'RELEASE');
});

test('program integrity apply rolls back on plan drift before mutation', async () => {
  const pool = integrityPool();
  await assert.rejects(
    runProgramIntegrityRepair(pool, { apply: true, expectedPlanHash: 'a'.repeat(64) }),
    /Repair plan drifted/,
  );
  assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
  assert.equal(pool.calls.some(call => /UPDATE programs p SET|UPDATE seen_urls seen SET|UPDATE scan_entries orphan SET/.test(call.sql)), false);
  assert.equal(pool.calls.some(call => call.sql === 'COMMIT'), false);
});

test('program integrity apply rolls back when a planned update misses its CAS', async () => {
  const preview = await buildProgramIntegrityPlan(integrityPool({ rejectConnect: true }));
  const pool = integrityPool({ refreshCasMiss: true });
  await assert.rejects(
    runProgramIntegrityRepair(pool, { apply: true, expectedPlanHash: preview.planHash }),
    /Program repair count changed/,
  );
  assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
  assert.equal(pool.calls.some(call => call.sql === 'COMMIT'), false);
});

test('program integrity apply refuses linked synthetic entries', async () => {
  const preview = await buildProgramIntegrityPlan(integrityPool({ linkedSynthetic: true, rejectConnect: true }));
  const pool = integrityPool({ linkedSynthetic: true });
  await assert.rejects(
    runProgramIntegrityRepair(pool, { apply: true, expectedPlanHash: preview.planHash }),
    /linked synthetic entries/,
  );
  assert.equal(pool.calls.some(call => /UPDATE programs p SET/.test(call.sql)), false);
  assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
});
