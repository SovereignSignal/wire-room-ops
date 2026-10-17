require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseOrgPatterns, config } = require('../src/config');
const { loadOperatorProfile } = require('../src/services/bd-qualifier');

test('parseOrgPatterns reads names and regexes, case-insensitive', () => {
  const patterns = parseOrgPatterns(' Example DAO , ^acme\\b ,, ');
  assert.equal(patterns.length, 2);
  assert.ok(patterns[0].test('example dao governance'));
  assert.ok(patterns[1].test('ACME Labs'));
  assert.equal(patterns[1].test('the acme labs'), false);
});

test('parseOrgPatterns matches an invalid regex literally and treats unset as empty', () => {
  const [literal] = parseOrgPatterns('foo(bar');
  assert.ok(literal.test('the foo(bar forum'));
  assert.deepEqual(parseOrgPatterns(undefined), []);
});

test('loadOperatorProfile prefers BD_PROFILE over the file and default', (t) => {
  const original = config.bdLeads.profile;
  t.after(() => { config.bdLeads.profile = original; });
  config.bdLeads.profile = '  Custom profile text  ';
  assert.equal(loadOperatorProfile(), 'Custom profile text');
  config.bdLeads.profile = '';
  assert.ok(loadOperatorProfile().length > 0);
});
