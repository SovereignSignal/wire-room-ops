require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatSettledBatchReport,
  hasOutstandingHistoryChecks,
  resolveTelegramIntakeText,
} = require('../src/services/telegram-adapter');
const { isBatchMessage, parseBatchEntries } = require('../src/services/intake-core');

test('settled batch report uses final database status instead of insert count', () => {
  const batch = {
    inserted: 3,
    duplicates: 1,
    errors: 1,
    failed: 2,
    entries: [
      { id: 101, name: 'Fresh Grant', wire: 'oss' },
      { id: 102, name: 'Later Duplicate', wire: 'crypto' },
      { id: 103, name: 'Judge Failure', wire: 'ai' },
      { name: 'Immediate Duplicate', wire: 'crypto', isDuplicate: true, error: 'Already seen' },
      { name: 'Bad Source', wire: 'ai', error: 'Missing verifiable source URL' },
    ],
  };
  const settled = [
    { id: 101, status: 'queued', duplicate_of_id: null, duplicate_reason: null, decided_recheck: { verdict: 'distinct' }, duplicate_chain_error: null },
    { id: 102, status: 'duplicate', duplicate_of_id: 44, duplicate_reason: 'same listing', decided_recheck: { verdict: 'same_listing' }, duplicate_chain_error: null },
    { id: 103, status: 'queued', duplicate_of_id: null, duplicate_reason: null, decided_recheck: { verdict: 'skipped-error' }, duplicate_chain_error: null },
  ];

  const report = formatSettledBatchReport(batch, settled);
  assert.match(report, /1 queued/);
  assert.match(report, /2 duplicates/);
  assert.match(report, /1 needs check/);
  assert.match(report, /1 error/);
  assert.match(report, /#102 Later Duplicate — duplicate of #44/);
  assert.match(report, /#103 \[ai\] Judge Failure — history check failed/);
  assert.doesNotMatch(report, /3 added/);
});

test('settled batch report marks unstamped queued entries as pending', () => {
  const report = formatSettledBatchReport({
    inserted: 1,
    duplicates: 0,
    errors: 0,
    failed: 0,
    entries: [{ id: 201, name: 'Pending Grant', wire: 'oss' }],
  }, [
    { id: 201, status: 'queued', duplicate_of_id: null, duplicate_reason: null, decided_recheck: null, duplicate_chain_error: null },
  ]);

  assert.match(report, /1 needs check/);
  assert.match(report, /history check pending/);
  assert.doesNotMatch(report, /1 queued/);
});

test('settled batch report escapes Telegram HTML', () => {
  const report = formatSettledBatchReport({
    inserted: 0,
    duplicates: 0,
    errors: 1,
    failed: 1,
    entries: [{ name: 'Grant <script>', wire: 'oss', error: 'Bad & unsafe' }],
  }, []);

  assert.match(report, /Grant &lt;script&gt;/);
  assert.match(report, /Bad &amp; unsafe/);
});

test('settled batch report truncates only at complete HTML line boundaries', () => {
  const entries = Array.from({ length: 60 }, (_, index) => ({
    name: `Grant ${index} ${'&'.repeat(160)}`,
    wire: 'oss',
    isDuplicate: true,
    error: `Already seen ${'&'.repeat(320)}`,
  }));
  const report = formatSettledBatchReport({
    inserted: 0,
    duplicates: entries.length,
    errors: 0,
    failed: entries.length,
    entries,
  }, []);

  assert.ok(report.length <= 4000);
  assert.match(report, /more results omitted/);
  assert.doesNotMatch(report.replaceAll('&amp;', '').replaceAll('&lt;', '').replaceAll('&gt;', ''), /&/);
  assert.equal((report.match(/<b>/g) || []).length, (report.match(/<\/b>/g) || []).length);
});

test('history completion detection treats unstamped queued rows as outstanding', () => {
  const acceptedIds = [201, 202];
  assert.equal(hasOutstandingHistoryChecks(acceptedIds, [
    { id: 201, status: 'queued', decided_recheck: { verdict: 'distinct' }, duplicate_chain_error: null },
    { id: 202, status: 'queued', decided_recheck: null, duplicate_chain_error: null },
  ]), true);
  assert.equal(hasOutstandingHistoryChecks(acceptedIds, [
    { id: 201, status: 'queued', decided_recheck: { verdict: 'distinct' }, duplicate_chain_error: null },
    { id: 202, status: 'duplicate', decided_recheck: null, duplicate_chain_error: null },
  ]), false);
});

test('hidden Telegram text_link URLs are materialized for compact batch parsing', () => {
  const names = [
    'Prezenti AI Sponsorship (Celo)',
    'GOAT Network AI Builder Grants',
  ];
  const text = names.join('\n');
  const entities = [
    {
      type: 'text_link',
      offset: 0,
      length: names[0].length,
      url: 'https://x.com/prezenti_grants/status/2090153678397436206',
    },
    {
      type: 'text_link',
      offset: names[0].length + 1,
      length: names[1].length,
      url: 'https://x.com/GOATNetwork/status/2087971190572794275',
    },
  ];

  const resolved = resolveTelegramIntakeText({ text, entities });
  assert.match(resolved, /prezenti_grants\/status\/2090153678397436206/);
  assert.match(resolved, /GOATNetwork\/status\/2087971190572794275/);
  assert.equal(isBatchMessage(resolved), true);
  const parsed = parseBatchEntries(resolved);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, names[0]);
  assert.equal(parsed[1].sourceUrl, 'https://x.com/GOATNetwork/status/2087971190572794275');
});

// Senders bracket their links ("Source: [https://...]"). The closing bracket used
// to survive into source_url and every X link 404'd for the operator.
test('bracketed source links do not carry their closing bracket into source_url', () => {
  const text = [
    '1. **Syndicate Hackathon**',
    '30-hour AI agent engineering hackathon with $10,000 prize pool.',
    'Deadline: September 6, 2026',
    'Source: [https://x.com/agent_wrapper/status/2095089614679933370]',
    '',
    '2. **Sui AI + DeFi Builder Program**',
    'Sui Foundation $10M ecosystem fund providing milestone-based grants.',
    'Link: [https://x.com/YellowMedia_HQ/status/2095764892100018588]',
  ].join('\n');

  assert.equal(isBatchMessage(text), true);
  const parsed = parseBatchEntries(text);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].sourceUrl, 'https://x.com/agent_wrapper/status/2095089614679933370');
  assert.equal(parsed[1].sourceUrl, 'https://x.com/YellowMedia_HQ/status/2095764892100018588');
  for (const item of parsed) assert.doesNotMatch(item.sourceUrl, /[\])]$/);
});
