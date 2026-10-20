require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

// Pins two data warts observed in the 2026-07-09 digest smoke:
//   deadline column carrying its own label ("deadline 2026-07-12")
//   duration mistaken for an amount ("3 m")
const { sanitizeResult } = require('../src/services/intake');

function base(overrides = {}) {
  return {
    name: 'Some Grant Program',
    description: 'A sufficiently long description of the program for testing.',
    amount: null,
    deadline: null,
    sourceUrl: 'https://example.org/grant',
    ...overrides,
  };
}

test('sanitizeResult strips a leading deadline/due label from the deadline value', () => {
  assert.equal(sanitizeResult(base({ deadline: 'deadline 2026-07-12' })).deadline, '2026-07-12');
  assert.equal(sanitizeResult(base({ deadline: 'Due: 2026-07-20' })).deadline, '2026-07-20');
  assert.equal(sanitizeResult(base({ deadline: '2026-07-27' })).deadline, '2026-07-27');
});

test('sanitizeResult leaves a percentage or share commitment null with a note', () => {
  const sanitized = sanitizeResult(base({
    amount: '5% share commitment',
    metadata: { fit_score: 3 },
  }));
  assert.equal(sanitized.amount, null);
  assert.equal(sanitized.metadata.fit_score, 3);
  assert.match(sanitized.metadata.amount_note, /5% share commitment/);
  assert.match(sanitized.metadata.amount_note, /Not stored as a USD amount/);
  assert.equal(sanitizeResult(base({ amount: '$2M pool' })).metadata, undefined);
});

test('sanitizeResult discards bare duration strings mistaken for amounts', () => {
  assert.equal(sanitizeResult(base({ amount: '3 m' })).amount, null);
  assert.equal(sanitizeResult(base({ amount: '4 months' })).amount, null);
  assert.equal(sanitizeResult(base({ amount: '$2M pool' })).amount, '$2M pool');
  assert.equal(sanitizeResult(base({ amount: '10M OP' })).amount, '10M OP');
});
