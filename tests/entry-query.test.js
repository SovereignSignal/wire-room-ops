require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildScanEntryFilterClauses,
  isQueueClassification,
  isQueueDateStatus,
  isQueueRoute,
} = require('../src/db/entry-query');

test('queue filter validators accept only known values', () => {
  assert.equal(isQueueClassification('GRANT'), true);
  assert.equal(isQueueClassification('grant'), false);
  assert.equal(isQueueRoute('source_check'), true);
  assert.equal(isQueueRoute('none'), true);
  assert.equal(isQueueRoute('publish-now'), false);
  assert.equal(isQueueDateStatus('upcoming'), true);
  assert.equal(isQueueDateStatus('all'), false);
});

test('buildScanEntryFilterClauses applies wire, classification, route, and score bounds', () => {
  const built = buildScanEntryFilterClauses({
    wire: 'crypto',
    classification: 'GRANT',
    route: 'publish',
    minScore: 70,
    maxScore: 100,
  }, 2);

  assert.deepEqual(built.conditions, [
    'wire = $2',
    'quality_score >= $3',
    'quality_score <= $4',
    `COALESCE(classification, 'UNCHECKED') = $5`,
    `COALESCE(metadata->'curator'->>'route', metadata->>'operator_route') = $6`,
  ]);
  assert.deepEqual(built.values, ['crypto', 70, 100, 'GRANT', 'publish']);
  assert.equal(built.nextIndex, 7);
});

test('unscored and empty-route filters do not treat null as zero', () => {
  const unscored = buildScanEntryFilterClauses({ unscored: true, route: 'none', dateStatus: 'no_date' }, 2);
  assert.ok(unscored.conditions.includes('quality_score IS NULL'));
  assert.ok(unscored.conditions.some(sql => sql.includes('IS NULL') && sql.includes('operator_route')));
  assert.ok(unscored.conditions.includes('deadline_parsed IS NULL'));
  assert.deepEqual(unscored.values, []);
});

test('timeline upcoming and expired use the parsed deadline date', () => {
  const upcoming = buildScanEntryFilterClauses({ dateStatus: 'upcoming' }, 2);
  const expired = buildScanEntryFilterClauses({ dateStatus: 'expired' }, 2);
  assert.ok(upcoming.conditions.includes('deadline_parsed IS NOT NULL AND deadline_parsed >= CURRENT_DATE'));
  assert.ok(expired.conditions.includes('deadline_parsed IS NOT NULL AND deadline_parsed < CURRENT_DATE'));
});

test('hideTweets excludes x.com and twitter.com hosts without touching other URLs', () => {
  const hidden = buildScanEntryFilterClauses({ hideTweets: true }, 2);
  assert.equal(hidden.conditions.length, 1);
  assert.match(hidden.conditions[0], /x\\.com/);
  assert.match(hidden.conditions[0], /twitter\\.com/);
  assert.match(hidden.conditions[0], /source_url IS NULL OR/);
  assert.deepEqual(hidden.values, []);
  const shown = buildScanEntryFilterClauses({ hideTweets: false }, 2);
  assert.deepEqual(shown.conditions, []);
});
