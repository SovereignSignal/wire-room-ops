require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildScrapedContentPrompt, buildFallbackPrompt } = require('../src/services/ollama');
const { buildGrokPrompt, buildAggregatorThreadPrompt, GROK_SEARCH_MODEL } = require('../src/services/grok');
const { buildPostPrompt, buildVerifierPrompt } = require('../src/services/post-generator');
const { buildEnrichedSummaryPrompt } = require('../src/services/auto-summarize');
const { buildForumJudgePrompt, RELEVANCE_KEYWORDS, DISCUSS_WATCH_NEWS_QUERY } = require('../src/services/forum');
const { parallelAreaGuide } = require('../src/services/parallel');
const { buildOpenExtractPrompt, buildWireResultExtractPrompt } = require('../src/services/source-feeds');
const { surfaceToScrapeSource } = require('../src/services/registry-watchers');

const REMOVED = [
  /Lead with a strong action verb/i,
  /Include ALL specific numbers/i,
  /WHY this matters/i,
  /unable to access/i,
  /ROI of \$1\.7/i,
  /TVL uplift/i,
];

function assertFactsOnly(prompt) {
  for (const pattern of REMOVED) assert.doesNotMatch(prompt, pattern);
  assert.match(prompt, /funder's own verb/i);
  assert.match(prompt, /return SKIP/i);
  assert.match(prompt, /do not add counts, ratios, ROI or percentages/i);
}

test('ollama and grok summary prompts drop the removed phrases and return SKIP', () => {
  assertFactsOnly(buildScrapedContentPrompt());
  assertFactsOnly(buildFallbackPrompt());
  assertFactsOnly(buildGrokPrompt());
  assertFactsOnly(buildAggregatorThreadPrompt({
    authorHandle: 'example',
    authorName: 'Example',
    tweetCount: 3,
    url: 'https://x.com/example/status/1',
    existingSummary: 'cached',
    fullThreadText: 'thread',
  }));
  assert.equal(GROK_SEARCH_MODEL, 'grok-4.7');
  assert.doesNotMatch(buildGrokPrompt(), /grok-4\.20-beta/);
});

test('post and summary prompts carry area wording and the verifier fail rule', () => {
  const area2 = buildPostPrompt({
    name: 'Round results',
    description: 'Recipients named.',
    amount: '$50,000',
    deadline: 'March 4, 2026',
    sourceUrl: 'https://example.org/a',
    bestLink: 'https://example.org/a',
    wireArea: '2',
  }, 'crypto');
  assert.match(area2, /X argues/);
  assert.match(area2, /Do not compute or add up totals/);
  assert.match(area2, /not an open call/i);
  assert.doesNotMatch(area2, /When the fields include an apply path or a deadline, include it/);

  const area3 = buildPostPrompt({
    name: 'Open call',
    description: 'Applications are open.',
    amount: null,
    deadline: 'June 1, 2026',
    sourceUrl: 'https://example.org/a',
    bestLink: 'https://example.org/a',
    wireArea: '3',
  }, 'oss');
  assert.match(area3, /When the fields include an apply path or a deadline, include it/);

  const summary = buildEnrichedSummaryPrompt({
    name: 'Example',
    description: 'A standing program.',
    amount: null,
    deadline: null,
    sourceUrl: 'https://example.org/a',
    wire: 'crypto',
  });
  assert.match(summary, /Summarize this funding item \(open call, award, governance decision, incentive, research or tool\)/);
  assert.match(summary, /never stated as fact/);
  assert.match(summary, /Do not compute or add up totals/);

  const verifier = buildVerifierPrompt('source', 'draft');
  assert.match(verifier, /FAIL if an opinion is stated as fact without attribution/);
  assert.match(verifier, /derived or added up rather than quoted from the source/);
});

test('forum, parallel, source-feed, and registry prompts cover areas 1-6 and keep Uniswap skipped', () => {
  const judge = buildForumJudgePrompt([{ title: 'Treasury vote', url: 'https://forum.example/t/1', forumName: 'Optimism', createdAt: null, replies: 0, views: 0, source: 'allowlist' }], 'crypto');
  assert.match(judge, /Find posts in wire areas 1–6/);
  assert.match(judge, /delegate elections and comms/i);
  assert.doesNotMatch(judge, /FUNDING OPPORTUNITIES for builders/);
  for (const word of ['awarded', 'recipients', 'results', 'retro', 'treasury', 'allocation', 'incentive', 'rewards', 'credits']) {
    assert.ok(RELEVANCE_KEYWORDS.includes(word), word);
  }
  assert.equal(DISCUSS_WATCH_NEWS_QUERY.classification, 'NEWS');
  assert.equal(DISCUSS_WATCH_NEWS_QUERY.status, 'awarded,voting');

  const forum = require('fs').readFileSync(require('path').join(__dirname, '../src/services/forum.ts'), 'utf8');
  assert.match(forum, /uniswap/i);

  const guide = parallelAreaGuide();
  assert.match(guide, /grant program results/);
  assert.match(guide, /VC\/equity raises/);

  const source = { name: 'Example', endpoint: 'https://example.org', urlPrefix: 'https://example.org', scrapePrompt: 'Registry proposals stay open-only.' };
  const open = buildOpenExtractPrompt(source, 'page');
  const wire = buildWireResultExtractPrompt(source, 'page');
  assert.match(open, /wire_area 3/);
  assert.match(open, /grants\.watch/);
  assert.match(wire, /wire_area 2/);
  assert.match(wire, /wire_area 1/);
  assert.match(wire, /result announcements are area 2/);

  const registry = surfaceToScrapeSource({ id: 1, org_name: 'NLnet', wire: 'oss', surface_type: 'grants_page', url: 'https://example.org/grants', tier: 'Tier 1' });
  assert.match(registry.scrapePrompt, /wire_area 3/);
  assert.match(registry.scrapePrompt, /wire_area 2/);
  assert.match(registry.scrapePrompt, /Registry proposals stay open-only/);

  const fs = require('fs');
  const path = require('path');
  const decided = fs.readFileSync(path.join(__dirname, '../src/jobs/decided-recheck.ts'), 'utf8');
  assert.match(decided, /Results for a known program count as "update"/);
  const review = fs.readFileSync(path.join(__dirname, '../src/services/prompt-review.ts'), 'utf8');
  assert.match(review, /findings in the six wire areas, excluding the OUT list/);
  assert.doesNotMatch(review, /actionable, current, high-quality opportunities/);
});
