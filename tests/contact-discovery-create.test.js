require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContactProperties } = require('../src/services/contact-discovery');

test('buildContactProperties maps fields incl. Needs Review + Org relation', () => {
  const p = buildContactProperties({ name:'Jane Doe', role:'Head of Grants', x_handle:'janedoe', evidence:'Named on org team page', wire:'crypto', program:'Ecosystem Grants' }, 'org-page-123');
  assert.equal(p['Name'].title[0].text.content, 'Jane Doe');
  assert.equal(p['X'].url, 'https://x.com/janedoe');
  assert.equal(p['Role'].rich_text[0].text.content, 'Head of Grants');
  assert.equal(p['Status'].select.name, 'Needs Review');
  assert.equal(p['Source'].select.name, 'Discovered');
  assert.equal(p['Wire'].select.name, 'crypto');
  assert.deepEqual(p['Org'].relation, [{ id: 'org-page-123' }]);
});
test('buildContactProperties omits X when no handle and Org when no page id (independent contact)', () => {
  const p = buildContactProperties({ name:'orhun', role:'OSS maintainer', x_handle:null, evidence:'github profile', wire:null, program:null }, null);
  assert.equal('X' in p, false);
  assert.equal('Org' in p, false);
  assert.equal(p['Status'].select.name, 'Needs Review');
});
test('buildContactProperties strips leading @ on handle', () => {
  const p = buildContactProperties({ name:'A B', role:'x', x_handle:'@foo', evidence:null, wire:null, program:null }, null);
  assert.equal(p['X'].url, 'https://x.com/foo');
});
