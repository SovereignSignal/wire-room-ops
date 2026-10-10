require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  blockedSourceDomain,
  isParallelAggregatorHost,
  parallelExcludeDomains,
  PARALLEL_EXCLUDE_DOMAINS,
} = require('../src/services/source-filter');
const { settleParallelHit, PARALLEL_EXTRACT_RULES } = require('../src/services/parallel');

test('Parallel exclude list is separate from the Gate 1 block list', () => {
  for (const host of ['facebook.com', 'fundsforngos.org', 'web3grant.com', 'web3grants.com', 'gate.com', 'grants.watch']) {
    assert.ok(PARALLEL_EXCLUDE_DOMAINS.includes(host), host);
    assert.equal(blockedSourceDomain(`https://${host}/some/post`), null, `${host} stays off the global list`);
  }
  const excluded = parallelExcludeDomains();
  assert.ok(excluded.includes('facebook.com'));
  assert.ok(excluded.includes('opportunitydesk.org'), 'scholarship domains still go to Parallel');
  assert.equal(new Set(excluded).size, excluded.length);
});

test('Parallel aggregator match includes subdomains', () => {
  assert.equal(isParallelAggregatorHost('https://m.facebook.com/story.php?id=1'), true);
  assert.equal(isParallelAggregatorHost('https://www.fundsforngos.org/listing'), true);
  assert.equal(isParallelAggregatorHost('https://cn.investing.com/news/1'), true);
  assert.equal(isParallelAggregatorHost('https://nlnet.nl/news/2026-call'), false);
});

test('aggregator hits are dropped unless the excerpt cites an official URL', () => {
  assert.equal(settleParallelHit({
    url: 'https://www.facebook.com/interledger/posts/1',
    title: 'Interledger grant',
    excerpts: ['Applications are open. See the post.'],
  }), null);

  const rewritten = settleParallelHit({
    url: 'https://fundsforngos.org/nlnet-call',
    title: 'NLnet call',
    excerpts: ['Apply at https://nlnet.nl/funding/open-call/ before June.'],
  });
  assert.equal(rewritten.url, 'https://nlnet.nl/funding/open-call/');

  assert.equal(settleParallelHit({
    url: 'https://facebook.com/opensats',
    title: 'OpenSats',
    excerpts: ['Listed on https://grants.watch/opensats and https://t.co/abc'],
  }), null, 'grants.watch and shorteners are not the funder URL');

  const direct = settleParallelHit({
    url: 'https://opensats.org/apply',
    title: 'OpenSats',
    excerpts: ['Rolling applications.'],
  });
  assert.equal(direct.url, 'https://opensats.org/apply');
});

test('extraction still asks for the funder URL and keeps evergreen programs', () => {
  assert.match(PARALLEL_EXTRACT_RULES, /funder's own URL/);
  assert.match(PARALLEL_EXTRACT_RULES, /Deadline to Rolling/);
});
