require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { foldedNameKey } = require('../src/services/dedup');

test('foldedNameKey ignores punctuation, quotes, dashes, and spacing', () => {
  const key = foldedNameKey('OpenSats — General Fund');
  assert.equal(key, 'opensats general fund');
  assert.equal(foldedNameKey('OpenSats: General Fund'), key);
  assert.equal(foldedNameKey('  opensats - general   fund. '), key);
  assert.equal(
    foldedNameKey('(Why) we’re launching the next cohort of Generator '),
    foldedNameKey("(Why) we're launching the next cohort of Generator"),
  );
  assert.equal(
    foldedNameKey('Public RFP | Research on Cardano’s utxoCostPerByte Parameter'),
    foldedNameKey("Public RFP: Research on Cardano's utxoCostPerByte Parameter"),
  );
});

test('foldedNameKey never drops letters, digits, or short names', () => {
  assert.notEqual(foldedNameKey('Fondation Ñ Grants'), foldedNameKey('Fondation Grants'));
  assert.notEqual(foldedNameKey('Gitcoin Grants Round 24'), foldedNameKey('Gitcoin Grants Round 25'));
  assert.equal(foldedNameKey('C++ Fund'), null);
  assert.equal(foldedNameKey('Grants'), null);
  assert.equal(foldedNameKey(''), null);
});
