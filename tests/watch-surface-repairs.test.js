require('ts-node/register/transpile-only');
process.env.DATABASE_URL = 'postgres://invalid:invalid@127.0.0.1:1/invalid';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  planSurfaceRepairs,
  surfaceNeedsGitcoinRepair,
  surfaceNeedsOctantRepair,
  GITCOIN_CAMPAIGNS_URL,
  OCTANT_FEED_URL,
} = require('../src/db/watch-surface-repairs');
const { skipsPlainFetch } = require('../src/services/registry-watchers');

test('gitcoin and octant matchers leave the live addresses and governance alone', () => {
  assert.equal(surfaceNeedsGitcoinRepair('https://grants.gitcoin.co/explorer'), true);
  assert.equal(surfaceNeedsGitcoinRepair('https://www.gitcoin.co'), true);
  assert.equal(surfaceNeedsGitcoinRepair('https://gov.gitcoin.co/t/something'), false);
  assert.equal(surfaceNeedsGitcoinRepair(GITCOIN_CAMPAIGNS_URL), false);
  assert.equal(surfaceNeedsOctantRepair('https://octant.app/epochs'), true);
  assert.equal(surfaceNeedsOctantRepair(OCTANT_FEED_URL), false);
  assert.equal(skipsPlainFetch('https://fil.org/grants'), true);
  assert.equal(skipsPlainFetch('https://www.fil.org/'), true);
  assert.equal(skipsPlainFetch('https://gitcoin.co/campaigns'), false);
});

test('repairs retarget one row and pause the duplicates', () => {
  const plan = planSurfaceRepairs([
    { id: 797, url: 'https://grants.gitcoin.co', surface_type: 'grants_page', status: 'active' },
    { id: 800, url: 'https://builder.gitcoin.co', surface_type: 'website', status: 'active' },
    { id: 12, url: 'https://gov.gitcoin.co', surface_type: 'forum', status: 'active' },
    { id: 1038, url: 'https://octant.app', surface_type: 'grants_page', status: 'active' },
    { id: 392, url: 'https://fil.org/grants', surface_type: 'grants_page', status: 'active' },
  ]);
  assert.deepEqual(plan.updates, [
    { id: 797, url: GITCOIN_CAMPAIGNS_URL, surface_type: 'grants_page' },
    { id: 1038, url: OCTANT_FEED_URL, surface_type: 'rss' },
  ]);
  assert.deepEqual(plan.pauses, [800]);
});

test('an existing campaigns row is kept and the dead hosts are paused', () => {
  const plan = planSurfaceRepairs([
    { id: 1, url: GITCOIN_CAMPAIGNS_URL, surface_type: 'grants_page', status: 'active' },
    { id: 797, url: 'https://grants.gitcoin.co/rounds', surface_type: 'grants_page', status: 'active' },
  ]);
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.pauses, [797]);
});
