require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractAmount,
  parseAmount,
  parseStructuredOutput,
} = require('../src/services/intake');

test('parseAmount supports major fiat symbols and codes', () => {
  const eur = parseAmount('\u20AC125M');
  assert.ok(eur);
  assert.equal(eur.currency, 'EUR');
  assert.equal(eur.numeric, 135000000);

  const gbp = parseAmount('GBP 4.5M');
  assert.ok(gbp);
  assert.equal(gbp.currency, 'GBP');
  assert.equal(gbp.numeric, 5670000);

  const inr = parseAmount('INR 500K');
  assert.ok(inr);
  assert.equal(inr.currency, 'INR');
  assert.equal(inr.numeric, 6000);

  const ngn = parseAmount('\u20A650,000,000');
  assert.ok(ngn);
  assert.equal(ngn.currency, 'NGN');
});

test('parseAmount takes upper bound of numeric ranges', () => {
  const parsed = parseAmount('$5,000 to $350,000');
  assert.ok(parsed);
  assert.equal(parsed.currency, 'USD');
  assert.equal(parsed.numeric, 350000);
});

test('extractAmount detects non-USD amounts', () => {
  assert.equal(extractAmount('Grant pool of \u20AC125M for 2026 applicants'), '\u20AC125M');
  assert.equal(extractAmount('Funding available: up to GBP 300K per team'), 'GBP 300K');
  assert.equal(extractAmount('Total reward: \u20B95,00,000 for finalists'), '\u20B95,00,000');
});

test('parseStructuredOutput parses canonical numbered format', () => {
  const content = [
    '1. **Alpha Grants** - Funding for OSS tooling',
    'Deadline: March 8, 2026',
    'Link: https://example.org/grants/alpha',
  ].join('\n');

  const parsed = parseStructuredOutput(content);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'Alpha Grants');
  assert.equal(parsed[0].sourceUrl, 'https://example.org/grants/alpha');
  assert.equal(parsed[0].deadline, 'March 8, 2026');
});

test('parseStructuredOutput parses x_search block format', () => {
  const content = [
    '@GrantDAO - Open applications for builders',
    'Apply now for ecosystem grants up to $100K.',
    'https://x.com/grantdao/status/12345',
    '2026-02-16',
  ].join('\n');

  const parsed = parseStructuredOutput(content);
  assert.equal(parsed.length, 1);
  assert.match(parsed[0].name, /^GrantDAO:/);
  assert.equal(parsed[0].sourceUrl, 'https://x.com/grantdao/status/12345');
  assert.equal(parsed[0].amount, '$100K');
});

test('parseStructuredOutput parses JSON payloads', () => {
  const content = JSON.stringify([
    {
      name: 'Beta Fellowship',
      description: 'Research fellowship for AI safety',
      amount: '$50,000',
      deadline: '2026-05-01',
      source_url: 'https://example.com/beta',
    },
  ]);

  const parsed = parseStructuredOutput(content);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'Beta Fellowship');
  assert.equal(parsed[0].sourceUrl, 'https://example.com/beta');
  assert.equal(parsed[0].amount, '$50,000');
});
