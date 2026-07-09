// Pins the 2026-07-03 digest redesign contract: the email answers "what needs
// me today?" — decisions first, BD leads on Wednesdays, anomalies only when
// present, and NO ops-telemetry tables (per-source matrix, cost table, wire
// table all live in the dashboard). Sov's feedback: the old email was noisy.
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderDailyDigest } = require('../src/services/email');

const DIGEST = {
  date: '2026-07-08',
  wires: [
    { wire: 'crypto', scansRun: 6, totalIngested: 21, newUnique: 9, duplicatesFound: 8, avgQualityScore: 64, highQualityCount: 4, pendingReview: 7, recentlyApproved: 2 },
    { wire: 'ai', scansRun: 5, totalIngested: 11, newUnique: 6, duplicatesFound: 3, avgQualityScore: 71, highQualityCount: 3, pendingReview: 4, recentlyApproved: 1 },
  ],
  totalPendingReview: 11, totalNewUnique: 15, hasActivity: true,
};

const FINDS = [
  { name: 'Schmidt Sciences RFP', wire: 'ai', quality_score: 88, amount: '$500k', deadline: 'Aug 15', source_url: 'https://x.org/1' },
  { name: 'NLnet Open Call', wire: 'oss', quality_score: 84, amount: null, deadline: null, source_url: null },
];

test('fresh signal leads: Open first section with linked finds and fresh count', () => {
  const r = renderDailyDigest(DIGEST, 'https://app.example', { topFinds: FINDS });
  assert.match(r.html, /Open first/);
  assert.match(r.html, /Fresh/);
  assert.match(r.html, /Issues/);
  assert.match(r.html, /Spend/);
  assert.match(r.html, /Schmidt Sciences RFP/);
  assert.match(r.html, /https:\/\/x\.org\/1/);
  assert.match(r.subject, /2 fresh/);
  assert.match(r.subject, /0 issues/);
  assert.ok(!r.html.includes('Needs you (11)'), 'stale queue count must not lead the email');
});

test('ops telemetry tables are GONE from the email', () => {
  const r = renderDailyDigest(DIGEST, 'https://app.example', {
    topFinds: FINDS,
    sourceBreakdown: [{ wire: 'crypto', source: 'feed', total: 5, queued: 2, approved: 1, duplicates: 1, parked: 1, signals: 0 }],
    costRecap: { rows: [{ provider: 'grok', calls: 40, cost_usd: 1.2 }], total: 1.2 },
  });
  assert.ok(!r.html.includes('Intake by Source'), 'per-source matrix must not render');
  assert.ok(!r.html.includes('API Costs (24h)'), 'cost table must not render');
  assert.ok(!r.html.includes('>By Wire<'), 'wire table must not render');
  assert.match(r.html, /\$1\.20/, 'cost appears only as a spend metric');
  assert.match(r.html, /Spend/);
});

test('quiet day is short and says so', () => {
  const r = renderDailyDigest({ ...DIGEST, totalPendingReview: 0 }, 'https://app.example', {});
  assert.match(r.html, /No fresh high-signal items/);
  assert.match(r.subject, /0 fresh/);
  assert.match(r.subject, /0 issues/);
  assert.ok(!r.html.includes('Queue is clear'), 'email should not frame quiet state as backlog state');
  assert.ok(r.html.length < 4000, `quiet email should be small, got ${r.html.length}`);
});

test('BD leads block renders only when leads are passed (Wednesdays)', () => {
  const none = renderDailyDigest(DIGEST, 'https://app.example', { topFinds: FINDS });
  assert.ok(!none.html.includes('BD leads'), 'no BD block without leads');
  const wed = renderDailyDigest(DIGEST, 'https://app.example', {
    topFinds: FINDS,
    bdLeads: [{ lead: 'Filecoin — grants-ops opportunity', source: 'https://x.org/fil', notes: '[Grants-ops · crypto · high] ProPGF open' }],
    bdLeadsUrl: 'https://notion.so/leads',
  });
  assert.match(wed.html, /BD leads/);
  assert.match(wed.html, /Filecoin — grants-ops opportunity/);
  assert.match(wed.html, /Triage in Notion/);
  assert.ok(!wed.subject.includes('BD lead'), 'subject stays focused on fresh items and issues');
});

test('anomalies gate: absent = zero issues; present = Production issues section + subject count', () => {
  const ok = renderDailyDigest(DIGEST, 'https://app.example', { topFinds: FINDS });
  assert.match(ok.subject, /0 issues/);
  assert.ok(!ok.html.includes('Production issues'), 'no production issues section when clean');
  const bad = renderDailyDigest(DIGEST, 'https://app.example', {
    topFinds: FINDS,
    anomalies: ['Source feeds: 2 of 19 sources errored'],
  });
  assert.match(bad.html, /Production issues/);
  assert.match(bad.html, /2 of 19 sources errored/);
  assert.match(bad.subject, /1 issue/);
});

test('activity telemetry stays out of the morning email body', () => {
  const r = renderDailyDigest(DIGEST, 'https://app.example', {
    agentBrief: { runs: [{ searchesDone: 8, totalFound: 11, entries: [{}, {}], skippedDuplicates: 5 }] },
    csvExport: { entryCount: 3, htmlTable: '<table><tr><td>SHOULD NOT APPEAR</td></tr></table>' },
    downloadUrls: { csv: 'https://x.org/csv', md: null },
  });
  assert.ok(!r.html.includes('Activity'), 'activity section must not render');
  assert.ok(!r.html.includes('Agent scan'), 'agent scan telemetry must stay out of email body');
  assert.ok(!r.html.includes('Approved last 24h'), 'approved export links must stay out of email body');
  assert.ok(!r.html.includes('SHOULD NOT APPEAR'), 'approved entries HTML table must not render');
});
