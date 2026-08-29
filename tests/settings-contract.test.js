const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('Settings no longer duplicates Scan Prompts (Scans tab owns them)', () => {
  const settings = read('client/src/components/dashboard/SettingsTab.tsx');
  assert.doesNotMatch(settings, /ScanPromptsTab/);
  assert.doesNotMatch(settings, /key: 'prompts'/);
  assert.doesNotMatch(settings, /SCAN PROMPTS/);
});

test('Distribution marks Discord and Slack unused; Telegram is live', () => {
  const dist = read('client/src/components/dashboard/DistributionTab.tsx');
  assert.match(dist, /Discord \(unused\)/);
  assert.match(dist, /Slack \(unused\)/);
  assert.match(dist, /Telegram is the live channel/);
  assert.match(dist, /function isUnusedChannel/);
});

test('Database tab hides URL change when the server locks it', () => {
  const db = read('client/src/components/dashboard/DatabaseTab.tsx');
  assert.match(db, /urlChangeAllowed/);
  assert.match(db, /DATABASE_URL cannot be changed in production/);
  assert.match(db, /!urlChangeAllowed \?/);
});
