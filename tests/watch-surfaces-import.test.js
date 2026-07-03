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
