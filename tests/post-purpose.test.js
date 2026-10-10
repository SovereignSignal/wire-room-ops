require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkFaithfulness } = require('../src/services/post-faithfulness');
const { buildPostPrompt, coversSentence, generatePosts, templatePosts, wireBodySentences } = require('../src/services/post-generator');

// Reconstructed from the Oct 10, 2026 posts and the curated facts those posts
// dropped. Production rows were not readable from this environment. The shipped
// sentences are first, which is what the old first-sentence fallback kept.
const SWF = {
  name: 'Social Web Foundation Fediverse Multimedia Grants',
  description: 'Applications are only for developer/creator teams and are submitted through the SWF grants portal. With the Interledger Foundation as partner, the grants fund ActivityPub and Fediverse multimedia software and new publication types.',
  amount: 'up to $20,000',
  deadline: 'November 4, 2026',
  sourceUrl: 'https://socialwebfoundation.org/2026/10/07/call-for-proposals-fediverse-multimedia-grants/',
};

const MERCOR = {
  name: 'Mercor AI Research Fund',
  description: "Grants can cover researcher hours, API costs, time of experts from Mercor's platform, and conference stipends. Open to researchers at universities, non-profit research organizations, public benefit corporations and small startups that do not sell AI training data, based in the US or UK. The fund supports research on real-world evaluations, interactive environments, long-horizon tasks, agentic tool use, reasoning, post-training, and evaluation methodology. Submit an Expression of Interest.",
  amount: '$5M',
  deadline: null,
  sourceUrl: 'https://jobs.ashbyhq.com/mercor/e1f6792d-1aae-4c2e-8edb-e2b91343dbb5',
};

const SWF_LIVE = '<b>Social Web Foundation Fediverse Multimedia Grants: up to $20,000, due November 4, 2026</b>\n\nApplications are only for developer/creator teams and are submitted through the SWF grants portal.\n\n🔗 <a href="https://socialwebfoundation.org/2026/10/07/call-for-proposals-fediverse-multimedia-grants/">Source</a>';

const MERCOR_LIVE = '<b>Mercor AI Research Fund: $5M for AI research grants</b>\n\nGrants can cover researcher hours, API costs, time of experts from Mercor\'s platform, and conference stipends. Open to researchers at universities, non-profit research organizations, public benefit corporations and small startups that do not sell AI training data, based in the US or UK.\n\n🔗 <a href="https://jobs.ashbyhq.com/mercor/e1f6792d-1aae-4c2e-8edb-e2b91343dbb5">Source</a>';

function facts(entry) {
  return [entry.name, entry.description, entry.amount, entry.deadline, entry.sourceUrl]
    .filter(part => typeof part === 'string' && part.trim())
    .join('\n');
}

function assertFaithful(entry, telegram) {
  const check = checkFaithfulness(facts(entry), telegram, { html: true });
  assert.equal(check.ok, true, check.violations.join('\n'));
}

test('the Social Web Foundation post keeps what the grants fund, including the partner', () => {
  const body = wireBodySentences(SWF.description);
  assert.match(body[0], /ActivityPub/);
  assert.match(body[0], /Interledger/);
  assert.equal(coversSentence(SWF_LIVE, body[0]), false);

  const posts = templatePosts(SWF);
  assert.match(posts.telegram, /<b>Social Web Foundation Fediverse Multimedia Grants — up to \$20,000, deadline November 4, 2026<\/b>/);
  assert.match(posts.telegram, /ActivityPub and Fediverse multimedia software and new publication types/);
  assert.match(posts.telegram, /Interledger Foundation as partner/);
  assert.match(posts.telegram, /developer\/creator teams/);
  assert.match(posts.telegram, /SWF grants portal/);
  assert.ok(posts.telegram.indexOf('ActivityPub') < posts.telegram.indexOf('developer/creator'));
  assert.match(posts.telegram, /🔗 <a href="https:\/\/socialwebfoundation.org\/2026\/10\/07\/call-for-proposals-fediverse-multimedia-grants\/">Source<\/a>/);
  assertFaithful(SWF, posts.telegram);
});

test('the Mercor post keeps the research topics and the expression of interest', () => {
  const body = wireBodySentences(MERCOR.description);
  assert.match(body[0], /real-world evaluations/);
  assert.equal(coversSentence(MERCOR_LIVE, body[0]), false);
  assert.equal(coversSentence(MERCOR_LIVE, 'Submit an Expression of Interest.'), false);

  const posts = templatePosts(MERCOR);
  assert.match(posts.telegram, /<b>Mercor AI Research Fund — \$5M<\/b>/);
  assert.match(posts.telegram, /real-world evaluations/);
  assert.match(posts.telegram, /long-horizon tasks/);
  assert.match(posts.telegram, /evaluation methodology/);
  assert.match(posts.telegram, /researcher hours/);
  assert.match(posts.telegram, /Open to researchers at universities/);
  assert.match(posts.telegram, /Expression of Interest/);
  assert.ok(posts.telegram.indexOf('real-world evaluations') < posts.telegram.indexOf('researcher hours'));
  assert.ok(posts.telegram.indexOf('researcher hours') < posts.telegram.indexOf('Expression of Interest'));
  assert.match(posts.telegram, /🔗 <a href="https:\/\/jobs.ashbyhq.com\/mercor\/e1f6792d-1aae-4c2e-8edb-e2b91343dbb5">Source<\/a>/);
  assertFaithful(MERCOR, posts.telegram);
});

test('a non-empty post prompt asks for the purpose sentence before eligibility', () => {
  const prompt = buildPostPrompt({ ...SWF, bestLink: SWF.sourceUrl, wireArea: '3' }, 'oss');
  assert.match(prompt, /what the funding is for/);
  assert.match(prompt, /before eligibility or how to apply/);
  assert.doesNotMatch(prompt, /Otherwise omit it/);
  assert.match(prompt, /When the fields include an apply path or a deadline, include it/);
});

test('a model draft that drops the purpose sentence is replaced by the template', async (t) => {
  const ollama = require('../src/services/ollama');
  const prompts = [];
  t.mock.method(ollama, 'ollamaComplete', async (params) => {
    if (params.purpose === 'post-verify') return { model: 'verifier', text: '{"unsupported":[]}' };
    prompts.push(params.prompt);
    const telegram = params.prompt.includes('Mercor') ? MERCOR_LIVE : SWF_LIVE;
    return { model: 'drafter', text: JSON.stringify({ tweet: `See ${SWF.sourceUrl}`, telegram }) };
  });

  const swf = await generatePosts(SWF, 'oss');
  assert.equal(swf.model, 'template');
  assert.match(swf.telegram, /ActivityPub/);
  assert.match(swf.telegram, /Interledger/);
  assert.match(swf.checkResult.rejected.join('\n'), /omitted:/);
  assert.match(prompts[1], /Include these sentences from the description/);
  assert.match(prompts[1], /ActivityPub/);
  assert.doesNotMatch(prompts[1], /none of these remain/);
  assertFaithful(SWF, swf.telegram);

  const mercor = await generatePosts(MERCOR, 'ai');
  assert.equal(mercor.model, 'template');
  assert.match(mercor.telegram, /real-world evaluations/);
  assert.match(mercor.telegram, /Expression of Interest/);
  assert.match(mercor.checkResult.rejected.join('\n'), /omitted:/);
  assertFaithful(MERCOR, mercor.telegram);
});

test('a model draft that already states the purpose is kept', async (t) => {
  const drafted = templatePosts(SWF);
  const ollama = require('../src/services/ollama');
  t.mock.method(ollama, 'ollamaComplete', async (params) => {
    if (params.purpose === 'post-verify') return { model: 'verifier', text: '{"unsupported":[]}' };
    return { model: 'drafter', text: JSON.stringify({ tweet: `Fediverse multimedia grants ${SWF.sourceUrl}`, telegram: drafted.telegram }) };
  });
  const result = await generatePosts(SWF, 'oss');
  assert.equal(result.model, 'drafter');
  assert.equal(result.checkResult.source, 'model');
  assert.equal(result.telegram, drafted.telegram);
});
