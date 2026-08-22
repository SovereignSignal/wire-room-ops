process.env.DATABASE_URL = 'postgres://invalid:invalid@127.0.0.1:1/invalid';
process.env.X_BEARER_TOKEN = 'test-bearer-token';

require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const apiUsage = require('../src/services/api-usage');
const originalLogApiUsage = apiUsage.logApiUsage;
apiUsage.logApiUsage = () => {};

const { runAccountMonitor } = require('../src/jobs/account-monitor');

const account = (overrides = {}) => ({
  id: 'account-1',
  handle: 'grantmaker',
  wire: 'ai',
  x_user_id: 'user-1',
  kind: 'org',
  person_name: null,
  ...overrides,
});

const tweet = (id, url = `https://example.org/${id}`) => ({
  id,
  text: `Applications ${id}`,
  created_at: '2026-07-21T00:00:00Z',
  entities: { urls: [{ expanded_url: url, display_url: url }] },
});

function fakePool(accounts = [account()]) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT id, handle, wire, x_user_id/.test(sql)) {
        return { rows: accounts, rowCount: accounts.length };
      }
      if (/RETURNING handle/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    },
  };
}

test('non-OK X timeline responses are errors, not empty successful checks', async () => {
  const pool = fakePool();
  const originalFetch = global.fetch;
  global.fetch = async () => ({ status: 503, ok: false });
  try {
    const result = await runAccountMonitor(pool, {
      getState: async () => null,
      setState: async () => { throw new Error('watermark must not advance'); },
      sleep: async () => {},
    });

    assert.equal(result.errors, 1);
    assert.equal(result.processed, 0);
    assert.ok(!pool.calls.some(call => /SET last_checked_at = NOW/.test(call.sql)), 'failed response must remain due for retry');
  } finally {
    global.fetch = originalFetch;
  }
});

test('account watermark advances only through durable tweets and passes the configured wire hint', async () => {
  const pool = fakePool();
  const stateWrites = [];
  const submissions = [];
  let requestedSince;

  const result = await runAccountMonitor(pool, {
    getState: async () => '100',
    setState: async (key, value) => stateWrites.push({ key, value }),
    getRecentTweets: async (_userId, _token, sinceId) => {
      requestedSince = sinceId;
      return [tweet('103'), tweet('102'), tweet('101')];
    },
    submit: async (message, source, options) => {
      submissions.push({ id: message.channelMessageId, text: message.text, source, options });
      if (message.channelMessageId === '102') return { status: 'error', errorMessage: 'temporary insert failure' };
      return { status: 'inserted' };
    },
    sleep: async () => {},
  });

  assert.equal(requestedSince, '100', 'stored watermark must be sent to X as since_id');
  assert.deepEqual(submissions.map(s => s.id), ['101', '102'], 'newer tweets must wait behind the failed tweet');
  assert.ok(submissions.every(s => s.source === 'x-monitor'));
  assert.ok(submissions.every(s => s.options.wireHint === 'ai'));
  assert.deepEqual(
    submissions.map(s => s.text),
    ['https://example.org/101', 'https://example.org/102'],
    'x-monitor must submit the canonical URL as a bare message so intake derives a source title instead of persisting tweet text',
  );
  assert.deepEqual(
    submissions.map(s => s.options.sourceContext),
    ['Applications 101', 'Applications 102'],
    'the original tweet must survive as provenance metadata, not as the queue title',
  );
  assert.deepEqual(stateWrites, [{ key: 'xmonitor:since:account-1', value: '101' }]);
  assert.equal(result.submitted, 1);
  assert.equal(result.errors, 1);
  assert.equal(result.processed, 0);
  assert.ok(!pool.calls.some(call => /SET last_checked_at = NOW/.test(call.sql)), 'partial account stays due for retry');
});

test('deterministic intake rejection is durable and does not pin the watermark', async () => {
  const pool = fakePool();
  const stateWrites = [];

  const result = await runAccountMonitor(pool, {
    getState: async () => '100',
    setState: async (key, value) => stateWrites.push({ key, value }),
    getRecentTweets: async () => [tweet('101')],
    submit: async () => ({ status: 'rejected', errorMessage: 'Duplicate' }),
    sleep: async () => {},
  });

  assert.deepEqual(stateWrites, [{ key: 'xmonitor:since:account-1', value: '101' }]);
  assert.equal(result.skipped, 1);
  assert.equal(result.errors, 0);
  assert.equal(result.processed, 1);
  assert.ok(pool.calls.some(call => /SET last_checked_at = NOW/.test(call.sql)));
});

test.after(() => {
  apiUsage.logApiUsage = originalLogApiUsage;
});
