require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeMonthSpend, WATCHTOWER_GROK_PURPOSE_PATTERNS } = require('../src/services/budget-guard');

test('computeMonthSpend sums grok cost + twitter reads at unit price', () => {
  // $3.20 grok + 400 tweet reads * $0.005 = $5.20
  assert.equal(computeMonthSpend(3.2, 400, 0.005), 5.2);
});

test('computeMonthSpend treats missing inputs as zero', () => {
  assert.equal(computeMonthSpend(0, 0, 0.005), 0);
  assert.equal(computeMonthSpend(null, undefined, 0.005), 0);
});

test('grok purpose patterns cover watchtower lanes and Tier 2 scan, nothing broader', () => {
  assert.deepEqual(WATCHTOWER_GROK_PURPOSE_PATTERNS, ['watchtower%', 'scan']);
});
