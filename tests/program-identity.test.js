require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProgramKey } = require('../src/services/program-identity');

// Real corpus variants — one program, one key.
test('normalizeProgramKey collapses round/cohort/date noise', () => {
  const variants = [
    'Anthropic Fellows Program',
    'Anthropic Fellows Program 2026',
    'Anthropic Fellows Program (Sept 2026 cohort)',
    'Anthropic Fellows Program (July 2026 cohort)',
    'Anthropic Fellows Program — May & July 2026 Cohorts',
    'Anthropic Fellows Program for AI safety research',
  ];
  const keys = new Set(variants.map(normalizeProgramKey));
  // "for AI safety research" is descriptive suffix, kept — two keys max
  assert.ok(keys.size <= 2, `expected <=2 keys, got ${[...keys].join(', ')}`);
  assert.equal(normalizeProgramKey('Anthropic Fellows Program 2026'), normalizeProgramKey('Anthropic Fellows Program (Sept 2026 cohort)'));
});

test('normalizeProgramKey strips rounds, quarters, seasons, fund numbers', () => {
  assert.equal(normalizeProgramKey('Cardano Catalyst Fund14'), normalizeProgramKey('Cardano Catalyst Fund12'));
  assert.equal(normalizeProgramKey('Uniswap Acceleration Season 3'), normalizeProgramKey('Uniswap Acceleration Season 7'));
  assert.equal(normalizeProgramKey('Zcash CDRGP Q3/Q4 2026'), normalizeProgramKey('Zcash CDRGP Q1 2027'));
  assert.equal(normalizeProgramKey('Optimism Round 8 Retro Funding'), normalizeProgramKey('Optimism Round 6 Retro Funding'));
});

test('normalizeProgramKey keeps genuinely different programs apart', () => {
  assert.notEqual(normalizeProgramKey('Arbitrum Foundation Audit Program'), normalizeProgramKey('Arbitrum Open House'));
  assert.notEqual(normalizeProgramKey('Anthropic Fellows Program'), normalizeProgramKey('Anthropic Economic Futures Initiative'));
  assert.notEqual(normalizeProgramKey('Claude Corps Fellowship'), normalizeProgramKey('Claude for Open Source'));
});

test('normalizeProgramKey handles empty/degenerate input', () => {
  assert.equal(normalizeProgramKey(''), '');
  assert.equal(normalizeProgramKey('2026'), '');
});

// ── Task 2: Resolution, round assessment, history ────────────────────

const {
  resolveProgram, assessRound, extractRoundLabel, historyLine,
} = require('../src/services/program-identity');

function fakeProgram(overrides = {}) {
  return {
    id: 1, canonical_name: 'Anthropic Fellows Program', normalized_key: normalizeProgramKey('Anthropic Fellows Program'),
    org_id: null, org_name: 'Anthropic', wire: 'ai',
    aliases: ['Anthropic Fellows Program 2026', 'Anthropic AI Safety Fellowship'],
    canonical_url: 'https://alignment.anthropic.com/2025/anthropic-fellows-program-2026/',
    url_domains: ['alignment.anthropic.com'], canonical_entry_id: 8416,
    latest_round_label: 'july 2026 cohort', latest_deadline: '2026-06-30',
    entry_count: 60, approved_count: 1, declined_count: 12,
    last_decision: 'declined 2026-07-07', first_seen: '2026-03-09', last_seen: '2026-07-09',
    ...overrides,
  };
}

function programPool(rows) {
  const calls = [];
  return { calls, async query(sql, params) { calls.push({ sql, params }); return { rows }; } };
}

test('resolveProgram: normalized-key exact match = 0.95', async () => {
  const pool = programPool([fakeProgram()]);
  const m = await resolveProgram(pool, { name: 'Anthropic Fellows Program (Dec 2026 cohort)', wire: 'ai' });
  assert.equal(m.pass, 'key');
  assert.equal(m.confidence, 0.95);
});

test('resolveProgram: alias match counts as key match', async () => {
  const pool = programPool([fakeProgram()]);
  const m = await resolveProgram(pool, { name: 'Anthropic AI Safety Fellowship 2027', wire: 'ai' });
  assert.ok(m, 'alias should resolve');
  assert.equal(m.pass, 'key');
});

test('resolveProgram: URL domain agreement boosts confidence', async () => {
  const pool = programPool([fakeProgram()]);
  const m = await resolveProgram(pool, {
    name: 'Anthropic Research Fellowship', // token overlap only
    sourceUrl: 'https://alignment.anthropic.com/2025/anthropic-fellows-program-2026/31',
  });
  assert.ok(m);
  assert.equal(m.urlBoost, true);
  assert.ok(m.confidence >= 0.85, `boosted token match should reach the bar, got ${m.confidence}`);
});

test('resolveProgram: org mismatch vetoes non-key matches', async () => {
  const pool = programPool([fakeProgram()]);
  const m = await resolveProgram(pool, { name: 'OpenAI Fellows Program Something', orgName: 'OpenAI' });
  assert.equal(m, null, 'different org must not fuzzy-match');
});

test('resolveProgram: no rows → null', async () => {
  const m = await resolveProgram(programPool([]), { name: 'Brand New Thing Grants' });
  assert.equal(m, null);
});

test('extractRoundLabel finds cohort/round/fund tokens', () => {
  assert.equal(extractRoundLabel('Anthropic Fellows Program (Sept 2026 cohort)'), 'sept 2026 cohort');
  assert.equal(extractRoundLabel('Cardano Catalyst Fund14'), 'fund14');
  assert.equal(extractRoundLabel('Optimism Round 8'), 'round 8');
  assert.equal(extractRoundLabel('NLnet Open Call'), null);
});

test('assessRound: differing round label = new_round; same/absent = same_round; ambiguity → new_round', () => {
  const p = fakeProgram();
  assert.equal(assessRound(p, { name: 'Anthropic Fellows Program (Sept 2026 cohort)' }).verdict, 'new_round');
  assert.equal(assessRound(p, { name: 'Anthropic Fellows Program (July 2026 cohort)' }).verdict, 'same_round');
  // no label on either side + later deadline → new_round
  const noLabel = fakeProgram({ latest_round_label: null });
  assert.equal(assessRound(noLabel, { name: 'Anthropic Fellows Program', deadline: '2026-09-30' }).verdict, 'new_round');
  // no label, no deadline signal → same_round (nothing indicates a new cycle)
  assert.equal(assessRound(noLabel, { name: 'Anthropic Fellows Program' }).verdict, 'same_round');
});

test('historyLine composes the display string', () => {
  assert.equal(historyLine(fakeProgram()), 'seen 60× · approved 1× · declined 12× · last declined 2026-07-07');
  assert.equal(historyLine(fakeProgram({ approved_count: 0, declined_count: 0, last_decision: null, entry_count: 3 })), 'seen 3×');
});
