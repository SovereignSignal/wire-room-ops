require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

// Unit tests for the source-feeds ingester — pure parse/extract logic, no network.
// Live endpoint shapes are verified separately via src/scripts/source-feeds-dryrun.ts.

const { parseFeed, SOURCE_REGISTRY } = require('../src/services/source-feeds');

const reg = (key) => SOURCE_REGISTRY.find(s => s.key === key);

test('parseFeed reads RSS <item> title/link/pubDate/description', () => {
  const xml = `<rss><channel>
    <item><title>RFP: Fund Safe AI</title><link>https://x.org/rfp</link>
      <pubDate>Fri, 12 Dec 2025 13:30:42 +0000</pubDate>
      <description><![CDATA[We fund <b>safety</b> work.]]></description></item>
  </channel></rss>`;
  const items = parseFeed(xml, { method: 'rss' });
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'RFP: Fund Safe AI');
  assert.equal(items[0].url, 'https://x.org/rfp');
  assert.equal(items[0].description, 'We fund safety work.'); // tags stripped, CDATA unwrapped
  assert.ok(items[0].publishedAt.startsWith('2025-12-12'));
});

test('parseFeed reads Atom <entry> and resolves relative link via urlPrefix', () => {
  const xml = `<feed><entry>
    <title type="text">Apply for funding before August 1st 2026</title>
    <link href="/news/2026/call.html"/>
    <updated>2026-06-12T00:00:00Z</updated>
    <content type="xhtml"><div>NGI Zero open call.</div></content>
  </entry></feed>`;
  const items = parseFeed(xml, { method: 'rss', urlPrefix: 'https://nlnet.nl' });
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://nlnet.nl/news/2026/call.html');
  assert.ok(items[0].name.includes('Apply for funding'));
});

test('Karma GAP extractor: builds funding-map fallback URL + parses budget, skips hackathons', () => {
  const extract = reg('karma-gap').extract;

  const grant = extract({
    type: 'grant', name: 'Filecoin ProPGF Batch 3', programId: 1479,
    metadata: { title: 'Filecoin ProPGF Batch 3', description: 'A $2M milestone-based fund.', programBudgetNumeric: 2000000, endsAt: '2026-07-01T00:00:00Z' },
    createdAt: '2026-05-13T15:39:29Z',
  });
  assert.equal(grant.url, 'https://gap.karmahq.xyz/funding-map/1479'); // no applicationUrl → fallback
  assert.equal(grant.amount, '2000000');
  assert.ok(grant.deadline.startsWith('2026-07-01'));

  // applicationUrl wins when present
  const withApp = extract({ type: 'grant', name: 'X', programId: 9, metadata: { title: 'X', applicationUrl: 'https://x.org/apply', description: 'd' } });
  assert.equal(withApp.url, 'https://x.org/apply');

  // BSON extended-JSON deadline ($timestamp.t = unix seconds)
  const bson = extract({ type: 'grant', name: 'Y', programId: 5, metadata: { title: 'Y', description: 'd' }, deadline: { $timestamp: { t: 1782000000 } } });
  assert.ok(bson.deadline.startsWith('20')); // ISO date produced

  assert.equal(extract({ type: 'hackathon', name: 'Student Hack', metadata: { title: 'Student Hack' } }), null);
  assert.equal(extract({ type: 'vcFund', name: 'Some VC', metadata: { title: 'Some VC' } }), null);
});

test('Giveth extractor: constructs qf URL and drops already-ended rounds', () => {
  const extract = reg('giveth-qf').extract;
  const open = extract({ name: 'GG25', slug: 'gg25', description: 'round', allocatedFundUSD: 50000, endDate: '2099-01-01T00:00:00Z' });
  assert.equal(open.url, 'https://giveth.io/qf/gg25');
  assert.equal(open.amount, '50000');
  assert.equal(extract({ name: 'Old', slug: 'old', endDate: '2020-01-01T00:00:00Z' }), null); // ended → dropped
});

test('Avalanche extractor: unique round URL + reward string', () => {
  const extract = reg('avax-retro9000').extract;
  const r = extract({ id: 'cmabc', name: 'C-Chain Round 4', description: 'd', potential_reward: { amount: 10000, currency: 'AVAX' }, submission_ends_at: '2026-06-18T18:00:00Z', created_at: '2026-05-27T17:34:21Z' });
  assert.equal(r.url, 'https://retro9000.avax.network/?round=cmabc');
  assert.equal(r.amount, '10000 AVAX');
  assert.ok(r.deadline.startsWith('2026-06-18'));
});

test('registry: feed sources are wired and Manifund is disabled (Vercel bot-check)', () => {
  assert.ok(SOURCE_REGISTRY.length >= 8);
  assert.equal(reg('manifund').enabled, false);
  assert.ok(reg('karma-gap').enabled);
});

test('EA Forum/LessWrong sources: multiple Forum-Magnum graphql feeds wired with itemsPath', () => {
  const ea = reg('ea-forum-funding');
  assert.equal(ea.method, 'graphql');
  assert.equal(ea.itemsPath, 'data.posts.results');
  assert.ok(reg('ea-forum-opportunities'), 'second EA Forum tag source exists');
  const lw = reg('lesswrong-funding');
  assert.ok(lw && lw.endpoint.includes('lesswrong.com'), 'LessWrong source exists');
});

test('Grants.gov factory: builds per-keyword source, raises rows to 100, shared extract filters off-beat', () => {
  const ai = reg('grants-gov-ai');
  assert.equal(JSON.parse(ai.body).rows, 100);
  assert.equal(JSON.parse(ai.body).keyword, 'artificial intelligence');
  assert.ok(reg('grants-gov-ml'), 'machine-learning keyword source exists');
  // shared extract: keeps an AI research opp, drops a medical one
  const keep = ai.extract({ title: 'NSF Trailblazer Engineering Impact Award', id: '358001', agencyName: 'National Science Foundation', number: 'NSF 26-502', oppStatus: 'posted' });
  assert.equal(keep.url, 'https://www.grants.gov/search-results-detail/358001');
  assert.equal(ai.extract({ title: 'Maternal Cardiovascular Health Study', id: '9', agencyName: 'NIH' }), null);
});
