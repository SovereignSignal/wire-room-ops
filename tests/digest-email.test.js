require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderDailyDigest } = require('../src/services/email');

const DIGEST = {
  date: '2026-07-09',
  wires: [
    { wire: 'crypto', scansRun: 2, totalIngested: 25, newUnique: 8, duplicatesFound: 12, avgQualityScore: 61, highQualityCount: 3, pendingReview: 6, recentlyApproved: 2 },
    { wire: 'ai', scansRun: 1, totalIngested: 16, newUnique: 5, duplicatesFound: 7, avgQualityScore: 58, highQualityCount: 2, pendingReview: 5, recentlyApproved: 1 },
  ],
  totalPendingReview: 11,
  totalNewUnique: 13,
  hasActivity: true,
};

const FINDS = [
  { id: 101, name: 'Schmidt Sciences RFP', wire: 'ai', quality_score: 91, amount: '$2M pool', deadline: 'Jul 31', source_url: 'https://x.org/1', curator_route: 'publish', curator_confidence: 'high' },
  { id: 102, name: 'NLnet Open Call', wire: 'oss', quality_score: 84, amount: null, deadline: null, source_url: null, curator_route: 'source_check', curator_confidence: 'med' },
];

const LEDGER = {
  lanes: [
    { key: 'scans', state: 'ok', detail: 'scans 41✓' },
    { key: 'feeds', state: 'ok', detail: 'feeds 19/19' },
    { key: 'bridge', state: 'ok', detail: 'bridge ✓' },
  ],
};

const CLOSING = [
  { name: 'EF Academic Grants', wire: 'ai', deadline: '2026-07-12', daysUntil: 3, amount: '$50-150k', sourceUrl: 'https://x.org/ef' },
];

test('clean day: RUN CLEAN band, ledger lanes, state-carrying subject', () => {
  const r = renderDailyDigest(DIGEST, 'https://app.example', { freshFinds: FINDS, totalNewEligible: 2, runLedger: LEDGER, costRecap: { rows: [], total: 1.2 } });
  assert.match(r.html, /RUN CLEAN/);
  assert.match(r.html, /scans 41✓/);
  assert.match(r.html, /feeds 19\/19/);
  assert.match(r.html, /41 in/); // totalIngested sum
  assert.match(r.html, /\$1\.20/);
  assert.equal(r.subject, 'Jul 9 — 2 new for review · run clean');
});

test('new-for-review cards: deep link into the queue, curator stamp, source as secondary link', () => {
  const r = renderDailyDigest(DIGEST, 'https://app.example', { freshFinds: FINDS, totalNewEligible: 2, runLedger: LEDGER });
  assert.match(r.html, /New for review \(2\)/);
  assert.match(r.html, /https:\/\/app\.example\/queue\?entry=101/);
  assert.match(r.html, /PUBLISH·HIGH/);
  assert.match(r.html, /CHECK·MED/);
  assert.match(r.html, /https:\/\/x\.org\/1/); // source stays, as the secondary link
  assert.match(r.html, /Open queue → 11 waiting/);
  assert.match(r.text, /queue\?entry=101/);
});

test('more-new line renders when eligible items exceed the shown cap', () => {
  const r = renderDailyDigest(DIGEST, 'https://app.example', { freshFinds: FINDS, totalNewEligible: 7, runLedger: LEDGER });
  assert.match(r.html, /5 more new in the queue/);
});

test('bad day: amber band, Production issues section, ⚠ subject leads with issues', () => {
  const r = renderDailyDigest(DIGEST, 'https://app.example', {
    freshFinds: FINDS.slice(0, 1), totalNewEligible: 1, runLedger: LEDGER,
    anomalies: ['Source feeds: 2 of 19 sources errored', 'API spend $6.40 in 24h (>$5)'],
  });
  assert.match(r.html, /⚠ 2 ISSUES/);
  assert.match(r.html, /Production issues \(2\)/);
  assert.match(r.html, /2 of 19 sources errored/);
  assert.equal(r.subject, '⚠ Jul 9 — 2 issues · 1 new');
});

test('quiet day: short email, green band, older-items pointer, no backlog framing', () => {
  const r = renderDailyDigest(DIGEST, 'https://app.example', { freshFinds: [], totalNewEligible: 0, runLedger: LEDGER });
  assert.equal(r.subject, 'Jul 9 — nothing new · run clean');
  assert.match(r.html, /Nothing new for review/);
  assert.match(r.html, /11 older item/);
  assert.ok(!r.html.includes('Needs you'), 'no backlog framing');
  assert.ok(r.html.length < 4000, `quiet email should be small, got ${r.html.length}`);
});

test('closing soon: renders only when non-empty, with bold day counts', () => {
  const withRows = renderDailyDigest(DIGEST, 'https://app.example', { freshFinds: [], runLedger: LEDGER, closingSoon: CLOSING });
  assert.match(withRows.html, /Closing soon/);
  assert.match(withRows.html, /EF Academic Grants/);
  assert.match(withRows.html, /3 days/);
  const without = renderDailyDigest(DIGEST, 'https://app.example', { freshFinds: [], runLedger: LEDGER, closingSoon: [] });
  assert.ok(!without.html.includes('Closing soon'));
});

test('BD leads block renders only when leads are passed (Wednesdays)', () => {
  const plain = renderDailyDigest(DIGEST, 'https://app.example', { freshFinds: FINDS, runLedger: LEDGER });
  assert.ok(!plain.html.includes('BD leads'));
  const wed = renderDailyDigest(DIGEST, 'https://app.example', {
    freshFinds: FINDS, runLedger: LEDGER,
    bdLeads: [{ lead: 'Filecoin — grants-ops opportunity', source: 'https://x.org/fil', notes: '[Grants-ops · crypto · high] ProPGF open' }],
    bdLeadsUrl: 'https://notion.so/leads',
  });
  assert.match(wed.html, /BD leads/);
  assert.match(wed.html, /Filecoin — grants-ops opportunity/);
  assert.match(wed.html, /Triage in Notion/);
  assert.ok(!wed.subject.includes('BD'), 'subject stays new-work + verdict');
});

test('ops telemetry stays out: no CSV links, no agent activity, no source/cost tables', () => {
  const r = renderDailyDigest(DIGEST, 'https://app.example', {
    freshFinds: FINDS, runLedger: LEDGER,
    csvExport: { entryCount: 3, htmlTable: '<table><tr><td>SHOULD NOT APPEAR</td></tr></table>' },
    downloadUrls: { csv: 'https://x.org/csv', md: null },
    agentBrief: { runs: [{ searchesDone: 8, totalFound: 11, entries: [{}, {}], skippedDuplicates: 5 }] },
  });
  assert.ok(!r.html.includes('SHOULD NOT APPEAR'));
  assert.ok(!r.html.includes('Agent scan:'), 'agent evidence lives in the ledger, not prose');
  assert.ok(!r.html.includes('Approved last 24h'));
  assert.ok(!r.html.includes('Intake by Source'));
  assert.ok(!r.html.includes('API Costs'));
});
