require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkDuplicate } = require('../src/services/dedup');

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

test('checkDuplicate flags same-name entry arriving from a different source URL', async () => {
  const pool = stubPool([
    { rows: [] }, // seen_urls: different URL, no match
    { rows: [{ id: 77, name: 'Filecoin PropGF Batch 3' }] }, // scan_entries exact-name match
  ]);

  const result = await checkDuplicate(pool, {
    sourceUrl: 'https://x.com/FilFoundation/status/2060424226209771724',
    name: 'Filecoin PropGF Batch 3',
    wire: 'crypto',
  });

  assert.equal(result.isDuplicate, true);
  assert.equal(result.matchType, 'name_exact');
  assert.equal(result.matchedEntryId, 77);
  assert.equal(result.matchedEntryName, 'Filecoin PropGF Batch 3');
});

test('checkDuplicate name layer compares case-insensitively and trims', async () => {
  const pool = stubPool([
    { rows: [] },
    (sql, params) => {
      assert.match(sql, /lower\(btrim\(name\)\)/);
      assert.equal(params[0], 'mantle turing test hackathon');
      assert.equal(params[1], 'crypto');
      return { rows: [{ id: 9, name: 'Mantle Turing Test Hackathon' }] };
    },
  ]);

  const result = await checkDuplicate(pool, {
    sourceUrl: 'https://mantle.xyz/hackathon',
    name: '  MANTLE Turing Test Hackathon ',
    wire: 'crypto',
  });

  assert.equal(result.isDuplicate, true);
  assert.equal(result.matchType, 'name_exact');
});

test('checkDuplicate name layer blocks on declined copies but not archived junk', async () => {
  const pool = stubPool([
    { rows: [] },
    (sql) => {
      assert.match(sql, /'declined'/);
      assert.doesNotMatch(sql, /'archived'/);
      return { rows: [] };
    },
  ]);

  const result = await checkDuplicate(pool, {
    sourceUrl: 'https://example.org/grant',
    name: 'Some Program',
    wire: 'oss',
  });

  assert.equal(result.isDuplicate, false);
});

test('checkDuplicate passes when neither URL nor name matches', async () => {
  const pool = stubPool([{ rows: [] }, { rows: [] }]);

  const result = await checkDuplicate(pool, {
    sourceUrl: 'https://example.org/new-grant',
    name: 'Entirely New Program',
    wire: 'ai',
  });

  assert.equal(result.isDuplicate, false);
  assert.equal(pool.calls.length, 2);
});

test('checkDuplicate URL match still short-circuits before the name layer', async () => {
  const pool = stubPool([
    {
      rows: [{
        first_seen_entry_id: 123,
        name: 'GOAT AI Builder Grants Program',
        url: 'https://goat.network/grants',
      }],
    },
  ]);

  const result = await checkDuplicate(pool, {
    sourceUrl: 'https://goat.network/grants',
    name: 'GOAT AI Builder Grants Program',
    wire: 'crypto',
  });

  assert.equal(result.isDuplicate, true);
  assert.equal(result.matchType, 'url_exact');
  assert.equal(pool.calls.length, 1);
});

test('checkDuplicate with urlOnly skips the exact-name layer (link-only intake dedup)', async () => {
  const pool = stubPool([
    { rows: [] }, // seen_urls: this exact link has not been seen
    { rows: [{ id: 55, name: 'Celo Prezenti Season 2 Grants' }] }, // name layer — must NOT run
  ]);

  const result = await checkDuplicate(
    pool,
    {
      sourceUrl: 'https://x.com/prezenti_grants/status/2069145678228447522',
      name: 'Celo Prezenti Season 2 Grants',
      wire: 'crypto',
    },
    180,
    { urlOnly: true },
  );

  assert.equal(result.isDuplicate, false, 'identical name from a different link must NOT dedup under urlOnly');
  assert.equal(pool.calls.length, 1, 'only the URL layer should run when urlOnly is set');
});
