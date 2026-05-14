require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractAmount,
  parseAmount,
  parseStructuredOutput,
} = require('../src/services/intake');
const { parseBatchEntries } = require('../src/services/intake-core');
const { checkDuplicate } = require('../src/services/dedup');
const { buildClassificationPrompt } = require('../src/services/classifier');

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
  assert.equal(parsed.results.length, 1);
  assert.equal(parsed.results[0].name, 'Alpha Grants');
  assert.equal(parsed.results[0].sourceUrl, 'https://example.org/grants/alpha');
  assert.equal(parsed.results[0].deadline, 'March 8, 2026');
  assert.equal(parsed.strategy, 'structured_text');
});

test('parseStructuredOutput parses x_search block format', () => {
  const content = [
    '@GrantDAO - Open applications for builders',
    'Apply now for ecosystem grants up to $100K.',
    'https://x.com/grantdao/status/12345',
    '2026-02-16',
  ].join('\n');

  const parsed = parseStructuredOutput(content);
  assert.equal(parsed.results.length, 1);
  assert.match(parsed.results[0].name, /^GrantDAO:/);
  assert.equal(parsed.results[0].sourceUrl, 'https://x.com/grantdao/status/12345');
  assert.equal(parsed.results[0].amount, '$100K');
  assert.equal(parsed.strategy, 'x_post');
});

test('parseStructuredOutput parses JSON payloads', () => {
  const content = JSON.stringify([
    {
      name: 'Beta Fellowship',
      description: 'Research fellowship for AI safety',
      amount: '$50,000',
      deadline: '2026-05-01',
      source_url: 'https://example.com/beta',
      published: '2026-03-01',
    },
  ]);

  const parsed = parseStructuredOutput(content);
  assert.equal(parsed.results.length, 1);
  assert.equal(parsed.results[0].name, 'Beta Fellowship');
  assert.equal(parsed.results[0].sourceUrl, 'https://example.com/beta');
  assert.equal(parsed.results[0].amount, '$50,000');
  assert.equal(parsed.results[0].sourcePublishedAt, '2026-03-01T00:00:00.000Z');
  assert.equal(parsed.strategy, 'json');
});

test('parseBatchEntries handles Grok scans with header, t.co links, and via-post placeholders', () => {
  const content = [
    'Total: 3 results after dedup and filtering.016',
    '[RAIN Fellowship 2026] — For mid-career African researchers partnering with Oxford on AI & emerging tech solutions for Energy, Agriculture, & Health.',
    'Deadline: May 15, 2026',
    'Link: https://webportalapp.com/sp/login/afox-visiting-fellowship-application-202658',
    'Isambard AI Grant — 10k GPU hours on UK supercomputer for Risk-aware Time-series Foundation Models research.',
    'Deadline: None listed (proposal accepted)',
    'Link: (via post mentioning acceptance)53',
    'Apart Research Secure Program Synthesis Fellowship — Related to AI safety/infra (via TAIS 2026).',
    'Deadline: None listed',
    'Link: https://t.co/wPo1P52O9836',
  ].join('\n');

  const parsed = parseBatchEntries(content);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].name, 'RAIN Fellowship 2026');
  assert.equal(parsed[0].deadline, 'May 15, 2026');
  assert.equal(parsed[1].name, 'Isambard AI Grant');
  assert.match(parsed[1].sourceUrl, /^https:\/\/manual\/needs-source\//);
  assert.match(parsed[1].description, /needs source verification/i);
  assert.equal(parsed[2].sourceUrl, 'https://t.co/wPo1P52O9836');
});

test('parseBatchEntries strips Grok citation suffixes from X status URLs', () => {
  const content = [
    '[Humanity AI $18M Grants] — Philanthropic initiative with $10M open call forthcoming.',
    'Deadline: None listed',
    'Link: https://x.com/StartingUpGood/status/205427501505964886818',
  ].join('\n');

  const parsed = parseBatchEntries(content);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].sourceUrl, 'https://x.com/StartingUpGood/status/2054275015059648868');
});

test('parseBatchEntries splits inline Deadline Link batch lines from Grok scans', () => {
  const content = [
    'MATS Autumn 2026 Fellowship — Fully-funded 10-week research fellowship for aspiring AI alignment, security & governance researchers/field-builders in Berkeley + London with stipend and compute support.58 Deadline: June 7, 2026 Link: https://x.com/MATSprogram/status/2054646467068146058',
    'Inuka Tech Fellowship 2026 — Fully sponsored Data Analytics & AI fellowship for Kenyan youth with industry-ready skills and apprenticeship exposure.4 Deadline: May 17, 2026 Link: https://x.com/PLPAfrica/status/2054501611649610134',
    'Google Data Center Community AI Fellowship 2026 — Fully funded AI + Entrepreneurship program with global exposure.3 Deadline: July 12, 2026 (priority) Link: https://x.com/opportunitiesfy/status/2054524557437145368',
    'Total: 3 results after dedup and filtering.',
  ].join('\n');

  const parsed = parseBatchEntries(content);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].name, 'MATS Autumn 2026 Fellowship');
  assert.equal(parsed[0].deadline, 'June 7, 2026');
  assert.equal(parsed[0].sourceUrl, 'https://x.com/MATSprogram/status/2054646467068146058');
  assert.match(parsed[0].description, /^Fully-funded 10-week research fellowship/);
  assert.equal(parsed[1].name, 'Inuka Tech Fellowship 2026');
  assert.equal(parsed[1].deadline, 'May 17, 2026');
  assert.equal(parsed[2].name, 'Google Data Center Community AI Fellowship 2026');
  assert.equal(parsed[2].deadline, 'July 12, 2026 (priority)');
});

test('dedup checks raw entries so rapid double-pastes do not slip through', async () => {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      assert.match(sql, /'raw'/);
      return {
        rows: [{
          first_seen_entry_id: 123,
          name: 'GOAT AI Builder Grants Program',
          url: 'https://x.com/GOATNetwork/status/2054873355162104296',
        }],
      };
    },
  };

  const result = await checkDuplicate(pool, {
    sourceUrl: 'https://x.com/GOATNetwork/status/2054873355162104296',
    name: 'GOAT AI Builder Grants Program',
    wire: 'crypto',
  });

  assert.equal(result.isDuplicate, true);
  assert.equal(result.matchedEntryId, 123);
  assert.equal(calls.length, 1);
});

test('classification prompt tells Grok to downgrade small random hackathons', () => {
  const prompt = buildClassificationPrompt({
    name: 'Youth AI Hackathon',
    description: 'Two-day local student event with no material funding listed',
    source_url: 'https://example.org/youth-ai-hackathon',
    wire: 'ai',
  });

  assert.match(prompt, /small random hackathons/i);
  assert.match(prompt, /sizable/i);
  assert.match(prompt, /prominent organizations/i);
});
