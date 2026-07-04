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
  assert.equal(extracted, 0);
  await runRegistryWatch({}, { dryRun: true }, deps);  // unchanged
  assert.equal(extracted, 0);
  page = '<p>Grants: OPEN — apply now</p>';
  const r = await runRegistryWatch({}, { dryRun: true }, deps); // changed -> extract, but dryRun blocks intake
  assert.equal(extracted, 1);
  assert.equal(r.diff.changed, 1);
});

test('budget check failure fails CLOSED: change recorded, state advanced, zero extraction, no throw', async () => {
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
  page = '<p>Grants: OPEN</p>';
  const r = await runRegistryWatch({}, { dryRun: true }, deps); // changed, but budget probe throws
  assert.equal(extracted, 0);                                   // fail closed: no spend
  assert.equal(r.diff.changed, 1);                              // change still counted
  assert.ok(marked.some(m => m.id === 3 && m.changed === true)); // ...and recorded via markChecked
  assert.equal(st.map.get('ws:hash:3'), require('../src/services/registry-watchers').contentHash(page)); // hash advanced to the new page
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
