require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSubmission, parseStructuredOutput } = require('../src/services/intake');
const { PROMPT_VARIANTS, SCAN_SOURCES } = require('../src/types/intake');

const manifest = {
  producer: 'grok-stringer',
  variant: 'S',
  wire: 'crypto',
  run_id: 'grok-scout-2026-07-17T16:00:00Z',
  generated_at: '2026-07-17T16:00:00Z',
  opportunities: [
    {
      name: 'Example Ecosystem Grants',
      summary: 'A verified open funding round for open source infrastructure.',
      source_url: 'https://example.org/grants/current-round',
      amount: '$250,000',
      deadline: '2026-08-31',
      source_published_at: '2026-07-16',
      fit_score: 91,
      fit_reason: 'Direct fit for crypto and OSS builders.',
      evidence: [
        'https://example.org/grants/current-round',
        'https://x.com/example/status/1234567890',
      ],
      discovered_via: 'x_search',
    },
  ],
  rejected: [
    {
      source_url: 'https://example.org/closed-round',
      reason: 'Closed before the run date.',
    },
  ],
};

const rawManifest = JSON.stringify(manifest);

test('Grok Scout uses canonical source and prompt-variant contracts', () => {
  assert.ok(SCAN_SOURCES.includes('grok-scout'));
  assert.ok(PROMPT_VARIANTS.includes('S'));
});

test('JSON parser preserves candidate audit fields and source manifest identity', () => {
  const parsed = parseStructuredOutput(rawManifest, 'json');

  assert.equal(parsed.strategy, 'json');
  assert.equal(parsed.results.length, 1);
  assert.deepEqual(parsed.results[0].metadata, {
    fit_score: 91,
    fit_reason: 'Direct fit for crypto and OSS builders.',
    evidence: [
      'https://example.org/grants/current-round',
      'https://x.com/example/status/1234567890',
    ],
    discovered_via: 'x_search',
    source_manifest: {
      producer: 'grok-stringer',
      variant: 'S',
      wire: 'crypto',
      run_id: 'grok-scout-2026-07-17T16:00:00Z',
      generated_at: '2026-07-17T16:00:00Z',
    },
  });
});

test('buildSubmission retains the complete raw manifest and parse strategy', () => {
  const submission = buildSubmission(
    rawManifest,
    'crypto',
    'S',
    '2026-07-17',
    'grok-scout'
  );

  assert.equal(submission.rawOutput, rawManifest);
  assert.equal(submission.parseStrategy, 'json');
  assert.equal(submission.source, 'grok-scout');
  assert.equal(submission.results[0].metadata.fit_score, 91);
});

test('insert-only intake persists Grok Scout metadata in scan_entries JSONB', async (t) => {
  const db = require('../src/db');
  t.mock.method(db, 'seedSeenUrlsFromMessages', async () => 0);
  const { runDailyIntake } = require('../src/jobs/daily-intake');

  const calls = [];
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      assert.match(sql, /INSERT INTO scan_entries/);
      return { rows: [{ id: 901 }], rowCount: 1 };
    },
  };

  const submission = buildSubmission(
    rawManifest,
    'crypto',
    'S',
    '2026-07-17',
    'grok-scout'
  );
  const summary = await runDailyIntake(pool, [submission], { insertOnly: true });

  assert.equal(summary.totalIngested, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /raw_output, parse_strategy, metadata, wire_area\)/);
  assert.equal(calls[0].values.length, 19);
  assert.equal(calls[0].values[18], null);
  assert.equal(calls[0].values[9], 'S');
  assert.equal(calls[0].values[10], 'grok-scout');
  assert.equal(calls[0].values[15], rawManifest);
  assert.equal(calls[0].values[16], 'json');
  assert.deepEqual(JSON.parse(calls[0].values[17]), submission.results[0].metadata);
});
