require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadCuratorKeys, matchCuratorKey, requiredCuratorScope, hashCuratorToken, curatorUserId,
} = require('../src/services/curator-keys');
const { parseCuratorEvidence } = require('../src/services/curator-evidence');
const { claimIdempotency, idempotencyBodyHash } = require('../src/services/curator-idempotency');
const { getDailyQueue, resolveQueueMinScore } = require('../src/jobs/daily-intake');
const { planCuratorWrite, applyCuratorWrite } = require('../src/services/curator');
const { deriveForumPostName, SOURCE_REGISTRY } = require('../src/services/source-feeds');
const { requireAuthOrInternalKey } = require('../src/middleware/internal-auth');

const future = '2099-01-01T00:00:00.000Z';
const token = 'test-curator-token-not-a-secret';

function keyList(scopes = ['read_queue', 'decide', 'propose']) {
  return JSON.stringify([{
    id: 'hedwig',
    name: 'Hedwig',
    sha256: hashCuratorToken(token),
    scopes,
    expires_at: future,
    revoked: false,
  }]);
}

test('curator principal is agent:<name>', () => {
  assert.equal(curatorUserId('Hedwig'), 'agent:hedwig');
});

test('a valid key list matches the bearer and rejects expired, revoked, and unknown scopes', () => {
  const loaded = loadCuratorKeys(keyList());
  assert.equal(loaded.malformed, false);
  assert.equal(matchCuratorKey(token, loaded.keys).userId, 'agent:hedwig');
  assert.equal(matchCuratorKey('other-token', loaded.keys), null);

  const expired = loadCuratorKeys(JSON.stringify([{
    id: 'hedwig', name: 'Hedwig', sha256: hashCuratorToken(token),
    scopes: ['read_queue'], expires_at: '2000-01-01T00:00:00.000Z', revoked: false,
  }]));
  assert.equal(matchCuratorKey(token, expired.keys), null);

  const revoked = loadCuratorKeys(JSON.stringify([{
    id: 'hedwig', name: 'Hedwig', sha256: hashCuratorToken(token),
    scopes: ['read_queue'], expires_at: future, revoked: true,
  }]));
  assert.equal(matchCuratorKey(token, revoked.keys), null);

  assert.equal(loadCuratorKeys('{"not":"an array"}').malformed, true);
  assert.equal(loadCuratorKeys(undefined).malformed, false);
  assert.equal(loadCuratorKeys(JSON.stringify([{
    id: 'x', name: 'X', sha256: hashCuratorToken(token),
    scopes: ['publish'], expires_at: future, revoked: false,
  }])).malformed, true);
});

test('curator scopes allow the editorial routes and the dashboard controls', () => {
  assert.equal(requiredCuratorScope('GET', '/api/scan/queue'), 'read_queue');
  assert.equal(requiredCuratorScope('GET', '/api/scan/entries/15'), 'read_queue');
  assert.equal(requiredCuratorScope('GET', '/api/scan/seen-urls?wire=ai'), 'read_queue');
  assert.equal(requiredCuratorScope('POST', '/api/scan/entries/15/action'), 'decide');
  assert.equal(requiredCuratorScope('POST', '/api/scan/entries/bulk-action'), 'decide');
  assert.equal(requiredCuratorScope('PATCH', '/api/scan/entries/15/wire'), 'decide');
  assert.equal(requiredCuratorScope('PATCH', '/api/scan/entries/15/source'), 'decide');
  assert.equal(requiredCuratorScope('POST', '/api/scan/entries/15/link-duplicate'), 'decide');
  assert.equal(requiredCuratorScope('POST', '/api/scan/entries/15/curate'), 'propose');
  assert.equal(requiredCuratorScope('POST', '/api/scan/submit'), 'propose');
  assert.equal(requiredCuratorScope('POST', '/api/scan/telegram-batch'), 'intake');

  assert.equal(requiredCuratorScope('GET', '/api/distribution/pace'), 'read_queue');
  assert.equal(requiredCuratorScope('GET', '/api/distribution/outgoing'), 'read_queue');
  assert.equal(requiredCuratorScope('PUT', '/api/distribution/pace'), 'decide');
  assert.equal(requiredCuratorScope('POST', '/api/scan/prompts'), 'decide');
  assert.equal(requiredCuratorScope('POST', '/api/forum/run'), 'decide');
  assert.equal(requiredCuratorScope('POST', '/api/scan/manual-intake'), 'decide');
  assert.equal(requiredCuratorScope('POST', '/api/scan/entries/15/redistribute'), 'decide');
  assert.equal(requiredCuratorScope('GET', '/api/scan/stats'), 'read_queue');

  for (const [method, path] of [
    ['POST', '/api/accounts'],
    ['GET', '/api/scan/telegram-batch'],
    ['POST', '/api/scan/submit-batch'],
    ['POST', '/api/scan/agent/send-brief'],
    ['POST', '/api/admin/purge-source'],
    ['POST', '/api/summary-sync'],
  ]) {
    assert.equal(requiredCuratorScope(method, path), 'forbidden', `${method} ${path}`);
  }
});

test('decide evidence requires reason and https sources; approve also requires a quote', () => {
  assert.equal(parseCuratorEvidence({}, { requireQuote: false }).ok, false);
  assert.equal(parseCuratorEvidence({
    reason: 'closed',
    sources: ['http://example.org/insecure'],
  }, { requireQuote: false }).ok, false);

  const decline = parseCuratorEvidence({
    reason: 'Not an open program.',
    sources: ['https://forum.example.org/t/pitch/1'],
  }, { requireQuote: false });
  assert.equal(decline.ok, true);
  assert.deepEqual(decline.evidence.sources, ['https://forum.example.org/t/pitch/1']);

  const approveMissing = parseCuratorEvidence({
    reason: 'Open.',
    sources: ['https://example.org/grants'],
  }, { requireQuote: true });
  assert.equal(approveMissing.ok, false);

  const approve = parseCuratorEvidence({
    reason: 'Open.',
    sources: ['https://example.org/grants'],
    quotes: [{ url: 'https://example.org/grants', quote: 'Applications are open.' }],
  }, { requireQuote: true });
  assert.equal(approve.ok, true);
  assert.equal(approve.evidence.quotes[0].quote, 'Applications are open.');
});

test('idempotency replays the same body and conflicts on a different body', async () => {
  const mem = new Map();
  const store = {
    async get(key) { return mem.has(key) ? mem.get(key) : null; },
    async set(key, value) { if (value == null) mem.delete(key); else mem.set(key, value); },
  };
  const hash = idempotencyBodyHash('POST', '/api/scan/entries/1/action', { action: 'decline', reason: 'no' });
  const first = await claimIdempotency({ store, storageKey: 'curator:idem:hedwig:k1', bodyHash: hash });
  assert.equal(first.kind, 'proceed');
  await first.finish(200, { success: true, newStatus: 'declined' });

  const replay = await claimIdempotency({ store, storageKey: 'curator:idem:hedwig:k1', bodyHash: hash });
  assert.equal(replay.kind, 'replay');
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.payload.newStatus, 'declined');

  const other = idempotencyBodyHash('POST', '/api/scan/entries/1/action', { action: 'decline', reason: 'different' });
  const conflict = await claimIdempotency({ store, storageKey: 'curator:idem:hedwig:k1', bodyHash: other });
  assert.equal(conflict.kind, 'conflict');
  assert.equal(conflict.statusCode, 409);
});

test('GET /queue omits the score predicate when minScore is null', async () => {
  assert.deepEqual(resolveQueueMinScore(undefined), { ok: true, minScore: null });
  assert.equal(resolveQueueMinScore('').ok, true);
  assert.equal(resolveQueueMinScore('nope').ok, false);
  assert.deepEqual(resolveQueueMinScore('40'), { ok: true, minScore: 40 });

  let sql = '';
  const pool = { query: async (text) => { sql = text; return { rows: [] }; } };
  await getDailyQueue(pool, null, null, '2026-10-01');
  assert.match(sql, /status IN \('queued'\)/);
  assert.doesNotMatch(sql, /quality_score >=/);

  await getDailyQueue(pool, 'ai', 40, '2026-10-01');
  assert.match(sql, /quality_score >= \$2/);
  assert.match(sql, /wire = \$3/);
});

test('curator route decline calls entry-actions; a stamp-only caller does not', async () => {
  const calls = [];
  const declineEntry = async (id, opts) => {
    calls.push({ id, opts });
    return { newStatus: 'declined' };
  };
  const writeStamp = async () => true;

  const curatorPlan = planCuratorWrite({
    isCurator: true, route: 'decline', confidence: 'high', rationale: 'pitch', by: 'agent:hedwig',
  });
  assert.equal(curatorPlan.decline, true);
  const declined = await applyCuratorWrite({
    entryId: 9, plan: curatorPlan, actor: 'agent:hedwig', reason: 'pitch', declineEntry, writeStamp,
  });
  assert.equal(declined.status, 'declined');
  assert.equal(calls[0].opts.quiet, true);
  assert.equal(calls[0].opts.force, false);
  assert.equal(calls[0].opts.reason, 'pitch');

  const stampOnly = planCuratorWrite({
    isCurator: false, route: 'decline', confidence: 'low', rationale: 'note', by: 'agent:stringer',
  });
  assert.equal(stampOnly.decline, false);
  const stamped = await applyCuratorWrite({
    entryId: 9, plan: stampOnly, declineEntry, writeStamp,
  });
  assert.equal(stamped.status, undefined);
  assert.equal(calls.length, 1);
});

test('EA Forum extract keeps a program-shaped name and does not force wire ai', () => {
  assert.equal(
    deriveForumPostName('Long-Term Future Fund: applications open for the next round', ''),
    'Long-Term Future Fund',
  );
  const ea = SOURCE_REGISTRY.find(s => s.key === 'ea-forum-funding');
  const named = ea.extract({
    title: 'Long-Term Future Fund: applications open for the next round',
    pageUrl: 'https://forum.effectivealtruism.org/posts/abc',
    contents: { plaintextDescription: 'The fund is open.' },
    postedAt: '2026-09-01T00:00:00.000Z',
  });
  assert.equal(named.name, 'Long-Term Future Fund');
  assert.equal(named.metadata.forum_title, 'Long-Term Future Fund: applications open for the next round');

  const oss = ea.extract({
    title: 'NLnet open call for open source maintainers',
    pageUrl: 'https://forum.effectivealtruism.org/posts/def',
    contents: { plaintextDescription: 'NLnet funds open source maintainers.' },
  });
  assert.equal(oss.wire, 'oss');
  assert.equal(oss.name, 'NLnet open call for open source maintainers');

  const headline = ea.extract({
    title: 'Why this funding round surprised me',
    pageUrl: 'https://forum.effectivealtruism.org/posts/ghi',
    contents: { plaintextDescription: 'A personal note about last week.' },
  });
  assert.equal(headline.name, 'Why this funding round surprised me');
  assert.equal(headline.wire, 'ai');
});

function invoke(method, path, bearer) {
  return new Promise((resolve) => {
    const req = { method, originalUrl: path, path, headers: { authorization: `Bearer ${bearer}` } };
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; resolve({ status: this.statusCode, body: payload, next: false }); },
    };
    requireAuthOrInternalKey(req, res, () => resolve({ status: null, next: true, session: req.agentSession }));
  });
}

test('a malformed curator list is 503, and an internal key still passes', async () => {
  const prev = process.env.WIRE_ROOM_CURATOR_KEYS;
  const prevKey = process.env.INTERNAL_API_KEY;
  process.env.WIRE_ROOM_CURATOR_KEYS = '{';
  process.env.INTERNAL_API_KEY = 'internal-test-key-not-secret';
  try {
    const denied = await invoke('GET', '/api/scan/queue', 'not-a-real-token');
    assert.equal(denied.status, 503);
    assert.equal(denied.body.error, 'curator_unavailable');
    const allowed = await invoke('POST', '/api/feeds/run', 'internal-test-key-not-secret');
    assert.equal(allowed.next, true);
    assert.equal(allowed.session.userId, 'agent:stringer');
    assert.equal(allowed.session.curator, undefined);
  } finally {
    if (prev === undefined) delete process.env.WIRE_ROOM_CURATOR_KEYS;
    else process.env.WIRE_ROOM_CURATOR_KEYS = prev;
    if (prevKey === undefined) delete process.env.INTERNAL_API_KEY;
    else process.env.INTERNAL_API_KEY = prevKey;
  }
});
