require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { findSummaryLeak, isLeakedSummary } = require('../src/services/summary-guard');
const { generateValidatedSummary, planSummaryAttempts } = require('../src/services/auto-summarize');
const { finalAnswerText, thinkControl } = require('../src/services/ollama');
const { parseArgs } = require('../src/scripts/backfill-summary-leaks');

// Shapes seen in approved scan_entries.enriched_summary (1,130 of 1,927 rows).
const LEAKED = [
  'We need to produce a concise opportunity summary for a crypto grants newsletter. Must be 2-4 sentences, lead with organization/program name and a strong action verb. Include all specific numbers. Grant name: Arbitrum Audit Program. Amount: $10M. Deadline? Not given. So',
  'We need to write concise opportunity summary. Lead with organization/program name: "Optimism Foundation". Action verb: "opened". Include numbers: 8M OP. Max 120 words. Let\'s draft:',
  'application deadline? Not given. Could infer from source? The source is a tweet. We can say "Applications are open now." Eligibility? builders on Base. So final:',
  'We must output only the final summary. The program is Gitcoin GG24 with a $1.5M matching pool; deadline Oct 31, 2026. Let\'s craft: Gitcoin launched',
  'The user wants a 2-4 sentence newsletter summary about the Solana Foundation Convertible Grants. Amount is up to $250K. Deadline is not specified',
  'Okay, so the grant is NLnet NGI Zero Commons Fund, amount €5,000-€50,000, deadline 2026-12-01. Write it in plain prose with no bullet points.',
  'I need to summarize the Ethereum Foundation ESP small grants. Amount: up to $30K. Deadline: rolling. Eligibility: open-source public goods.',
  'Amount? Unknown. Deadline? Probably rolling. Eligibility? Anyone building on Stellar. Hmm.',
];

const CLEAN = [
  'Datapoint AI doubled its data grant to $2M and released a 300K+ human video-preference dataset for open research teams. Applications are reviewed on a rolling basis.',
  '**Optimism Foundation** opened Retro Funding Round 7 with 10M OP for onchain builders. Applications close Oct 31, 2026.',
  'NumFOCUS opened Round 2 of its 2026 Small Development Grants, offering up to $10,000 per project. Proposals are due Oct 17.',
  'Now accepting applications, the Web3 Foundation Grants Program funds Polkadot tooling with up to $100K per milestone-based grant.',
  'First cohort of the Base Builder Grants awarded 1-5 ETH to 40 teams. Who qualifies? Any team shipping on Base mainnet.',
  'OKX Ventures launched a $100M ecosystem fund for early-stage teams building on X Layer, with no fixed deadline.',
];

test('findSummaryLeak flags real-looking leaked reasoning', () => {
  for (const sample of LEAKED) {
    assert.ok(findSummaryLeak(sample), `expected leak: ${sample.slice(0, 60)}`);
  }
});

test('findSummaryLeak passes finished summaries', () => {
  for (const sample of CLEAN) {
    assert.equal(findSummaryLeak(sample), null, `false positive: ${sample.slice(0, 60)}`);
  }
  assert.equal(isLeakedSummary(null), false);
  assert.equal(isLeakedSummary(''), false);
});

test('finalAnswerText never returns the thinking field', () => {
  const reasoning = 'We need to produce a concise opportunity summary for a crypto grants newsletter. Must be 2-4 sentences...';
  assert.equal(finalAnswerText({ message: { role: 'assistant', content: '', thinking: reasoning } }), '');
  assert.equal(
    finalAnswerText({ message: { role: 'assistant', content: ' Datapoint AI doubled its grant. ', thinking: reasoning } }),
    'Datapoint AI doubled its grant.',
  );
  assert.equal(
    finalAnswerText({ done_reason: 'length', message: { role: 'assistant', content: 'Datapoint AI doubled' } }),
    '',
    'a length stop is a truncated answer',
  );
});

test('thinkControl lowers gpt-oss reasoning and leaves other models alone', () => {
  assert.deepEqual(thinkControl('gpt-oss:120b'), { think: 'low' });
  assert.deepEqual(thinkControl('kimi-k2.5:cloud'), {});
});

test('planSummaryAttempts falls back across providers and retries a lone provider once', () => {
  assert.deepEqual(planSummaryAttempts('auto', { ollama: true, grok: true }), ['ollama', 'grok']);
  assert.deepEqual(planSummaryAttempts('auto', { ollama: false, grok: true }), ['grok', 'grok']);
  assert.deepEqual(planSummaryAttempts('ollama', { ollama: true, grok: true }), ['ollama', 'ollama']);
  assert.deepEqual(planSummaryAttempts('grok', { ollama: true, grok: false }), []);
});

const INPUT = {
  entryId: 1,
  name: 'Datapoint AI Data Grant',
  description: 'Datapoint AI doubles data grant to $2M',
  amount: '$2M',
  deadline: null,
  sourceUrl: 'https://datapoint.ai/grants',
  wire: 'ai',
};

test('generateValidatedSummary rejects leaked output and falls back to the next provider', async () => {
  const result = await generateValidatedSummary(INPUT, {
    preference: 'auto',
    available: { ollama: true, grok: true },
    ollama: async () => LEAKED[0],
    grok: async () => CLEAN[0],
  });
  assert.equal(result.summary, CLEAN[0]);
  assert.equal(result.provider, 'grok');
  assert.equal(result.attempts[0].outcome, 'rejected');
  assert.match(result.attempts[0].detail, /starts-we-need|we-need-to-write/);
});

test('generateValidatedSummary returns no summary when every attempt is reasoning, empty, or errors', async () => {
  const result = await generateValidatedSummary(INPUT, {
    preference: 'auto',
    available: { ollama: true, grok: true },
    ollama: async () => null,
    grok: async () => { throw new Error('timeout'); },
  });
  assert.equal(result.summary, null);
  assert.deepEqual(result.attempts.map(a => a.outcome), ['empty', 'error']);

  const rejected = await generateValidatedSummary(INPUT, {
    preference: 'ollama',
    available: { ollama: true, grok: false },
    ollama: async () => LEAKED[2],
  });
  assert.equal(rejected.summary, null);
  assert.deepEqual(rejected.attempts.map(a => a.outcome), ['rejected', 'rejected']);
});

test('backfill parseArgs defaults to a dry run and refuses ambiguous modes', () => {
  const dry = parseArgs([]);
  assert.equal(dry.apply, false);
  assert.equal(dry.batchSize, 10);
  assert.equal(dry.delayMs, 2000);
  const apply = parseArgs(['--apply', '--limit', '50', '--status', 'approved', '--ids', '3,4']);
  assert.equal(apply.apply, true);
  assert.equal(apply.limit, 50);
  assert.equal(apply.status, 'approved');
  assert.deepEqual(apply.ids, [3, 4]);
  assert.throws(() => parseArgs(['--apply', '--dry-run']), /either/);
  assert.throws(() => parseArgs(['--limit']), /needs a value/);
});
