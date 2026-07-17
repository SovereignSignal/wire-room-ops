require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  clusterByKey,
  resolveChainSafe,
  chainActionFor,
  isSyntheticTestName,
  selectEligibleClusters,
  chunkClusters,
} = require('../src/scripts/program-backfill');

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

test('synthetic test exclusion preserves legitimate programs containing Test', () => {
  assert.equal(isSyntheticTestName('Test'), true);
  assert.equal(isSyntheticTestName(' Test Program'), true);
  assert.equal(isSyntheticTestName('Testnet Grants'), false);
  assert.equal(isSyntheticTestName('Mantle Turing Test'), false);
  assert.equal(isSyntheticTestName('OAI Resilience Test'), false);

  const clusters = clusterByKey([
    { id: 1, name: 'Test Program', status: 'approved' },
    { id: 2, name: 'Test Program 2026', status: 'duplicate' },
    { id: 3, name: 'Mantle Turing Test', status: 'approved' },
    { id: 4, name: 'Real Program', status: 'queued' },
    { id: 5, name: 'Real Program 2026', status: 'queued' },
    { id: 6, name: 'Undecided Singleton', status: 'queued' },
  ]);
  const eligibleNames = selectEligibleClusters(clusters).flatMap(([, members]) => members.map(m => m.name));
  assert.equal(eligibleNames.includes('Test Program'), false);
  assert.equal(eligibleNames.includes('Mantle Turing Test'), true);
  assert.equal(eligibleNames.includes('Real Program'), true);
  assert.equal(eligibleNames.includes('Undecided Singleton'), false);
});

test('chunkClusters partitions work into resumable model-sized batches', () => {
  const chunks = chunkClusters(Array.from({ length: 45 }, (_, i) => i));
  assert.deepEqual(chunks.map(chunk => chunk.length), [20, 20, 5]);
  assert.throws(() => chunkClusters([1], 0), /at least 1/);
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

test('chainActionFor: cycle canonical gets cleared, partner repointed, healthy chains untouched', () => {
  const ptr = new Map([[8804, 8771], [8771, 8804], [10, null], [11, 10], [12, 11]]);
  assert.deepEqual(chainActionFor(ptr, { id: 8771, duplicate_of_id: 8804 }), { action: 'clear' });
  assert.deepEqual(chainActionFor(ptr, { id: 8804, duplicate_of_id: 8771 }), { action: 'none' }, '8804 already points at the resolved canonical 8771');
  assert.deepEqual(chainActionFor(ptr, { id: 12, duplicate_of_id: 11 }), { action: 'repoint', to: 10 });
  assert.deepEqual(chainActionFor(ptr, { id: 11, duplicate_of_id: 10 }), { action: 'none' });
  assert.deepEqual(chainActionFor(ptr, { id: 77, duplicate_of_id: null }), { action: 'orphan' });
});
