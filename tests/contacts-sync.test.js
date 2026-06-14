require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

// Unit test for the Notion-X-URL → handle parser used by the contacts sync.
// The reconcile itself is DB-integration tested in CI via the admin endpoint;
// this pins the join-key extraction (handle from the X URL).
const { handleFromXUrl, shouldWatchContact } = require('../src/jobs/contacts-sync');

test('watches normal/approved/blank statuses', () => {
  assert.equal(shouldWatchContact('Monitored'), true);
  assert.equal(shouldWatchContact('Approved'), true);
  assert.equal(shouldWatchContact(''), true);
  assert.equal(shouldWatchContact(null), true);
});

test('does NOT watch Skip or Needs Review (any case)', () => {
  assert.equal(shouldWatchContact('Skip'), false);
  assert.equal(shouldWatchContact('skip'), false);
  assert.equal(shouldWatchContact('Needs Review'), false);
  assert.equal(shouldWatchContact('needs review'), false);
});

test('handleFromXUrl extracts the lowercased handle from X/Twitter URLs', () => {
  assert.equal(handleFromXUrl('https://x.com/akrolsmir'), 'akrolsmir');
  assert.equal(handleFromXUrl('https://x.com/AndrewCritchPhD'), 'andrewcritchphd'); // lowercased
  assert.equal(handleFromXUrl('https://twitter.com/mehan_j'), 'mehan_j');
  assert.equal(handleFromXUrl('https://www.x.com/@GonnaEth'), 'gonnaeth'); // strips @
  assert.equal(handleFromXUrl('https://x.com/sebkrier/status/2065030790136602967'), 'sebkrier'); // ignores path
});

test('handleFromXUrl returns null for missing/non-X urls', () => {
  assert.equal(handleFromXUrl(''), null);
  assert.equal(handleFromXUrl(null), null);
  assert.equal(handleFromXUrl(undefined), null);
  assert.equal(handleFromXUrl('https://linkedin.com/in/foo'), null);
  assert.equal(handleFromXUrl('not a url'), null);
});
