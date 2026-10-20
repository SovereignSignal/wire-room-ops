require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeUrl, urlLookupKeys } = require('../src/utils/url');

test('urlLookupKeys starts with the stored key and covers scheme and www spellings', () => {
  const keys = urlLookupKeys('http://www.opensats.org/apply/');
  assert.equal(keys[0], normalizeUrl('http://www.opensats.org/apply/'));
  for (const spelling of ['https://opensats.org/apply', 'http://opensats.org/apply', 'https://www.opensats.org/apply']) {
    assert.ok(keys.includes(normalizeUrl(spelling)), spelling);
  }
});

test('urlLookupKeys drops browser highlights and extra tracking parameters', () => {
  assert.ok(urlLookupKeys('https://opensats.org/apply#:~:text=Apply%20now').includes('https://opensats.org/apply'));
  assert.ok(urlLookupKeys('https://opensats.org/apply#how-to:~:text=Apply').includes('https://opensats.org/apply#how-to'));
  assert.ok(urlLookupKeys('https://opensats.org/apply?srsltid=AfmBOoq&utm_id=9&mc_cid=x').includes('https://opensats.org/apply'));
  assert.ok(urlLookupKeys('https://opensats.org/apply?lang=en&srsltid=abc').includes('https://opensats.org/apply?lang=en'));
});

test('urlLookupKeys folds mobile X hosts and photo or video suffixes to the post', () => {
  const post = 'https://x.com/opensats/status/1850000000000000001';
  assert.ok(urlLookupKeys('https://mobile.twitter.com/OpenSats/status/1850000000000000001').includes(post));
  assert.ok(urlLookupKeys('https://x.com/OpenSats/status/1850000000000000001/photo/1').includes(post));
  assert.ok(urlLookupKeys('https://twitter.com/OpenSats/status/1850000000000000001/video/2').includes(post));
});

test('urlLookupKeys keeps paths, ordinary anchors, and hash routes distinct', () => {
  const a = urlLookupKeys('https://snapshot.org/#/ens.eth/proposal/0xaaa');
  assert.ok(!a.includes(normalizeUrl('https://snapshot.org/#/ens.eth/proposal/0xbbb')));
  assert.ok(!a.includes('https://snapshot.org'));
  assert.ok(!urlLookupKeys('https://nlnet.nl/funding.html#core').includes('https://nlnet.nl/funding.html#commons'));
  assert.ok(!urlLookupKeys('https://example.org/grants/round-1').includes('https://example.org/grants/round-2'));
  assert.ok(!urlLookupKeys('https://grants.example.org/apply').includes('https://example.org/apply'));
});

test('urlLookupKeys handles empty and unparseable input like normalizeUrl', () => {
  assert.deepEqual(urlLookupKeys(''), []);
  assert.deepEqual(urlLookupKeys('not a url'), [normalizeUrl('not a url')]);
  assert.equal(urlLookupKeys('https://opensats.org/apply](https://opensats.org/apply)')[0], 'https://opensats.org/apply');
});
