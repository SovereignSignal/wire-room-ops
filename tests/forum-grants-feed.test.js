require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

// Exclusion list is read from env at config load, so set it before requiring.
process.env.EXCLUDED_ORGS = 'example dao';

const { grantsFeedItemToRaw, fetchGrantsFeedResults } = require('../src/services/forum');

// --- grantsFeedItemToRaw mapping ---

test('grantsFeedItemToRaw keeps the thread headline as the name and the program in metadata', () => {
  const raw = grantsFeedItemToRaw({
    title: '[RFC] Grants Council Season 9 Budget',
    program: 'Optimism Grants Council Season 9',
    url: 'https://gov.optimism.io/t/rfc-s9/9001',
    protocol: 'Optimism',
    kind: 'program_launch',
    confidence: 88,
    status: 'open',
    excerpt: 'The Grants Council proposes a Season 9 budget of 4M OP...',
    amountMax: 4000000,
    currency: 'OP',
    deadline: '2026-08-15T00:00:00.000Z',
    topicCreatedAt: new Date().toISOString(),
  });
  assert.equal(raw.name, '[RFC] Grants Council Season 9 Budget');
  assert.equal(raw.metadata.program, 'Optimism Grants Council Season 9');
  assert.match(raw.description, /Program: Optimism Grants Council Season 9/);
  assert.equal(raw.sourceUrl, 'https://gov.optimism.io/t/rfc-s9/9001');
  assert.equal(raw.amount, '4,000,000 OP');
  assert.equal(raw.deadline, '2026-08-15');
  assert.match(raw.description, /Signal: open/);
  assert.match(raw.description, /discuss\.watch grants feed, 88% program_launch/);
});

test('grantsFeedItemToRaw falls back to title, formats USD ranges, nulls absent fields', () => {
  const raw = grantsFeedItemToRaw({
    title: 'New dev tooling RFP',
    url: 'https://forum.celo.org/t/rfp/123',
    protocol: 'Celo',
    kind: 'rfp',
    confidence: 72,
    amountMin: 50000,
    amountMax: 100000,
    currency: 'USD',
  });
  assert.equal(raw.name, 'New dev tooling RFP');
  assert.equal(raw.amount, '$50,000–100,000');
  assert.equal(raw.deadline, null);
  assert.equal(raw.sourcePublishedAt, null);
});

test('grantsFeedItemToRaw keeps application titles distinct inside one program', () => {
  const raw = grantsFeedItemToRaw({
    title: 'Grant Application: Tensor Core Accelerated Proving for Orchard',
    program: 'Zcash Community Grants',
    url: 'https://forum.zcashcommunity.com/t/grant-application-tensor-core/56664',
    protocol: 'Zcash',
    kind: 'application',
    confidence: 94,
  });

  assert.equal(raw.name, 'Grant Application: Tensor Core Accelerated Proving for Orchard');
  assert.equal(raw.metadata.program, 'Zcash Community Grants');
  assert.match(raw.description, /Program: Zcash Community Grants/);
});

// --- fetchGrantsFeedResults (stubbed fetch) ---
// One parent so these tests don't replace global.fetch while another is in its
// inter-request delay.

function stubFetch(payload, status = 200) {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    };
  };
  return calls;
}

function grantsParams(url) {
  return new URL(String(url)).searchParams;
}

test('fetchGrantsFeedResults request behavior', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  await t.test('maps items, skips excluded orgs and stale threads', async () => {
    const fresh = new Date().toISOString();
    const stale = new Date(Date.now() - 90 * 86400000).toISOString();
    const calls = stubFetch({
      items: [
        { title: 'CoW Grants: batch 12', url: 'https://forum.cow.fi/t/batch-12/900', protocol: 'CoW Protocol', confidence: 90, kind: 'application', topicCreatedAt: fresh },
        { title: 'Example DAO CFM round', url: 'https://gov.exampledao.org/t/cfm/800', protocol: 'Example DAO Governance', confidence: 95, kind: 'rfp', topicCreatedAt: fresh },
        { title: 'Ancient grants thread', url: 'https://forum.celo.org/t/old/1', protocol: 'Celo', confidence: 80, kind: 'rfp', topicCreatedAt: stale },
        { title: 'No URL item', confidence: 80 },
      ],
      meta: { count: 4, nextCursor: null },
    });

    const { results, urls } = await fetchGrantsFeedResults('crypto', '2026-07-04');

    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'CoW Grants: batch 12');
    assert.ok(urls.has('https://forum.cow.fi/t/batch-12/900'));
    assert.equal(calls.length, 1);
    const params = grantsParams(calls[0]);
    assert.match(calls[0], /\/grants\?/);
    assert.equal(params.get('wire'), 'crypto');
    assert.match(params.get('min_confidence'), /^\d+$/);
    assert.equal(params.get('limit'), '100');
    assert.equal(params.get('status'), null);
  });

  await t.test('drops voting, awarded and closed items, keeps other statuses, and still skips excluded orgs', async () => {
    const fresh = new Date().toISOString();
    stubFetch({
      items: [
        { id: 10, title: 'Season results', url: 'https://gov.optimism.io/t/results/1', protocol: 'Optimism', confidence: 90, status: 'awarded', topicCreatedAt: fresh },
        { id: 11, title: 'Live treasury vote', url: 'https://gov.arbitrum.foundation/t/vote/2', protocol: 'Arbitrum', confidence: 92, status: 'Voting', topicCreatedAt: fresh },
        { id: 12, title: 'Round 4 closed', url: 'https://forum.celo.org/t/round-4/3', protocol: 'Celo', confidence: 95, status: 'closed', topicCreatedAt: fresh },
        { id: 13, title: 'Builder grants are open', url: 'https://forum.celo.org/t/builders/4', protocol: 'Celo', confidence: 95, status: 'open', topicCreatedAt: fresh },
        { id: 14, title: 'Next round announced', url: 'https://forum.cow.fi/t/next/5', protocol: 'CoW Protocol', confidence: 90, status: 'announced', topicCreatedAt: fresh },
        { id: 15, title: 'Grants program', url: 'https://forum.zcashcommunity.com/t/zcg/6', protocol: 'Zcash', confidence: 90, status: 'unknown', topicCreatedAt: fresh },
        { id: 16, title: 'Untagged RFP', url: 'https://forum.scroll.io/t/rfp/7', protocol: 'Scroll', confidence: 90, topicCreatedAt: fresh },
        { id: 17, title: 'Example DAO open call', url: 'https://gov.example-dao.org/t/call/8', protocol: 'Example DAO', confidence: 99, status: 'open', topicCreatedAt: fresh },
      ],
    });
    const { results, urls } = await fetchGrantsFeedResults('crypto', '2026-10-01');
    assert.deepEqual(results.map(item => item.name), [
      'Builder grants are open',
      'Next round announced',
      'Grants program',
      'Untagged RFP',
    ]);
    assert.equal(urls.has('https://gov.optimism.io/t/results/1'), false);
    assert.equal(results.some(item => item.metadata && 'wire_area' in item.metadata), false);
  });

  await t.test('a comma-separated status is one request per value, merged and deduped by id or url', async () => {
    const fresh = new Date().toISOString();
    const stale = new Date(Date.now() - 90 * 86400000).toISOString();
    const pages = {
      open: {
        items: [
          { id: 10, title: 'Season grants', url: 'https://gov.optimism.io/t/grants/1', protocol: 'Optimism', confidence: 90, status: 'open', topicCreatedAt: fresh },
          { id: 12, title: 'Shared url call', url: 'https://forum.celo.org/t/round/3', protocol: 'Celo', confidence: 80, status: 'open', topicCreatedAt: fresh },
          { id: 15, title: 'Stale twin', url: 'https://forum.example/t/cycle/9', protocol: 'Example', confidence: 70, status: 'open', topicCreatedAt: stale },
        ],
      },
      announced: {
        items: [
          { id: '10', title: 'Season grants again', url: 'https://gov.optimism.io/t/grants/1?src=feed', protocol: 'Optimism', confidence: 91, status: 'announced', topicCreatedAt: fresh },
          { id: 13, title: 'Shared url duplicate', url: 'https://forum.celo.org/t/round/3/', protocol: 'Celo', confidence: 70, status: 'announced', topicCreatedAt: fresh },
          { id: 15, title: 'Fresh cycle', url: 'https://forum.example/t/cycle/9', protocol: 'Example', confidence: 84, status: 'announced', topicCreatedAt: fresh },
          { id: 14, title: 'New RFP', url: 'https://gov.arbitrum.foundation/t/rfp/4', protocol: 'Arbitrum', confidence: 88, status: 'announced', topicCreatedAt: fresh },
        ],
      },
    };
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      const status = grantsParams(url).get('status');
      return { ok: true, status: 200, json: async () => pages[status] || { items: [] } };
    };

    const { results, urls } = await fetchGrantsFeedResults('crypto', '2026-10-01', { status: 'open,announced' });

    assert.deepEqual(calls.map(url => grantsParams(url).get('status')), ['open', 'announced']);
    for (const url of calls) {
      const params = grantsParams(url);
      assert.equal(params.get('wire'), 'crypto');
      assert.equal(params.get('since'), '2026-10-01');
      assert.equal(params.get('limit'), '100');
      assert.match(params.get('min_confidence'), /^\d+$/);
    }
    assert.deepEqual(results.map(item => item.name), [
      'Season grants',
      'Shared url call',
      'Fresh cycle',
      'New RFP',
    ]);
    assert.equal(urls.size, 4);
    assert.ok(urls.has('https://forum.celo.org/t/round/3'));
    assert.equal([...urls].some(url => url.endsWith('/')), false);
  });

  await t.test('a multi-status pull keeps the other status when one request fails', async () => {
    const fresh = new Date().toISOString();
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      const status = grantsParams(url).get('status');
      if (status === 'open') return { ok: false, status: 500, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [{ id: 20, title: 'New RFP', url: 'https://gov.arbitrum.foundation/t/rfp/4', protocol: 'Arbitrum', confidence: 88, status: 'announced', topicCreatedAt: fresh }],
        }),
      };
    };

    const { results } = await fetchGrantsFeedResults('oss', '2026-10-01', { status: 'open,announced' });
    assert.equal(calls.length, 2);
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'New RFP');

    global.fetch = async (url) => {
      const status = grantsParams(url).get('status');
      if (status === 'open') return { ok: false, status: 502, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ error: 'Internal error' }) };
    };
    const bothFailed = await fetchGrantsFeedResults('oss', '2026-10-01', { status: 'open,announced' });
    assert.equal(bothFailed.results.length, 0);
  });

  await t.test('keeps distinct Snapshot proposal hashes and collapses only the same proposal', async () => {
    const fresh = new Date().toISOString();
    const aave = 'https://snapshot.org/#/aavedao.eth/proposal/0x2d6af8b127e816dd15046979a27e5b5de2e9e0ecd2207c6425ff5db8270970ea';
    const aaveDup = 'https://snapshot.org/#/aavedao.eth/proposal/0x2D6AF8B127E816DD15046979A27E5B5DE2E9E0ECD2207C6425FF5DB8270970EA/';
    const gitcoin = 'https://snapshot.org/#/gitcoindao.eth/proposal/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    stubFetch({
      items: [
        { id: 1, title: 'Aave service provider proposal', url: aave, protocol: 'Aave', confidence: 90, kind: 'proposal', topicCreatedAt: fresh },
        { id: 2, title: 'Aave service provider proposal again', url: aaveDup, protocol: 'Aave', confidence: 90, kind: 'proposal', topicCreatedAt: fresh },
        { id: 3, title: 'Gitcoin matching proposal', url: gitcoin, protocol: 'Gitcoin', confidence: 91, kind: 'proposal', topicCreatedAt: fresh },
      ],
    });
    const { results, urls } = await fetchGrantsFeedResults('crypto', '2026-10-01');
    assert.deepEqual(results.map(item => item.sourceUrl), [aave, gitcoin]);
    assert.equal(urls.size, 2);
    assert.ok([...urls].every(url => url.includes('#/')));
  });

  await t.test('fails soft on HTTP errors and API errors', async () => {
    stubFetch({}, 500);
    const errRes = await fetchGrantsFeedResults('ai', '2026-07-04');
    assert.equal(errRes.results.length, 0);

    stubFetch({ error: 'Internal error' });
    const apiErr = await fetchGrantsFeedResults('ai', '2026-07-04');
    assert.equal(apiErr.results.length, 0);
  });
});
