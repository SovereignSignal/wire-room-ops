require('ts-node/register/transpile-only');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/wireops_test';
process.env.NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL || 'ops@example.com';
process.env.PRIVY_APP_ID = process.env.PRIVY_APP_ID || 'test-app';
process.env.PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET || 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadScrapePage,
  decidePlainFetch,
  firecrawlJobForFeed,
  PLAIN_FETCH_MIN_TEXT,
} = require('../src/services/source-feeds');
const { scrapeUrl, resolveFirecrawlJob } = require('../src/services/scraper');
const { prepareNewsletterPrompt, applySummaryScrapeNote, buildFallbackPrompt, completeNewsletterSummary } = require('../src/services/ollama');
const { processEntry } = require('../src/services/processor');
const { intakeFirecrawlOptions } = require('../src/services/intake-core');
const apiProvider = require('../src/services/api-provider');
const apiUsage = require('../src/services/api-usage');
const asyncUtil = require('../src/utils/async');

const source = {
  key: 'avax-grants',
  name: 'Avalanche — Grants',
  wire: 'crypto',
  method: 'scrape',
  endpoint: 'https://build.avax.network/grants',
  enabled: true,
};

function longPage() {
  const paragraph = 'The Avalanche Foundation is accepting applications for the infraBUIDL grant program. Builders can apply for funding to ship public goods on the network. This page lists the open programs, who can apply, and how to submit. '.repeat(3);
  return `<html><head><title>Avalanche Grants</title></head><body>
    <h1>Avalanche Grants</h1>
    <p>${paragraph} The page is ordinary HTML, not a cloudflare challenge.</p>
    <a href="/grants/infrabuidl">infraBUIDL program</a>
    <a href="https://build.avax.network/grants/codebase">Codebase grants</a>
  </body></html>`;
}

function countingScrape(result) {
  const calls = [];
  const scrape = async (url, opts) => {
    calls.push({ url, opts });
    return result(calls.length);
  };
  return { calls, scrape };
}

test('plain fetch success extracts text and links and does not call Firecrawl', async (t) => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => { logs.push(args.join(' ')); });
  const { calls, scrape } = countingScrape(() => ({ success: true, content: 'should not be used', url: source.endpoint }));
  const loaded = await loadScrapePage(source, {
    fetchPage: async () => ({ status: 200, body: longPage() }),
    scrape,
  });
  assert.equal(calls.length, 0);
  assert.equal(loaded.path, 'fetch');
  assert.equal(loaded.reason, 'ok');
  assert.match(loaded.content, /infraBUIDL program/);
  assert.match(loaded.content, /https:\/\/build\.avax\.network\/grants\/infrabuidl/);
  assert.match(loaded.content, /https:\/\/build\.avax\.network\/grants\/codebase/);
  assert.ok(loaded.content.length >= PLAIN_FETCH_MIN_TEXT);
  assert.ok(logs.some(line => line.includes('avax-grants') && line.includes('path=fetch')));
});

test('empty plain fetch falls back to one Firecrawl call', async (t) => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => { logs.push(args.join(' ')); });
  const { calls, scrape } = countingScrape(() => ({
    success: true,
    content: 'Firecrawl markdown with the open Avalanche grant programs and application links.',
    url: source.endpoint,
  }));
  const loaded = await loadScrapePage(source, {
    fetchPage: async () => ({ status: 200, body: '<html><body><p>Hi</p></body></html>' }),
    scrape,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].opts, { attempts: 1, job: 'source-feed:avax-grants' });
  assert.equal(loaded.path, 'firecrawl');
  assert.equal(loaded.reason, 'empty');
  assert.match(loaded.content, /Firecrawl markdown/);
  assert.ok(logs.some(line => line.includes('path=firecrawl (empty:')));
});

test('blocked and js-only pages fall back once', async () => {
  const cloudflare = `<html><head><title>Just a moment...</title></head><body>${'Checking your browser before accessing this site. Enable JavaScript and cookies to continue. '.repeat(8)}cf-browser-verification</body></html>`;
  const shell = '<html><body><div id="root"></div><script src="/static/app.js"></script></body></html>';
  for (const [body, status, detail] of [
    [cloudflare, 200, 'bot challenge'],
    ['', 403, 'HTTP 403'],
    ['rate limited', 429, 'HTTP 429'],
    [shell, 200, 'js-only shell'],
  ]) {
    const decision = decidePlainFetch({ status, body }, source.endpoint);
    assert.equal(decision.fallback, true, detail);
    assert.equal(decision.reason, 'blocked', detail);
    assert.equal(decision.detail, detail);
    const { calls, scrape } = countingScrape(() => ({ success: true, content: 'recovered page text for the grant listing', url: source.endpoint }));
    const loaded = await loadScrapePage(source, {
      fetchPage: async () => ({ status, body }),
      scrape,
    });
    assert.equal(calls.length, 1, detail);
    assert.equal(loaded.path, 'firecrawl');
    assert.equal(loaded.reason, 'blocked');
  }
});

test('network errors and timeouts fall back once and a failed fallback is not retried', async () => {
  const timeout = new Error('The operation was aborted');
  timeout.name = 'TimeoutError';
  for (const failure of [new Error('fetch failed'), timeout]) {
    const { calls, scrape } = countingScrape(() => ({ success: false, content: '', url: source.endpoint, error: 'Firecrawl API error: 500' }));
    await assert.rejects(
      () => loadScrapePage(source, { fetchPage: async () => { throw failure; }, scrape }),
      /scrape failed: Firecrawl API error: 500/,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.attempts, 1);
    assert.equal(calls[0].opts.job, 'source-feed:avax-grants');
  }
});

test('non-2xx responses that are not bot walls still fall back once', async () => {
  const { calls, scrape } = countingScrape(() => ({ success: true, content: 'fallback body', url: source.endpoint }));
  const loaded = await loadScrapePage(source, {
    fetchPage: async () => ({ status: 500, body: 'unavailable' }),
    scrape,
  });
  assert.equal(calls.length, 1);
  assert.equal(loaded.reason, 'http');
});

test('an unsafe scrape URL never calls Firecrawl', async () => {
  const { calls, scrape } = countingScrape(() => ({ success: true, content: 'nope', url: 'http://127.0.0.1/secret' }));
  await assert.rejects(
    () => loadScrapePage({ ...source, endpoint: 'http://127.0.0.1/secret' }, { scrape }),
    /not a safe public HTTP\(S\) target/,
  );
  assert.equal(calls.length, 0);
});

test('registry-watch scrape feeds are labeled registry-watch', () => {
  assert.equal(firecrawlJobForFeed({ key: 'ws-diff-12', usagePurpose: 'watchtower-registry-extract' }), 'registry-watch');
  assert.equal(firecrawlJobForFeed({ key: 'longview' }), 'source-feed:longview');
  assert.equal(resolveFirecrawlJob('summary'), 'summary');
  assert.equal(resolveFirecrawlJob('not-a-job'), 'fallback');
  assert.equal(resolveFirecrawlJob('source-feed:avax-grants'), 'source-feed:avax-grants');
});

function firecrawlFetch(status, body) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

async function withFirecrawl(t, run) {
  const logs = [];
  t.mock.method(apiProvider, 'getCachedProvider', () => ({ api_key: 'fc-test', base_url: 'https://api.firecrawl.dev/v1' }));
  t.mock.method(apiUsage, 'logApiUsage', (params) => { logs.push(params); });
  t.mock.method(asyncUtil, 'sleep', async () => {});
  const original = global.fetch;
  try {
    await run({ logs, restoreFetch: () => { global.fetch = original; } });
  } finally {
    global.fetch = original;
  }
}

test('summary and telegram-link scrapes make one Firecrawl call even when attempts ask for more', async (t) => {
  await withFirecrawl(t, async ({ logs }) => {
    for (const job of ['summary', 'telegram-link']) {
      const { calls, fetchImpl } = firecrawlFetch(500, 'nope');
      global.fetch = fetchImpl;
      const result = await scrapeUrl('https://example.com/grants', { attempts: 9, job });
      assert.equal(result.success, false);
      assert.equal(calls.length, 1, job);
      assert.equal(logs.filter(row => row.job === job).length, 1, job);
      assert.equal(logs.at(-1).provider, 'firecrawl');
      assert.equal(logs.at(-1).purpose, 'scrape');
    }
  });
});

test('other Firecrawl callers still retry and are labeled fallback', async (t) => {
  await withFirecrawl(t, async ({ logs }) => {
    const { calls, fetchImpl } = firecrawlFetch(500, 'nope');
    global.fetch = fetchImpl;
    const result = await scrapeUrl('https://example.com/other');
    assert.equal(result.success, false);
    assert.equal(calls.length, 3);
    assert.equal(logs.length, 3);
    assert.ok(logs.every(row => row.job === 'fallback'));
  });
});

test('a summary scrape is one attempt and a failure marks the summary missing', async () => {
  const calls = [];
  const prepared = await prepareNewsletterPrompt({
    id: '1',
    url: 'https://example.com/program',
    quick_summary: 'Cached blurb',
    category: 'Grant',
    timestamp: new Date('2026-10-03T00:00:00Z'),
    source: 'feed',
    wire: 'crypto',
  }, async (url, opts) => {
    calls.push({ url, opts });
    return { success: false, content: '', url, error: 'blocked' };
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].opts, { attempts: 1, job: 'summary' });
  assert.equal(prepared.scraped, false);
  assert.doesNotMatch(prepared.prompt, /PAGE CONTENT|scraped_content/i);
  assert.match(prepared.prompt, /return SKIP/i);
  assert.doesNotMatch(prepared.prompt, /unable to access/i);
  assert.equal(applySummaryScrapeNote('Draft summary.', false), 'SKIP');
  assert.equal(applySummaryScrapeNote('Draft summary.', true), 'Draft summary.');
  assert.equal(applySummaryScrapeNote('SKIP', true), 'SKIP');
  const skipped = await completeNewsletterSummary({
    id: '1', url: 'https://example.com/program', quick_summary: 'Cached blurb',
    category: 'Grant', timestamp: new Date(), source: 'feed', wire: 'crypto',
  }, prepared);
  assert.equal(skipped, 'SKIP');
  assert.match(buildFallbackPrompt(), /return SKIP/i);
});

test('a throwing summary scrape still degrades without a second attempt', async () => {
  let calls = 0;
  const prepared = await prepareNewsletterPrompt({
    id: '2',
    url: 'https://example.com/program',
    quick_summary: 'Cached blurb',
    category: 'Grant',
    timestamp: new Date('2026-10-03T00:00:00Z'),
    source: 'feed',
  }, async () => {
    calls += 1;
    throw new Error('network down');
  });
  assert.equal(calls, 1);
  assert.equal(prepared.scraped, false);
});

test('processEntry scrapes once and retries only the model call', async (t) => {
  t.mock.method(asyncUtil, 'sleep', async () => {});
  let prepares = 0;
  let completes = 0;
  const entry = {
    id: '9',
    url: 'https://example.com/program',
    quick_summary: 'Cached blurb',
    category: 'Grant',
    timestamp: new Date('2026-10-03T00:00:00Z'),
    source: 'feed',
    wire: 'ai',
  };
  const result = await processEntry(entry, {}, {
    prepareNonX: async () => {
      prepares += 1;
      return { prompt: 'cached prompt', scraped: false };
    },
    completeNonX: async () => {
      completes += 1;
      if (completes < 3) throw new Error('model down');
      return 'Usable summary from cached text.';
    },
  });
  assert.equal(prepares, 1);
  assert.equal(completes, 3);
  assert.equal(result.enrichedSummary, 'Usable summary from cached text.');
  assert.equal(result.processingError, undefined);
});

test('telegram intake asks for one telegram-link scrape; other intake does not', () => {
  assert.deepEqual(intakeFirecrawlOptions('telegram'), { job: 'telegram-link', attempts: 1 });
  assert.deepEqual(intakeFirecrawlOptions('telegram-intake'), { job: 'telegram-link', attempts: 1 });
  assert.deepEqual(intakeFirecrawlOptions('x-monitor'), { job: 'fallback' });
  assert.deepEqual(intakeFirecrawlOptions('manual-intake'), { job: 'fallback' });
});
