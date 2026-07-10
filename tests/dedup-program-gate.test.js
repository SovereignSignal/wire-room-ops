require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkDuplicate } = require('../src/services/dedup');

// Fake pool that answers seen_urls/name-layer queries empty, and answers the
// programs candidate query with a canned program row.
function gatePool(programRows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/FROM programs/.test(sql)) return { rows: programRows };
      return { rows: [] };
    },
  };
}

const PROGRAM = {
  id: 9, canonical_name: 'Anthropic Fellows Program', normalized_key: 'anthropicfellowsprogram',
  org_id: null, org_name: 'Anthropic', wire: 'ai', aliases: [],
  canonical_url: null, url_domains: [], canonical_entry_id: 8416,
  latest_round_label: 'july 2026 cohort', latest_deadline: null,
  entry_count: 60, approved_count: 1, declined_count: 12,
  last_decision: 'declined 2026-07-07', first_seen: null, last_seen: null,
};

test('program gate: same round at key confidence → duplicate pointing at the canonical entry', async () => {
  const r = await checkDuplicate(gatePool([PROGRAM]), { sourceUrl: 'https://random.example/x', name: 'Anthropic Fellows Program (July 2026 cohort)', wire: 'ai' }, 180, { programGate: true });
  assert.equal(r.isDuplicate, true);
  assert.equal(r.matchType, 'program');
  assert.equal(r.matchedEntryId, 8416);
  assert.match(r.reason, /seen 60×/);
});

test('program gate: NEW round resolves but does not block; resolution rides on the result', async () => {
  const r = await checkDuplicate(gatePool([PROGRAM]), { sourceUrl: 'https://random.example/x', name: 'Anthropic Fellows Program (Sept 2026 cohort)', wire: 'ai' }, 180, { programGate: true });
  assert.equal(r.isDuplicate, false);
  assert.equal(r.programResolution.verdict, 'new_round');
  assert.equal(r.programResolution.programId, 9);
});

test('program gate: off by default and under urlOnly', async () => {
  const p1 = gatePool([PROGRAM]);
  await checkDuplicate(p1, { sourceUrl: 'https://a.example/x', name: 'Anthropic Fellows Program (July 2026 cohort)', wire: 'ai' }, 180);
  assert.ok(!p1.calls.some(c => /FROM programs/.test(c.sql)), 'no gate without opt-in');
  const p2 = gatePool([PROGRAM]);
  await checkDuplicate(p2, { sourceUrl: 'https://a.example/x', name: 'Anthropic Fellows Program (July 2026 cohort)', wire: 'ai' }, 180, { urlOnly: true, programGate: true });
  assert.ok(!p2.calls.some(c => /FROM programs/.test(c.sql)), 'urlOnly wins — dumb pipe stays URL-only');
});

test('program gate: resolver failure fails open', async () => {
  const pool = { async query(sql) { if (/FROM programs/.test(sql)) throw new Error('boom'); return { rows: [] }; } };
  const r = await checkDuplicate(pool, { sourceUrl: 'https://a.example/x', name: 'Anything', wire: 'ai' }, 180, { programGate: true });
  assert.equal(r.isDuplicate, false);
});
