const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('process-raw uses the shared 180-day exact-name dedup window', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/jobs/process-raw.ts'), 'utf8');
  assert.match(source, /DEFAULT_DEDUPE_WINDOW_DAYS/);
  assert.doesNotMatch(source, /finalizeExistingEntryDedup\([\s\S]*?,\s*14\s*,/);
});

test('daily-intake and summary-sync share the same default window constant', () => {
  const intake = fs.readFileSync(path.join(__dirname, '../src/jobs/daily-intake.ts'), 'utf8');
  const sync = fs.readFileSync(path.join(__dirname, '../src/jobs/summary-sync.ts'), 'utf8');
  const types = fs.readFileSync(path.join(__dirname, '../src/types/intake.ts'), 'utf8');
  assert.match(types, /export const DEFAULT_DEDUPE_WINDOW_DAYS = 180/);
  assert.match(intake, /dedupeWindow: DEFAULT_DEDUPE_WINDOW_DAYS/);
  assert.match(sync, /DEFAULT_DEDUPE_WINDOW_DAYS/);
});
