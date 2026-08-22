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

const programIdentity = require('../src/services/program-identity');
const programFinalizations = [];
programIdentity.finalizeProgramForEntry = async (_pool, entry, resolution) => {
  programFinalizations.push({ entry, resolution });
};

const { processRawEntries, recoverStrandedDedupedEntries, isCompletionSufficient } = require('../src/jobs/process-raw');
const { resolveBareUrlIntakeFields } = require('../src/services/intake-core');

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

test('Gate 1 accepts canonical one-word titles and rejects only explicit social handles', () => {
  const base = {
    description: 'Official source description with enough detail for classification and editorial routing.',
    source_url: 'https://example.org/program',
  };
  assert.deepEqual(isCompletionSufficient({ ...base, name: 'Gitcoin' }), { passes: true });
  assert.deepEqual(isCompletionSufficient({ ...base, name: 'OpenAI' }), { passes: true });
  assert.deepEqual(isCompletionSufficient({ ...base, name: '@gitcoin' }), {
    passes: false,
    reason: 'Name is only a handle',
  });
});

test('stranded deduped rows are recovered to the review queue after the safety window', async () => {
  const pool = routingPool([
    ["WHERE status = 'deduped'", { rows: [
      { id: 91, status: 'queued', scan_source: 'telegram' },
      { id: 92, status: 'queued', scan_source: 'manual-intake' },
    ], rowCount: 2 }],
    [RAW_BATCH, { rows: [] }],
  ]);

  const stats = await processRawEntries(pool);

  assert.equal(stats.processed, 2);
  assert.equal(stats.queued, 2);
  const recovery = pool.calls.find(c => c.sql.includes("WHEN scan_source = 'x-monitor' THEN 'UNCHECKED'"));
  assert.ok(recovery, 'deduped recovery update was not issued');
  assert.match(recovery.sql, /updated_at < NOW\(\) - \$1::interval/);
  assert.match(
    recovery.sql,
    /duplicate_reason IS DISTINCT FROM 'URL already exists in seed history'/,
    'terminal seed-history conflicts must stay parked',
  );
  assert.match(recovery.sql, /CASE WHEN scan_source = 'x-monitor' THEN 'raw' ELSE 'queued' END/);
  assert.deepEqual(recovery.params, ['15 minutes']);
});

test('stranded x-monitor handoffs return to raw instead of leaking into the queue as UNCHECKED', async () => {
  const pool = routingPool([
    ["WHERE status = 'deduped'", { rows: [{ id: 93, status: 'raw', scan_source: 'x-monitor' }], rowCount: 1 }],
  ]);

  const recovered = await recoverStrandedDedupedEntries(pool);

  assert.deepEqual(recovered, { queued: 0, retried: 1 });
  const recovery = pool.calls[0];
  assert.match(recovery.sql, /WHEN scan_source = 'x-monitor' THEN 'raw'/);
  assert.match(recovery.sql, /WHEN scan_source = 'x-monitor' THEN 'UNCHECKED'/);
  assert.match(recovery.sql, /quality_score = CASE WHEN scan_source = 'x-monitor' THEN NULL/);
});

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
  const queuedUpdate = pool.calls.find(c => c.sql.includes("status = 'queued'")
    && c.sql.includes("WHERE id = $1 AND status = 'deduped'"));
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

test('classification evidence reaches Gate 2 and a successful in-scope grant CAS finalizes the corrected program identity', async () => {
  let batchCalls = 0;
  let classificationInput;
  classifier.classifyEntry = async input => {
    classificationInput = input;
    return {
      classification: 'GRANT',
      reason: 'open and in scope',
      qualityScore: 82,
      scoreReason: 'strong evidence',
      operatorRoute: 'publish',
      tags: ['grant'],
      inScope: true,
      detectedWire: 'ai',
      extracted: {},
    };
  };
  programFinalizations.length = 0;
  const row = {
    id: 505,
    name: 'AI Safety Compute Grants',
    description: 'A funded compute program for artificial intelligence safety research teams.',
    source_url: 'https://example.org/ai-safety-compute',
    amount: '$100,000',
    deadline: 'September 1, 2026',
    deadline_parsed: '2026-09-01',
    source_published_at: '2026-07-20T12:00:00Z',
    wire: 'crypto',
    scan_date: '2026-07-21',
    prompt_id: null,
    prompt_intent: 'discovery',
  };
  const pool = routingPool([
    [RAW_BATCH, () => (++batchCalls === 1 ? { rows: [row] } : { rows: [] })],
    ["WHERE id = $1 AND status = 'deduped'", { rows: [{ id: row.id }], rowCount: 1 }],
    ['SET classification = $1', { rows: [{ id: row.id }], rowCount: 1 }],
  ]);

  await processRawEntries(pool);

  assert.equal(classificationInput.amount, '$100,000');
  assert.equal(classificationInput.deadlineParsed, '2026-09-01');
  assert.equal(classificationInput.sourcePublishedAt, '2026-07-20T12:00:00Z');
  assert.equal(programFinalizations.length, 1);
  assert.equal(programFinalizations[0].entry.wire, 'crypto', 'detected Wire stays advisory until atomic reassignment');
  assert.equal(programFinalizations[0].entry.deadline, '2026-09-01');
  classifier.classifyEntry = async () => { throw new Error('classifier stubbed out in tests'); };
});

test('program identity is skipped for NEWS and for a lost classification CAS', async () => {
  const runCase = async ({ id, classification, rowCount }) => {
    let batchCalls = 0;
    classifier.classifyEntry = async () => ({
      classification,
      reason: 'test classification',
      qualityScore: 60,
      scoreReason: 'test',
      operatorRoute: 'source_check',
      tags: [],
      inScope: true,
      detectedWire: 'oss',
      extracted: {},
    });
    const row = {
      id,
      name: `Program guard ${id}`,
      description: 'A sufficiently detailed opportunity used to validate the program handoff guard.',
      source_url: `https://example.org/program-${id}`,
      amount: null,
      deadline: null,
      deadline_parsed: null,
      source_published_at: null,
      wire: 'oss',
      scan_date: '2026-07-21',
      prompt_id: null,
      prompt_intent: null,
    };
    const pool = routingPool([
      [RAW_BATCH, () => (++batchCalls === 1 ? { rows: [row] } : { rows: [] })],
      ["WHERE id = $1 AND status = 'deduped'", { rows: [{ id }], rowCount: 1 }],
      ['SET classification = $1', { rows: rowCount ? [{ id }] : [], rowCount }],
    ]);
    await processRawEntries(pool);
  };

  programFinalizations.length = 0;
  await runCase({ id: 506, classification: 'NEWS', rowCount: 1 });
  await runCase({ id: 507, classification: 'GRANT', rowCount: 0 });

  assert.equal(programFinalizations.length, 0);
  classifier.classifyEntry = async () => { throw new Error('classifier stubbed out in tests'); };
});

test('canonical one-word x-monitor title reaches settled classification instead of incomplete', async () => {
  const resolved = resolveBareUrlIntakeFields({
    initialName: 'example.org/gitcoin',
    originalText: 'https://example.org/gitcoin',
    scraped: {
      name: 'Gitcoin',
      description: 'Official canonical source description for an open funding opportunity.',
      scrapedContent: '# Gitcoin\nOfficial canonical source description.',
    },
    scanSource: 'x-monitor',
  });
  assert.equal(resolved.ok, true);

  let batchCalls = 0;
  classifier.classifyEntry = async () => ({
    classification: 'GRANT',
    reason: 'open and in scope',
    qualityScore: 80,
    scoreReason: 'canonical evidence',
    operatorRoute: 'publish',
    tags: ['grant'],
    inScope: true,
    detectedWire: 'oss',
    extracted: {},
  });
  const row = {
    id: 600,
    name: resolved.name,
    description: resolved.description,
    source_url: 'https://example.org/gitcoin',
    amount: null,
    deadline: null,
    deadline_parsed: null,
    source_published_at: null,
    wire: 'oss',
    scan_source: 'x-monitor',
    scan_date: '2026-08-22',
    prompt_id: null,
    prompt_intent: null,
  };
  const pool = routingPool([
    [RAW_BATCH, () => (++batchCalls === 1 ? { rows: [row] } : { rows: [] })],
    ["WHERE id = $1 AND status = 'deduped'", { rows: [{ id: row.id }], rowCount: 1 }],
    ['SET classification = $1', { rows: [{ id: row.id }], rowCount: 1 }],
  ]);

  const stats = await processRawEntries(pool);

  assert.equal(stats.incomplete, 0);
  assert.equal(stats.queued, 1);
  assert.ok(pool.calls.some(call => call.sql.includes('SET classification = $1')));
});

test('x-monitor park classifications settle outside the review queue', async () => {
  let batchCalls = 0;
  classifier.classifyEntry = async () => ({
    classification: 'NEWS',
    reason: 'context only',
    qualityScore: 35,
    scoreReason: 'no applicant path',
    operatorRoute: 'park',
    tags: ['context'],
    inScope: true,
    detectedWire: 'ai',
    extracted: {},
  });
  const row = {
    id: 601,
    name: 'Canonical source title',
    description: 'A sufficiently detailed source description that should be classified before review.',
    source_url: 'https://example.org/x-monitor-park',
    amount: null,
    deadline: null,
    deadline_parsed: null,
    source_published_at: null,
    wire: 'ai',
    scan_source: 'x-monitor',
    scan_date: '2026-08-22',
    prompt_id: null,
    prompt_intent: null,
  };
  const pool = routingPool([
    [RAW_BATCH, () => (++batchCalls === 1 ? { rows: [row] } : { rows: [] })],
    ["WHERE id = $1 AND status = 'deduped'", { rows: [{ id: row.id }], rowCount: 1 }],
    ['SET classification = $1', { rows: [{ id: row.id }], rowCount: 1 }],
  ]);

  const stats = await processRawEntries(pool);

  const classified = pool.calls.find(c => c.sql.includes('SET classification = $1'));
  assert.ok(classified, 'classification write was not issued');
  assert.equal(classified.params[7], 'archived', 'parked x-monitor rows must not land in the operator queue');
  assert.equal(classified.params[8], 'deduped', 'x-monitor must remain hidden until classification settles');
  assert.equal(classified.params[9], row.source_url, 'classification CAS must fence source rewrites');
  assert.equal(classified.params[10], row.name, 'classification CAS must fence title rewrites');
  assert.equal(classified.params[12], row.wire, 'classification CAS must fence wire rewrites');
  assert.match(classified.sql, /source_url = \$10/);
  assert.match(classified.sql, /description IS NOT DISTINCT FROM \$12/);
  assert.doesNotMatch(classified.sql, /wire\s*=\s*COALESCE/, 'classification must not mutate dedup Wire scope');
  assert.equal(stats.queued, 0);
  assert.equal(stats.archived, 1);
  assert.ok(
    !pool.calls.some(c => c.params?.[0] === row.id && c.sql.includes('SET quality_score = NULL') && c.sql.includes("status = 'queued'")),
    'x-monitor must never become transiently visible as UNCHECKED',
  );
  classifier.classifyEntry = async () => { throw new Error('classifier stubbed out in tests'); };
});

test('x-monitor classifier failure returns the row to raw instead of leaking UNCHECKED into the queue', async () => {
  let batchCalls = 0;
  classifier.classifyEntry = async () => { throw new Error('temporary classifier failure'); };
  const row = {
    id: 602,
    name: 'Canonical source title',
    description: 'A sufficiently detailed source description that must remain pending when classification fails.',
    source_url: 'https://example.org/x-monitor-retry',
    amount: null,
    deadline: null,
    deadline_parsed: null,
    source_published_at: null,
    wire: 'ai',
    scan_source: 'x-monitor',
    scan_date: '2026-08-22',
    prompt_id: null,
    prompt_intent: null,
  };
  const pool = routingPool([
    [RAW_BATCH, () => (++batchCalls === 1 ? { rows: [row] } : { rows: [] })],
    ["WHERE id = $1 AND status = 'deduped'", { rows: [{ id: row.id }], rowCount: 1 }],
    ["SET status = 'raw'", { rows: [{ id: row.id }], rowCount: 1 }],
  ]);

  await processRawEntries(pool);

  const retry = pool.calls.find(c => c.sql.includes("SET status = 'raw'"));
  assert.ok(retry, 'failed x-monitor classification must be returned to raw for a later retry');
  assert.match(retry.sql, /status = 'deduped'/);
  assert.deepEqual(retry.params, [row.id]);
});
