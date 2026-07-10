require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { sweepSourceLinks } = require('../src/jobs/decided-recheck');

function fakeSweepPool(row, updateRowCount = 1) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT id, source_url FROM scan_entries/.test(sql)) {
        return { rows: [row], rowCount: 1 };
      }
      if (/UPDATE scan_entries SET/.test(sql)) {
        return { rows: updateRowCount ? [{ id: row.id }] : [], rowCount: updateRowCount };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

test('source sweep annotations use queued/source/metadata compare-and-set guards', async () => {
  const pool = fakeSweepPool({ id: 41, source_url: 'scan://needs-source/41' }, 0);
  const flagged = await sweepSourceLinks(pool);
  assert.equal(flagged, 0, 'a stale row must not be reported as mutated');

  const update = pool.calls.find(call => /UPDATE scan_entries SET/.test(call.sql));
  assert.match(update.sql, /status = 'queued'/);
  assert.match(update.sql, /source_url IS NOT DISTINCT FROM \$4/);
  assert.match(update.sql, /metadata -> 'source_link'/);
  assert.match(update.sql, /RETURNING id/);
  assert.equal(update.params[0], 41);
  assert.match(update.params[1], /No real source link/);
  assert.equal(update.params[2], 'placeholder');
  assert.equal(update.params[3], 'scan://needs-source/41');
});

test('source sweep safely initializes null metadata for stable canonical links', async () => {
  const pool = fakeSweepPool({ id: 42, source_url: 'https://example.com/grants/program' });
  const flagged = await sweepSourceLinks(pool);
  assert.equal(flagged, 0);

  const update = pool.calls.find(call => /UPDATE scan_entries SET/.test(call.sql));
  assert.match(update.sql, /COALESCE\(metadata, '\{\}'::jsonb\)/);
  assert.match(update.sql, /source_url IS NOT DISTINCT FROM \$3/);
  assert.deepEqual(update.params, [42, 'ok', 'https://example.com/grants/program']);
});
