require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const { dropStaleFirstRunItems, FIRST_RUN_MAX_AGE_DAYS, isStaleFirstRunItem } = require('../src/services/source-feeds');

const NOW = Date.parse('2026-10-10T00:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

function item(publishedAt, url) {
  return { publishedAt, url, name: url };
}

test('a first run drops items older than 45 days and keeps undated ones', () => {
  assert.equal(FIRST_RUN_MAX_AGE_DAYS, 45);
  assert.equal(isStaleFirstRunItem(daysAgo(46), NOW), true);
  assert.equal(isStaleFirstRunItem(daysAgo(45), NOW), false);
  assert.equal(isStaleFirstRunItem(null, NOW), false);
  assert.equal(isStaleFirstRunItem('not-a-date', NOW), false);

  const fresh = dropStaleFirstRunItems([
    item(daysAgo(400), 'https://octant.substack.com/p/epoch-2025'),
    item(daysAgo(10), 'https://octant.substack.com/p/epoch-13'),
    item(null, 'https://example.org/scrape'),
  ], true, NOW);
  assert.deepEqual(fresh.map(row => row.url), [
    'https://octant.substack.com/p/epoch-13',
    'https://example.org/scrape',
  ]);
});

test('a later run keeps an old published item', () => {
  const kept = dropStaleFirstRunItems([item(daysAgo(400), 'https://example.org/old')], false, NOW);
  assert.equal(kept.length, 1);
});
