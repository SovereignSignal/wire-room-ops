require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { formatScoreboard } = require('../src/scripts/challenger-scoreboard');

test('formatScoreboard renders one aligned line per source with rates', () => {
  const out = formatScoreboard([
    { scan_source: 'telegram', total: 40, queued: 30, approved: 10 },
    { scan_source: 'x-list', total: 12, queued: 8, approved: 2 },
  ]);
  assert.ok(out.includes('telegram'));
  assert.ok(out.includes('x-list'));
  assert.ok(out.includes('25%')); // telegram approval rate 10/40
  assert.ok(out.split('\n').length >= 3); // header + 2 rows
});

test('formatScoreboard handles empty input', () => {
  assert.ok(formatScoreboard([]).includes('no entries'));
});
