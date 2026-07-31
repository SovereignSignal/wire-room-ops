require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { findSeenUrls } = require('../src/db');

test('findSeenUrls returns the ORIGINAL urls whose normalized form is known', async () => {
  const pool = {
    query: async (_sql, params) => {
      assert.ok(Array.isArray(params[0]), 'first param is the normalized url array');
      assert.equal(params[1], 'ai');
      // Pretend the normalized form of the first url is already seen.
      return { rows: [{ normalized_url: params[0][0] }] };
    },
  };
  const seen = await findSeenUrls(pool, ['https://Example.org/Grant?utm_source=x', 'https://other.org/b'], 'ai');
  assert.ok(seen.has('https://Example.org/Grant?utm_source=x'), 'original casing/query preserved in the returned set');
  assert.equal(seen.has('https://other.org/b'), false);
});

test('findSeenUrls short-circuits on an empty list without querying', async () => {
  let called = false;
  const pool = { query: async () => { called = true; return { rows: [] }; } };
  const seen = await findSeenUrls(pool, [], 'ai');
  assert.equal(seen.size, 0);
  assert.equal(called, false);
});

test('findSeenUrls maps one normalized hit back to every original that shares it', async () => {
  const pool = { query: async (_sql, params) => ({ rows: [{ normalized_url: params[0][0] }] }) };
  // Two urls differing only by tracking params normalize to the same key.
  const seen = await findSeenUrls(pool, ['https://x.org/a?utm_source=1', 'https://x.org/a?utm_source=2'], 'oss');
  assert.equal(seen.size, 2, 'both originals are dropped when their shared normalized form is seen');
});
