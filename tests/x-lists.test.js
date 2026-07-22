// runXLists reads config.watchtower.xListIds (from X_LIST_IDS) once, at
// module load — pin it (and a fake bearer token) unconditionally, before
// requiring the job, so the suite is deterministic regardless of ambient
// env (also kills the real DATABASE_URL, which was causing ambient DB
// connection attempts and [ApiUsage] TLS noise in test output).
process.env.DATABASE_URL = 'postgres://invalid:invalid@127.0.0.1:1/invalid'; // kill ambient DB writes + noise
process.env.X_LIST_IDS = 'crypto:111,ai:222';
process.env.X_BEARER_TOKEN = 'test-bearer-token';

require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseXListConfig, tweetToIntakeMessage, filterNewTweets, runXLists } = require('../src/jobs/x-lists');

const tweet = (id) => ({ id, text: `tweet ${id}`, created_at: '2026-07-03T00:00:00Z', author_id: 'a1' });

// Baseline deps: every branch stubbed with a network/DB-free default. Tests
// override just the pieces they care about — a stub `{}` pool is fine since
// every DB touch goes through an injected fn.
function baseDeps(overrides = {}) {
  return {
    fetchListTweets: async () => ({ tweets: [], authors: new Map() }),
    checkBudget: async () => ({ allowed: true, spentUsd: 0, capUsd: 20 }),
    recordTwitterReads: async () => {},
    getState: async () => null,
    setState: async () => {},
    submit: async () => ({ status: 'inserted' }),
    ...overrides,
  };
}

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

// ---- filterNewTweets (Finding 1: the Lists endpoint has no since_id, so
// this is what stands in for it — client-side, against the app_state watermark) ----

test('filterNewTweets: no watermark returns every tweet (baseline run)', () => {
  const tweets = [tweet('30'), tweet('20'), tweet('10')];
  assert.deepEqual(filterNewTweets(tweets, null), tweets);
});

test('filterNewTweets: drops ids at or below the watermark', () => {
  const tweets = [tweet('30'), tweet('20'), tweet('10')];
  assert.deepEqual(filterNewTweets(tweets, '20'), [tweet('30')]); // 20 == watermark is excluded, not just <
});

test('filterNewTweets: a malformed watermark fails open (returns every tweet)', () => {
  const tweets = [tweet('30'), tweet('20')];
  assert.deepEqual(filterNewTweets(tweets, 'not-a-number'), tweets);
});

// ---- runXLists branch coverage (Finding 3), via injected deps: no network, no DB ----

test('runXLists: baseline run (no watermark) meters reads, sets the watermark, submits nothing', async () => {
  const tweets = [tweet('103'), tweet('102'), tweet('101')]; // newest first, as the API returns them
  const submitCalls = [];
  const setStateCalls = [];
  const meterCalls = [];
  const deps = baseDeps({
    fetchListTweets: async () => ({ tweets, authors: new Map() }),
    recordTwitterReads: async (n) => meterCalls.push(n),
    getState: async () => null, // no watermark for either configured list
    setState: async (key, value) => setStateCalls.push({ key, value }),
    submit: async () => { submitCalls.push(1); return { status: 'inserted' }; },
  });

  const result = await runXLists({}, {}, deps);

  assert.equal(result.ran, true);
  assert.equal(submitCalls.length, 0, 'baseline run must not submit');
  assert.equal(result.perList.length, 2, 'both configured lists ran');
  for (const row of result.perList) {
    assert.equal(row.baseline, true);
    assert.equal(row.fetched, 3);
    assert.equal(row.fresh, 3, 'everything counts as fresh with no watermark, even though nothing is submitted');
    assert.equal(row.submitted, 0);
  }
  assert.deepEqual(meterCalls, [3, 3], 'reads metered for all fetched tweets on both lists');
  assert.equal(setStateCalls.length, 2);
  for (const call of setStateCalls) assert.equal(call.value, '103', 'watermark set to the newest id');
});

test('runXLists: budget blocked skips every list — no fetch calls at all', async () => {
  const fetchCalls = [];
  const deps = baseDeps({
    fetchListTweets: async (listId) => { fetchCalls.push(listId); return { tweets: [], authors: new Map() }; },
    checkBudget: async () => ({ allowed: false, spentUsd: 21, capUsd: 20 }),
  });

  const result = await runXLists({}, {}, deps);

  assert.equal(result.ran, false);
  assert.match(result.reason, /budget/i);
  assert.deepEqual(fetchCalls, [], 'no list should be fetched once the budget is exhausted');
  assert.deepEqual(result.perList, []);
});

test('runXLists: dry run fetches and meters without consuming fresh posts', async () => {
  const tweets = [tweet('203'), tweet('202'), tweet('105')]; // 105 < the '200' watermark below
  const submitCalls = [];
  const setStateCalls = [];
  const meterCalls = [];
  const deps = baseDeps({
    fetchListTweets: async () => ({ tweets, authors: new Map() }),
    recordTwitterReads: async (n) => meterCalls.push(n),
    getState: async () => '200', // existing watermark → not a baseline run
    setState: async (key, value) => setStateCalls.push({ key, value }),
    submit: async () => { submitCalls.push(1); return { status: 'inserted' }; },
  });

  const result = await runXLists({}, { dryRun: true }, deps);

  assert.equal(result.ran, true);
  assert.equal(submitCalls.length, 0, 'dry run must not submit');
  assert.deepEqual(meterCalls, [3, 3], 'metering happens regardless of dry-run');
  assert.equal(setStateCalls.length, 0, 'dry-run findings must remain available for a later live run');
  for (const row of result.perList) {
    assert.equal(row.baseline, false);
    assert.equal(row.fetched, 3);
    assert.equal(row.fresh, 2, 'ids 203 and 202 are newer than the 200 watermark; 105 is not');
    assert.equal(row.submitted, 0);
  }
});

test('runXLists: transient intake failure advances only through the durable contiguous prefix and preserves wire', async () => {
  const tweets = [tweet('203'), tweet('202'), tweet('201')];
  const submitCalls = [];
  const setStateCalls = [];
  const deps = baseDeps({
    fetchListTweets: async () => ({ tweets, authors: new Map([['a1', 'author']]) }),
    getState: async () => '200',
    setState: async (key, value) => setStateCalls.push({ key, value }),
    submit: async (message, source, options) => {
      submitCalls.push({ id: message.channelMessageId, source, options });
      if (message.channelMessageId === '202') return { status: 'error', errorMessage: 'temporary database outage' };
      return { status: 'inserted' };
    },
  });

  const result = await runXLists({}, { dryRun: false }, deps);

  assert.deepEqual(submitCalls.map(c => c.id), ['201', '202', '201', '202'], 'each list must stop before newer tweet 203');
  assert.ok(submitCalls.every(c => c.source === 'x-list'));
  assert.deepEqual(submitCalls.map(c => c.options.wireHint), ['crypto', 'crypto', 'ai', 'ai']);
  assert.equal(setStateCalls.length, 2);
  assert.ok(setStateCalls.every(c => c.value === '201'), 'watermark must stop at the last durable tweet');
  assert.ok(result.perList.every(row => row.error === 'temporary database outage'));
  assert.ok(result.perList.every(row => row.submitted === 1));
});

test('runXLists: RATE_LIMITED on the first list aborts the run — the second list is never fetched', async () => {
  const fetchCalls = [];
  const deps = baseDeps({
    fetchListTweets: async (listId) => {
      fetchCalls.push(listId);
      if (listId === '111') throw new Error('RATE_LIMITED');
      return { tweets: [tweet('1')], authors: new Map() };
    },
  });

  const result = await runXLists({}, {}, deps);

  assert.equal(result.ran, true, 'the run itself completes — the abort is per-list, logged as an error row');
  assert.deepEqual(fetchCalls, ['111'], 'the loop must break before reaching the second list');
  assert.equal(result.perList.length, 1);
  assert.equal(result.perList[0].listId, '111');
  assert.equal(result.perList[0].error, 'RATE_LIMITED');
});
