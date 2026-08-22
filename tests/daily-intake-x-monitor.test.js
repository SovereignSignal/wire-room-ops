require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const { runDailyIntake } = require('../src/jobs/daily-intake');

test('daily intake rejects reserved x-monitor source before any database work', async () => {
  let queried = false;
  const pool = {
    async query() { queried = true; throw new Error('database must not be reached'); },
  };
  const submission = {
    wire: 'ai',
    promptVariant: 'A',
    source: 'x-monitor',
    scanDate: '2026-08-22',
    results: [{
      name: 'Raw social title',
      description: 'Raw account monitor payload that must use canonical URL intake instead.',
      sourceUrl: 'https://example.org/program',
    }],
  };

  await assert.rejects(
    runDailyIntake(pool, [submission]),
    /x-monitor submissions must use the Account Monitor canonical-URL intake path/,
  );
  assert.equal(queried, false);
});
