require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseXListConfig, tweetToIntakeMessage } = require('../src/jobs/x-lists');

test('parseXListConfig parses wire:listId pairs and skips malformed entries', () => {
  assert.deepEqual(parseXListConfig('crypto:111, ai:222,oss:333'), [
    { wire: 'crypto', listId: '111' },
    { wire: 'ai', listId: '222' },
    { wire: 'oss', listId: '333' },
  ]);
  assert.deepEqual(parseXListConfig(''), []);
  assert.deepEqual(parseXListConfig('junk,ai:9'), [{ wire: 'ai', listId: '9' }]);
});

test('tweetToIntakeMessage prefers external URLs and falls back to the post URL', () => {
  const withLink = tweetToIntakeMessage(
    { id: '15', text: 'New $2M grants round open', created_at: '2026-07-03T00:00:00Z',
      entities: { urls: [{ expanded_url: 'https://fund.org/apply' }, { expanded_url: 'https://x.com/self/status/1' }] } },
    'crypto', 'fundorg',
  );
  assert.deepEqual(withLink.urls, ['https://fund.org/apply']); // x.com links dropped
  assert.equal(withLink.senderId, 'x-list:crypto');
  assert.equal(withLink.channelMessageId, '15');
  assert.equal(withLink.forwardedFrom, '@fundorg');
  assert.ok(withLink.text.includes('https://fund.org/apply'));

  const noLink = tweetToIntakeMessage(
    { id: '16', text: 'Applications open today', created_at: '2026-07-03T00:00:00Z' },
    'ai', 'lab',
  );
  assert.deepEqual(noLink.urls, ['https://x.com/i/status/16']); // announcement lives in the post itself
});
