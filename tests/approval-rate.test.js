require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewedApprovalRate } = require('../src/services/approval-rate');

test('reviewed approval rate ignores rows that were not decided', () => {
  assert.equal(reviewedApprovalRate(2, 8), 0.2);
  assert.equal(reviewedApprovalRate(1, 0), 1);
  assert.equal(reviewedApprovalRate(0, 4), 0);
  assert.equal(reviewedApprovalRate(0, 0), null);
  assert.equal(reviewedApprovalRate(1, 2), 0.333);
});
