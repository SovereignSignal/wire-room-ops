require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyVerdict, resolveDuplicateChain } = require('../src/jobs/decided-recheck');

const TARGET = {
  id: 11127,
  wire: 'ai',
  name: 'Anthropic Fellows Program (Sept 2026 cohort)',
  description: 'Applications for the September cohort.',
  source_url: 'https://job-boards.greenhouse.io/anthropic/jobs/1',
  deadline: null,
};

function candidate(overrides = {}) {
  return {
    id: 8572,
    name: 'Anthropic Fellows Program',
    status: 'duplicate',
    source_url: 'https://alignment.anthropic.com/x',
    decided_date: '2026-06-08',
    resolve_to: 8416,
    overlap: 3,
    domain_match: true,
    squash_match: true,
    ...overrides,
  };
}

const verdict = (overrides = {}) => ({
  matched_id: 8572,
  verdict: 'same_listing',
  confidence: 0.95,
  reason: 'same program, same cohort',
  ...overrides,
});

function fakePool(
  chainRows = [{ id: 4200, status: 'approved', duplicate_of_id: null, depth: 2, cycle: false }],
  options = {},
) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [], rowCount: 0 };
    if (/WHERE id = ANY\(\$1::bigint\[\]\)/.test(sql)) {
      const candidateStatus = options.currentCandidateStatus
        || (chainRows[0]?.id === 8572 && chainRows[0]?.depth === 0 ? chainRows[0].status : 'duplicate');
      const rows = options.lockedRows || [
        { id: TARGET.id, status: options.targetStatus || 'queued', duplicate_of_id: null },
        { id: 8572, status: candidateStatus, duplicate_of_id: candidateStatus === 'duplicate' ? 8416 : null },
      ];
      return { rows, rowCount: rows.length };
    }
    if (/WITH RECURSIVE duplicate_chain/.test(sql)) {
      return { rows: chainRows, rowCount: chainRows.length };
    }
    if (/WHERE id = \$1\s+FOR UPDATE/.test(sql)) {
      const row = options.parentRow || {
        id: chainRows[0]?.id,
        status: chainRows[0]?.status,
        duplicate_of_id: chainRows[0]?.duplicate_of_id ?? null,
      };
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (/UPDATE seen_urls/.test(sql)) return { rows: [], rowCount: 1 };
    if (/UPDATE scan_entries/.test(sql)) {
      const rowCount = options.updateRowCount ?? 1;
      return { rows: rowCount ? [{ id: params?.[0] ?? 1 }] : [], rowCount };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release: () => calls.push({ sql: 'RELEASE', params: [] }) };
  return {
    calls,
    query,
    async connect() { return client; },
  };
}

test('same_listing resolves a multi-hop duplicate chain to the terminal row atomically', async () => {
  const pool = fakePool([{ id: 4200, status: 'approved', duplicate_of_id: null, depth: 2, cycle: false }]);
  const out = await applyVerdict(pool, TARGET, [candidate()], verdict());

  assert.equal(out, 'duplicate');
  assert.ok(pool.calls.some(call => call.sql === 'BEGIN'));
  assert.ok(pool.calls.some(call => /WITH RECURSIVE duplicate_chain/.test(call.sql)));
  const update = pool.calls.find(call => /SET status = 'duplicate'/.test(call.sql));
  assert.equal(update.params[1], 4200);
  assert.match(update.params[2], /resolved 2 hops to canonical #4200/);
  assert.match(update.sql, /parent\.duplicate_of_id IS NULL/);
  const registryUpdate = pool.calls.find(call => /UPDATE seen_urls/.test(call.sql));
  assert.deepEqual(registryUpdate.params, [TARGET.id, 4200]);
  assert.ok(pool.calls.some(call => call.sql === 'COMMIT'));
});

test('candidate state is re-read after verdict instead of trusting the stale snapshot', async () => {
  const pool = fakePool(
    [{ id: 4200, status: 'approved', duplicate_of_id: null, depth: 1, cycle: false }],
    { currentCandidateStatus: 'duplicate' },
  );
  const out = await applyVerdict(pool, TARGET, [candidate({ status: 'approved' })], verdict());

  assert.equal(out, 'duplicate');
  assert.ok(pool.calls.some(call => /WITH RECURSIVE duplicate_chain/.test(call.sql)));
  const update = pool.calls.find(call => /SET status = 'duplicate'/.test(call.sql));
  assert.equal(update.params[1], 4200);
});

test('self-referential resolution blocks automatic demotion', async () => {
  const pool = fakePool([
    { id: TARGET.id, status: 'queued', duplicate_of_id: null, depth: 1, cycle: false },
  ]);
  const out = await applyVerdict(pool, TARGET, [candidate()], verdict());

  assert.equal(out, 'chain-unresolved');
  assert.equal(pool.calls.some(call => /SET status = 'duplicate'/.test(call.sql)), false);
  const note = pool.calls.find(call => /duplicate_chain_error/.test(call.sql));
  assert.match(note.params[1], /cycle-to-target/);
});

test('dead-end duplicate chain blocks automatic demotion and leaves an audit note', async () => {
  const pool = fakePool([{ id: 8416, status: 'duplicate', duplicate_of_id: null, depth: 1, cycle: false }]);
  const out = await applyVerdict(pool, TARGET, [candidate()], verdict());

  assert.equal(out, 'chain-unresolved');
  assert.equal(pool.calls.some(call => /SET status = 'duplicate'/.test(call.sql)), false);
  assert.ok(pool.calls.some(call => /duplicate_chain_error/.test(call.sql)));
});

test('cycle in duplicate chain blocks automatic demotion', async () => {
  const pool = fakePool([{ id: 8572, status: 'duplicate', duplicate_of_id: 8416, depth: 2, cycle: true }]);
  const resolution = await resolveDuplicateChain(pool, 8572);
  assert.deepEqual(resolution, { id: null, status: 'duplicate', depth: 2, error: 'cycle' });
});

test('approved match is validated from current database state', async () => {
  const pool = fakePool([
    { id: 8572, status: 'approved', duplicate_of_id: null, depth: 0, cycle: false },
  ]);
  const out = await applyVerdict(pool, TARGET, [candidate({ status: 'approved', resolve_to: null })], verdict());

  assert.equal(out, 'duplicate');
  assert.ok(pool.calls.some(call => /WITH RECURSIVE duplicate_chain/.test(call.sql)));
  const update = pool.calls.find(call => /SET status = 'duplicate'/.test(call.sql));
  assert.equal(update.params[1], 8572);
});

test('low-confidence same_listing only stamps metadata', async () => {
  const pool = fakePool();
  const out = await applyVerdict(pool, TARGET, [candidate()], verdict({ confidence: 0.5 }));

  assert.equal(out, 'same_listing');
  assert.equal(pool.calls.some(call => call.sql === 'BEGIN'), false);
  assert.equal(pool.calls.some(call => /SET status = 'duplicate'/.test(call.sql)), false);
});

test('compare-and-set loss reports stale instead of claiming a mutation', async () => {
  const pool = fakePool(
    [{ id: 8572, status: 'approved', duplicate_of_id: null, depth: 0, cycle: false }],
    { updateRowCount: 0 },
  );
  const out = await applyVerdict(pool, TARGET, [candidate({ status: 'approved' })], verdict());
  assert.equal(out, 'stale');
  assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK'));
});
