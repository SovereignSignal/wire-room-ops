require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { hasUsefulSourceUrl, isUsefulUrl, parseStructuredOutput } = require('../src/services/intake');
const { isCompletionSufficient } = require('../src/jobs/process-raw');
const { normalizeUrl } = require('../src/utils/url');
const intake = require('../src/services/intake');
const {
  parseReprocessArgs,
  partitionArchivedNoSourceRows,
  reprocessArchivedNoSourceUrls,
} = require('../src/scripts/reprocess-no-source-url');

const AAVE = 'https://snapshot.org/#/aavedao.eth/proposal/0x2d6af8b127e816dd15046979a27e5b5de2e9e0ecd2207c6425ff5db8270970ea';
const GITCOIN = 'https://snapshot.org/#/gitcoindao.eth/proposal/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test('dedup uses the shared normalizer', () => {
  assert.equal(intake.normalizeUrl, normalizeUrl);
});

test('Snapshot proposal hash routes are useful sources', () => {
  assert.equal(isUsefulUrl(AAVE), true);
  assert.equal(hasUsefulSourceUrl(AAVE), true);
  assert.equal(isUsefulUrl(GITCOIN), true);
  assert.equal(isUsefulUrl('https://snapshot.box/#/s:aavedao.eth/proposal/0xabc'), true);
  assert.equal(isUsefulUrl('https://example.com/#/programs/open-source-fellowship'), true);
  assert.equal(isUsefulUrl('https://example.com/#!/programs/open-source-fellowship'), true);
  assert.equal(isUsefulUrl('https://snapshot.org/#/aavedao.eth'), true);
});

test('bare homepages and in-page anchors stay rejected', () => {
  const rejected = [
    'https://snapshot.org',
    'https://snapshot.org/',
    'https://snapshot.org/#',
    'https://snapshot.org/#/',
    'https://snapshot.org/#about',
    'https://snapshot.org/#/about',
    'https://snapshot.org/#/home',
    'https://snapshot.org/#/en',
    'https://snapshot.org/#!/',
    'https://example.com',
    'https://example.com/',
    'https://example.com/#section',
    'https://example.com/#/about',
    'https://example.com/#/?id=1',
    'https://example.com/#!/about',
  ];
  for (const url of rejected) {
    assert.equal(isUsefulUrl(url), false, url);
    assert.equal(hasUsefulSourceUrl(url), false, url);
  }
  assert.equal(hasUsefulSourceUrl(''), false);
  assert.equal(hasUsefulSourceUrl('   '), false);
  assert.equal(hasUsefulSourceUrl(null), false);
});

test('a real path is still useful when a hash anchor is also present', () => {
  assert.equal(isUsefulUrl('https://foundation.example.org/programs/open-source-fellowship#details'), true);
});

test('process-raw completeness accepts a Snapshot proposal URL', () => {
  const result = isCompletionSufficient({
    name: 'Aave service provider proposal',
    description: 'Treasury allocation for the grants program this cycle, with enough detail to review.',
    source_url: AAVE,
  });
  assert.deepEqual(result, { passes: true });
});

test('normalization keeps the fragment so distinct Snapshot proposals do not collapse', () => {
  const aave = normalizeUrl(AAVE);
  const gitcoin = normalizeUrl(GITCOIN);
  assert.notEqual(aave, gitcoin);
  assert.match(aave, /#\/aavedao\.eth\/proposal\/0x2d6af8b127e816dd15046979a27e5b5de2e9e0ecd2207c6425ff5db8270970ea$/);
  assert.match(gitcoin, /#\/gitcoindao\.eth\/proposal\/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa$/);

  const cased = 'https://snapshot.org/?utm_source=twitter&s=1#/aavedao.eth/proposal/0x2D6AF8B127E816DD15046979A27E5B5DE2E9E0ECD2207C6425FF5DB8270970EA/';
  assert.equal(normalizeUrl(cased), aave);
});

test('structured intake keeps Snapshot proposal links and drops a bare homepage', () => {
  const parsed = parseStructuredOutput([
    '1. **Aave DAO service provider proposal** - Fund a grants operations review for the next cycle',
    `Link: ${AAVE}`,
    '2. **Gitcoin grants round proposal** - Allocate matching funds for the open source round',
    `Link: ${GITCOIN}`,
  ].join('\n'));
  assert.equal(parsed.strategy, 'structured_text');
  assert.deepEqual(parsed.results.map(row => row.sourceUrl), [AAVE, GITCOIN]);

  const home = parseStructuredOutput([
    '1. **Snapshot** - The governance homepage is not a proposal source',
    'Link: https://snapshot.org/',
  ].join('\n'));
  assert.equal(home.results.length, 1);
  assert.equal(home.results[0].sourceUrl, '');
});

test('JSON intake keeps a hash-routed proposal and clears a homepage', () => {
  const parsed = parseStructuredOutput(JSON.stringify([
    {
      name: 'Aave proposal',
      description: 'Treasury allocation for the grants program this cycle',
      url: AAVE,
    },
    {
      name: 'Snapshot home',
      description: 'This is only the Snapshot homepage and should not count',
      url: 'https://snapshot.org/',
    },
  ]), 'json');
  assert.equal(parsed.strategy, 'json');
  assert.equal(parsed.results[0].sourceUrl, AAVE);
  assert.equal(parsed.results[1].sourceUrl, '');
});

test('reprocess args default to a dry run', () => {
  const dry = parseReprocessArgs([]);
  assert.equal(dry.apply, false);
  assert.equal(dry.ids, null);
  assert.equal(dry.limit, null);
  assert.equal(dry.samples, 20);

  const apply = parseReprocessArgs(['--apply', '--ids', '18876,18880', '--limit', '5', '--samples', '2']);
  assert.equal(apply.apply, true);
  assert.deepEqual(apply.ids, [18876, 18880]);
  assert.equal(apply.limit, 5);
  assert.equal(apply.samples, 2);

  assert.throws(() => parseReprocessArgs(['--apply', '--dry-run']), /either/);
  assert.throws(() => parseReprocessArgs(['--ids']), /needs a value/);
  assert.throws(() => parseReprocessArgs(['--limit', '0']), /positive integer/);
  assert.throws(() => parseReprocessArgs(['--ids', '0']), /positive integers/);
});

test('only archived rows whose URL is now useful are reprocessable', () => {
  const rows = [
    { id: 18876, source_url: AAVE, wire: 'crypto', name: 'Aave proposal' },
    { id: 2, source_url: 'https://snapshot.org/', wire: 'crypto', name: 'home' },
    { id: 3, source_url: 'https://snapshot.org/#/', wire: 'crypto', name: 'hash home' },
    { id: 4, source_url: 'https://foundation.example.org/programs/fellowship', wire: 'oss', name: 'path' },
    { id: 5, source_url: '   ', wire: 'ai', name: 'blank' },
  ];
  const { reprocess, stillInvalid } = partitionArchivedNoSourceRows(rows);
  assert.deepEqual(reprocess.map(row => row.id), [18876, 4]);
  assert.deepEqual(stillInvalid.map(row => row.id), [2, 3, 5]);
});

function fakeDb(rows, updatedIds) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM scan_entries')) {
        const ids = params[0];
        const matched = ids == null ? rows : rows.filter(row => ids.includes(Number(row.id)));
        return { rows: matched, rowCount: matched.length };
      }
      if (sql.includes('UPDATE scan_entries')) {
        const ids = updatedIds == null ? params[0] : updatedIds;
        return { rows: ids.map(id => ({ id })), rowCount: ids.length };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

const ARCHIVED = [
  { id: 18876, source_url: AAVE, wire: 'crypto', name: 'Aave proposal' },
  { id: 18877, source_url: 'https://snapshot.org/', wire: 'crypto', name: 'Snapshot home' },
  { id: 18878, source_url: GITCOIN, wire: 'crypto', name: 'Gitcoin proposal' },
  { id: 18879, source_url: 'https://snapshot.org/#about', wire: 'crypto', name: 'anchor' },
];

test('dry run plans both Snapshot proposals and does not write', async () => {
  const db = fakeDb(ARCHIVED);
  const result = await reprocessArchivedNoSourceUrls(db, {
    apply: false, ids: null, limit: null, samples: 20,
  });
  assert.equal(result.scanned, 4);
  assert.deepEqual(result.eligible.map(row => row.id), [18876, 18878]);
  assert.deepEqual(result.selected.map(row => row.id), [18876, 18878]);
  assert.equal(result.stillInvalid, 2);
  assert.deepEqual(result.updatedIds, []);
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /archived_reason/);
  assert.deepEqual(db.calls[0].params, [null]);
  assert.equal(db.calls.some(call => /UPDATE/i.test(call.sql)), false);
});

test('apply requeues only the rows whose URL is now valid', async () => {
  const db = fakeDb(ARCHIVED);
  const result = await reprocessArchivedNoSourceUrls(db, {
    apply: true, ids: [18876], limit: 1, samples: 20,
  });
  assert.deepEqual(db.calls[0].params, [[18876]]);
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].id, 18876);
  assert.match(db.calls[1].sql, /status = 'raw'/);
  assert.match(db.calls[1].sql, /archived_reason/);
  assert.match(db.calls[1].sql, /reprocessed_no_source_url/);
  assert.match(db.calls[1].sql, /source_url = planned.source_url/);
  assert.deepEqual(db.calls[1].params, [[18876], [AAVE]]);
  assert.deepEqual(result.updatedIds, [18876]);
});

test('apply reports rows that changed before the write', async () => {
  const db = fakeDb(ARCHIVED, []);
  const result = await reprocessArchivedNoSourceUrls(db, {
    apply: true, ids: null, limit: null, samples: 20,
  });
  assert.deepEqual(result.selected.map(row => row.id), [18876, 18878]);
  assert.deepEqual(db.calls[1].params, [[18876, 18878], [AAVE, GITCOIN]]);
  assert.deepEqual(result.updatedIds, []);
});

test('limit counts only rows whose URL is now useful', async () => {
  const db = fakeDb(ARCHIVED);
  const result = await reprocessArchivedNoSourceUrls(db, {
    apply: false, ids: null, limit: 1, samples: 20,
  });
  assert.equal(result.eligible.length, 2);
  assert.deepEqual(result.selected.map(row => row.id), [18876]);
  assert.equal(db.calls.some(call => /UPDATE/i.test(call.sql)), false);
});
