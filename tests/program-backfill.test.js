require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { clusterByKey, resolveChainSafe } = require('../src/scripts/program-backfill');

test('clusterByKey groups by normalized program key and skips empty keys', () => {
  const rows = [
    { id: 1, name: 'Anthropic Fellows Program', status: 'approved' },
    { id: 2, name: 'Anthropic Fellows Program 2026', status: 'duplicate' },
    { id: 3, name: 'NLnet Open Call', status: 'queued' },
    { id: 4, name: '2026', status: 'archived' }, // degenerate → skipped
  ];
  const clusters = clusterByKey(rows);
  const sizes = [...clusters.values()].map(v => v.length).sort();
  assert.deepEqual(sizes, [1, 2]);
});

test('resolveChainSafe: flat chains, deep chains, cycles (real corpus fixture 8804<->8771), orphans', () => {
  const ptr = new Map([
    [10, null],          // canonical
    [11, 10], [12, 11],  // depth 2
    [8804, 8771], [8771, 8804], // the real mutual cycle
    [99, 100],           // dangling pointer to unknown id
  ]);
  assert.equal(resolveChainSafe(ptr, 12), 10);
  assert.equal(resolveChainSafe(ptr, 10), 10);
  assert.equal(resolveChainSafe(ptr, 8804), 8771, 'cycle resolves to smallest member');
  assert.equal(resolveChainSafe(ptr, 8771), 8771);
  assert.equal(resolveChainSafe(ptr, 99), 100, 'dangling pointer resolves to its target');
});
