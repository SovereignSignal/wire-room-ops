require('ts-node/register/transpile-only');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/wireops_test';
process.env.NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL || 'ops@example.com';
process.env.PRIVY_APP_ID = process.env.PRIVY_APP_ID || 'test-app';
process.env.PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET || 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const db = require('../src/db');
const { providerRouter } = require('../src/routes/providers');
const {
  usageTimestamp,
  parseUsageJobQuery,
  getRecentUsage,
  getUsageSummary,
  logApiUsage,
  flushUsageLogs,
} = require('../src/services/api-usage');

const CREATED = new Date('2026-10-03T15:04:05.000Z');

test('usageTimestamp emits ISO 8601 and does not leave a Date to serialize as {}', () => {
  const copied = {};
  for (const key of Object.keys(CREATED)) copied[key] = CREATED[key];
  assert.deepEqual(JSON.parse(JSON.stringify({ created_at: copied })), { created_at: {} });
  assert.equal(usageTimestamp(CREATED), '2026-10-03T15:04:05.000Z');
  assert.equal(usageTimestamp('2026-10-03T15:04:05.000Z'), '2026-10-03T15:04:05.000Z');
  const lostPrototype = { toISOString() { return '2026-10-03T15:04:05.000Z'; } };
  assert.equal(usageTimestamp(lostPrototype), '2026-10-03T15:04:05.000Z');
  assert.equal(usageTimestamp(null), null);
});

test('parseUsageJobQuery accepts Firecrawl jobs and rejects anything else', () => {
  assert.deepEqual(parseUsageJobQuery(undefined), { ok: true });
  assert.deepEqual(parseUsageJobQuery(''), { ok: true });
  assert.deepEqual(parseUsageJobQuery('summary'), { ok: true, job: 'summary' });
  assert.deepEqual(parseUsageJobQuery('source-feed:avax-grants'), { ok: true, job: 'source-feed:avax-grants' });
  assert.deepEqual(parseUsageJobQuery('source-feed:ws-diff-4'), { ok: true, job: 'source-feed:ws-diff-4' });
  assert.equal(parseUsageJobQuery('not-a-job').ok, false);
  assert.equal(parseUsageJobQuery('summary;drop').ok, false);
  assert.equal(parseUsageJobQuery(['summary']).ok, false);
});

test('logApiUsage stores the Firecrawl job label', async (t) => {
  const inserted = [];
  t.mock.method(db, 'getPool', () => ({
    query: async (sql, params) => {
      inserted.push({ sql, params });
      return { rows: [] };
    },
  }));
  logApiUsage({
    provider: 'firecrawl',
    model: 'scrape',
    purpose: 'scrape',
    job: 'source-feed:longview',
    duration_ms: 40,
    success: true,
  });
  await flushUsageLogs();
  assert.equal(inserted.length, 1);
  assert.match(inserted[0].sql, /job/);
  assert.equal(inserted[0].params[11], 'source-feed:longview');
});

test('getRecentUsage returns created_at as an ISO string and can filter by job', async (t) => {
  let captured;
  t.mock.method(db, 'getPool', () => ({
    query: async (sql, params) => {
      captured = { sql, params };
      return {
        rows: [{
          id: 7,
          provider: 'firecrawl',
          model: 'scrape',
          purpose: 'scrape',
          job: 'registry-watch',
          tokens_in: null,
          tokens_out: null,
          estimated_cost_usd: '0.010000',
          wire: null,
          entry_id: null,
          duration_ms: 12,
          success: true,
          error_message: null,
          created_at: CREATED,
        }],
      };
    },
  }));
  const [row] = await getRecentUsage({ limit: 5, provider: 'firecrawl', job: 'registry-watch' });
  assert.match(captured.sql, /job = \$2/);
  assert.deepEqual(captured.params.slice(0, 2), ['firecrawl', 'registry-watch']);
  assert.equal(row.created_at, '2026-10-03T15:04:05.000Z');
  assert.equal(row.job, 'registry-watch');
  assert.equal(JSON.parse(JSON.stringify(row)).created_at, '2026-10-03T15:04:05.000Z');
  assert.equal(row.estimated_cost_usd, 0.01);
});

test('getUsageSummary groups by job and filters on it', async (t) => {
  let captured;
  t.mock.method(db, 'getPool', () => ({
    query: async (sql, params) => {
      captured = { sql, params };
      return {
        rows: [{
          provider: 'firecrawl',
          purpose: 'scrape',
          job: 'summary',
          models: ['scrape'],
          calls: 4,
          tokens_in: 0,
          tokens_out: 0,
          estimated_cost_usd: '0.04',
          unpriced_calls: 0,
          errors: 1,
        }],
      };
    },
  }));
  const [row] = await getUsageSummary({ days: 30, provider: 'firecrawl', job: 'summary' });
  assert.match(captured.sql, /GROUP BY provider, purpose, job/);
  assert.ok(captured.params.includes('firecrawl'));
  assert.ok(captured.params.includes('summary'));
  assert.equal(row.job, 'summary');
  assert.equal(row.calls, 4);
  assert.equal(row.estimated_cost_usd, 0.04);
});

async function withUsageApp(t, rowsFor) {
  t.mock.method(db, 'getPool', () => ({
    query: async (sql, params) => ({ rows: rowsFor(sql, params) }),
  }));
  const app = express();
  app.use('/api', providerRouter);
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const { port } = server.address();
  return {
    port,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test('GET /api/usage/recent and /summary expose job and ISO created_at', async (t) => {
  const app = await withUsageApp(t, (sql, params) => {
    if (sql.includes('GROUP BY provider, purpose, job')) {
      assert.equal(params[1], 'firecrawl');
      return [{
        provider: 'firecrawl',
        purpose: 'scrape',
        job: 'telegram-link',
        models: ['scrape'],
        calls: 2,
        tokens_in: 0,
        tokens_out: 0,
        estimated_cost_usd: '0.02',
        unpriced_calls: 0,
        errors: 0,
      }];
    }
    assert.match(sql, /created_at/);
    assert.equal(params[0], 'summary');
    return [{
      id: 1,
      provider: 'firecrawl',
      model: 'scrape',
      purpose: 'scrape',
      job: 'summary',
      tokens_in: null,
      tokens_out: null,
      estimated_cost_usd: null,
      wire: null,
      entry_id: null,
      duration_ms: 8,
      success: false,
      error_message: 'empty content',
      created_at: CREATED,
    }];
  });
  try {
    const recent = await fetch(`http://127.0.0.1:${app.port}/api/usage/recent?job=summary&limit=20`);
    const recentBody = await recent.json();
    assert.equal(recent.status, 200);
    assert.equal(recentBody[0].created_at, '2026-10-03T15:04:05.000Z');
    assert.equal(typeof recentBody[0].created_at, 'string');
    assert.equal(recentBody[0].job, 'summary');

    const summary = await fetch(`http://127.0.0.1:${app.port}/api/usage/summary?provider=firecrawl&days=30`);
    const summaryBody = await summary.json();
    assert.equal(summary.status, 200);
    assert.equal(summaryBody[0].job, 'telegram-link');
    assert.equal(summaryBody[0].calls, 2);

    const bad = await fetch(`http://127.0.0.1:${app.port}/api/usage/recent?job=nope`);
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'Invalid job filter' });
  } finally {
    await app.close();
  }
});
