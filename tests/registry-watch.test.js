require('ts-node/register/transpile-only');
process.env.DATABASE_URL = 'postgres://invalid:invalid@127.0.0.1:1/invalid';
process.env.REGISTRY_WATCH_ENABLED = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runRegistryWatch } = require('../src/jobs/registry-watch');

const S = (id, type, url) => ({ id, org_name: 'Org' + id, wire: 'oss', surface_type: type, url, tier: 'Tier 1' });
const state = () => { const m = new Map(); return { get: async k => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); }, map: m }; };

test('rss lane: first run baselines (marks seen, submits nothing), second run submits fresh', async () => {
  const st = state();
  const marked = [];
  const items1 = [{ name: 'Old call', description: 'd', url: 'https://o.org/a', amount: null, deadline: null, publishedAt: null }];
  const items2 = [...items1, { name: 'New call', description: 'd', url: 'https://o.org/b', amount: null, deadline: null, publishedAt: null }];
  let fetchCount = 0;
  const deps = {
    getDue: async (_p, types) => (types.includes('rss') ? [S(1, 'rss', 'https://o.org/feed')] : []),
    fetchSourceImpl: async () => (++fetchCount === 1 ? items1 : items2),
    intake: async (_pool, subs) => { deps.submitted = subs; return { newUnique: 1 }; },
    mark: async (_p, id, o) => marked.push({ id, ...o }),
    getState: st.get, setState: st.set,
  };
  const r1 = await runRegistryWatch({}, { dryRun: false }, deps);
  assert.equal(r1.rss.fresh, 0); // baseline
  assert.equal(deps.submitted, undefined);
  const r2 = await runRegistryWatch({}, { dryRun: false }, deps);
  assert.equal(r2.rss.fresh, 1);
  assert.ok(deps.submitted && deps.submitted.length === 1);
  assert.equal(deps.submitted[0].results[0].sourceUrl, 'https://o.org/b');
  assert.ok(marked.every(m => m.id === 1));
});

test('diff lane: unchanged page extracts nothing; changed page extracts once and respects dryRun', async () => {
  const st = state();
  let page = '<p>Grants: none open</p>';
  let extracted = 0;
  const deps = {
    getDue: async (_p, types) => (types.includes('grants_page') ? [S(2, 'grants_page', 'https://g.org/grants')] : []),
    fetchPage: async () => page,
    fetchSourceImpl: async () => { extracted++; return [{ name: 'Fresh grant', description: 'd', url: 'https://g.org/apply', amount: null, deadline: null, publishedAt: null }]; },
    intake: async () => { throw new Error('must not intake in dryRun'); },
    mark: async () => {},
    budget: async () => ({ allowed: true, spentUsd: 0, capUsd: 20 }),
    getState: st.get, setState: st.set,
  };
  await runRegistryWatch({}, { dryRun: true }, deps);  // baseline hash stored
  const baselineHash = st.map.get('ws:hash:2');
  assert.equal(extracted, 0);
  await runRegistryWatch({}, { dryRun: true }, deps);  // unchanged
  assert.equal(extracted, 0);
  page = '<p>Grants: OPEN — apply now</p>';
  const r = await runRegistryWatch({}, { dryRun: true }, deps); // changed -> extract, but dryRun blocks intake
  assert.equal(extracted, 1);
  assert.equal(r.diff.changed, 1);
  assert.equal(st.map.get('ws:hash:2'), baselineHash, 'dry-run must leave changed content available for a live intake');
  assert.equal(st.map.has('ws:seen:2'), false);
});

test('budget check failure fails closed and leaves the changed hash retryable', async () => {
  const st = state();
  let page = '<p>Grants: none open</p>';
  let extracted = 0;
  const marked = [];
  const deps = {
    getDue: async (_p, types) => (types.includes('grants_page') ? [S(3, 'grants_page', 'https://b.org/grants')] : []),
    fetchPage: async () => page,
    fetchSourceImpl: async () => { extracted++; return []; },
    intake: async () => { throw new Error('must not intake'); },
    mark: async (_p, id, o) => marked.push({ id, ...o }),
    budget: async () => { throw new Error('db down'); },
    getState: st.get, setState: st.set,
  };
  await runRegistryWatch({}, { dryRun: true }, deps);  // baseline hash stored
  const baselineHash = st.map.get('ws:hash:3');
  page = '<p>Grants: OPEN</p>';
  const r = await runRegistryWatch({}, { dryRun: true }, deps); // changed, but budget probe throws
  assert.equal(extracted, 0);                                   // fail closed: no spend
  assert.equal(r.diff.changed, 1);                              // change still counted
  assert.ok(marked.some(m => m.id === 3 && m.changed === true)); // ...and recorded via markChecked
  assert.equal(st.map.get('ws:hash:3'), baselineHash, 'failed budget probe must not consume the page change');
});

test('rss lane checkpoints fresh URLs only after intake succeeds', async () => {
  const st = state();
  const oldItem = { name: 'Old call', description: 'd', url: 'https://retry.org/a', amount: null, deadline: null, publishedAt: null };
  const newItem = { name: 'New call', description: 'd', url: 'https://retry.org/b', amount: null, deadline: null, publishedAt: null };
  let items = [oldItem];
  let failIntake = false;
  let intakeCalls = 0;
  const deps = {
    getDue: async (_p, types) => (types.includes('rss') ? [S(4, 'rss', 'https://retry.org/feed')] : []),
    fetchSourceImpl: async () => items,
    intake: async () => {
      intakeCalls++;
      if (failIntake) throw new Error('temporary intake outage');
      return { newUnique: 1 };
    },
    mark: async () => {},
    getState: st.get, setState: st.set,
  };

  await runRegistryWatch({}, { dryRun: false }, deps); // baseline
  items = [oldItem, newItem];
  failIntake = true;
  await assert.rejects(runRegistryWatch({}, { dryRun: false }, deps), /temporary intake outage/);
  assert.deepEqual(st.map.get('ws:seen:4').urls, ['https://retry.org/a'], 'failed intake must leave the prior watermark intact');

  failIntake = false;
  const retried = await runRegistryWatch({}, { dryRun: false }, deps);
  assert.equal(retried.rss.fresh, 1);
  assert.equal(intakeCalls, 2, 'the same fresh URL must be retried');
  assert.deepEqual(st.map.get('ws:seen:4').urls, ['https://retry.org/a', 'https://retry.org/b']);
});

test('first HTML change submits extracted items and checkpoints hash only after intake', async () => {
  const st = state();
  let page = '<p>No grants open</p>';
  let failIntake = true;
  const submissions = [];
  const deps = {
    getDue: async (_p, types) => (types.includes('grants_page') ? [S(5, 'grants_page', 'https://first-change.org/grants')] : []),
    fetchPage: async () => page,
    fetchSourceImpl: async () => [{ name: 'First changed grant', description: 'd', url: 'https://first-change.org/apply', amount: null, deadline: null, publishedAt: null }],
    intake: async (_pool, subs) => {
      submissions.push(subs);
      if (failIntake) throw new Error('intake unavailable');
      return { newUnique: 1 };
    },
    mark: async () => {},
    budget: async () => ({ allowed: true, spentUsd: 0, capUsd: 20 }),
    getState: st.get, setState: st.set,
  };

  await runRegistryWatch({}, { dryRun: false }, deps); // free hash baseline, no extraction
  const baselineHash = st.map.get('ws:hash:5');
  page = '<p>Applications now open</p>';

  await assert.rejects(runRegistryWatch({}, { dryRun: false }, deps), /intake unavailable/);
  assert.equal(submissions[0][0].results[0].sourceUrl, 'https://first-change.org/apply', 'first change must not become a second baseline');
  assert.equal(st.map.get('ws:hash:5'), baselineHash, 'failed intake must leave the changed hash retryable');
  assert.equal(st.map.has('ws:seen:5'), false);

  failIntake = false;
  await runRegistryWatch({}, { dryRun: false }, deps);
  assert.equal(submissions.length, 2, 'changed page must be retried after intake recovery');
  assert.equal(st.map.get('ws:hash:5'), require('../src/services/registry-watchers').contentHash(page));
  assert.deepEqual(st.map.get('ws:seen:5').urls, ['https://first-change.org/apply']);
});

test('disabled gate returns ran:false without touching deps', async () => {
  process.env.REGISTRY_WATCH_ENABLED = 'false';
  delete require.cache[require.resolve('../src/jobs/registry-watch')];
  delete require.cache[require.resolve('../src/config')];
  const { runRegistryWatch: rw } = require('../src/jobs/registry-watch');
  const r = await rw({}, {}, { getDue: async () => { throw new Error('must not select'); } });
  assert.equal(r.ran, false);
  process.env.REGISTRY_WATCH_ENABLED = 'true';
});

// --- Scrape fallback (2026-08-01): OpenAI, Octant, Aptos and Starknet serve
// their pages to browsers but 403/429/TLS-block a plain fetch from datacenter
// IPs. The diff lane falls back to a Firecrawl scrape for change-detection
// content — one paid call per failing surface per run, still capped and
// budget-gated downstream.

test('diff lane: plain-fetch failure falls back to scrapePage and the surface stays healthy', async () => {
  const st = state();
  const marked = [];
  let scraped = 0;
  let extracted = 0;
  let md = '# Grants\nnone open';
  const deps = {
    getDue: async (_p, types) => (types.includes('grants_page') ? [S(7, 'grants_page', 'https://blocked.org/grants')] : []),
    fetchPage: async () => { throw new Error('HTTP 403'); },
    scrapePage: async () => { scraped++; return md; },
    fetchSourceImpl: async () => { extracted++; return [{ name: 'G', description: 'd', url: 'https://blocked.org/apply', amount: null, deadline: null, publishedAt: null }]; },
    intake: async () => { throw new Error('must not intake in dryRun'); },
    mark: async (_p, id, o) => marked.push({ id, ...o }),
    budget: async () => ({ allowed: true, spentUsd: 0, capUsd: 20 }),
    getState: st.get, setState: st.set,
  };
  const r1 = await runRegistryWatch({}, { dryRun: true }, deps); // baseline via scrape
  assert.equal(r1.diff.errors, 0);
  assert.equal(scraped, 1);
  assert.ok(st.map.get('ws:hash:7'), 'scraped content must baseline the hash');
  assert.ok(marked.every(m => m.failed !== true), 'fallback success must not record a failure');
  md = '# Grants\nOPEN — apply now';
  const r2 = await runRegistryWatch({}, { dryRun: true }, deps); // changed via scrape
  assert.equal(r2.diff.changed, 1);
  assert.equal(extracted, 1);
});

test('diff lane: when both plain fetch and scrape fail, the surface records a failure', async () => {
  const st = state();
  const marked = [];
  const deps = {
    getDue: async (_p, types) => (types.includes('grants_page') ? [S(8, 'grants_page', 'https://down.org/grants')] : []),
    fetchPage: async () => { throw new Error('HTTP 403'); },
    scrapePage: async () => { throw new Error('scrape failed: Firecrawl API error: 429'); },
    fetchSourceImpl: async () => [],
    intake: async () => {},
    mark: async (_p, id, o) => marked.push({ id, ...o }),
    getState: st.get, setState: st.set,
  };
  const r = await runRegistryWatch({}, { dryRun: true }, deps);
  assert.equal(r.diff.errors, 1);
  assert.ok(marked.some(m => m.id === 8 && m.failed === true));
});
