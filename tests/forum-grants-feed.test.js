require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { grantsFeedItemToRaw, fetchGrantsFeedResults } = require('../src/services/forum');

// --- grantsFeedItemToRaw mapping ---

test('grantsFeedItemToRaw prefers the extracted program name over the thread title', () => {
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
  assert.equal(raw.name, 'Optimism Grants Council Season 9');
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
  assert.match(raw.description, /Program: Zcash Community Grants/);
});

// --- fetchGrantsFeedResults (stubbed fetch) ---

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

test('fetchGrantsFeedResults maps items, skips uniswap (operator conflict) and stale threads', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  const fresh = new Date().toISOString();
  const stale = new Date(Date.now() - 90 * 86400000).toISOString();
  const calls = stubFetch({
    items: [
      { title: 'CoW Grants: batch 12', url: 'https://forum.cow.fi/t/batch-12/900', protocol: 'CoW Protocol', confidence: 90, kind: 'application', topicCreatedAt: fresh },
      { title: 'Uniswap CFM round', url: 'https://gov.uniswap.org/t/cfm/800', protocol: 'Uniswap Governance', confidence: 95, kind: 'rfp', topicCreatedAt: fresh },
      { title: 'Ancient grants thread', url: 'https://forum.celo.org/t/old/1', protocol: 'Celo', confidence: 80, kind: 'rfp', topicCreatedAt: stale },
      { title: 'No URL item', confidence: 80 },
    ],
    meta: { count: 4, nextCursor: null },
  });

  const { results, urls } = await fetchGrantsFeedResults('crypto', '2026-07-04');

  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'CoW Grants: batch 12');
  assert.ok(urls.has('https://forum.cow.fi/t/batch-12/900'));
  // Request carried wire + since + min_confidence
  assert.match(calls[0], /\/grants\?/);
  assert.match(calls[0], /wire=crypto/);
  assert.match(calls[0], /min_confidence=\d+/);
});

test('fetchGrantsFeedResults fails soft on HTTP errors and API errors', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  stubFetch({}, 500);
  const errRes = await fetchGrantsFeedResults('ai', '2026-07-04');
  assert.equal(errRes.results.length, 0);

  stubFetch({ error: 'Internal error' });
  const apiErr = await fetchGrantsFeedResults('ai', '2026-07-04');
  assert.equal(apiErr.results.length, 0);
});
