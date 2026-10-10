require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { formatScoreboard } = require('../src/scripts/challenger-scoreboard');

test('formatScoreboard renders one aligned line per source with rates', () => {
  const out = formatScoreboard([
    { scan_source: 'telegram', total: 40, queued: 20, approved: 10, declined: 10 },
    { scan_source: 'x-list', total: 12, queued: 8, approved: 2, declined: 0 },
  ]);
  assert.ok(out.includes('telegram'));
  assert.ok(out.includes('x-list'));
  assert.ok(out.includes('reviewed'));
  // 10 approved and 10 declined is 50% of decided rows, not 10/40 of every row.
  assert.ok(out.includes('50%'));
  assert.ok(!out.includes('25%'));
  assert.ok(out.split('\n').length >= 3); // header + 2 rows
});

test('formatScoreboard handles empty input', () => {
  assert.ok(formatScoreboard([]).includes('no entries'));
});
