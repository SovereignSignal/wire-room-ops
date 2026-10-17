// Pins the pruned Notion org-property contract (CRM simplification 2026-07-03,
// the operator: "no more than 8-10 fields"). Notion carries only the 10-field human view;
// Twitter/GitHub/Tags/Source Type/Items Sourced live ONLY in Postgres. If the
// sync ever writes a pruned field again, Notion would silently re-create it as
// a new property — these tests make that a loud failure instead.
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOrgProperties } = require('../src/services/notion-sync');

const FULL_ORG = {
  name: 'Acme',
  website: 'https://acme.org',
  twitter: 'https://x.com/acme',
  github_url: 'https://github.com/acme',
  wires: ['ai'],
  tags: ['x', 'y'],
  items_sourced: '7',
  entry_count: 2,
  avg_quality_score: '71.4',
  last_seen: '2026-07-01',
  org_type: 'Foundation/Lab',
  source_type: 'Daily Crypto Grant Wire',
  tier: 'Tier 1 - Official',
  description: 'AI lab.',
  last_signal: 'Shipped X.',
};

test('pruned fields are NEVER written, even when the org has the data', () => {
  const props = buildOrgProperties(FULL_ORG);
  for (const pruned of ['Twitter', 'GitHub URL', 'Tags', 'Source Type', 'Items Sourced']) {
    assert.equal(pruned in props, false, `pruned field '${pruned}' must not be written to Notion`);
  }
});

test('the 10-view fields the sync owns are all written', () => {
  const props = buildOrgProperties(FULL_ORG);
  assert.equal(props['Name'].title[0].text.content, 'Acme');
  assert.deepEqual(props['Website'], { url: 'https://acme.org' });
  assert.ok(Array.isArray(props['Wire'].multi_select));
  assert.deepEqual(props['Quality Score'], { number: 71 });
  assert.deepEqual(props['Last Checked'], { date: { start: '2026-07-01' } });
  assert.deepEqual(props['Type'], { select: { name: 'Foundation/Lab' } });
  assert.deepEqual(props['Tier'], { select: { name: 'Tier 1 - Official' } });
});

test('Wire capitalizes for the Notion multi_select (crypto→Crypto, ai→AI, oss→OSS)', () => {
  const props = buildOrgProperties({ name: 'Acme', wires: ['crypto', 'ai', 'oss'] });
  assert.deepEqual(props['Wire'].multi_select.map(o => o.name), ['Crypto', 'AI', 'OSS']);
});

test('Action(s) carries description and last_signal when present', () => {
  const props = buildOrgProperties({ name: 'Acme', description: 'AI lab.', last_signal: 'Shipped X.' });
  const text = props['Action(s)'].rich_text.map(r => r.text.content).join('');
  assert.ok(text.includes('AI lab.') && text.includes('Shipped X.'));
});

test('Action(s) renders the BD operator_read between description and latest signal', () => {
  const props = buildOrgProperties({ name: 'Acme', description: 'AI lab.', operator_read: 'scaling a new fund, thin team', last_signal: 'Shipped X.' });
  const text = props['Action(s)'].rich_text.map(r => r.text.content).join('');
  assert.ok(text.includes('Operator read: scaling a new fund, thin team'));
  assert.ok(text.indexOf('AI lab.') < text.indexOf('Operator read:') && text.indexOf('Operator read:') < text.indexOf('Latest:'));
});

test('no Action(s) when neither description nor last_signal present', () => {
  assert.equal('Action(s)' in buildOrgProperties({ name: 'Acme' }), false);
});

test('minimal org writes only Name (no undefined-field noise)', () => {
  const props = buildOrgProperties({ name: 'Acme' });
  assert.deepEqual(Object.keys(props), ['Name']);
});
