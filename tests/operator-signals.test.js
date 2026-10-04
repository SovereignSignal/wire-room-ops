require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  includeOperatorSignalRow,
  isScopeDeclineReason,
  operatorSignalQuery,
  SIGNAL_DECISION_CUTOFF,
} = require('../src/services/operator-signals');

test('operator signals ignore decisions before 2026-10-04 and scope-reason declines', () => {
  const query = operatorSignalQuery('crypto');
  assert.equal(SIGNAL_DECISION_CUTOFF, '2026-10-04');
  assert.match(query.sql, /decision_at/);
  assert.doesNotMatch(query.sql, /created_at >=/);
  assert.equal(query.params[query.params.length - 1], '2026-10-04');
  assert.match(query.sql, /award/);
  assert.match(query.sql, /governance/);

  assert.equal(isScopeDeclineReason('award / recipient slate, not an open call'), true);
  assert.equal(isScopeDeclineReason('governance proposal / treasury vote'), true);
  assert.equal(isScopeDeclineReason('not-open: applications are closed'), true);
  assert.equal(isScopeDeclineReason('not an open call'), true);
  assert.equal(isScopeDeclineReason('scam token promoter'), false);

  const onCutoff = '2026-10-04T00:00:00.000Z';
  assert.equal(includeOperatorSignalRow({
    status: 'declined', decision_at: '2026-09-30T23:00:00.000Z', action_reason: 'scam',
  }), false);
  assert.equal(includeOperatorSignalRow({
    status: 'declined', decision_at: onCutoff, action_reason: 'award / recipient slate, not an open call',
  }), false);
  assert.equal(includeOperatorSignalRow({
    status: 'declined', decision_at: onCutoff, action_reason: 'governance proposal',
  }), false);
  assert.equal(includeOperatorSignalRow({
    status: 'declined', decision_at: onCutoff, action_reason: 'not an open call',
  }), false);
  assert.equal(includeOperatorSignalRow({
    status: 'declined', decision_at: onCutoff, action_reason: 'scam token promoter',
  }), true);
  assert.equal(includeOperatorSignalRow({
    status: 'approved', decision_at: onCutoff, action_reason: 'award note on an approval',
  }), true);
  assert.equal(includeOperatorSignalRow({
    status: 'declined', decision_at: null, action_reason: 'scam',
  }), false);
});
