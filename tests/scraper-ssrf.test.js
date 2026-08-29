const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const scraper = fs.readFileSync(path.join(__dirname, '../src/services/scraper.ts'), 'utf8');

test('shortener resolution uses safePublicFetch, not raw follow-redirects fetch', () => {
  assert.match(scraper, /import \{ isSafeHttpUrl, safePublicFetch \} from '\.\.\/utils\/ssrf'/);
  assert.match(scraper, /safePublicFetch\(url, \{\s*method: 'HEAD'/);
  assert.match(scraper, /if \(!isSafeHttpUrl\(url\)\)/);
  assert.doesNotMatch(scraper, /redirect: 'follow'/);
});

test('Firecrawl scrape refuses non-public HTTP targets before the provider call', () => {
  assert.match(scraper, /export async function scrapeUrl/);
  assert.match(scraper, /async function scrapeWithFirecrawl/);
  const scrapeUrl = scraper.slice(scraper.indexOf('export async function scrapeUrl'));
  assert.match(scrapeUrl, /if \(!isSafeHttpUrl\(url\)\)/);
  assert.match(scrapeUrl, /URL is not a safe public HTTP\(S\) target/);
});
