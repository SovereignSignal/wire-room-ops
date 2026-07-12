require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

// Keep this unit test hermetic. summary-sync imports these modules at load time,
// so patch them before requiring the job.
const db = require('../src/db');
db.getAppState = async () => null;
db.setAppState = async () => {};

const intakeCore = require('../src/services/intake-core');
intakeCore.getActiveWires = async () => ['crypto', 'ai', 'oss', 'repos', 'models', 'claw'];

const dedup = require('../src/services/dedup');
dedup.checkDuplicate = async () => ({
  isDuplicate: false,
  matchType: null,
  matchedEntryId: null,
  matchedEntryName: null,
  confidence: 0,
  reason: 'No duplicate found',
});
let registerSeenResult = { urlConflict: false, conflictEntryId: null };
dedup.registerSeenInTransaction = async () => registerSeenResult;

const { shouldBridgeWire, syncSummariesToScanEntries } = require('../src/jobs/summary-sync');

test('bridges summaries whose wire is an active feed wire', () => {
  assert.equal(shouldBridgeWire('crypto', ['crypto', 'ai', 'oss']), true);
});

test('does NOT bridge non-grant digest wires even when feeds table marks them active', () => {
  const activeFeeds = ['crypto', 'ai', 'oss', 'repos', 'models', 'claw'];
  assert.equal(shouldBridgeWire('repos', activeFeeds), false);
  assert.equal(shouldBridgeWire('models', activeFeeds), false);
  assert.equal(shouldBridgeWire('claw', activeFeeds), false);
});

test('legacy null-wire summaries still bridge (keyword inference handles them)', () => {
  assert.equal(shouldBridgeWire(null, ['crypto', 'ai', 'oss']), true);
  assert.equal(shouldBridgeWire(undefined, ['crypto', 'ai', 'oss']), true);
  // empty string is treated like null — legacy row sent to inference path
  assert.equal(shouldBridgeWire('', ['crypto', 'ai', 'oss']), true);
});

/**
 * Minimal in-memory mock Pool. Lets us assert exactly which INSERT/SELECT
 * statements ran and what parameters were bound, without a live database.
 */
function makeMockPool(opts = {}) {
  const queries = [];
  const existing = new Set(opts.existingUrls || []);
  const existingSummaryIds = new Set((opts.existingSummaryIds || []).map(String));
  const inserteds = [];

  async function runQuery(sql, params = []) {
    queries.push({ sql, params });
    const normalized = (sql || '').trim().toUpperCase();

    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK'
        || normalized.startsWith('SELECT PG_ADVISORY_XACT_LOCK')) {
      return { rowCount: null, rows: [] };
    }

    // The summaries fetch SELECT.
    if (normalized.includes('FROM SUMMARIES')) {
      return { rows: opts.summaries || [] };
    }

    // Idempotency lookup inside the transaction.
    if (normalized.startsWith('SELECT ID, STATUS, NAME, SOURCE_URL')) {
      const url = params[0];
      const summaryId = params[1];
      if (!existing.has(url) && !existingSummaryIds.has(String(summaryId))) return { rows: [] };
      return {
        rows: [{
          id: 999,
          status: opts.existingStatus || 'approved',
          name: 'Existing summary',
          source_url: url,
          wire: 'ai',
          scan_date: '2026-06-22',
        }],
      };
    }

    // INSERT scan entry.
    if (normalized.startsWith('INSERT INTO SCAN_ENTRIES')) {
      inserteds.push({ sql, params });
      return { rowCount: 1, rows: [{ id: opts.insertId || 12345 }] };
    }

    if (normalized.startsWith('UPDATE SCAN_ENTRIES')) {
      return { rowCount: opts.updateRowCount ?? 1, rows: opts.updateRowCount === 0 ? [] : [{ id: params[3] }] };
    }

    return { rowCount: 0, rows: [] };
  }

  const client = {
    query: runQuery,
    release() {},
  };
  return {
    _queries: queries,
    _inserteds: inserteds,
    _existing: existing,
    _existingSummaryIds: existingSummaryIds,
    query: runQuery,
    async connect() { return client; },
  };
}

test('summary-sync inserts URL-backed summary as queued source_check', async () => {
  const pool = makeMockPool({
    summaries: [
      {
        summary_id: 1001,
        title: 'Tarbell Grants for AI Accountability Reporting',
        description: 'Grants for accountability reporting.',
        wire: 'ai',
        entities: { amounts: ['$5,000'], deadlines: ['2026-07-01'] },
        created_at: '2026-06-22T14:18:00Z',
        extracted_urls: ['https://www.tarbellcenter.org/grants'],
      },
    ],
  });

  const result = await syncSummariesToScanEntries(pool, 168);

  assert.equal(result.synced, 1, 'one summary should be synced');
  assert.equal(result.skipped, 0);
  assert.equal(result.errors, 0);
  assert.equal(pool._inserteds.length, 1, 'exactly one INSERT');

  const ins = pool._inserteds[0];
  // status 'queued' and operator_route 'source_check' are SQL literals, not params
  assert.match(ins.sql, /'queued'/i, 'status must be queued');
  assert.match(ins.sql, /'source_check'/i, 'operator_route must be source_check');
  assert.match(ins.sql, /RETURNING id/i, 'insert must return id for registerSeen');
  assert.equal(ins.params[0], 'Tarbell Grants for AI Accountability Reporting');
  assert.equal(ins.params[2], 'https://www.tarbellcenter.org/grants');
  assert.equal(ins.params[9], false, 'real URL rows should not require source verification');
});

test('summary-sync parks a seed-history URL instead of leaving it queued', async () => {
  const pool = makeMockPool({
    summaries: [
      {
        summary_id: 1007,
        title: 'Historical Seed Program',
        description: 'Already present in the seed URL history.',
        wire: 'oss',
        entities: {},
        created_at: '2026-06-22T14:18:00Z',
        extracted_urls: ['https://example.com/historical-seed-program'],
      },
    ],
  });
  registerSeenResult = { urlConflict: true, conflictEntryId: null };
  try {
    const result = await syncSummariesToScanEntries(pool, 168);
    assert.equal(result.synced, 0);
    assert.equal(result.skipped, 1);
    const parked = pool._queries.find(({ sql }) => /SET status = 'deduped'/i.test(sql));
    assert.ok(parked, 'conflicting insert must be parked');
    assert.deepEqual(parked.params.slice(0, 2), [
      12345,
      'URL already exists in seed history',
    ]);
  } finally {
    registerSeenResult = { urlConflict: false, conflictEntryId: null };
  }
});

test('summary-sync parks (does NOT stall the bridge) when the URL owner is a non-canonical parent', async () => {
  // Regression for the July 2026 unresolvable-parent class in the tele-sum bridge.
  // A URL claim that resolves to a parent the demoter cannot accept is PERMANENT.
  // If it throws, the row errors, and the watermark only advances on a clean run
  // (result.errors === 0) — so ONE poison summary would freeze the watermark and
  // stall every later summary behind it. It must park forward instead.
  const pool = makeMockPool({
    summaries: [
      {
        summary_id: 1099,
        title: 'Unresolvable Parent Summary',
        description: 'URL owned by an entry in a status the demoter cannot canonicalize.',
        wire: 'oss',
        entities: {},
        created_at: '2026-06-22T14:18:00Z',
        extracted_urls: ['https://example.com/unresolvable-summary-parent'],
      },
    ],
  });
  const duplicateChain = require('../src/services/duplicate-chain');
  const originalDemote = duplicateChain.demoteEntryToDuplicateInTransaction;
  registerSeenResult = { urlConflict: true, conflictEntryId: 999 };
  duplicateChain.demoteEntryToDuplicateInTransaction = async () => ({
    outcome: 'unresolvable', canonicalParentId: null, unresolvableReason: 'invalid-status',
  });
  try {
    const result = await syncSummariesToScanEntries(pool, 168);
    assert.equal(result.errors, 0, 'an unresolvable parent must not error the run — an error freezes the watermark and stalls the whole bridge');
    assert.equal(result.skipped, 1, 'the conflicting row is parked and counted as skipped');
    const parked = pool._queries.find(({ sql }) => /SET status = 'deduped'/i.test(sql));
    assert.ok(parked, 'entry must be parked forward (deduped), not thrown');
  } finally {
    registerSeenResult = { urlConflict: false, conflictEntryId: null };
    duplicateChain.demoteEntryToDuplicateInTransaction = originalDemote;
  }
});

test('summary-sync creates placeholder URL when summary has no extracted URL', async () => {
  const pool = makeMockPool({
    summaries: [
      {
        summary_id: 1002,
        title: 'Vals AI Fellowship',
        description: 'Fellowship for AI evaluators.',
        wire: 'ai',
        entities: {},
        created_at: '2026-06-22T14:18:00Z',
        extracted_urls: null,
      },
    ],
  });

  const result = await syncSummariesToScanEntries(pool, 168);

  assert.equal(result.synced, 1, 'no-URL summary must still sync (not skip)');
  assert.equal(result.skipped, 0);
  assert.equal(pool._inserteds.length, 1);

  const ins = pool._inserteds[0];
  const url = ins.params[2];
  assert.match(url, /^https:\/\/manual\/needs-source\/summary-1002-vals-ai-fellowship/,
    'placeholder URL must be stable and include summary id + slug');
  assert.equal(ins.params[9], true, 'placeholder rows should require source verification');
});

test('summary-sync is idempotent: existing URL is skipped, no INSERT', async () => {
  const pool = makeMockPool({
    summaries: [
      {
        summary_id: 1003,
        title: 'OpenAI Codex OSS Support',
        description: 'Maintainer sponsorships.',
        wire: 'oss',
        entities: {},
        created_at: '2026-06-19T17:11:00Z',
        extracted_urls: ['https://x.com/jxnlco/status/2067672883522879581'],
      },
    ],
    existingUrls: ['https://x.com/jxnlco/status/2067672883522879581'],
  });

  const result = await syncSummariesToScanEntries(pool, 168);

  assert.equal(result.synced, 0);
  assert.equal(result.skipped, 1);
  assert.equal(pool._inserteds.length, 0, 'no INSERT when URL already exists');
});

test('summary-sync is idempotent: same metadata.summary_id is skipped even when URL differs', async () => {
  const pool = makeMockPool({
    summaries: [
      {
        summary_id: 1004,
        title: 'Tarbell Grants',
        description: 'x',
        wire: 'ai',
        entities: {},
        created_at: '2026-06-22T14:18:00Z',
        extracted_urls: ['https://example.com/new-url-for-same-summary'],
      },
    ],
    existingSummaryIds: [1004],
  });

  const result = await syncSummariesToScanEntries(pool, 168);

  assert.equal(result.synced, 0, 'same summary_id must not re-insert even when URL changes');
  assert.equal(result.skipped, 1);
  assert.equal(pool._inserteds.length, 0);
});

test('summary-sync skips non-feed digest wires', async () => {
  const pool = makeMockPool({
    summaries: [
      {
        summary_id: 1005,
        title: 'Repo Digest Item',
        description: 'digest item',
        wire: 'repos',
        entities: {},
        created_at: '2026-06-22T14:18:00Z',
        extracted_urls: ['https://example.com/repo'],
      },
    ],
  });

  const result = await syncSummariesToScanEntries(pool, 168);

  assert.equal(result.synced, 0);
  assert.equal(result.skipped, 1);
  assert.equal(pool._inserteds.length, 0);
});

test('summary-sync skips when there is no title', async () => {
  const pool = makeMockPool({
    summaries: [
      {
        summary_id: 1006,
        title: null,
        description: 'no title',
        wire: 'ai',
        entities: {},
        created_at: '2026-06-22T14:18:00Z',
        extracted_urls: ['https://example.com/x'],
      },
    ],
  });

  const result = await syncSummariesToScanEntries(pool, 168);
  assert.equal(result.synced, 0);
  assert.equal(result.skipped, 1);
  assert.equal(pool._inserteds.length, 0);
});
