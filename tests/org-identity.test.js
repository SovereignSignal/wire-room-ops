require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { extractOrgFromName, canonicalizeOrgName, findSimilarOrg, runOrgExtraction } = require('../src/services/org-extractor');

test('title extraction preserves Google.org and Google DeepMind before separators', () => {
  assert.equal(extractOrgFromName('Google.org Impact Challenge: AI for Science'), 'Google.org');
  assert.equal(extractOrgFromName('Google.org Impact Challenge: AI for Science — $30 million'), 'Google.org');
  assert.equal(extractOrgFromName('Google DeepMind Multi-Agent AI Safety Research Fund'), 'Google DeepMind');
  assert.equal(extractOrgFromName('Google DeepMind — research grants'), 'Google DeepMind');
  assert.equal(extractOrgFromName('DeepMind: research grants'), 'Google DeepMind');
  assert.equal(extractOrgFromName('Google Research Scholar Program'), 'Google');
  assert.equal(extractOrgFromName('[Google.org] — Impact Challenge: AI for Science'), 'Google.org');
  assert.equal(extractOrgFromName('[Mozilla Foundation — Democracy x AI Cohort] — grants'), 'Mozilla Foundation');
});

test('title aliases require a boundary and preserve existing specific program prefixes', () => {
  assert.equal(extractOrgFromName('Basecamp grant funding'), null);
  assert.equal(extractOrgFromName('Meta-Labs research grant'), null);
  assert.equal(extractOrgFromName('Meta - research grant'), 'Meta');
  assert.equal(extractOrgFromName('Database Labs — research funding'), 'Database Labs');
  assert.equal(extractOrgFromName('Rocket Pool GMC Round 40 — results'), 'Rocket Pool');
  assert.equal(extractOrgFromName('  GOOGLE   DEEPMIND research grants'), 'Google DeepMind');
});

test('organization-name normalization uses whole aliases without absorbing other entities', () => {
  assert.equal(canonicalizeOrgName('google.org'), 'Google.org');
  assert.equal(canonicalizeOrgName('[Google.org]'), 'Google.org');
  assert.equal(canonicalizeOrgName('Google DeepMind'), 'Google DeepMind');
  assert.equal(canonicalizeOrgName('deepmind'), 'Google DeepMind');
  assert.equal(canonicalizeOrgName('Database Labs'), 'Database Labs');
  assert.equal(canonicalizeOrgName('Metamorphic Research Foundation'), 'Metamorphic Research Foundation');
  assert.equal(canonicalizeOrgName('Google.org Partner Foundation'), 'Google.org Partner Foundation');
});

function orgRows(t, rows) {
  t.mock.method(db, 'getPool', () => ({ query: async () => ({ rows }) }));
}

test('profile lookup prefers exact names over another profile alias regardless of row order', async t => {
  for (const rows of [
    [{ id: 1, name: 'Google', aliases: ['Google.org'] }, { id: 2, name: 'Google.org' }],
    [{ id: 2, name: 'Google.org' }, { id: 1, name: 'Google', aliases: ['Google.org'] }],
  ]) {
    orgRows(t, rows);
    assert.deepEqual(await findSimilarOrg(' GOOGLE.ORG '), { id: 2, name: 'Google.org' });
  }
});

test('profile lookup accepts unique recorded aliases and whole-name canonical aliases', async t => {
  orgRows(t, [{ id: 1, name: 'Arbitrum Foundation' }, { id: 2, name: 'Example Foundation', aliases: ['Example Fund'] }]);
  assert.deepEqual(await findSimilarOrg('Arbitrum'), { id: 1, name: 'Arbitrum Foundation' });
  assert.deepEqual(await findSimilarOrg(' Example  Fund '), { id: 2, name: 'Example Foundation' });
});

test('profile lookup refuses substring, punctuation and shared-token identity guesses', async t => {
  orgRows(t, [{ id: 1, name: 'Google' }, { id: 2, name: 'Open Research Foundation' }, { id: 3, name: 'A-B Labs' }]);
  assert.equal(await findSimilarOrg('Google.org'), null);
  assert.equal(await findSimilarOrg('Google DeepMind'), null);
  assert.equal(await findSimilarOrg('Open Research Institute'), null);
  assert.equal(await findSimilarOrg('AB Labs'), null);
  assert.equal(await findSimilarOrg('  '), null);
});

test('ambiguous aliases and case-variant names abort instead of selecting a profile', async t => {
  orgRows(t, [{ id: 1, name: 'First Foundation', aliases: ['Shared Name'] }, { id: 2, name: 'Second Foundation', aliases: ['Shared Name'] }]);
  await assert.rejects(findSimilarOrg('Shared Name'), /Ambiguous organization match/);
  orgRows(t, [{ id: 1, name: 'Example Foundation' }, { id: 2, name: 'EXAMPLE FOUNDATION' }]);
  await assert.rejects(findSimilarOrg('Example Foundation'), /Ambiguous organization match/);
});

test('batch extraction preserves an unlinked entry when profile identity is ambiguous', async t => {
  const calls = [];
  t.mock.method(db, 'getPool', () => ({ query: async sql => {
    calls.push(sql);
    if (/FROM scan_entries/.test(sql)) return { rows: [{ id: 1, name: 'Google.org Impact Challenge: AI for Science', description: '', wire: 'ai' }] };
    if (/FROM org_profiles/.test(sql)) return { rows: [{ id: 1, name: 'Google.org' }, { id: 2, name: 'GOOGLE.ORG' }] };
    throw new Error('Unexpected write');
  } }));
  const stats = await runOrgExtraction();
  assert.deepEqual(stats, { processed: 1, linked: 0, newOrgs: 0, errors: 1 });
  assert.equal(calls.some(sql => /UPDATE|INSERT|DELETE|ALTER|CREATE/.test(sql)), false);
});

test('automatic lookup refuses enriched program profiles and their aliases', async t => {
  orgRows(t, [{ id: 1, name: 'Laude Institute Moonshot Program', aliases: ['Laude Institute'], org_type: 'Non-Profit/NGO', website: 'https://example.org', description: 'Enriched program' }]);
  await assert.rejects(findSimilarOrg('Laude Institute Moonshot Program'), /requires review/);
  await assert.rejects(findSimilarOrg('Laude Institute'), /requires review/);
});

test('explicit recorded aliases can still identify a genuine organization', async t => {
  orgRows(t, [{ id: 1, name: 'Example Foundation', aliases: ['Example Scholarship Program'] }]);
  assert.deepEqual(await findSimilarOrg('Example Scholarship Program'), { id: 1, name: 'Example Foundation' });
});

test('a rejected exact program profile does not silently fall through to another identity', async t => {
  orgRows(t, [{ id: 1, name: 'Example Scholarship Program' }, { id: 2, name: 'Example Foundation', aliases: ['Example Scholarship Program'] }]);
  await assert.rejects(findSimilarOrg('Example Scholarship Program'), /requires review/);
});

test('Grok fallback cannot return a program as the funding organization', async t => {
  const provider = require('../src/services/api-provider');
  const { extractOrgsFromEntries } = require('../src/services/org-extractor');
  t.mock.method(provider, 'getCachedProvider', () => ({ api_key: 'test-only', base_url: 'https://provider.invalid' }));
  t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify([
    { id: 1, org: 'Example Scholar Program' }, { id: 2, org: 'Example Research Grants' },
    { id: 3, org: 'Example Foundation' }, { id: 4, org: 'United Nations Development Programme' },
  ]) } }] }) }));
  const result = await extractOrgsFromEntries([1,2,3,4].map(id => ({ id, name: 'Unresolved opportunity', description: '', wire: 'ai' })));
  assert.deepEqual(result.map(x => x.orgName), [null, null, 'Example Foundation', 'United Nations Development Programme']);
});

test('ambiguous Base titles abstain while explicit and reviewed Coinbase programs resolve', () => {
  for (const name of ['BASE Fellowship Fall 2026', 'Base Fellowship — apply', '[BASE] Fellowship', 'base: grants', 'Base Research — fellowship', 'BASE']) {
    assert.equal(extractOrgFromName(name), null, name);
  }
  for (const name of ['Base (Coinbase) — grants', 'Base Batches 003 Startup Track', 'Base Ecosystem Fund Request for Builders']) {
    assert.equal(extractOrgFromName(name), 'Base (Coinbase)', name);
  }
  assert.equal(canonicalizeOrgName('BASE'), 'BASE');
  assert.equal(canonicalizeOrgName('Base'), 'Base');
  assert.equal(extractOrgFromName('Base Batcheship — funding'), null);
});

test('reviewed program titles resolve owners without normalizing programs into organizations', () => {
  const { isProgramOrgName, shouldArchiveOrgProfile } = require('../src/services/org-extractor');
  for (const [name, owner] of [['BNB Hack', 'BNB Chain'], ['Acquia Fair Trade Initiative', 'Acquia']]) {
    assert.equal(extractOrgFromName(`${name}: applications`), owner);
    assert.equal(extractOrgFromName(`  ${name.toUpperCase()} — support`), owner);
    assert.equal(canonicalizeOrgName(name), name);
    assert.equal(isProgramOrgName(name), true);
    assert.equal(shouldArchiveOrgProfile({ name }), false);
  }
  for (const name of ['Hack Club', 'Community Initiatives', 'Chan Zuckerberg Initiative']) {
    assert.equal(isProgramOrgName(name), false, name);
  }
});

test('bare Base cannot select a profile through exact names or recorded aliases', async t => {
  orgRows(t, [{ id: 1, name: 'BASE' }, { id: 2, name: 'Base (Coinbase)', aliases: ['base'] }]);
  await assert.rejects(findSimilarOrg('BASE'), /requires review/);
  await assert.rejects(findSimilarOrg('base'), /requires review/);
  assert.deepEqual(await findSimilarOrg('Base (Coinbase)'), { id: 2, name: 'Base (Coinbase)' });
  orgRows(t, [{ id: 1, name: 'BASE', aliases: ['Black in AI Safety and Ethics'] }]);
  await assert.rejects(findSimilarOrg('Black in AI Safety and Ethics'), /requires review/);
});

test('reviewed program profiles cannot be reused through enrichment or owner aliases', async t => {
  for (const [name, owner] of [['BNB Hack', 'BNB Chain'], ['Acquia Fair Trade Initiative', 'Acquia']]) {
    orgRows(t, [{ id: 1, name, aliases: [owner], website: 'https://example.test', description: 'Previously enriched' }]);
    await assert.rejects(findSimilarOrg(name), /requires review/);
    await assert.rejects(findSimilarOrg(owner), /requires review/);
  }
});

test('unresolved Base identity cannot be overridden by model fallback or an extra model result', async t => {
  const provider = require('../src/services/api-provider');
  const { extractOrgsFromEntries } = require('../src/services/org-extractor');
  t.mock.method(provider, 'getCachedProvider', () => ({ api_key: 'test-only', base_url: 'https://provider.invalid' }));
  const requests = [];
  t.mock.method(global, 'fetch', async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify([
      { id: 1, org: 'Base (Coinbase)' }, { id: 2, org: 'BNB Hack' },
      { id: 3, org: 'Acquia Fair Trade Initiative' }, { id: 4, org: 'BASE' }, { id: 5, org: 'Example Foundation' },
    ]) } }] }) };
  });
  const result = await extractOrgsFromEntries([1,2,3,4,5].map(id => ({ id, name: id === 1 ? 'BASE Fellowship Fall 2026' : 'Unresolved opportunity', description: '', wire: 'ai' })));
  assert.deepEqual(result.map(x => [x.entryId, x.orgName]), [[1,null],[2,null],[3,null],[4,null],[5,'Example Foundation']]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].messages[0].content.includes('BASE Fellowship'), false);
});


test('Colosseum event titles resolve to their owner without reusing event profiles', async t => {
  for (const title of ["Colosseum Crypto World's Fair — Superteam Argentina Track", "Colosseum Crypto World’s Fair Zcash Track", "Crypto World's Fair — Colosseum", "Crypto World’s Fair — Colosseum"]) {
    assert.equal(extractOrgFromName(title), 'Colosseum', title);
  }
  assert.equal(extractOrgFromName('ColosseumX grants'), null);
  assert.equal(extractOrgFromName("Crypto World's Fairground grants"), null);
  orgRows(t, [{ id: 1, name: "Crypto World's Fair" }, { id: 2, name: 'Colosseum' }]);
  await assert.rejects(findSimilarOrg("Crypto World's Fair"), /requires review/);
  assert.deepEqual(await findSimilarOrg('Colosseum'), {id: 2, name: 'Colosseum'});
});


test('Rust Foundation grant titles resolve the existing organization without absorbing lookalikes', () => {
  for (const title of ['Rust Foundation Fellowship Grants Program', 'Rust Foundation Community Grants Program']) {
    assert.equal(extractOrgFromName(title), 'Rust Foundation');
  }
  assert.equal(extractOrgFromName('Rust Foundationary Research Grants'), null);
  assert.equal(canonicalizeOrgName('rust foundation'), 'Rust Foundation');
});
