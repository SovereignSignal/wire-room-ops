require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { qualifiesAsDigestOrg, normalizeDigestOrg } = require('../src/services/digest-orgs');

test('rejects bare owner/repo handles', () => {
  assert.equal(qualifiesAsDigestOrg('crafter-station/petdex', { mentionCount: 5, hasLink: true }), false);
  assert.equal(qualifiesAsDigestOrg('orhun', { mentionCount: 1, hasLink: true }), false);
});

test('accepts a named org with >=2 mentions', () => {
  assert.equal(qualifiesAsDigestOrg('Anthropic', { mentionCount: 2, hasLink: false }), true);
});

test('accepts a named org with a resolvable link even at 1 mention', () => {
  assert.equal(qualifiesAsDigestOrg('MiniMax', { mentionCount: 1, hasLink: true }), true);
});

test('rejects a single-mention org with no link', () => {
  assert.equal(qualifiesAsDigestOrg('SomeStartup', { mentionCount: 1, hasLink: false }), false);
});

test('rejects empty/whitespace/junk', () => {
  assert.equal(qualifiesAsDigestOrg('', { mentionCount: 9, hasLink: true }), false);
  assert.equal(qualifiesAsDigestOrg('   ', { mentionCount: 9, hasLink: true }), false);
});

test('normalizeDigestOrg trims and collapses whitespace', () => {
  assert.equal(normalizeDigestOrg('  Anthropic  '), 'Anthropic');
  assert.equal(normalizeDigestOrg('huggingface-org'), 'huggingface-org');
});
