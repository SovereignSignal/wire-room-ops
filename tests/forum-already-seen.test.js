require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeUrl } = require('../src/utils/url');
const {
  forumTopicKey,
  forumResultIndexesToSkip,
  findForumSourceUrlsByHost,
} = require('../src/services/forum-seen');
const { runDailyIntake } = require('../src/jobs/daily-intake');

const EXACT = 'https://forum.example.org/t/exact-topic/100';
const STORED_NORMALIZED = 'https://forum.example.org/t/normalized-topic/200';
const EQUIVALENT = 'http://forum.example.org/t/normalized-topic/200/7/?utm_source=discourse#post-7';
const DECLINED = 'https://forum.example.org/t/declined-topic/300';
const FRESH = 'https://forum.example.org/t/brand-new-topic/400';

function forumSubmission(sourceUrl, name) {
  return {
    wire: 'crypto',
    promptVariant: 'N',
    scanDate: '2026-10-10',
    source: 'forum',
    results: [{
      name,
      description: `${name} on the governance forum`,
      sourceUrl,
      amount: null,
      deadline: null,
    }],
  };
}

/**
 * Stub pool. The seen_urls probe is the intake seed check; a row makes it
 * return before touching messages. The source_url select is the forum
 * already-seen lookup and returns every fixture URL — the real query has no
 * status predicate, so a declined row is included.
 */
function intakePool(existingSourceUrls) {
  const calls = [];
  const insertedUrls = [];
  const pool = {
    calls,
    insertedUrls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM seen_urls')) return { rows: [{ seeded: 1 }], rowCount: 1 };
      if (sql.includes('FROM scan_entries') && sql.includes('source_url')) {
        return {
          rows: existingSourceUrls.map(source_url => ({ source_url })),
          rowCount: existingSourceUrls.length,
        };
      }
      if (sql.includes('INSERT INTO scan_entries')) {
        const width = 19;
        const count = Math.floor((params?.length || 0) / width);
        const rows = [];
        for (let i = 0; i < count; i++) {
          insertedUrls.push(params[i * width + 2]);
          rows.push({ id: 1000 + i });
        }
        return { rows, rowCount: count };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return pool;
}

function lookupSql(pool) {
  return pool.calls.find(call => call.sql.includes('FROM scan_entries') && call.sql.includes('source_url'));
}

test('forum topic key reuses normalizeUrl and adds forum-only rules', () => {
  assert.equal(forumTopicKey(EXACT), forumTopicKey(EXACT));
  assert.equal(forumTopicKey(EQUIVALENT), forumTopicKey(STORED_NORMALIZED));
  assert.equal(forumTopicKey('https://forum.example.org/t/slug/123/4'), forumTopicKey('https://forum.example.org/t/slug/123'));
  assert.equal(forumTopicKey('https://forum.example.org/t/123/4'), forumTopicKey('https://forum.example.org/t/123'));
  assert.notEqual(forumTopicKey('https://forum.example.org/t/slug/123'), forumTopicKey('https://forum.example.org/t/slug/124'));
  // Shared normalizer still keeps Snapshot proposal hashes. This key must not
  // become the global dedup key.
  const snapshot = 'https://snapshot.org/#/aavedao.eth/proposal/0xabc';
  assert.ok(normalizeUrl(snapshot).includes('#/aavedao.eth/proposal/0xabc'));
  assert.equal(forumTopicKey(snapshot).includes('#'), false);
});

test('a later equivalent URL in the same batch is skipped', () => {
  const skip = forumResultIndexesToSkip(
    [STORED_NORMALIZED, EQUIVALENT, FRESH],
    [],
  );
  assert.deepEqual([...skip], [1]);
});

test('exact repeat URL is skipped before insert', async () => {
  const pool = intakePool([EXACT]);
  const summary = await runDailyIntake(pool, [forumSubmission(EXACT, 'Exact topic')], { insertOnly: true });

  assert.equal(summary.skippedAlreadySeen, 1);
  assert.equal(summary.totalIngested, 0);
  assert.deepEqual(pool.insertedUrls, []);
  assert.equal(lookupSql(pool).params[0].includes('forum.example.org'), true);
});

test('normalized-equivalent URL is skipped before insert', async () => {
  const pool = intakePool([STORED_NORMALIZED]);
  const summary = await runDailyIntake(pool, [forumSubmission(EQUIVALENT, 'Normalized topic')], { insertOnly: true });

  assert.equal(summary.skippedAlreadySeen, 1);
  assert.equal(summary.totalIngested, 0);
  assert.deepEqual(pool.insertedUrls, []);
  assert.equal(forumTopicKey(EQUIVALENT), forumTopicKey(STORED_NORMALIZED));
});

test('genuinely new URL is still created', async () => {
  const pool = intakePool([EXACT, STORED_NORMALIZED, DECLINED]);
  const summary = await runDailyIntake(pool, [forumSubmission(FRESH, 'Brand new topic')], { insertOnly: true });

  assert.equal(summary.skippedAlreadySeen, 0);
  assert.equal(summary.totalIngested, 1);
  assert.deepEqual(pool.insertedUrls, [FRESH]);
});

test('URL previously seen only on a declined entry is still skipped', async () => {
  const pool = intakePool([DECLINED]);
  const summary = await runDailyIntake(pool, [forumSubmission(DECLINED, 'Declined topic')], { insertOnly: true });

  assert.equal(summary.skippedAlreadySeen, 1);
  assert.equal(summary.totalIngested, 0);
  assert.deepEqual(pool.insertedUrls, []);
  const sql = lookupSql(pool).sql;
  assert.equal(/status/i.test(sql), false);
  assert.equal(sql.includes('declined'), false);
});

test('non-forum submissions do not use the forum already-seen check', async () => {
  const pool = intakePool([EXACT]);
  const submission = forumSubmission(EXACT, 'Web result');
  submission.source = 'web-search';
  const summary = await runDailyIntake(pool, [submission], { insertOnly: true });

  assert.equal(summary.skippedAlreadySeen, 0);
  assert.equal(summary.totalIngested, 1);
  assert.deepEqual(pool.insertedUrls, [EXACT]);
  assert.equal(lookupSql(pool), undefined);
});

test('findForumSourceUrlsByHost queries every host and skips an empty list', async () => {
  let called = false;
  const empty = await findForumSourceUrlsByHost({
    query: async () => { called = true; return { rows: [] }; },
  }, ['', 'not a url']);
  assert.deepEqual(empty, []);
  assert.equal(called, false);

  const pool = {
    async query(sql, params) {
      assert.equal(/status/i.test(sql), false);
      assert.deepEqual(params[0], ['forum.example.org']);
      return { rows: [{ source_url: DECLINED }, { source_url: null }] };
    },
  };
  const rows = await findForumSourceUrlsByHost(pool, [EQUIVALENT]);
  assert.deepEqual(rows, [DECLINED]);
});
