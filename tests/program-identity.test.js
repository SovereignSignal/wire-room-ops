require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProgramKey } = require('../src/services/program-identity');

// Real corpus variants — one program, one key.
test('normalizeProgramKey collapses round/cohort/date noise', () => {
  const variants = [
    'Anthropic Fellows Program',
    'Anthropic Fellows Program 2026',
    'Anthropic Fellows Program (Sept 2026 cohort)',
    'Anthropic Fellows Program (July 2026 cohort)',
    'Anthropic Fellows Program — May & July 2026 Cohorts',
    'Anthropic Fellows Program for AI safety research',
  ];
  const keys = new Set(variants.map(normalizeProgramKey));
  // "for AI safety research" is descriptive suffix, kept — two keys max
  assert.ok(keys.size <= 2, `expected <=2 keys, got ${[...keys].join(', ')}`);
  assert.equal(normalizeProgramKey('Anthropic Fellows Program 2026'), normalizeProgramKey('Anthropic Fellows Program (Sept 2026 cohort)'));
});

test('normalizeProgramKey strips rounds, quarters, seasons, fund numbers', () => {
  assert.equal(normalizeProgramKey('Cardano Catalyst Fund14'), normalizeProgramKey('Cardano Catalyst Fund12'));
  assert.equal(normalizeProgramKey('Uniswap Acceleration Season 3'), normalizeProgramKey('Uniswap Acceleration Season 7'));
  assert.equal(normalizeProgramKey('Zcash CDRGP Q3/Q4 2026'), normalizeProgramKey('Zcash CDRGP Q1 2027'));
  assert.equal(normalizeProgramKey('Optimism Round 8 Retro Funding'), normalizeProgramKey('Optimism Round 6 Retro Funding'));
});

test('normalizeProgramKey keeps genuinely different programs apart', () => {
  assert.notEqual(normalizeProgramKey('Arbitrum Foundation Audit Program'), normalizeProgramKey('Arbitrum Open House'));
  assert.notEqual(normalizeProgramKey('Anthropic Fellows Program'), normalizeProgramKey('Anthropic Economic Futures Initiative'));
  assert.notEqual(normalizeProgramKey('Claude Corps Fellowship'), normalizeProgramKey('Claude for Open Source'));
});

test('normalizeProgramKey handles empty/degenerate input', () => {
  assert.equal(normalizeProgramKey(''), '');
  assert.equal(normalizeProgramKey('2026'), '');
});
