require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCuratorStamp } = require('../src/services/curator');

test('buildCuratorStamp builds a normalized stamp from valid input', () => {
  const s = buildCuratorStamp(
    { route: 'PUBLISH', confidence: 'High', rationale: 'Open grant, official source', by: 'stringer' },
    '2026-06-24T00:00:00.000Z',
  );
  assert.equal(s.route, 'publish');
  assert.equal(s.confidence, 'high');
  assert.equal(s.rationale, 'Open grant, official source');
  assert.equal(s.by, 'stringer');
  assert.equal(s.at, '2026-06-24T00:00:00.000Z');
});

test('buildCuratorStamp defaults by to "curator" when omitted', () => {
  const s = buildCuratorStamp({ route: 'park', confidence: 'low' }, '2026-06-24T00:00:00.000Z');
  assert.equal(s.by, 'curator');
  assert.equal(s.rationale, '');
});

test('buildCuratorStamp rejects an invalid route', () => {
  assert.throws(() => buildCuratorStamp({ route: 'maybe', confidence: 'high' }), /Invalid (curator )?route/i);
});

test('buildCuratorStamp rejects an invalid confidence', () => {
  assert.throws(() => buildCuratorStamp({ route: 'park', confidence: 'meh' }), /Invalid confidence/i);
});
