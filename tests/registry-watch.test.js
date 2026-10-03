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
  assert.equal(r2.mode, 'live');
  assert.equal(r2.submitted, 1);
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
  const r = await runRegistryWatch({}, { dryRun: true }, deps); // changed -> extract, store hash, no intake
  assert.equal(extracted, 1);
  assert.equal(r.diff.changed, 1);
  assert.equal(r.mode, 'dry-run');
  assert.equal(r.submitted, 0);
  assert.equal(r.pending, 1);
  assert.equal(r.deferred_surfaces, 0);
  assert.equal(st.map.get('ws:hash:2'), require('../src/services/registry-watchers').contentHash(page));
  assert.deepEqual(st.map.get('ws:seen:2').urls, ['https://g.org/apply']);
  const pending = st.map.get('registry-watch:pending');
  assert.equal(pending.itemCount, 1);
  assert.equal(pending.items[0].title, 'Fresh grant');
  assert.equal(pending.items[0].url, 'https://g.org/apply');
  assert.equal(pending.items[0].org, 'Org2');
  assert.equal(pending.items[0].wire, 'oss');
  assert.equal(pending.items[0].reason, 'Page content changed');
  const again = await runRegistryWatch({}, { dryRun: true }, deps);
  assert.equal(extracted, 1, 'a stored hash must not pay for the same page again');
  assert.equal(again.pending, 0);
  assert.equal(st.map.get('registry-watch:pending').items.length, 1, 'a quiet run keeps the last review copy');
  assert.equal(st.map.get('registry-watch:pending').lastRunItemCount, 0);
  assert.notEqual(st.map.get('ws:hash:2'), baselineHash);
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
  assert.equal(r.diff.errors, 1);
  assert.equal(r.deferred_surfaces, 1);
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
    pace: async () => {},
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

test('diff lane: scrape fallback is capped per run — excess failures fail fast without scraping', async () => {
  const st = state();
  let scraped = 0;
  const surfaces = Array.from({ length: 17 }, (_, i) => S(100 + i, 'grants_page', `https://blocked${i}.org/grants`));
  const deps = {
    getDue: async (_p, types) => (types.includes('grants_page') ? surfaces : []),
    fetchPage: async () => { throw new Error('HTTP 403'); },
    scrapePage: async () => { scraped++; return '# page'; },
    pace: async () => {},
    fetchSourceImpl: async () => [],
    intake: async () => {},
    mark: async () => {},
    budget: async () => ({ allowed: true, spentUsd: 0, capUsd: 20 }),
    getState: st.get, setState: st.set,
  };
  const r = await runRegistryWatch({}, { dryRun: true }, deps);
  assert.equal(scraped, 15, 'fallback scrapes must stop at the per-run cap');
  assert.equal(r.diff.errors, 2, 'surfaces beyond the cap record plain failures');
});

test('diff lane: consecutive Firecrawl calls are paced to respect the free-tier rate limit', async () => {
  const st = state();
  const paced = [];
  const deps = {
    getDue: async (_p, types) => (types.includes('grants_page') ? [S(30, 'grants_page', 'https://w1.org/g'), S(31, 'grants_page', 'https://w2.org/g')] : []),
    fetchPage: async () => { throw new Error('HTTP 403'); }, // both surfaces take the scrape fallback
    scrapePage: async (u) => `# page ${u}`,
    fetchSourceImpl: async () => [],
    intake: async () => {},
    mark: async () => {},
    budget: async () => ({ allowed: true, spentUsd: 0, capUsd: 20 }),
    pace: async (ms) => { paced.push(ms); },
    getState: st.get, setState: st.set,
  };
  await runRegistryWatch({}, { dryRun: true }, deps);
  assert.equal(paced.length, 1, 'second Firecrawl call is paced; the first is not');
  assert.ok(paced[0] >= 5000, 'pace must be a real rate-limit gap, not a token delay');
});

test('first live run marks the backlog seen and submits only items published after go-live', async () => {
  const st = state();
  st.map.set('ws:seen:11', { urls: ['https://old.example/seed'], lastRun: '2020-01-01T00:00:00.000Z' });
  const items = [
    { name: 'Old call', description: 'd', url: 'https://old.example/old', amount: null, deadline: null, publishedAt: '2020-06-01T00:00:00.000Z' },
    { name: 'New call', description: 'd', url: 'https://old.example/new', amount: null, deadline: null, publishedAt: '2099-01-01T00:00:00.000Z' },
    { name: 'Undated', description: 'd', url: 'https://old.example/undated', amount: null, deadline: null, publishedAt: null },
  ];
  const submitted = [];
  const deps = {
    getDue: async (_p, types) => (types.includes('rss') ? [S(11, 'rss', 'https://old.example/feed')] : []),
    fetchSourceImpl: async () => items,
    intake: async (_p, subs) => { submitted.push(subs); return { newUnique: 1 }; },
    mark: async () => {},
    getState: st.get, setState: st.set,
  };
  const r = await runRegistryWatch({}, { dryRun: false }, deps);
  assert.equal(r.submitted, 1);
  assert.equal(submitted[0][0].results[0].sourceUrl, 'https://old.example/new');
  const seen = st.map.get('ws:seen:11').urls;
  assert.ok(seen.includes('https://old.example/old'));
  assert.ok(seen.includes('https://old.example/undated'));
  assert.ok(st.map.get('registry-watch:live-since'));

  items.push({ name: 'Later', description: 'd', url: 'https://old.example/later', amount: null, deadline: null, publishedAt: null });
  const r2 = await runRegistryWatch({}, { dryRun: false }, deps);
  assert.equal(r2.submitted, 1);
  assert.equal(submitted[1][0].results[0].sourceUrl, 'https://old.example/later');
});

test('REGISTRY_WATCH_SUBMIT_BACKLOG submits the pre-go-live items on the first live run', async () => {
  process.env.REGISTRY_WATCH_SUBMIT_BACKLOG = 'true';
  try {
    const st = state();
    st.map.set('ws:seen:12', { urls: ['https://back.example/seed'], lastRun: '2020-01-01T00:00:00.000Z' });
    const items = [
      { name: 'Old', description: 'd', url: 'https://back.example/old', amount: null, deadline: null, publishedAt: '2020-01-02T00:00:00.000Z' },
      { name: 'Undated', description: 'd', url: 'https://back.example/undated', amount: null, deadline: null, publishedAt: null },
    ];
    const submitted = [];
    const deps = {
      getDue: async (_p, types) => (types.includes('rss') ? [S(12, 'rss', 'https://back.example/feed')] : []),
      fetchSourceImpl: async () => items,
      intake: async (_p, subs) => { submitted.push(subs); return { newUnique: 2 }; },
      mark: async () => {},
      getState: st.get, setState: st.set,
    };
    const r = await runRegistryWatch({}, { dryRun: false }, deps);
    assert.equal(r.submitted, 2);
    assert.equal(submitted[0][0].results.length, 2);
  } finally {
    delete process.env.REGISTRY_WATCH_SUBMIT_BACKLOG;
  }
});

test('fil.org skips the plain fetch and scrapes once', async () => {
  const st = state();
  let plain = 0;
  let scraped = 0;
  const deps = {
    getDue: async (_p, types) => (types.includes('grants_page') ? [S(13, 'grants_page', 'https://fil.org/grants')] : []),
    fetchPage: async () => { plain++; throw new Error('must not plain-fetch fil.org'); },
    scrapePage: async () => { scraped++; return '<p>Filecoin grants</p>'; },
    pace: async () => {},
    fetchSourceImpl: async () => [],
    intake: async () => { throw new Error('must not intake'); },
    mark: async () => {},
    getState: st.get, setState: st.set,
  };
  const r = await runRegistryWatch({}, { dryRun: true }, deps);
  assert.equal(plain, 0);
  assert.equal(scraped, 1);
  assert.equal(r.diff.errors, 0);
  assert.ok(st.map.get('ws:hash:13'));
  await runRegistryWatch({}, { dryRun: true }, deps);
  assert.equal(plain, 0);
  assert.equal(scraped, 2, 'the daily hash check still reads the page once');
  assert.equal(r.diff.extracted || 0, 0, 'an unchanged page is not extracted');
});

test('HTTP 429 backs off once and does not retry the plain fetch', async () => {
  const st = state();
  let plain = 0;
  let scraped = 0;
  const paced = [];
  const deps = {
    getDue: async (_p, types) => (types.includes('grants_page') ? [S(14, 'grants_page', 'https://example.org/grants')] : []),
    fetchPage: async () => { plain++; throw new Error('HTTP 429'); },
    scrapePage: async () => { scraped++; return '<p>grants</p>'; },
    pace: async (ms) => { paced.push(ms); },
    fetchSourceImpl: async () => [],
    intake: async () => {},
    mark: async () => {},
    getState: st.get, setState: st.set,
  };
  const r = await runRegistryWatch({}, { dryRun: true }, deps);
  assert.equal(plain, 1);
  assert.equal(scraped, 1);
  assert.equal(r.diff.errors, 0);
  assert.equal(paced.length, 1);
  assert.ok(paced[0] >= 5000);
});
