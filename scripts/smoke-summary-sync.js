// Smoke test: exercise the COMPILED dist/ version of syncSummariesToScanEntries
// against an in-memory mock pool to verify runtime behavior matches the type
// contract. Not part of `npm test` (which uses src via ts-node). Run manually
// after `npm run build`.
//
// Note: getStatusCounts uses the module's internal getPool() and is not
// dependency-injectable, so it is covered by typecheck/build rather than this
// mock-pool smoke script.

const db = require('/repos/wire-room-ops/dist/db/index.js');
db.getAppState = async () => null;
db.setAppState = async () => {};

const intakeCore = require('/repos/wire-room-ops/dist/services/intake-core.js');
intakeCore.getActiveWires = async () => ['crypto', 'ai', 'oss'];

const { syncSummariesToScanEntries } = require('/repos/wire-room-ops/dist/jobs/summary-sync.js');

function assert(cond, msg) { if (!cond) { throw new Error('SMOKE FAIL: ' + msg); } }

function makePool(summaries, existingUrls = new Set()) {
  let insertSeen = null;
  let insertCount = 0;
  const client = {
    async query(sql, params = []) {
      const up = (sql || '').trim().toUpperCase();
      if (up === 'BEGIN' || up === 'COMMIT' || up === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (up.startsWith('INSERT INTO SEEN_URLS')) return { rows: [{ id: 1 }], rowCount: 1 };
      if (up.startsWith('INSERT INTO SEEN_NAMES')) return { rows: [{ id: 2 }], rowCount: 1 };
      if (up.includes('FROM SEEN_URLS')) return { rows: [] };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = {
    _getInsertSeen: () => insertSeen,
    _getInsertCount: () => insertCount,
    async connect() { return client; },
    async query(sql, params = []) {
      const up = (sql || '').trim().toUpperCase();
      if (up.startsWith('SELECT ID FROM SCAN_ENTRIES')) {
        return { rows: existingUrls.has(params[0]) ? [{ id: 1 }] : [] };
      }
      if (up.includes('FROM SEEN_URLS') || up.includes('FROM SEEN_NAMES')) return { rows: [] };
      if (up.includes('FROM SCAN_ENTRIES') && !up.includes('FROM SUMMARIES')) return { rows: [] };
      if (up.includes('FROM SUMMARIES')) return { rows: summaries };
      if (up.startsWith('INSERT INTO SCAN_ENTRIES')) {
        insertCount++;
        insertSeen = { sql, params };
        return { rowCount: 1, rows: [{ id: 4242 }] };
      }
      return { rows: [] };
    },
  };
  return pool;
}

(async () => {
  // syncSummariesToScanEntries end-to-end with no-URL summary (placeholder path)
  const summaries = [
    { summary_id: 9001, title: 'Smoke Test Fellowship', description: 'x', wire: 'ai', entities: {}, created_at: '2026-06-22T10:00:00Z', extracted_urls: [] },
  ];
  const pool = makePool(summaries);
  const res = await syncSummariesToScanEntries(pool, 168);
  const insertSeen = pool._getInsertSeen();
  console.log('sync result =', res);
  assert(res.synced === 1, 'should sync 1');
  assert(res.errors === 0, 'should have 0 errors');
  assert(insertSeen, 'INSERT must have run');
  assert(/'queued'/i.test(insertSeen.sql), 'status literal queued present');
  assert(/'source_check'/i.test(insertSeen.sql), 'route literal source_check present');
  const urlUsed = insertSeen.params[2];
  assert(/^https:\/\/manual\/needs-source\/summary-9001-/.test(urlUsed), 'placeholder URL shape, got: ' + urlUsed);

  // Second run: idempotency — simulate the placeholder URL now existing
  const pool2 = makePool(summaries, new Set([urlUsed]));
  const res2 = await syncSummariesToScanEntries(pool2, 168);
  console.log('rerun sync result =', res2);
  assert(res2.synced === 0, 'rerun should sync 0');
  assert(res2.skipped === 1, 'rerun should skip 1');
  assert(pool2._getInsertCount() === 0, 'no INSERT on rerun');

  console.log('\nALL SMOKE CHECKS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
