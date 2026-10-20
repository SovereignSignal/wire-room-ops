require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkDuplicate, registerSeenInTransaction, promoteOpenCall } = require('../src/services/dedup');

function stubPool(responses) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      const responder = responses[calls.length - 1];
      if (!responder) throw new Error(`unexpected query #${calls.length}: ${sql}`);
      return typeof responder === 'function' ? responder(sql, params) : responder;
    },
  };
}

function connected(responses) {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      const responder = responses[calls.length - 1];
      if (!responder) throw new Error(`unexpected query #${calls.length}: ${sql}`);
      return typeof responder === 'function' ? responder(sql, params) : responder;
    },
    release() {},
  };
  return { calls, connect: async () => client };
}

const URL = 'https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/HORIZON-BRIDGING-2027-01-13';

test('a forthcoming URL is not a duplicate and does not query siblings', async () => {
  const pool = stubPool([
    { rows: [{
      first_seen_entry_id: 19856,
      name: 'HORIZON-BRIDGING-2027-01-13',
      url: URL,
      deadline: '2027-02-16',
      deadline_parsed: '2027-02-16',
      status: 'queued',
      lifecycle: 'forthcoming',
    }] },
  ]);
  const result = await checkDuplicate(pool, {
    sourceUrl: URL,
    name: 'HORIZON-BRIDGING-2027-01-13',
    wire: 'ai',
    excludeEntryId: 21000,
  });
  assert.equal(result.isDuplicate, false);
  assert.equal(result.lifecyclePromotion.entryId, 19856);
  assert.equal(pool.calls.length, 1);
});

test('an exact-name forthcoming call yields instead of name_exact', async () => {
  const pool = stubPool([
    { rows: [] },
    { rows: [{ id: 19921, name: 'HORIZON-BRIDGING-2027-01-12', lifecycle: 'forthcoming' }] },
  ]);
  const result = await checkDuplicate(pool, {
    sourceUrl: 'https://example.org/other-horizon-page',
    name: 'HORIZON-BRIDGING-2027-01-12',
    wire: 'ai',
    excludeEntryId: 21001,
  });
  assert.equal(result.isDuplicate, false);
  assert.equal(result.matchType, null);
  assert.equal(result.lifecyclePromotion.entryId, 19921);
});

test('registerSeen does not treat a forthcoming URL owner as a conflict', async () => {
  const pool = stubPool([
    { rowCount: 0, rows: [] },
    { rows: [{
      first_seen_entry_id: 19856,
      name: 'HORIZON-BRIDGING-2027-01-13',
      status: 'queued',
      lifecycle: 'forthcoming',
      deadline: null,
      deadline_parsed: null,
    }] },
    { rowCount: 1, rows: [] },
  ]);
  const result = await registerSeenInTransaction(pool, {
    id: 21000,
    sourceUrl: URL,
    name: 'HORIZON-BRIDGING-2027-01-13',
    wire: 'ai',
    scanDate: '2026-10-20',
  });
  assert.equal(result.urlConflict, false);
  assert.equal(result.lifecyclePromotion.entryId, 19856);
  assert.match(pool.calls[2].sql, /seen_names/);
});

test('promoteOpenCall archives the carrier and opens the forthcoming owner', async () => {
  const pool = connected([
    { rows: [], rowCount: null },
    { rows: [], rowCount: null },
    { rows: [{ id: 19856, status: 'queued' }], rowCount: 1 },
    { rows: [{ id: 21000 }], rowCount: 1 },
    { rows: [], rowCount: null },
  ]);
  const result = await promoteOpenCall(pool, {
    ownerId: 19856,
    sourceId: 21000,
    openingDate: '2026-10-21',
    expectedStatus: 'queued',
    sourceUrl: URL,
  });
  assert.equal(result.promoted, true);
  const owner = pool.calls[2];
  const carrier = pool.calls[3];
  assert.match(owner.sql, /lifecycle = 'open'/);
  assert.match(owner.sql, /lifecycle = 'forthcoming'/);
  assert.match(carrier.sql, /status = 'archived'/);
  assert.doesNotMatch(carrier.sql, /status = 'duplicate'/);
  assert.match(pool.calls[4].sql, /COMMIT/);
});

test('promoteOpenCall rolls back when the owner is no longer forthcoming', async () => {
  const pool = connected([
    { rows: [], rowCount: null },
    { rows: [], rowCount: null },
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: null },
  ]);
  const result = await promoteOpenCall(pool, {
    ownerId: 19856,
    sourceId: 21000,
    openingDate: null,
    expectedStatus: 'queued',
    sourceUrl: URL,
  });
  assert.equal(result.promoted, false);
  assert.match(pool.calls[3].sql, /ROLLBACK/);
  assert.equal(pool.calls.length, 4);
});
