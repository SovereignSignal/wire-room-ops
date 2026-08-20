require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyOrgName,
  shouldArchiveOrgProfile,
  extractOrgFromName,
} = require('../src/services/org-extractor');
const { runOrgCleanup } = require('../src/migrations/cleanup-org-profiles');

test('classifyOrgName tags tweet/title noise, programs, events, and real orgs', () => {
  assert.equal(classifyOrgName('RT @Walkowiak_Emma'), 'noise');
  assert.equal(classifyOrgName("New Kalil's Corner today"), 'noise');
  assert.equal(classifyOrgName('backtest-bias'), 'noise');
  assert.equal(classifyOrgName('Official Launch'), 'noise');
  assert.equal(classifyOrgName('Season 7 Nominations'), 'noise');
  assert.equal(classifyOrgName('BUIDL CTC 2026 Fall'), 'event');
  assert.equal(classifyOrgName('Protocol Summit 12'), 'event');
  assert.equal(classifyOrgName('Rocket Pool GMC Round 40'), 'program');
  assert.equal(classifyOrgName('FAS AI Safety Policy Entrepreneurship Fellowship'), 'program');
  assert.equal(classifyOrgName('MagicBlock Magic Incubator'), 'program');
  assert.equal(classifyOrgName('Snyk Secure Developer Program'), 'program');
  assert.equal(classifyOrgName('Taiko Grant Program'), 'program');
  assert.equal(classifyOrgName('Ethereum Foundation'), 'org');
  assert.equal(classifyOrgName('Gitcoin'), 'org');
  assert.equal(classifyOrgName('United Nations Development Programme'), 'org');
  assert.equal(classifyOrgName('Google Research Scholar Program'), 'org');
  assert.equal(classifyOrgName('Deep Funding'), 'org');
  assert.equal(classifyOrgName('Jane Doe'), 'person');
  assert.equal(classifyOrgName('AI-BOOST'), 'org');
  assert.equal(classifyOrgName('CRC'), 'abbrev');
});

test('shouldArchiveOrgProfile keeps enriched programs and existing abbreviations', () => {
  assert.equal(shouldArchiveOrgProfile({ name: 'RT @Walkowiak_Emma' }), true);
  assert.equal(shouldArchiveOrgProfile({ name: 'backtest-bias' }), true);
  assert.equal(shouldArchiveOrgProfile({ name: 'Rocket Pool GMC Round 40' }), true);
  assert.equal(shouldArchiveOrgProfile({
    name: 'Taiko Grant Program',
    org_type: 'Protocol DAO',
  }), false);
  assert.equal(shouldArchiveOrgProfile({ name: 'Taiko Grant Program' }), true);
  assert.equal(shouldArchiveOrgProfile({ name: 'Jane Doe' }), true);
  assert.equal(shouldArchiveOrgProfile({ name: 'Jane Doe', website: 'https://example.org' }), false);
  assert.equal(shouldArchiveOrgProfile({ name: 'CRC', org_type: 'Protocol DAO' }), false);
  assert.equal(shouldArchiveOrgProfile({ name: 'Ethereum Foundation' }), false);
  assert.equal(shouldArchiveOrgProfile({ name: 'United Nations Development Programme' }), false);
});

test('extractOrgFromName no longer mints tweet titles or program shells as orgs', () => {
  assert.equal(extractOrgFromName('RT @Walkowiak_Emma: interesting paper'), null);
  assert.equal(extractOrgFromName("New Kalil's Corner today — weekly notes"), null);
  assert.equal(extractOrgFromName('FAS AI Safety Policy Entrepreneurship Fellowship — apply'), null);
  assert.equal(extractOrgFromName('Rocket Pool GMC Round 40 — results'), null);
  assert.equal(extractOrgFromName('MagicBlock Magic Incubator — cohort 2'), null);
  assert.equal(extractOrgFromName('Ethereum Foundation — ESP academic grants'), 'Ethereum Foundation');
  assert.equal(extractOrgFromName('Gitcoin — Allo stack update'), 'Gitcoin');
});

function stubPool(orgs) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT id, name, org_type, website, description FROM org_profiles/i.test(sql)) {
        return { rows: orgs };
      }
      if (/UPDATE scan_entries SET org_id = NULL/i.test(sql)) {
        return { rows: [{ id: 11 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

test('runOrgCleanup dry-run lists archivable rows and does not delete', async () => {
  const pool = stubPool([
    { id: 1, name: 'RT @Walkowiak_Emma', org_type: null, website: null, description: null },
    { id: 2, name: 'Ethereum Foundation', org_type: 'Foundation/Lab', website: 'https://ethereum.org', description: 'EF' },
    { id: 3, name: 'Taiko Grant Program', org_type: 'Protocol DAO', website: null, description: null },
  ]);
  const result = await runOrgCleanup(pool, { dryRun: true });
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.archived.map(row => row.name), ['RT @Walkowiak_Emma']);
  assert.equal(result.badOrgsDeleted, 0);
  assert.equal(pool.calls.filter(c => /DELETE FROM org_profiles/i.test(c.sql)).length, 0);
});

test('runOrgCleanup deletes noise rows, unlinks entries, and skips Notion when asked', async () => {
  const pool = stubPool([
    { id: 9, name: 'backtest-bias', org_type: null, website: null, description: null },
  ]);
  const result = await runOrgCleanup(pool, { archiveNotion: false });
  assert.equal(result.badOrgsDeleted, 1);
  assert.equal(result.entriesUnlinked, 1);
  assert.equal(result.notionArchived, 0);
  assert.ok(pool.calls.some(c => /DELETE FROM org_profiles/i.test(c.sql) && c.params[0] === 9));
});
