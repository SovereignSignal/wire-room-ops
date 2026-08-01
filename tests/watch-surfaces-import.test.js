require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { mapOrgToSurfaces, SCOUT_SEED_SURFACES } = require('../src/scripts/import-watch-surfaces');

const page = {
  id: 'abc-123',
  properties: {
    'Name': { type: 'title', title: [{ plain_text: 'NLnet Foundation' }] },
    'Wire': { type: 'multi_select', multi_select: [{ name: 'OSS' }] },
    'Tier': { type: 'select', select: { name: 'Tier 1 - Official' } },
    'Grants Program URL': { type: 'url', url: 'https://nlnet.nl/propose/' },
    'Blog URL': { type: 'url', url: null },
    'RSS Feed URL': { type: 'url', url: 'https://nlnet.nl/feed.atom' },
    'Twitter': { type: 'url', url: 'https://x.com/nlnetfdn' },
  },
};

test('mapOrgToSurfaces extracts one row per populated URL column', () => {
  const rows = mapOrgToSurfaces(page);
  assert.equal(rows.length, 3); // grants_page + rss + x_account (Blog URL is null)
  const types = rows.map(r => r.surface_type).sort();
  assert.deepEqual(types, ['grants_page', 'rss', 'x_account']);
  const grants = rows.find(r => r.surface_type === 'grants_page');
  assert.equal(grants.org_name, 'NLnet Foundation');
  assert.equal(grants.wire, 'oss');            // lowercased to match feeds wires
  assert.equal(grants.tier, 'Tier 1 - Official');
  assert.equal(grants.url, 'https://nlnet.nl/propose/');
  assert.equal(grants.notion_page_id, 'abc-123');
});

test('mapOrgToSurfaces returns [] for a page with no name or no URLs', () => {
  assert.deepEqual(mapOrgToSurfaces({ id: 'x', properties: {} }), []);
});

test('scout seed list is present and well-formed', () => {
  assert.ok(SCOUT_SEED_SURFACES.length >= 20);
  for (const r of SCOUT_SEED_SURFACES) {
    assert.ok(r.org_name && r.url && r.surface_type && r.wire);
  }
});

// --- URL hygiene (2026-08-01): the Tier 1 dry run surfaced human annotations
// pasted into Notion URL columns ("https://sam.gov (search DARPA)") and two
// URLs mashed into one field with a "|" separator. splitSurfaceUrls is the
// import-time gate that keeps that class out of watch_surfaces.

const { splitSurfaceUrls } = require('../src/scripts/import-watch-surfaces');

test('splitSurfaceUrls passes a clean URL through untouched', () => {
  assert.deepEqual(splitSurfaceUrls('https://nlnet.nl/propose/'), ['https://nlnet.nl/propose/']);
});

test('splitSurfaceUrls splits pipe-separated URLs and strips trailing annotations', () => {
  assert.deepEqual(
    splitSurfaceUrls('https://a.com/lfm (TGE track) | https://a.com/pay (payments track)'),
    ['https://a.com/lfm', 'https://a.com/pay'],
  );
});

test('splitSurfaceUrls strips a single trailing parenthesized annotation', () => {
  assert.deepEqual(splitSurfaceUrls('https://sam.gov (search DARPA)'), ['https://sam.gov']);
});

test('splitSurfaceUrls drops fragments that are not http(s) URLs', () => {
  assert.deepEqual(splitSurfaceUrls('not a url'), []);
  assert.deepEqual(splitSurfaceUrls('ftp://files.example.com/x'), []);
  assert.deepEqual(splitSurfaceUrls(''), []);
  assert.deepEqual(splitSurfaceUrls(null), []);
});

test('splitSurfaceUrls rejects a URL with embedded whitespace that is not an annotation', () => {
  assert.deepEqual(splitSurfaceUrls('https://a.com/x y z'), []);
});

test('mapOrgToSurfaces yields one row per URL in a multi-URL column', () => {
  const multi = {
    id: 'page-2',
    properties: {
      'Name': { type: 'title', title: [{ plain_text: 'Starknet Foundation' }] },
      'Wire': { type: 'multi_select', multi_select: [{ name: 'Crypto' }] },
      'Application URL': { type: 'url', url: 'https://x.io/seed (early-stage) | https://x.io/growth (later-stage)' },
    },
  };
  const rows = mapOrgToSurfaces(multi);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.url).sort(), ['https://x.io/growth', 'https://x.io/seed']);
  assert.ok(rows.every(r => r.surface_type === 'application'));
});
