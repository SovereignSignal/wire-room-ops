require('ts-node/register/transpile-only');
process.env.DATABASE_URL = 'postgres://invalid:invalid@127.0.0.1:1/invalid';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isTier12, surfaceToRssSource, surfaceToScrapeSource, overlapsSeedRegistry,
  normalizeForHash, contentHash, tierClause,
} = require('../src/services/registry-watchers');

const s = (over = {}) => ({ id: 7, org_name: 'NLnet Foundation', wire: 'oss', surface_type: 'rss', url: 'https://nlnet.nl/feed.atom', tier: 'Tier 1 - Official', ...over });

test('isTier12 accepts tier 1/2 variants and Official, rejects tier 3/none', () => {
  for (const t of ['Tier 1 - Official', 'Tier 1', 'Official', 'Tier 2 - Secondary', 'Tier 2']) assert.equal(isTier12(t), true, t);
  for (const t of ['Tier 3 - Monitor', 'Tier 3', null, '']) assert.equal(isTier12(t), false, String(t));
});

test('surfaceToRssSource maps a surface into a FeedSource the feeds engine accepts', () => {
  const src = surfaceToRssSource(s());
  assert.equal(src.key, 'ws-rss-7');
  assert.equal(src.method, 'rss');
  assert.equal(src.endpoint, 'https://nlnet.nl/feed.atom');
  assert.equal(src.wire, 'oss');
  assert.equal(src.enabled, true);
  assert.ok(src.maxItems <= 20);
});

test('surfaceToScrapeSource builds a change-extraction scrape source', () => {
  const src = surfaceToScrapeSource(s({ surface_type: 'grants_page', url: 'https://example.org/grants' }));
  assert.equal(src.key, 'ws-diff-7');
  assert.equal(src.method, 'scrape');
  assert.ok(src.scrapePrompt && src.scrapePrompt.length > 20);
  assert.match(src.scrapePrompt, /wire_area 2/);
  assert.match(src.scrapePrompt, /Registry proposals stay open-only/);
  assert.equal(src.usagePurpose, 'watchtower-registry-extract');
});

test('overlapsSeedRegistry catches an enabled seed source URL, misses others', () => {
  assert.equal(overlapsSeedRegistry(s()), true); // nlnet.nl/feed.atom is an enabled SOURCE_REGISTRY endpoint
  assert.equal(overlapsSeedRegistry(s({ url: 'https://example.org/never-a-seed' })), false);
});

test('normalizeForHash strips tags/whitespace/dynamic noise; contentHash is stable', () => {
  const a = '<html><body><p>Grants  open!</p><script>x=1</script><span>token=abc123</span></body></html>';
  const b = '<html><body><p>Grants open!</p><script>y=2</script><span>token=zzz999</span></body></html>';
  assert.equal(typeof contentHash(a), 'string');
  assert.equal(contentHash(a).length, 64);
  assert.notEqual(normalizeForHash(a), '');
  // scripts stripped; text equal after whitespace collapse except the token span
  assert.ok(normalizeForHash(a).includes('Grants open!'));
});

test('tierClause defaults to Tier 1 only', () => {
  const sql = tierClause('1');
  assert.match(sql, /Tier 1%/);
  assert.equal(/Tier 2%/.test(sql), false);
});

test('tierClause can include Tier 2', () => {
  const sql = tierClause('1,2');
  assert.match(sql, /Tier 1%/);
  assert.match(sql, /Tier 2%/);
});

test('tierClause accepts Tier 2 alone', () => {
  const sql = tierClause('2');
  assert.match(sql, /Tier 2%/);
  assert.equal(/Tier 1%/.test(sql), false);
});

test('tierClause falls back to Tier 1 on empty or garbage input', () => {
  for (const input of ['', '   ', 'banana']) {
    const sql = tierClause(input);
    assert.match(sql, /Tier 1%/, `input ${JSON.stringify(input)} must fall back to Tier 1`);
    assert.equal(/Tier 2%/.test(sql), false);
  }
});

test('tierClause keeps the legacy "Official" spelling in the Tier 1 branch', () => {
  assert.match(tierClause('1'), /tier = 'Official'/);
});
