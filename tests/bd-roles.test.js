// Pins the BD roles lane (Phase B): the title taxonomy that gates postings
// before the LLM qualifier, the ATS parsers, and the net-new watermark
// semantics (incl. the Phase-3 lesson: first-run capping + seen-set merge).
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  roleMatchesLane, parseGreenhouse, parseAshby, pickFreshRoles,
  ROLES_FIRST_RUN_LIMIT, ROLES_REGISTRY, enabledRoleSources,
} = require('../src/services/bd-roles');

test('taxonomy: senior BD/grants/governance/ops titles pass', () => {
  for (const t of [
    'Head of Business Development',
    'Director, Ecosystem Partnerships',
    'Grants Program Manager',
    'Program Officer, Open Source',
    'Governance Lead',
    'Chief of Staff',
    'VP Revenue',
    'Head of Grants',
    'Partnerships Manager',
    'Director of Operations',
  ]) {
    assert.equal(roleMatchesLane(t), true, `should match: ${t}`);
  }
});

test('taxonomy: engineering, junior, and off-lane titles are rejected', () => {
  for (const t of [
    'Software Engineer, Partnerships Platform',
    'Forward Deployed Software Engineer - SF',
    'Research Scientist',
    'Partnerships Intern',
    'Account Executive',
    'Customer Success Manager',
    'Community Manager',
    'Recruiter, Business Development',
    'Marketing Manager',
    'General Counsel',
    '0->1 Engineer, Open Source AI',
    'Business Development Representative (SDR)',
    'Lead Generation Strategy and Operations',
    'Technical Program Manager, AI Delivery',
    'Community & Executive Escalations Program Manager',
  ]) {
    assert.equal(roleMatchesLane(t), false, `should reject: ${t}`);
  }
});

test('greenhouse parser maps live field shapes', () => {
  const src = { key: 'gh-x', org: 'Mozilla', lane: 'oss', method: 'greenhouse', enabled: true };
  const out = parseGreenhouse({ jobs: [
    { id: 1, title: 'Head of Grants', absolute_url: 'https://g.io/1', updated_at: '2026-06-01T13:35:12-04:00', location: { name: 'Remote US' } },
    { id: 2, title: '', absolute_url: 'https://g.io/2' },
  ] }, src);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { sourceKey: 'gh-x', lane: 'oss', org: 'Mozilla', title: 'Head of Grants', url: 'https://g.io/1', location: 'Remote US', comp: null, publishedAt: '2026-06-01T13:35:12-04:00' });
});

test('ashby parser maps live field shapes incl. compensation summary', () => {
  const src = { key: 'ashby-x', org: 'OpenAI', lane: 'ai', method: 'ashby', enabled: true };
  const out = parseAshby({ jobs: [
    { id: 'a', title: 'Head of Partnerships', jobUrl: 'https://a.io/1', location: 'SF', publishedAt: '2026-06-20T00:00:00Z', compensation: { compensationTierSummary: '$300K – $400K' } },
  ] }, src);
  assert.equal(out.length, 1);
  assert.equal(out[0].comp, '$300K – $400K');
  assert.equal(out[0].url, 'https://a.io/1');
});

test('pickFreshRoles: first run caps to newest N but marks the whole backlog seen', () => {
  const mk = (i, ts) => ({ sourceKey: 's', lane: 'ai', org: 'O', title: `Head of X ${i}`, url: `https://x/${i}`, location: null, comp: null, publishedAt: ts });
  const postings = Array.from({ length: 20 }, (_, i) => mk(i, `2026-06-${String(i + 1).padStart(2, '0')}T00:00:00Z`));
  const r = pickFreshRoles(postings, null);
  assert.equal(r.firstRunCapped, true);
  assert.equal(r.fresh.length, ROLES_FIRST_RUN_LIMIT);
  assert.equal(r.fresh[0].url, 'https://x/19', 'newest first');
  assert.equal(r.seenUrls.length, 20, 'whole backlog marked seen');
});

test('pickFreshRoles: subsequent runs return only net-new and merge the seen set', () => {
  const mk = (i) => ({ sourceKey: 's', lane: 'ai', org: 'O', title: `Head of X ${i}`, url: `https://x/${i}`, location: null, comp: null, publishedAt: null });
  const prev = ['https://x/0', 'https://x/1'];
  const r = pickFreshRoles([mk(0), mk(1), mk(2)], prev);
  assert.deepEqual(r.fresh.map(p => p.url), ['https://x/2']);
  assert.equal(r.firstRunCapped, false);
  assert.ok(r.seenUrls.includes('https://x/2') && r.seenUrls.includes('https://x/0'));
});

test('aggregate boards: hiring org extracted from "Title at Org" titles (fossjobs shape)', () => {
  const { splitAggregateTitle } = require('../src/services/bd-roles');
  const a = splitAggregateTitle('[Full-time] Program Manager - Sovereign Tech Fund (all genders) at Sovereign Tech Agency', 'FOSS Jobs board');
  assert.equal(a.org, 'Sovereign Tech Agency');
  assert.equal(a.title, 'Program Manager - Sovereign Tech Fund (all genders)');
  const b = splitAggregateTitle('Head of Grants', 'FOSS Jobs board');
  assert.deepEqual(b, { title: 'Head of Grants', org: 'FOSS Jobs board' });
});

test('registry: every source carries a lane tag and the lanes are balanced by design', () => {
  const lanes = { crypto: 0, ai: 0, oss: 0 };
  for (const s of enabledRoleSources()) {
    assert.ok(['crypto', 'ai', 'oss'].includes(s.lane), `bad lane on ${s.key}`);
    lanes[s.lane]++;
    assert.ok(s.method !== 'rss' || s.url, `rss source ${s.key} needs url`);
    assert.ok(s.method === 'rss' || s.slug, `${s.key} needs slug`);
  }
  assert.ok(lanes.ai >= 4 && lanes.oss >= 4 && lanes.crypto >= 4, `each lane needs sources: ${JSON.stringify(lanes)}`);
});
