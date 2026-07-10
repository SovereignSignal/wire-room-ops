require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

// Unit tests (fake pool, no DB) for applyVerdict's duplicate-chain
// resolution: a same_listing match against a row that is ITSELF a duplicate
// must resolve through resolve_to (duplicate_of_id) and still demote —
// this exact gap let a 0.95-confidence dupe reach the digest on 2026-07-09
// (entry #11127 matched #8572 which was already a duplicate).
const { applyVerdict } = require('../src/jobs/decided-recheck');

function fakePool() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
}

const TARGET = { id: 11127, name: 'Anthropic Fellows Program (Sept 2026 cohort)', source_url: 'https://job-boards.greenhouse.io/anthropic/jobs/1' };

function candidate(overrides = {}) {
  return {
    id: 8572, name: 'Anthropic Fellows Program', status: 'duplicate',
    source_url: 'https://alignment.anthropic.com/x', decided_date: '2026-06-08',
    resolve_to: 4200, overlap: 3, domain_match: true, squash_match: true,
    ...overrides,
  };
}

test('same_listing vs a duplicate-status match resolves the chain and demotes to the canonical id', async () => {
  const pool = fakePool();
  const out = await applyVerdict(pool, TARGET, [candidate()], { matched_id: 8572, verdict: 'same_listing', confidence: 0.95, reason: 'same program, new cohort framing' });

  assert.equal(out, 'duplicate');
  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].sql, /SET status = 'duplicate'/);
  assert.equal(pool.calls[0].params[1], 4200, 'duplicate_of_id must be the resolved canonical entry, not the duplicate row');
  assert.match(pool.calls[0].params[2], /canonical #4200/);
});

test('same_listing vs a duplicate-status match with no resolve_to falls back to the matched id', async () => {
  const pool = fakePool();
  const out = await applyVerdict(pool, TARGET, [candidate({ resolve_to: null })], { matched_id: 8572, verdict: 'same_listing', confidence: 0.9, reason: 'r' });

  assert.equal(out, 'duplicate');
  assert.equal(pool.calls[0].params[1], 8572);
});

test('same_listing vs an approved match still demotes to the matched id directly', async () => {
  const pool = fakePool();
  const out = await applyVerdict(pool, TARGET, [candidate({ status: 'approved', resolve_to: null })], { matched_id: 8572, verdict: 'same_listing', confidence: 0.9, reason: 'r' });

  assert.equal(out, 'duplicate');
  assert.equal(pool.calls[0].params[1], 8572);
  assert.ok(!/canonical #/.test(pool.calls[0].params[2]), 'no chain note when no chain was resolved');
});

test('low-confidence same_listing still only stamps metadata', async () => {
  const pool = fakePool();
  const out = await applyVerdict(pool, TARGET, [candidate()], { matched_id: 8572, verdict: 'same_listing', confidence: 0.5, reason: 'unsure' });

  assert.equal(out, 'same_listing');
  assert.ok(!/SET status = 'duplicate'/.test(pool.calls[0].sql), 'below-threshold verdicts must not demote');
});
