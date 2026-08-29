const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('STRINGER briefing no longer describes retired distribution or fuzzy dedup as current', () => {
  const source = fs.readFileSync(path.join(__dirname, '../STRINGER.md'), 'utf8');
  assert.match(source, /Approve = publish/);
  assert.doesNotMatch(source, /Distribution is currently paused/);
  assert.doesNotMatch(source, /drip-distribution\.ts/);
  assert.doesNotMatch(source, /fuzzy name blocking is on/i);
  assert.match(source, /Fuzzy name blocking is off/);
});
