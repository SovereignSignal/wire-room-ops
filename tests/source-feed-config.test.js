require('ts-node/register/transpile-only');
process.env.DATABASE_URL = 'postgres://invalid:invalid@127.0.0.1:1/invalid';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SOURCE_REGISTRY } = require('../src/services/source-feeds');
const {
  applySourceFeedConfig,
  describeSources,
  normalizeSourceFeedConfig,
  validateAddedBody,
  validatePatchBody,
} = require('../src/services/source-feed-config');

test('a patch can retarget and disable a built-in feed', () => {
  const config = normalizeSourceFeedConfig({
    patches: {
      longview: { endpoint: 'https://www.longview.org/grantmaking/', enabled: false },
      nope: { endpoint: 'http://insecure.example/feed' },
    },
    added: [{
      key: 'custom-rss',
      name: 'Custom',
      wire: 'oss',
      method: 'rss',
      endpoint: 'https://example.org/feed',
      titleAllow: 'grant|rfp',
    }],
  });
  assert.equal(config.patches.nope, undefined);
  const sources = applySourceFeedConfig(SOURCE_REGISTRY, config);
  const longview = sources.find(source => source.key === 'longview');
  assert.equal(longview.enabled, false);
  assert.equal(longview.endpoint, 'https://www.longview.org/grantmaking/');
  const added = sources.find(source => source.key === 'custom-rss');
  assert.equal(added.method, 'rss');
  assert.equal(added.enabled, true);
  assert.equal(added.titleAllow.test('An RFP is open'), true);
  const view = describeSources(config).find(source => source.key === 'custom-rss');
  assert.equal(view.origin, 'added');
});

test('added feeds must be https rss or scrape, and cannot reuse a built-in key', () => {
  assert.equal(validateAddedBody({ key: 'gitcoin-campaigns', name: 'X', wire: 'crypto', method: 'rss', endpoint: 'https://example.org/feed' }).ok, false);
  const bad = validateAddedBody({ key: 'new-feed', name: 'X', wire: 'crypto', method: 'scrape', endpoint: 'https://example.org/grants' });
  assert.equal(bad.ok, false);
  const good = validateAddedBody({
    key: 'new-feed',
    name: 'New',
    wire: 'ai',
    method: 'scrape',
    endpoint: 'https://example.org/grants',
    scrapePrompt: 'Extract open grants.',
  });
  assert.equal(good.ok, true);
  assert.equal(validatePatchBody({}).ok, false);
  assert.equal(validatePatchBody({ enabled: false }).ok, true);
});

test('a garbage overlay falls back to the built-in registry', () => {
  const config = normalizeSourceFeedConfig('nope');
  const sources = applySourceFeedConfig(SOURCE_REGISTRY, config);
  assert.equal(sources.length, SOURCE_REGISTRY.length);
  assert.equal(sources.find(source => source.key === 'octant').enabled, true);
});
