require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkFaithfulness, checkTelegramHtml } = require('../src/services/post-faithfulness');
const { buildPostPrompt, generatePosts, templatePosts, postGenerationModel, postVerificationModel } = require('../src/services/post-generator');
const { buildEnrichedSummaryPrompt } = require('../src/services/auto-summarize');

const TRACKS = {
  input: 'Example Foundation fellowship. Three tracks: $100,000, $112,000, and $100,000. Applications are being accepted.',
  source: 'https://example.org/fellowship',
};

test('currency that is not in the input is rejected, including a summed total', () => {
  const output = '<b>Example Foundation fellowship — $212K</b>\n\n<a href="https://example.org/fellowship">Source</a>';
  const check = checkFaithfulness(`${TRACKS.input}\n${TRACKS.source}`, output);
  assert.equal(check.ok, false);
  assert.match(check.violations.join('\n'), /212000/);
});

test('an amount copied in another format is allowed', () => {
  const check = checkFaithfulness(
    'Award of $100K.\nhttps://example.org/a',
    '<b>Award of $100,000</b>\n\n<a href="https://example.org/a">Source</a>',
  );
  assert.deepEqual(check.violations.filter(item => item.startsWith('amount')), []);
});

test('four tracks is rejected when the input says three', () => {
  const check = checkFaithfulness(
    'The program has three tracks.\nhttps://example.org/a',
    '<b>The program has four tracks</b>\n\n<a href="https://example.org/a">Source</a>',
  );
  assert.equal(check.ok, false);
  assert.match(check.violations.join('\n'), /number 4/);
});

test('opens is rejected unless the input uses that verb', () => {
  const standing = checkFaithfulness(
    'The fellowship is accepting applications.\nhttps://example.org/a',
    '<b>The fellowship opens for maintainers</b>\n\n<a href="https://example.org/a">Source</a>',
  );
  assert.equal(standing.ok, false);
  assert.match(standing.violations.join('\n'), /opens/);

  const stated = checkFaithfulness(
    'The fellowship opens for maintainers.\nhttps://example.org/a',
    '<b>The fellowship opens for maintainers</b>\n\n<a href="https://example.org/a">Source</a>',
  );
  assert.equal(stated.violations.some(item => /opens/.test(item)), false);
});

test('eligibility that the input does not state is rejected', () => {
  const check = checkFaithfulness(
    'Example research grant. $50K.\nhttps://example.org/a',
    '<b>Example research grant — $50K</b>\n\nOpen to EU residents.\n\n<a href="https://example.org/a">Source</a>',
  );
  assert.equal(check.ok, false);
  assert.match(check.violations.join('\n'), /eligibility/);
});

test('opinion lines are rejected', () => {
  const check = checkFaithfulness(
    'Example Foundation grant. $50K.\nhttps://example.org/a',
    '<b>Example Foundation grant — $50K</b>\n\nOne of the largest programs and worth exploring. It signals strong appetite.\n\n<a href="https://example.org/a">Source</a>',
  );
  assert.equal(check.ok, false);
  const text = check.violations.join('\n');
  assert.match(text, /one of the/);
  assert.match(text, /worth exploring/);
  assert.match(text, /signals/);
});

test('a date the input does not state is rejected, and an equivalent date is allowed', () => {
  const invented = checkFaithfulness(
    'Deadline 2026-03-01.\nhttps://example.org/a',
    '<b>Deadline March 16, 2026</b>\n\n<a href="https://example.org/a">Source</a>',
  );
  assert.match(invented.violations.join('\n'), /2026-03-16/);

  const same = checkFaithfulness(
    'Deadline 2026-03-01.\nhttps://example.org/a',
    '<b>Deadline March 1, 2026</b>\n\n<a href="https://example.org/a">Source</a>',
  );
  assert.equal(same.violations.some(item => item.startsWith('date')), false);
});

test('rolling is rejected unless the input says it', () => {
  const check = checkFaithfulness(
    'Applications are being accepted.\nhttps://example.org/a',
    '<b>Applications are being accepted</b>\n\nDeadline is rolling.\n\n<a href="https://example.org/a">Source</a>',
    { html: false },
  );
  assert.match(check.violations.join('\n'), /rolling/);
});

test('Telegram HTML must use allowed, balanced tags', () => {
  assert.match(checkTelegramHtml('<b>Headline').join('\n'), /unclosed/);
  assert.match(checkTelegramHtml('<script>alert(1)</script>').join('\n'), /disallowed/);
  assert.deepEqual(checkTelegramHtml('<b>Headline</b>\n\n<a href="https://example.org/a">Source</a>'), []);
});

test('the post prompt no longer asks for new information or opens/launches examples', () => {
  const prompt = buildPostPrompt({
    name: 'Example',
    description: '',
    amount: null,
    deadline: null,
    sourceUrl: 'https://example.org/a',
    bestLink: 'https://example.org/a',
  }, 'crypto');
  assert.doesNotMatch(prompt, /add NEW information/i);
  assert.doesNotMatch(prompt, /NEW information only/i);
  assert.doesNotMatch(prompt, /adding context beyond the headline/i);
  assert.doesNotMatch(prompt, /OpenAI launches/);
  assert.doesNotMatch(prompt, /Sovereign Tech Agency opens/);
  assert.match(prompt, /only facts/i);
  assert.match(prompt, /headline only/i);
});

test('the summary prompt uses the same faithfulness rules', () => {
  const prompt = buildEnrichedSummaryPrompt({
    name: 'Example',
    description: 'A standing program.',
    amount: null,
    deadline: null,
    sourceUrl: 'https://example.org/a',
    wire: 'crypto',
  });
  assert.match(prompt, /only facts/i);
  assert.match(prompt, /is accepting applications/);
  assert.doesNotMatch(prompt, /strong action verb/i);
  assert.doesNotMatch(prompt, /add NEW information/i);
});

test('a thin template does not invent a summary sentence', () => {
  const posts = templatePosts({
    name: 'Example Fellowship',
    description: '',
    amount: '$50K',
    deadline: null,
    sourceUrl: 'https://example.org/a',
  });
  assert.match(posts.telegram, /Example Fellowship/);
  assert.match(posts.telegram, /\$50K/);
  assert.doesNotMatch(posts.telegram, /Grant opportunity/);
  const check = checkFaithfulness('Example Fellowship\n$50K\nhttps://example.org/a', posts.telegram);
  assert.deepEqual(check.violations, [], check.violations.join('\n'));
});

test('post generation uses temperature 0.1 and the verifier uses 0', async (t) => {
  const previousGen = process.env.POST_GEN_MODEL;
  const previousVerify = process.env.POST_VERIFY_MODEL;
  process.env.POST_GEN_MODEL = 'post-gen-test';
  process.env.POST_VERIFY_MODEL = 'post-verify-test';
  const ollama = require('../src/services/ollama');
  const calls = [];
  t.mock.method(ollama, 'ollamaComplete', async (params) => {
    calls.push(params);
    if (params.purpose === 'post-verify') {
      return { model: params.model, text: '{"unsupported":[]}' };
    }
    return {
      model: params.model,
      text: JSON.stringify({
        tweet: 'Example Fellowship is accepting applications. $50K https://example.org/a',
        telegram: '<b>Example Fellowship is accepting applications — $50K</b>\n\n<a href="https://example.org/a">Source</a>',
      }),
    };
  });
  try {
    assert.equal(postGenerationModel(), 'post-gen-test');
    assert.equal(postVerificationModel(), 'post-verify-test');
    const result = await generatePosts({
      name: 'Example Fellowship',
      description: 'Example Fellowship is accepting applications.',
      amount: '$50K',
      deadline: null,
      sourceUrl: 'https://example.org/a',
    }, 'oss');
    assert.equal(result.model, 'post-gen-test');
    assert.equal(result.checkResult.source, 'model');
    assert.equal(calls.filter(call => call.purpose === 'post-gen').length, 1);
    assert.equal(calls.find(call => call.purpose === 'post-gen').temperature, 0.1);
    assert.equal(calls.find(call => call.purpose === 'post-gen').model, 'post-gen-test');
    assert.equal(calls.find(call => call.purpose === 'post-verify').temperature, 0);
    assert.equal(calls.find(call => call.purpose === 'post-verify').model, 'post-verify-test');
    assert.match(calls[0].prompt, /only facts/i);
  } finally {
    if (previousGen === undefined) delete process.env.POST_GEN_MODEL;
    else process.env.POST_GEN_MODEL = previousGen;
    if (previousVerify === undefined) delete process.env.POST_VERIFY_MODEL;
    else process.env.POST_VERIFY_MODEL = previousVerify;
  }
});

test('a draft that fails the checker is retried once and then replaced by the template', async (t) => {
  const ollama = require('../src/services/ollama');
  let drafts = 0;
  t.mock.method(ollama, 'ollamaComplete', async (params) => {
    if (params.purpose === 'post-verify') return { model: 'verifier', text: '{"unsupported":["combined the awards into $212K"]}' };
    drafts += 1;
    return {
      model: 'drafter',
      text: JSON.stringify({
        tweet: 'Total $212K https://example.org/fellowship',
        telegram: '<b>Total $212K</b>\n\n<a href="https://example.org/fellowship">Source</a>',
      }),
    };
  });
  const result = await generatePosts({
    name: 'Example Foundation fellowship',
    description: TRACKS.input,
    amount: null,
    deadline: null,
    sourceUrl: TRACKS.source,
  }, 'crypto');
  assert.equal(drafts, 2);
  assert.equal(result.model, 'template');
  assert.equal(result.checkResult.source, 'template');
  assert.doesNotMatch(result.telegram, /212/);
  assert.equal(result.verifierResult.ok, false);
  assert.match(result.checkResult.rejected.join('\n'), /212|unsupported/);
});
