require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOrgProperties } = require('../src/services/notion-sync');

test('Source Type is built as multi_select (single value wrapped in array)', () => {
  const props = buildOrgProperties({ name: 'Acme', source_type: 'Daily Crypto Grant Wire' });
  assert.deepEqual(props['Source Type'], { multi_select: [{ name: 'Daily Crypto Grant Wire' }] });
});

test('no Source Type key when org.source_type is absent', () => {
  const props = buildOrgProperties({ name: 'Acme' });
  assert.equal('Source Type' in props, false);
});

test('Wire and Tags remain multi_select; Name is title', () => {
  const props = buildOrgProperties({ name: 'Acme', wires: ['ai'], tags: ['x'] });
  assert.ok(Array.isArray(props['Wire'].multi_select));
  assert.ok(Array.isArray(props['Tags'].multi_select));
  assert.equal(props['Name'].title[0].text.content, 'Acme');
});
