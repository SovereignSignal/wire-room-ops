require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { findSummaryLeak, isLeakedSummary } = require('../src/services/summary-guard');
const { config } = require('../src/config');
const { generateValidatedSummary, planSummaryAttempts } = require('../src/services/auto-summarize');
const {
  finalAnswerText, thinkControl, summaryModelChain, modelForSummary, buildOllamaChatBody, SUMMARY_TOKEN_BUDGET,
} = require('../src/services/ollama');
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
  assert.equal(
    finalAnswerText({ message: { role: 'assistant', content: 'reasoning about the grant</think>Datapoint AI doubled its grant.' } }),
    'Datapoint AI doubled its grant.',
  );
});

test('thinkControl disables deepseek and glm reasoning and only lowers gpt-oss', () => {
  assert.deepEqual(thinkControl('gpt-oss:120b'), { think: 'low' });
  assert.deepEqual(thinkControl('deepseek-v4.1-flash'), { think: false });
  assert.deepEqual(thinkControl('glm-5.3-flash'), { think: false });
  assert.deepEqual(thinkControl('glm-5.3-flash:cloud'), { think: false });
  assert.deepEqual(thinkControl('kimi-k2.5:cloud'), {});
});

test('summary model chain is the env pair and ignores a caller-supplied blank', () => {
  const previous = {
    defaultModel: config.apis.ollama.defaultModel,
    fallbackModel: config.apis.ollama.fallbackModel,
  };
  config.apis.ollama.defaultModel = 'deepseek-v4.1-flash';
  config.apis.ollama.fallbackModel = 'glm-5.3-flash';
  try {
    assert.deepEqual(summaryModelChain(), ['deepseek-v4.1-flash', 'glm-5.3-flash']);
    assert.deepEqual(summaryModelChain('  '), ['deepseek-v4.1-flash', 'glm-5.3-flash']);
    assert.deepEqual(summaryModelChain('pinned-model'), ['pinned-model']);
    assert.equal(modelForSummary(undefined), 'deepseek-v4.1-flash');
    const body = buildOllamaChatBody('deepseek-v4.1-flash', 'Summarize this.');
    assert.equal(body.model, 'deepseek-v4.1-flash');
    assert.equal(body.think, false);
    assert.equal(body.options.num_predict, SUMMARY_TOKEN_BUDGET);
    assert.ok(SUMMARY_TOKEN_BUDGET >= 4096);
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/services/ollama.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.doesNotMatch(src, /default_model/);
  } finally {
    config.apis.ollama.defaultModel = previous.defaultModel;
    config.apis.ollama.fallbackModel = previous.fallbackModel;
  }
});

test('planSummaryAttempts tries the primary model then the fallback, and retries a single model', () => {
  assert.deepEqual(
    planSummaryAttempts({ primary: 'deepseek-v4.1-flash', fallback: 'glm-5.3-flash' }),
    [
      { slot: 'primary', model: 'deepseek-v4.1-flash' },
      { slot: 'fallback', model: 'glm-5.3-flash' },
    ],
  );
  assert.deepEqual(
    planSummaryAttempts({ primary: 'deepseek-v4.1-flash', fallback: 'deepseek-v4.1-flash' }),
    [
      { slot: 'primary', model: 'deepseek-v4.1-flash' },
      { slot: 'primary', model: 'deepseek-v4.1-flash' },
    ],
  );
  assert.deepEqual(planSummaryAttempts({ primary: '', fallback: '' }), []);
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

test('generateValidatedSummary rejects leaked output and falls back to the next model', async () => {
  const calls = [];
  const result = await generateValidatedSummary(INPUT, {
    available: true,
    models: { primary: 'deepseek-v4.1-flash', fallback: 'glm-5.3-flash' },
    ollama: async (_opts, model) => {
      calls.push(model);
      return model === 'glm-5.3-flash'
        ? 'Datapoint AI Data Grant doubles its data grant to $2M.'
        : LEAKED[0];
    },
  });
  assert.deepEqual(calls, ['deepseek-v4.1-flash', 'glm-5.3-flash']);
  assert.equal(result.summary, 'Datapoint AI Data Grant doubles its data grant to $2M.');
  assert.equal(result.provider, 'ollama');
  assert.equal(result.model, 'glm-5.3-flash');
  assert.equal(result.attempts[0].outcome, 'rejected');
  assert.match(result.attempts[0].detail, /starts-we-need|we-need-to-write/);
});

test('generateValidatedSummary returns no summary when every attempt is reasoning, empty, or errors', async () => {
  const result = await generateValidatedSummary(INPUT, {
    available: true,
    models: { primary: 'deepseek-v4.1-flash', fallback: 'glm-5.3-flash' },
    ollama: async (_opts, model) => {
      if (model === 'deepseek-v4.1-flash') return null;
      throw new Error('timeout');
    },
  });
  assert.equal(result.summary, null);
  assert.deepEqual(result.attempts.map(a => a.outcome), ['empty', 'error']);

  const rejected = await generateValidatedSummary(INPUT, {
    available: true,
    models: { primary: 'deepseek-v4.1-flash', fallback: '' },
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
