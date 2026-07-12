// End-to-end pins for the raw-entry pipeline (processRawEntries):
// Gate 1 → dedup → URL claim → queue, including the Phase-3 guarantee that a
// row whose processing throws cannot be refetched forever within one run
// (the June 2026 crash-loop shape: one poisoned row starved the whole cycle).
require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

// classifyEntry is patched out: Gate 2's failure path (entry stays queued as
// UNCHECKED) is exactly the designed fail-open behavior we want to observe,
// without a network call. process-raw calls it via namespace access, so
// patching the module export takes effect.
const classifier = require('../src/services/classifier');
classifier.classifyEntry = async () => { throw new Error('classifier stubbed out in tests'); };

const dedup = require('../src/services/dedup');
const finalized = [];
dedup.finalizeExistingEntryDedup = async (_pool, entry) => {
  finalized.push(entry);
  if (entry.id === 202) return { outcome: 'duplicate', canonicalEntryId: 77 };
  if (entry.id === 404) throw new Error('simulated DB failure during claim');
  return { outcome: 'unique' };
};

const { processRawEntries } = require('../src/jobs/process-raw');

/** Stub pool that routes by SQL substring, records every call (params deep-
 *  copied — process-raw mutates its `attempted` array between calls). Also
 *  implements connect() because registerSeen runs inside a client transaction. */
function routingPool(routes) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params: Array.isArray(params) ? params.map(p => (Array.isArray(p) ? [...p] : p)) : params });
    for (const [needle, responder] of routes) {
      if (sql.includes(needle)) {
        return typeof responder === 'function' ? responder(sql, params) : responder;
      }
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    calls,
    query,
    connect: async () => ({ query, release() {} }),
  };
}

const RAW_BATCH = 'SELECT se.id, se.name';

test('Gate 1: incomplete row is marked incomplete and excluded from the next batch query', async () => {
  let batchCalls = 0;
  const pool = routingPool([
    [RAW_BATCH, () => {
      batchCalls++;
      return batchCalls === 1
        ? { rows: [{ id: 101, name: 'X', description: '', source_url: '', wire: 'crypto', scan_date: '2026-07-03', prompt_id: null, prompt_intent: null }] }
        : { rows: [] };
    }],
    ["SET status = 'incomplete'", { rows: [{ id: 101 }], rowCount: 1 }],
  ]);

  const stats = await processRawEntries(pool);
  assert.equal(stats.incomplete, 1);

  const incompleteUpdate = pool.calls.find(c => c.sql.includes("'incomplete'"));
  assert.ok(incompleteUpdate, "no UPDATE to status='incomplete' issued");
  assert.deepEqual(incompleteUpdate.params, [101]);

  // Bug-4 pin: the second batch query must exclude the already-attempted id —
  // this is what makes the loop terminate even when a row stays status='raw'.
  const batchQueries = pool.calls.filter(c => c.sql.includes(RAW_BATCH));
  assert.equal(batchQueries.length, 2);
  assert.deepEqual(batchQueries[0].params[1], [], 'first batch should exclude nothing');
  assert.deepEqual(batchQueries[1].params[1], [101], 'second batch must exclude the attempted id');
});

test('dedup: exact-name match from another source is marked duplicate with provenance', async () => {
  let batchCalls = 0;
  const pool = routingPool([
    [RAW_BATCH, () => {
      batchCalls++;
      return batchCalls === 1
        ? { rows: [{ id: 202, name: 'Filecoin PropGF Batch 3', description: 'A real grant program with a description well over the completeness minimum.', source_url: 'https://example.org/propgf', wire: 'crypto', scan_date: '2026-07-03', prompt_id: null, prompt_intent: null }] }
        : { rows: [] };
    }],
  ]);

  const stats = await processRawEntries(pool);
  assert.equal(stats.duplicates, 1);
  assert.equal(finalized.at(-1).id, 202);
});

test('clean row is URL-claimed then queued; classifier failure leaves it queued as UNCHECKED (fail-open)', async () => {
  let batchCalls = 0;
  const pool = routingPool([
    [RAW_BATCH, () => {
      batchCalls++;
      return batchCalls === 1
        ? { rows: [{ id: 303, name: 'NLnet Open Call June', description: 'Open call for privacy-enhancing internet technology projects, grants 5k-50k EUR.', source_url: 'https://nlnet.nl/propose', wire: 'oss', scan_date: '2026-07-03', prompt_id: null, prompt_intent: null }] }
        : { rows: [] };
    }],
    ["WHERE id = $1 AND status = 'deduped'", { rows: [{ id: 303 }], rowCount: 1 }],
  ]);

  const stats = await processRawEntries(pool);
  assert.equal(stats.queued, 1);
  assert.equal(stats.duplicates, 0);

  assert.equal(finalized.at(-1).id, 303, 'entry was not finalized through the atomic dedup path');
  const queuedUpdate = pool.calls.find(c => c.sql.includes("status = 'queued'") && c.sql.includes("'UNCHECKED'"));
  assert.ok(queuedUpdate, 'row was never queued as UNCHECKED');
  assert.deepEqual(queuedUpdate.params, [303]);

  // classifier threw — nothing may have archived or re-touched the row after queueing
  assert.ok(!pool.calls.some(c => c.sql.includes("'archived'")), 'fail-open violated: row archived on classifier failure');
});

test('a poisoned row (registerSeen throws) cannot spin the loop: run terminates, row excluded after first attempt', async () => {
  let batchCalls = 0;
  const pool = routingPool([
    [RAW_BATCH, (sql, params) => {
      batchCalls++;
      const excluded = params[1] || [];
      // Simulate the DB honoring the exclusion: the poisoned row keeps
      // status='raw' but must not be re-served once attempted.
      return excluded.includes(404)
        ? { rows: [] }
        : { rows: [{ id: 404, name: 'Poisoned Row Grant', description: 'This row will throw during URL claim and must not be refetched forever.', source_url: 'https://example.org/poison', wire: 'ai', scan_date: '2026-07-03', prompt_id: null, prompt_intent: null }] };
    }],
    ['FROM seen_urls', { rows: [] }],
    ['FROM scan_entries', { rows: [] }],
    ['INSERT INTO seen_urls', () => { throw new Error('simulated DB failure during claim'); }],
  ]);

  const stats = await processRawEntries(pool);
  assert.equal(stats.queued, 0);
  assert.equal(batchCalls, 2, 'loop must stop after the exclusion empties the batch — not refetch the poisoned row');
});
