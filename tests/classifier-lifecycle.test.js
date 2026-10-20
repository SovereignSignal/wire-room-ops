require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildClassificationPrompt,
  parseClassificationResponse,
  shouldFinalizeProgram,
  shouldFinalizeAfterLifecycleSettle,
} = require('../src/services/classifier');

function validReply(overrides = {}) {
  return JSON.stringify({
    classification: 'GRANT',
    in_scope: true,
    wire: 'oss',
    quality_score: 78,
    operator_route: 'publish',
    score_reason: 'Credible open program with complete details.',
    reason: 'Applications are open.',
    tags: ['NLnet'],
    wire_area: '3',
    extracted: {},
    ...overrides,
  });
}

const entry = {
  name: 'Open Source Fund',
  description: 'Maintainer funding round.',
  source_url: 'https://example.org/fund',
  wire: 'oss',
  currentDate: '2026-10-20T12:00:00.000Z',
};

test('current prompt drops only the stated-date clause and asks for lifecycle', () => {
  const prompt = buildClassificationPrompt(entry);
  assert.match(prompt, /GRANT vs NEWS boundary/);
  assert.match(prompt, /applications are now open/);
  assert.doesNotMatch(prompt, /or opens on a stated date/);
  assert.doesNotMatch(prompt, /unresolved application status/);
  assert.doesNotMatch(prompt, /Evidence for downstream review/);
  assert.match(prompt, /keep classification GRANT/);
  assert.match(prompt, /"lifecycle":"open"/);
  assert.match(prompt, /"in_scope":true,"wire":"oss"/);
});

test('legacy prompt keeps the stated-date clause and does not ask for lifecycle', () => {
  const prompt = buildClassificationPrompt(entry, undefined, { variant: 'legacy' });
  assert.match(prompt, /or opens on a stated date/);
  assert.doesNotMatch(prompt, /"lifecycle":"open"/);
  assert.doesNotMatch(prompt, /keep classification GRANT/);
});

test('a forthcoming read stays GRANT so program finalisation still runs', () => {
  const result = parseClassificationResponse(validReply({
    classification: 'NEWS',
    lifecycle: 'forthcoming',
    opening_date: '2026-11-17',
    operator_route: 'decline',
  }), { currentDate: '2026-10-20' });
  assert.equal(result.classification, 'GRANT');
  assert.equal(result.lifecycle, 'forthcoming');
  assert.equal(result.openingDate, '2026-11-17');
  assert.equal(result.wireArea, '3');
  assert.equal(result.operatorRoute, 'source_check');
  assert.equal(shouldFinalizeProgram(result), true);
});

test('a future opening date forces forthcoming even when the model says open', () => {
  const result = parseClassificationResponse(validReply({
    lifecycle: 'open',
    opening_date: '2026-11-17',
  }), { currentDate: '2026-10-20' });
  assert.equal(result.classification, 'GRANT');
  assert.equal(result.lifecycle, 'forthcoming');
  assert.equal(shouldFinalizeProgram(result), true);
});

test('an opening date of today does not flip an explicit forthcoming call to open', () => {
  const result = parseClassificationResponse(validReply({
    lifecycle: 'forthcoming',
    opening_date: '2026-10-20',
  }), { currentDate: '2026-10-20T23:00:00.000Z' });
  assert.equal(result.classification, 'GRANT');
  assert.equal(result.lifecycle, 'forthcoming');
  assert.equal(result.openingDate, '2026-10-20');
});

test('a past deadline closes a forthcoming label and still finalises', () => {
  const result = parseClassificationResponse(validReply({
    lifecycle: 'forthcoming',
    opening_date: '2026-11-17',
  }), { deadlineParsed: '2026-07-01', currentDate: '2026-10-20' });
  assert.equal(result.classification, 'EXPIRED');
  assert.equal(result.lifecycle, 'closed');
  assert.equal(result.operatorRoute, 'decline');
  assert.equal(shouldFinalizeProgram(result), true);
});

test('legacy parse does not coerce NEWS plus forthcoming into GRANT', () => {
  const result = parseClassificationResponse(validReply({
    classification: 'NEWS',
    lifecycle: 'forthcoming',
    opening_date: '2026-11-17',
  }), { currentDate: '2026-10-20' }, { settleLifecycle: false });
  assert.equal(result.classification, 'NEWS');
  assert.equal(result.lifecycle, 'forthcoming');
  assert.equal(shouldFinalizeProgram(result), false);
});

test('an omitted lifecycle on a live GRANT infers open, and an invalid value does not throw', () => {
  const open = parseClassificationResponse(validReply(), { currentDate: '2026-10-20' });
  assert.equal(open.lifecycle, 'open');
  assert.equal(open.openingDate, null);
  const invalid = parseClassificationResponse(validReply({ lifecycle: 'maybe' }), { currentDate: '2026-10-20' });
  assert.equal(invalid.classification, 'GRANT');
  assert.equal(invalid.lifecycle, 'open');
});

test('off-scope noise is not coerced back to GRANT by a forthcoming label', () => {
  const result = parseClassificationResponse(validReply({
    classification: 'GRANT',
    in_scope: false,
    wire: 'off_domain',
    lifecycle: 'forthcoming',
    operator_route: 'publish',
  }));
  assert.equal(result.classification, 'NOISE');
  assert.equal(result.inScope, false);
  assert.equal(shouldFinalizeProgram(result), false);
});

test('lifecycle settlement keeps forthcoming programs and skips a promoted carrier', () => {
  const forthcoming = { inScope: true, classification: 'GRANT' };
  const news = { inScope: true, classification: 'NEWS' };
  const open = { inScope: true, classification: 'GRANT' };
  assert.equal(shouldFinalizeAfterLifecycleSettle('none', false, forthcoming), true);
  assert.equal(shouldFinalizeAfterLifecycleSettle('none', false, news), false);
  assert.equal(shouldFinalizeAfterLifecycleSettle('promote', true, open), false);
  assert.equal(shouldFinalizeAfterLifecycleSettle('promote', false, open), true);
  assert.equal(shouldFinalizeAfterLifecycleSettle('collapse', false, forthcoming), false);
});
