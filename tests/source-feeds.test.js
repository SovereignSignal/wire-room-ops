require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

// Unit tests for the source-feeds ingester — pure parse/extract logic, no network.
// Live endpoint shapes are verified separately via src/scripts/source-feeds-dryrun.ts.

const { parseFeed, SOURCE_REGISTRY, readJsonBody, FeedFetchError, inferTitleWireArea, stampFeedWireArea } = require('../src/services/source-feeds');

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

test('registry: dead feeds are gone and the October 2026 replacements are wired', () => {
  assert.equal(reg('manifund'), undefined);
  assert.equal(reg('avax-retro9000'), undefined);
  assert.equal(reg('ai2050'), undefined);
  assert.ok(reg('karma-gap').enabled);

  const avax = reg('avax-grants');
  assert.equal(avax.method, 'scrape');
  assert.equal(avax.endpoint, 'https://build.avax.network/grants');
  assert.equal(avax.wire, 'crypto');
  assert.equal(avax.enabled, true);

  assert.equal(reg('longview').endpoint, 'https://www.longview.org/grantmaking/');

  const schmidt = reg('schmidt-sciences');
  assert.equal(schmidt.method, 'rss');
  assert.equal(schmidt.endpoint, 'https://www.schmidtsciences.org/feed/');
  assert.equal(schmidt.titleAllow.test('Schmidt Sciences Names 28 AI2050 Fellows'), true);
  assert.equal(schmidt.titleAllow.test('AI agents evolve their own languages'), false);

  const octant = reg('octant');
  assert.equal(octant.method, 'rss');
  assert.equal(octant.endpoint, 'https://octant.substack.com/feed');
  assert.equal(octant.titleAllow.test('Epoch 13 - The Privacy Round'), true);
  assert.equal(octant.titleAllow.test('A closer look at the new Octant Voting App'), false);

  const esp = reg('ef-esp-rfp');
  assert.equal(esp.method, 'scrape');
  assert.equal(esp.endpoint, 'https://esp.ethereum.foundation/applicants/rfp');
  assert.equal(esp.enabled, true);

  const gitcoin = reg('gitcoin-campaigns');
  assert.equal(gitcoin.method, 'scrape');
  assert.equal(gitcoin.endpoint, 'https://gitcoin.co/campaigns');

  const alpha = reg('alpha-omega');
  assert.equal(alpha.method, 'rss');
  assert.equal(alpha.endpoint, 'https://alpha-omega.dev/feed/');
  assert.equal(alpha.titleAllow.test('Open call: security grants'), true);
  assert.equal(alpha.titleAllow.test('Securing Hex: How Alpha-Omega Helped Strengthen a Package Ecosystem'), false);
  assert.equal(alpha.titleAllow.test('Alpha-Omega awarded security grant recipients'), true);

  const nlnet = reg('nlnet-news');
  assert.equal(nlnet.titleAllow.test('NLnet announces recipients of the 2026 call'), true);
  assert.equal(nlnet.titleAllow.test('Office closed for the holiday'), false);
  const otf = reg('otf-news');
  assert.equal(otf.titleAllow.test('OTF round results and retro'), true);
});

test('RSS titles stamp result posts as wire_area 2 and framework posts as wire_area 1', () => {
  assert.equal(inferTitleWireArea('NLnet announces recipients of the 2026 call'), '2');
  assert.equal(inferTitleWireArea('Treasury allocation framework change'), '1');
  assert.equal(inferTitleWireArea('Epoch 13 - The Privacy Round'), null);
  const stamped = stampFeedWireArea({
    name: 'Round results', description: 'Recipients', url: 'https://example.org/r',
    amount: null, deadline: null, publishedAt: null,
  });
  assert.equal(stamped.metadata.wire_area, '2');
});

test('new RSS feeds parse an item and the title filter keeps the call', () => {
  const xml = `<rss><channel>
    <item><title>Epoch 13 - The Privacy Round</title><link>https://octant.substack.com/p/epoch-13</link>
      <pubDate>Wed, 11 Aug 2026 12:00:00 +0000</pubDate><description>Applications are open.</description></item>
    <item><title>A closer look at the new Octant Voting App</title><link>https://octant.substack.com/p/voting</link>
      <pubDate>Wed, 01 Jul 2026 12:00:00 +0000</pubDate><description>Product notes.</description></item>
  </channel></rss>`;
  const source = reg('octant');
  const items = parseFeed(xml, source).filter(it => source.titleAllow.test(it.name));
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://octant.substack.com/p/epoch-13');
  assert.ok(items[0].publishedAt.startsWith('2026-08-11'));
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

// Minimal Response stand-in: only the members readJsonBody touches.
// contentEncoding is optional (third param) so existing call sites (no encoding —
// i.e. identity) keep working unchanged.
function fakeResponse(body, contentLength, contentEncoding) {
  return {
    headers: {
      get: (h) => {
        const key = h.toLowerCase();
        if (key === 'content-length') return contentLength != null ? String(contentLength) : null;
        if (key === 'content-encoding') return contentEncoding != null ? contentEncoding : null;
        return null;
      },
    },
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

// Regression guard for the exact July 2026 outage signature: Karma GAP answered
// 200 + content-length: 0 + an empty body (identity encoding, nothing to decode).
test('a zero content-length empty body reports invalid JSON, not truncation', async () => {
  await assert.rejects(
    () => readJsonBody(fakeResponse('', 0)),
    (err) => {
      assert.ok(err instanceof FeedFetchError);
      assert.match(err.message, /invalid JSON \(0 bytes received\)/);
      return true;
    }
  );
});

test('readJsonBody does not report truncation when content-length is a compressed byte count', async () => {
  // Small JSON envelopes EXPAND under gzip: 33 raw bytes can compress to 48 bytes on
  // the wire. r.text() returns the DECODED body, so comparing its byte length against
  // a gzip content-length is comparing different units — the check must be skipped
  // whenever content-encoding says the body isn't identity.
  const body = JSON.stringify({ data: { posts: { results: [] } } }); // 33 raw bytes
  const decodedBytes = Buffer.byteLength(body, 'utf8');
  const gzippedContentLength = decodedBytes + 15; // simulate gzip expansion (e.g. 48 for 33)
  const out = await readJsonBody(fakeResponse(body, gzippedContentLength, 'gzip'));
  assert.deepEqual(out, { data: { posts: { results: [] } } });
});

const { classifyFetchError, DEFAULT_TIMEOUT_MS } = require('../src/services/source-feeds');

test('classifyFetchError turns an AbortSignal timeout into a readable transient error', () => {
  // AbortSignal.timeout() rejects with a DOMException named TimeoutError in Node 18+.
  const err = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const out = classifyFetchError(err, 45000);
  assert.equal(out.transient, true);
  assert.equal(out.message, 'timeout after 45s');
});

test('classifyFetchError also handles the AbortError spelling', () => {
  const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
  assert.equal(classifyFetchError(err, 20000).message, 'timeout after 20s');
});

test('classifyFetchError treats 5xx as transient and 4xx as permanent', () => {
  assert.equal(classifyFetchError(new Error('HTTP 503'), 20000).transient, true);
  assert.equal(classifyFetchError(new Error('HTTP 404'), 20000).transient, false);
});

test('classifyFetchError passes a FeedFetchError through unchanged', () => {
  const original = new FeedFetchError('truncated body: got 10 of 900 bytes', true);
  assert.equal(classifyFetchError(original, 20000), original);
});

test('classifyFetchError defaults unknown failures to permanent', () => {
  const out = classifyFetchError(new Error('itemsPath "programs" is not an array'), 20000);
  assert.equal(out.transient, false);
  assert.match(out.message, /itemsPath/);
});

// undici collapses connection-layer failures into a bare TypeError('fetch failed') /
// TypeError('terminated'), with the real cause nested in err.cause. classifyFetchError
// must unwrap it: known-transient causes retry, and the cause code must survive into
// the message (the alternative — "fetch failed" — is less informative than the JSON
// parse error it replaced).
test('classifyFetchError unwraps a connection-reset cause as transient and keeps the code', () => {
  const err = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });
  const out = classifyFetchError(err, 20000);
  assert.equal(out.transient, true);
  assert.match(out.message, /ECONNRESET/);
});

test('classifyFetchError unwraps an unexpected-close cause (terminated) as transient', () => {
  const err = Object.assign(new Error('terminated'), { cause: { name: 'SocketError', message: 'other side closed' } });
  const out = classifyFetchError(err, 20000);
  assert.equal(out.transient, true);
  assert.match(out.message, /other side closed/);
});

test('classifyFetchError keeps a DNS failure (ENOTFOUND) permanent — a dead domain must not retry daily', () => {
  const err = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  const out = classifyFetchError(err, 20000);
  assert.equal(out.transient, false);
  assert.match(out.message, /ENOTFOUND/);
});

test('karma-gap gets a longer timeout than the registry default', () => {
  assert.equal(reg('karma-gap').timeoutMs, 45000);
  assert.equal(DEFAULT_TIMEOUT_MS, 20000);
});

test('karma-gap requests identity encoding — the API returns an empty gzip body otherwise', () => {
  // Server defect: with Accept-Encoding: gzip (Node fetch's default) this API answers
  // 200 + content-encoding: gzip + content-length: 0 + empty body. Verified 2026-07-30.
  assert.equal(reg('karma-gap').headers['Accept-Encoding'], 'identity');
});

const { fetchSourceWithTransientRetry } = require('../src/jobs/source-feeds');

const noSleep = async () => {};
const src = { key: 'k', name: 'K', wire: 'crypto', method: 'rest_json', endpoint: 'https://x', enabled: true };

test('transient failure is retried once and can succeed', async () => {
  let calls = 0;
  const items = await fetchSourceWithTransientRetry(src, async () => {
    calls++;
    if (calls === 1) throw new FeedFetchError('truncated body: got 10 of 900 bytes', true);
    return [{ name: 'A', description: '', url: 'https://x/a', amount: null, deadline: null, publishedAt: null }];
  }, noSleep);
  assert.equal(calls, 2);
  assert.equal(items.length, 1);
});

test('permanent failure is NOT retried — a paid scrape must not run twice', async () => {
  let calls = 0;
  await assert.rejects(
    () => fetchSourceWithTransientRetry(src, async () => { calls++; throw new Error('HTTP 404'); }, noSleep),
    (err) => { assert.equal(err.message, 'HTTP 404'); assert.equal(err.transient, false); return true; }
  );
  assert.equal(calls, 1, 'permanent failures must be attempted exactly once');
});

test('a transient failure twice surfaces the second error', async () => {
  let calls = 0;
  await assert.rejects(
    () => fetchSourceWithTransientRetry(src, async () => {
      calls++;
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    }, noSleep),
    (err) => { assert.equal(err.message, 'timeout after 20s'); return true; }
  );
  assert.equal(calls, 2);
});

test('retry honours the per-source timeout in its message', async () => {
  await assert.rejects(
    () => fetchSourceWithTransientRetry({ ...src, timeoutMs: 45000 }, async () => {
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    }, noSleep),
    (err) => { assert.equal(err.message, 'timeout after 45s'); return true; }
  );
});
