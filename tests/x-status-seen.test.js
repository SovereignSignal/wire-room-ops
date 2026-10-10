require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeUrl } = require('../src/utils/url');
const {
  xStatusId,
  xStatusIndexesToSkip,
  findXStatusSourceUrls,
  grokBatchTracksXStatus,
} = require('../src/services/x-status-seen');
const { processBatchMessage, processIntakeMessage } = require('../src/services/intake-core');
const { formatSettledBatchReport } = require('../src/services/telegram-adapter');

const REPEAT = '1111111111111111111';
const TWIN = '2222222222222222222';
const QUERY = '3333333333333333333';
const FRESH = '4444444444444444444';

const STORED_REPEAT = `https://x.com/alpha/status/${REPEAT}`;
const STORED_TWITTER = `https://twitter.com/Beta/status/${TWIN}`;
const STORED_QUERY = `https://x.com/gamma/status/${QUERY}`;

function batchText(lines) {
  return lines.join('\n');
}

/**
 * Stub pool. The regexp_match select is the X already-seen lookup and returns
 * every fixture URL — the real query has no status predicate, so a declined
 * row is included. seen_urls stays empty so checkDuplicate does not also
 * count the row as a duplicate.
 */
function stubIntake(t, existingSourceUrls) {
  const db = require('../src/db');
  const originalGetAllFeeds = db.getAllFeeds;
  const originalGetPool = db.getPool;
  t.after(() => {
    db.getAllFeeds = originalGetAllFeeds;
    db.getPool = originalGetPool;
  });
  db.getAllFeeds = async () => [{ key: 'crypto' }, { key: 'ai' }, { key: 'oss' }];

  const insertedUrls = [];
  const lookups = [];
  const client = {
    query: async (sql, params) => {
      if (/INSERT INTO scan_entries/i.test(sql)) {
        insertedUrls.push(params[2]);
        return { rows: [{ id: 800 + insertedUrls.length }], rowCount: 1 };
      }
      if (/INSERT INTO seen_urls/i.test(sql)) return { rows: [{ id: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  db.getPool = () => ({
    connect: async () => client,
    query: async (sql, params) => {
      if (sql.includes('regexp_match') && sql.includes('scan_entries')) {
        lookups.push({ sql, params });
        return {
          rows: existingSourceUrls.map(source_url => ({ source_url })),
          rowCount: existingSourceUrls.length,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  });
  return { insertedUrls, lookups };
}

test('x status key equates twitter.com, x.com, query strings, and fragments', () => {
  const id = xStatusId(STORED_REPEAT);
  assert.equal(id, REPEAT);
  assert.equal(xStatusId(`https://twitter.com/ALPHA/status/${REPEAT}?s=20`), REPEAT);
  assert.equal(xStatusId(`https://x.com/other/status/${REPEAT}?t=abc&s=20#frag`), REPEAT);
  assert.equal(xStatusId(`https://mobile.twitter.com/Alpha/status/${REPEAT}/`), REPEAT);
  assert.equal(xStatusId(`https://www.x.com/i/web/status/${REPEAT}`), REPEAT);
  assert.equal(xStatusId('https://example.org/status/1111111111111111111'), '');
  assert.equal(xStatusId('https://x.com/alpha'), '');
  // Shared normalizer still keeps Snapshot proposal hashes.
  const snapshot = 'https://snapshot.org/#/aavedao.eth/proposal/0xabc';
  assert.ok(normalizeUrl(snapshot).includes('#/aavedao.eth/proposal/0xabc'));
  assert.equal(xStatusId(snapshot), '');
  assert.equal(grokBatchTracksXStatus('telegram', 'agent'), true);
  assert.equal(grokBatchTracksXStatus('telegram', 'operator'), false);
  assert.equal(grokBatchTracksXStatus('manual-intake', 'agent'), false);
});

test('a later equivalent status ID in the same batch is skipped', () => {
  const skip = xStatusIndexesToSkip([
    STORED_REPEAT,
    `https://twitter.com/someone/status/${REPEAT}?s=20`,
    `https://x.com/gamma/status/${FRESH}`,
    'https://example.org/grants/open',
  ], []);
  assert.deepEqual([...skip], [1]);
});

test('repeat X URL already stored in any status is skipped before insert', async (t) => {
  const { insertedUrls, lookups } = stubIntake(t, [STORED_REPEAT]);
  const result = await processBatchMessage({
    text: batchText([
      `Repeat Grant - ${STORED_REPEAT}#frag`,
      `Fresh Grant - https://x.com/delta/status/${FRESH}`,
    ]),
    senderId: 'agent:grok-batch',
  }, 'telegram', { origin: 'agent' });

  assert.equal(result.skippedAlreadySeen, 1);
  assert.equal(result.inserted, 1);
  assert.equal(result.duplicates, 0);
  assert.equal(result.entries[0].skippedAlreadySeen, true);
  assert.equal(result.entries[0].isDuplicate, undefined);
  assert.deepEqual(insertedUrls, [`https://x.com/delta/status/${FRESH}`]);
  const sql = lookups[0].sql;
  assert.equal(/\bstatus\s*(=|IN|NOT)/i.test(sql), false);
  assert.equal(sql.includes("'declined'"), false);
  assert.deepEqual(lookups[0].params[0], ['x.com', 'twitter.com']);
  assert.deepEqual(lookups[0].params[1], [REPEAT, FRESH]);
});

test('twitter.com and x.com status IDs are the same post', async (t) => {
  const { insertedUrls } = stubIntake(t, [STORED_TWITTER]);
  const result = await processBatchMessage({
    text: batchText([
      `Twitter Twin - https://x.com/beta/status/${TWIN}`,
      `Other Post - https://x.com/delta/status/${FRESH}`,
    ]),
    senderId: 'agent:grok-batch',
  }, 'telegram', { origin: 'agent' });

  assert.equal(result.skippedAlreadySeen, 1);
  assert.equal(result.entries[0].skippedAlreadySeen, true);
  assert.deepEqual(insertedUrls, [`https://x.com/delta/status/${FRESH}`]);
  assert.equal(xStatusId(STORED_TWITTER), xStatusId(`https://x.com/beta/status/${TWIN}`));
});

test('an X URL that only differs by ?s= is skipped', async (t) => {
  const { insertedUrls } = stubIntake(t, [STORED_QUERY]);
  const result = await processBatchMessage({
    text: batchText([
      `Query Variant - https://twitter.com/GAMMA/status/${QUERY}?s=20`,
      `Other Post - https://x.com/delta/status/${FRESH}`,
    ]),
    senderId: 'agent:grok-batch',
  }, 'telegram', { origin: 'agent' });

  assert.equal(result.skippedAlreadySeen, 1);
  assert.equal(result.inserted, 1);
  assert.deepEqual(insertedUrls, [`https://x.com/delta/status/${FRESH}`]);
  assert.equal(
    result.entries.filter(entry => entry.skippedAlreadySeen).length,
    1,
  );
});

test('a new status ID is still inserted', async (t) => {
  const { insertedUrls } = stubIntake(t, [STORED_REPEAT, STORED_TWITTER, STORED_QUERY]);
  const freshUrl = `https://x.com/delta/status/${FRESH}`;
  const result = await processBatchMessage({
    text: batchText([
      `Fresh Grant - ${freshUrl}`,
      `Known Grant - ${STORED_REPEAT}`,
    ]),
    senderId: 'agent:grok-batch',
  }, 'telegram', { origin: 'agent' });

  assert.equal(result.skippedAlreadySeen, 1);
  assert.equal(result.inserted, 1);
  assert.deepEqual(insertedUrls, [freshUrl]);
  assert.ok(result.entries.some(entry => entry.id && entry.name.includes('Fresh')));
});

test('operator telegram pastes and manual intake do not use the X status check', async (t) => {
  const { insertedUrls, lookups } = stubIntake(t, [STORED_REPEAT]);
  const operator = await processBatchMessage({
    text: batchText([
      `Repeat Grant - ${STORED_REPEAT}`,
      `Fresh Grant - https://x.com/delta/status/${FRESH}`,
    ]),
    senderId: 'telegram:1',
  }, 'telegram', { origin: 'operator' });

  assert.equal(operator.skippedAlreadySeen, 0);
  assert.equal(operator.inserted, 2);
  assert.equal(lookups.length, 0);

  const manual = await processBatchMessage({
    text: batchText([
      `Repeat Grant - ${STORED_REPEAT}`,
      `Fresh Grant - https://x.com/epsilon/status/5555555555555555555`,
    ]),
    senderId: 'agent:grok-batch',
  }, 'manual-intake', { origin: 'agent' });

  assert.equal(manual.skippedAlreadySeen, 0);
  assert.equal(manual.inserted, 2);
  assert.equal(lookups.length, 0);
  assert.equal(insertedUrls.length, 4);
});

test('a single agent telegram X post uses the same skip', async (t) => {
  stubIntake(t, [STORED_REPEAT]);
  const skipped = await processIntakeMessage({
    text: `Repeat Grant ${STORED_REPEAT}?s=20`,
    senderId: 'agent:grok-batch',
  }, 'telegram', { origin: 'agent' });

  assert.equal(skipped.status, 'rejected');
  assert.equal(skipped.skippedAlreadySeen, true);
  assert.match(skipped.errorMessage, /already in scan_entries/);
});

test('findXStatusSourceUrls queries status IDs and skips an empty list', async () => {
  let called = false;
  const empty = await findXStatusSourceUrls({
    query: async () => { called = true; return { rows: [] }; },
  }, ['', 'https://example.org/not-a-post', 'not a url']);
  assert.deepEqual(empty, []);
  assert.equal(called, false);

  const pool = {
    async query(sql, params) {
      assert.equal(/\bstatus\s*(=|IN|NOT)/i.test(sql), false);
      assert.deepEqual(params[0], ['x.com', 'twitter.com']);
      assert.deepEqual(params[1], [REPEAT]);
      return { rows: [{ source_url: STORED_REPEAT }, { source_url: null }] };
    },
  };
  const rows = await findXStatusSourceUrls(pool, [`https://twitter.com/a/status/${REPEAT}?s=20`]);
  assert.deepEqual(rows, [STORED_REPEAT]);
});

test('the Grok batch workflow log prints skippedAlreadySeen', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '../.github/workflows/grok-scout-submit.yml'),
    'utf8',
  );
  assert.match(workflow, /skippedAlreadySeen/);
  assert.match(workflow, /skipped/);
});

test('a skipped batch row is not reported as a processing error', () => {
  const report = formatSettledBatchReport({
    inserted: 1,
    duplicates: 0,
    errors: 0,
    retryableErrors: 0,
    failed: 0,
    skippedAlreadySeen: 1,
    entries: [
      { name: 'Repeat Grant', wire: 'crypto', skippedAlreadySeen: true, error: 'Already in scan_entries' },
      { id: 9, name: 'Fresh Grant', wire: 'crypto' },
    ],
  }, [
    { id: 9, status: 'queued', duplicate_of_id: null, duplicate_reason: null, decided_recheck: { verdict: 'distinct' }, duplicate_chain_error: null },
  ]);

  assert.match(report, /1 already seen/);
  assert.match(report, /already in scan_entries/);
  assert.match(report, /1 queued/);
  assert.doesNotMatch(report, /processing failed/);
});
