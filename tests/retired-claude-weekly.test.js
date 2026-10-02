require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

test('the server never calls Anthropic and the weekly issue is gone', () => {
  const offenders = [];
  for (const file of walk(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    if (/api\.anthropic\.com|@anthropic-ai\/sdk|services\/anthropic|jobs\/weekly-issue|weekly-notion|parallel-task/.test(text)) {
      offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, []);

  const pkg = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
  assert.doesNotMatch(pkg, /@anthropic-ai\/sdk/);

  const removed = [
    'src/services/anthropic.ts',
    'src/jobs/weekly-issue.ts',
    'src/services/weekly-notion.ts',
    'src/services/parallel-task.ts',
    'src/scripts/weekly-run-once.ts',
    'src/scripts/weekly-seed-prior.ts',
  ];
  for (const rel of removed) {
    assert.equal(fs.existsSync(path.join(ROOT, rel)), false, rel);
  }

  const scheduler = fs.readFileSync(path.join(SRC, 'services/scheduler.ts'), 'utf8');
  assert.doesNotMatch(scheduler, /runWeeklyIssue|weekly-issue/);

  const providers = fs.readFileSync(path.join(SRC, 'routes/providers.ts'), 'utf8');
  assert.doesNotMatch(providers, /'anthropic'/);

  const backfill = fs.readFileSync(path.join(SRC, 'scripts/backfill-summary-leaks.ts'), 'utf8');
  assert.match(backfill, /generateValidatedSummary/);
  assert.match(backfill, /--apply/);
  assert.doesNotMatch(backfill, /summarizeViaGrok|services\/grok/);
});
