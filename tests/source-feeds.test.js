require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

// Unit tests for the source-feeds ingester — pure parse/extract logic, no network.
// Live endpoint shapes are verified separately via src/scripts/source-feeds-dryrun.ts.

const { parseFeed, SOURCE_REGISTRY, readJsonBody, FeedFetchError } = require('../src/services/source-feeds');

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

test('registry: feed sources wired; Manifund re-enabled via scrape', () => {
  assert.ok(SOURCE_REGISTRY.length >= 10);
  const mf = reg('manifund');
  assert.equal(mf.enabled, true);
  assert.equal(mf.method, 'scrape');
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

test('OTF funds scrape source is wired (scrape method, funds endpoint)', () => {
  const s = reg('otf-funds');
  assert.ok(s, 'otf-funds exists');
  assert.equal(s.method, 'scrape');
  assert.ok(s.endpoint.includes('opentech.fund/funds'));
});

test('own-site funder scrape sources are registered', () => {
  for (const k of ['coefficient-giving','longview','sff','sovereign-tech','futo-grants']) {
    const s = reg(k);
    assert.ok(s, `${k} exists`);
    assert.equal(s.method, 'scrape');
  }
});

test('Phase 2b staged AI sources: aisafety-funding, ea-opportunities, eu-funding-tenders, sam-gov registered', () => {
  // scrape sources
  for (const [k, host] of [['aisafety-funding', 'aisafety.com'], ['ea-opportunities', 'eaopportunities.org']]) {
    const s = reg(k);
    assert.ok(s, `${k} exists`);
    assert.equal(s.method, 'scrape', `${k} is scrape`);
    assert.ok(s.endpoint.includes(host), `${k} endpoint includes ${host}`);
    assert.equal(s.wire, 'ai', `${k} wire is ai`);
  }
  assert.equal(reg('aisafety-funding').enabled, true, 'aisafety-funding is enabled (dry-run verified)');
  // rest_json stubs (gated; no keys or unresolved shape)
  for (const k of ['eu-funding-tenders', 'sam-gov']) {
    const s = reg(k);
    assert.ok(s, `${k} exists`);
    assert.equal(s.method, 'rest_json', `${k} is rest_json`);
    assert.equal(s.wire, 'ai', `${k} wire is ai`);
    assert.equal(s.enabled, false, `${k} is disabled (gated)`);
  }
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

// Minimal Response stand-in: only the two members readJsonBody touches.
function fakeResponse(body, contentLength) {
  return {
    headers: { get: (h) => (h.toLowerCase() === 'content-length' && contentLength != null ? String(contentLength) : null) },
    text: async () => body,
  };
}

test('readJsonBody parses a complete JSON body', async () => {
  const body = JSON.stringify({ programs: [{ name: 'A' }] });
  const out = await readJsonBody(fakeResponse(body, Buffer.byteLength(body, 'utf8')));
  assert.deepEqual(out, { programs: [{ name: 'A' }] });
});

test('readJsonBody reports truncation with byte counts, and marks it transient', async () => {
  const full = JSON.stringify({ programs: [{ name: 'A' }] });
  const cut = full.slice(0, 10);
  await assert.rejects(
    () => readJsonBody(fakeResponse(cut, Buffer.byteLength(full, 'utf8'))),
    (err) => {
      assert.ok(err instanceof FeedFetchError);
      assert.equal(err.transient, true);
      assert.match(err.message, /truncated body: got 10 of \d+ bytes/);
      return true;
    }
  );
});

test('readJsonBody counts BYTES not UTF-16 units — multibyte body is not a false truncation', async () => {
  // "é" is 1 UTF-16 unit but 2 UTF-8 bytes. A naive text.length check would
  // see 20 < 25 and wrongly report truncation on a complete body.
  const body = JSON.stringify({ name: 'Fondation Créé — Zürich' });
  const bytes = Buffer.byteLength(body, 'utf8');
  assert.ok(bytes > body.length, 'fixture must actually contain multibyte characters');
  const out = await readJsonBody(fakeResponse(body, bytes));
  assert.equal(out.name, 'Fondation Créé — Zürich');
});

test('readJsonBody reports invalid JSON when no content-length is present (chunked)', async () => {
  await assert.rejects(
    () => readJsonBody(fakeResponse('{"programs": [', null)),
    (err) => {
      assert.ok(err instanceof FeedFetchError);
      assert.equal(err.transient, true);
      assert.match(err.message, /invalid JSON \(14 bytes received\)/);
      return true;
    }
  );
});
