require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { checkDuplicate } = require('../src/services/dedup');

function statusSet(sql) {
  const match = sql.match(/status IN \(([^)]+)\)/);
  assert.ok(match, `expected a status filter in SQL: ${sql}`);
  return match[1].match(/'([^']+)'/g).map((value) => value.slice(1, -1)).sort();
}

function stubPool(responses) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      const response = responses[calls.length - 1];
      if (!response) throw new Error(`unexpected query #${calls.length}: ${sql}`);
      return typeof response === 'function' ? response(sql, params) : response;
    },
  };
}

test('exact URL dedupe blocks raw, queued, wire-approved, program-approved, and rejected history equally', async () => {
  const pool = stubPool([{
    rows: [{
      first_seen_entry_id: 41,
      name: 'Known Program',
      url: 'https://example.org/program',
    }],
  }]);

  const result = await checkDuplicate(pool, {
    sourceUrl: 'https://example.org/program',
    name: 'Known Program',
    wire: 'oss',
  });

  assert.equal(result.isDuplicate, true);
  assert.deepEqual(statusSet(pool.calls[0].sql), ['approved', 'declined', 'queued', 'raw']);
  assert.doesNotMatch(pool.calls[0].sql, /distributable/i, 'quiet approvals differ only by distributable and must remain in history');
  assert.doesNotMatch(pool.calls[0].sql, /'archived'/, 'automated archived junk remains eligible for reconsideration');
});

test('exact name dedupe has the same reviewed-history status policy as exact URL dedupe', async () => {
  const pool = stubPool([
    { rows: [] },
    { rows: [{ id: 42, name: 'Known Program' }] },
  ]);

  const result = await checkDuplicate(pool, {
    sourceUrl: 'https://different.example/program',
    name: 'Known Program',
    wire: 'oss',
  });

  assert.equal(result.isDuplicate, true);
  assert.deepEqual(statusSet(pool.calls[0].sql), ['approved', 'declined', 'queued', 'raw']);
  assert.deepEqual(statusSet(pool.calls[1].sql), ['approved', 'declined', 'queued', 'raw']);
  assert.doesNotMatch(pool.calls[1].sql, /distributable/i);
});

test('quiet approval remains an approved decision while only disabling distribution', () => {
  const actions = fs.readFileSync(path.join(__dirname, '..', 'src/services/entry-actions.ts'), 'utf8');
  assert.match(actions, /approve:\s*'approved'/);
  assert.match(actions, /const distributable = opts\.quiet \? false : true;/);
});
