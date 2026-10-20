require('ts-node/register/transpile-only');

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitApprovalDelivery } = require('../src/services/entry-actions');

test('splitApprovalDelivery keeps forthcoming rows off the send set', () => {
  const rows = [
    { id: 1, lifecycle: 'open' },
    { id: 2, lifecycle: 'forthcoming' },
    { id: 3, lifecycle: null },
    { id: 4 },
  ];
  const delivery = splitApprovalDelivery(rows);
  assert.deepEqual(delivery.send.map(row => row.id), [1, 3, 4]);
  assert.deepEqual(delivery.hold.map(row => row.id), [2]);
});

test('send paths skip lifecycle forthcoming and an approval writes a hold', () => {
  const root = path.join(__dirname, '../src');
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  const actions = read('services/entry-actions.ts');
  const distribution = read('services/distribution.ts');
  const queue = read('services/publication-queue.ts');
  const db = read('db/index.ts');
  const pace = read('services/distribution-pace.ts');
  assert.match(actions, /lifecycle IS DISTINCT FROM 'forthcoming'/);
  assert.match(actions, /Forthcoming call; held from sending/);
  assert.match(actions, /available_at = NOW\(\)/);
  assert.match(distribution, /lifecycle IS DISTINCT FROM 'forthcoming'/);
  assert.match(queue, /lifecycle IS DISTINCT FROM 'forthcoming'/);
  assert.match(db, /lifecycle IS DISTINCT FROM 'forthcoming'/);
  assert.match(pace, /lifecycle IS DISTINCT FROM 'forthcoming'/);
  assert.match(pace, /Forthcoming call; held from sending/);
});
