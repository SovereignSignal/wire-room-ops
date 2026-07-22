require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const { isUsableBdVerification } = require('../src/services/bd-verify');

test('BD verification requires explicit current reality, citation, and confidence', () => {
  const good = {
    id: 1,
    is_real: true,
    currently_active: true,
    last_activity: '2026-07-20',
    status_summary: 'Official program is accepting applications.',
    citationUrl: 'https://official.example/program',
    confidence: 'medium',
  };
  assert.equal(isUsableBdVerification(good), true);
  assert.equal(isUsableBdVerification({ ...good, is_real: false }), false);
  assert.equal(isUsableBdVerification({ ...good, citationUrl: null }), false);
  assert.equal(isUsableBdVerification({ ...good, confidence: 'low' }), false);
  assert.equal(isUsableBdVerification({ ...good, status_summary: null }), false);
});
