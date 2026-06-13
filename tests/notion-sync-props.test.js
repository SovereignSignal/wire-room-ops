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

test('Items Sourced uses live items_sourced when present', () => {
  const props = buildOrgProperties({ name: 'Acme', items_sourced: '7', entry_count: 2 });
  assert.deepEqual(props['Items Sourced'], { number: 7 });
});

test('Items Sourced falls back to entry_count when items_sourced absent', () => {
  const props = buildOrgProperties({ name: 'Acme', entry_count: 3 });
  assert.deepEqual(props['Items Sourced'], { number: 3 });
});

test('GitHub URL is mapped when org.github_url present', () => {
  const props = buildOrgProperties({ name: 'Acme', github_url: 'https://github.com/acme' });
  assert.deepEqual(props['GitHub URL'], { url: 'https://github.com/acme' });
});
test('no GitHub URL key when absent', () => {
  assert.equal('GitHub URL' in buildOrgProperties({ name: 'Acme' }), false);
});

test('Action(s) carries description and last_signal when present', () => {
  const props = buildOrgProperties({ name: 'Acme', description: 'AI lab.', last_signal: 'Shipped X.' });
  const text = props['Action(s)'].rich_text.map(r => r.text.content).join('');
  assert.ok(text.includes('AI lab.') && text.includes('Shipped X.'));
});
test('no Action(s) when neither description nor last_signal present', () => {
  assert.equal('Action(s)' in buildOrgProperties({ name: 'Acme' }), false);
});
