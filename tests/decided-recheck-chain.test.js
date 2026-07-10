require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyVerdict, resolveDuplicateChain } = require('../src/jobs/decided-recheck');

function fakePool(chainRows = [{ id: 4200, status: 'approved', duplicate_of_id: null, depth: 2, cycle: false }]) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/WITH RECURSIVE duplicate_chain/.test(sql)) {
        return { rows: chainRows, rowCount: chainRows.length };
      }
      return { rows: [{ id: params?.[0] ?? 1 }], rowCount: 1 };
    },
  };
}

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

test('same_listing resolves a multi-hop duplicate chain to the terminal row', async () => {
  const pool = fakePool([{ id: 4200, status: 'approved', duplicate_of_id: null, depth: 2, cycle: false }]);
  const out = await applyVerdict(pool, TARGET, [candidate()], verdict());

  assert.equal(out, 'duplicate');
  assert.equal(pool.calls.length, 2);
  assert.match(pool.calls[0].sql, /WITH RECURSIVE duplicate_chain/);
  assert.match(pool.calls[1].sql, /SET status = 'duplicate'/);
  assert.equal(pool.calls[1].params[1], 4200);
  assert.match(pool.calls[1].params[2], /resolved 2 hops to canonical #4200/);
  assert.match(pool.calls[1].sql, /action_reason/);
  assert.match(pool.calls[1].sql, /RETURNING id/);
});

test('dead-end duplicate chain blocks automatic demotion and leaves an audit note', async () => {
  const pool = fakePool([{ id: 8416, status: 'duplicate', duplicate_of_id: null, depth: 1, cycle: false }]);
  const out = await applyVerdict(pool, TARGET, [candidate()], verdict());

  assert.equal(out, 'chain-unresolved');
  assert.equal(pool.calls.length, 2);
  assert.doesNotMatch(pool.calls[1].sql, /SET status = 'duplicate'/);
  assert.match(pool.calls[1].sql, /duplicate_chain_error/);
});

test('cycle in duplicate chain blocks automatic demotion', async () => {
  const pool = fakePool([{ id: 8572, status: 'duplicate', duplicate_of_id: 8416, depth: 2, cycle: true }]);
  const resolution = await resolveDuplicateChain(pool, 8572);
  assert.deepEqual(resolution, { id: null, status: 'duplicate', depth: 2, error: 'cycle' });
});

test('approved match demotes directly without a chain query', async () => {
  const pool = fakePool();
  const out = await applyVerdict(pool, TARGET, [candidate({ status: 'approved', resolve_to: null })], verdict());

  assert.equal(out, 'duplicate');
  assert.equal(pool.calls.length, 1);
  assert.equal(pool.calls[0].params[1], 8572);
});

test('low-confidence same_listing only stamps metadata', async () => {
  const pool = fakePool();
  const out = await applyVerdict(pool, TARGET, [candidate()], verdict({ confidence: 0.5 }));

  assert.equal(out, 'same_listing');
  assert.equal(pool.calls.length, 1);
  assert.doesNotMatch(pool.calls[0].sql, /SET status = 'duplicate'/);
});

test('compare-and-set loss reports stale instead of claiming a mutation', async () => {
  const pool = {
    calls: [],
    async query(sql, params) {
      this.calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
  const out = await applyVerdict(pool, TARGET, [candidate({ status: 'approved' })], verdict());
  assert.equal(out, 'stale');
});
