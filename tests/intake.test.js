require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractAmount,
  parseAmount,
  parseStructuredOutput,
} = require('../src/services/intake');
const {
  determinePostClassificationStatus,
  isBatchMessage,
  normalizeDeadlineForDb,
  parseBatchEntries,
  processBatchMessage,
  processIntakeMessage,
  semanticBatchKey,
} = require('../src/services/intake-core');
const { checkDuplicate, findRelatedOpportunity } = require('../src/services/dedup');
const { buildClassificationPrompt } = require('../src/services/classifier');
const { applySourceFreshnessGate } = require('../src/jobs/daily-intake');

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

test('Grok count header does not hide an indented numbered batch from Telegram routing', () => {
  const content = [
    'Total: 2 results after dedup and filtering.',
    '',
    '1. [DARPA Artificial Intelligence Reinforcements (AIR) Program] — AI-capable F-16 research program.',
    '   Deadline: None listed',
    '   Link: https://x.com/DARPA/status/2077785604650086860',
    '',
    '2. [PIBBSS Fellowship] — Fully funded AI safety fellowship.',
    '   Deadline: July 20, 2026',
    '   Link: https://x.com/schoolafrica/status/2078099277016924509',
  ].join('\n');

  assert.equal(isBatchMessage(content), true);
  const parsed = parseBatchEntries(content);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map(entry => entry.name), [
    'DARPA Artificial Intelligence Reinforcements (AIR) Program',
    'PIBBSS Fellowship',
  ]);
  assert.equal(parsed[0].sourceUrl, 'https://x.com/DARPA/status/2077785604650086860');
  assert.equal(parsed[1].deadline, 'July 20, 2026');
});

test('positive Grok count headers route every supported one-result batch form', () => {
  const cases = [
    {
      label: 'plain numbered item with direct URL',
      text: [
        'Total relevant results after deduplication and filtering: 1',
        '1. Solo Infrastructure Grant — Funding for open-source maintainers. https://example.org/solo-infrastructure',
      ].join('\n'),
      expectedUrl: 'https://example.org/solo-infrastructure',
    },
    {
      label: 'numbered item with Link and no Deadline',
      text: [
        'Total relevant results after deduplication and filtering: 1',
        '1. Solo Research Fellowship — Support for independent AI safety research.',
        'Link: https://example.org/solo-fellowship',
      ].join('\n'),
      expectedUrl: 'https://example.org/solo-fellowship',
    },
    {
      label: 'inline Deadline and Link row',
      text: [
        'Total relevant results after deduplication and filtering: 1',
        'Solo Public Goods Fund — Grants for protocol tooling. Deadline: August 1, 2026 Link: https://example.org/solo-public-goods',
      ].join('\n'),
      expectedUrl: 'https://example.org/solo-public-goods',
    },
    {
      label: 'legacy count header',
      text: [
        'Total: 1 result after dedup and filtering.',
        '1. Solo Legacy Grant — Funding for one qualified project. https://example.org/solo-legacy',
      ].join('\n'),
      expectedUrl: 'https://example.org/solo-legacy',
    },
  ];

  for (const { label, text, expectedUrl } of cases) {
    assert.equal(isBatchMessage(text), true, label);
    const parsed = parseBatchEntries(text);
    assert.equal(parsed.length, 1, label);
    assert.equal(parsed[0].sourceUrl, expectedUrl, label);
  }
});

test('empty, zero-result, and contradictory count summaries do not route as batches', () => {
  assert.equal(isBatchMessage('Total relevant results after deduplication and filtering: 1'), false);
  assert.equal(isBatchMessage([
    'Total relevant results after deduplication and filtering: 0',
    'No qualifying results found in this scan.',
  ].join('\n')), false);

  const contradictory = [
    'Total relevant results after deduplication and filtering: 1',
    'No qualifying results found after deduplication and filtering.',
  ].join('\n');
  assert.equal(isBatchMessage(contradictory), false);
  assert.equal(parseBatchEntries(contradictory).length, 0);
});

test('indented plain-text fields route and parse every unnumbered batch item', () => {
  const content = [
    'Alpha Grant — First opportunity.',
    '   Deadline: August 1, 2026',
    '   Link: https://example.com/alpha',
    'Beta Fellowship — Second opportunity.',
    '   Deadline: August 2, 2026',
    '   Link: https://example.com/beta',
  ].join('\n');

  assert.equal(isBatchMessage(content), true);
  const parsed = parseBatchEntries(content);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map(entry => entry.name), ['Alpha Grant', 'Beta Fellowship']);
  assert.deepEqual(parsed.map(entry => entry.sourceUrl), [
    'https://example.com/alpha',
    'https://example.com/beta',
  ]);
});

test('single intake rejects Grok control lines and bot receipts before persistence', async () => {
  const messages = [
    'Total: 12 results after dedup and filtering.',
    'Total relevant results after deduplication and filtering: 12',
    'No qualifying results found in this scan.',
    'No qualifying results found after deduplication and filtering.',
    'ai — Captured ai entry #11826: Total: 12 results after dedup and filtering.',
    '— Captured existing entry #11826: Total: 12 results after dedup and filtering.',
    'Intake saved, checks outstanding: ⏳ 12 pending',
  ];

  for (const text of messages) {
    const result = await processIntakeMessage({ text, senderId: 'test' });
    assert.equal(result.status, 'rejected', text);
    assert.match(result.errorMessage, /control\/status text/i, text);
  }
});

test('parseBatchEntries ignores prose before the first plain-text batch item', () => {
  const content = [
    'No major new results missed in initial scan, but here is the compiled list of qualifying announcements:',
    '',
    'GOAT Network $1M Agent Builder Grants — Grants for agent builders on Bitcoin-secured infrastructure to drive transactions, security, and yield.',
    'Deadline: None listed',
    'Link: https://x.com/GOATNetwork/status/2076968094736511177',
    'Ripple Effect Certified Veteran Employer Grants — $250,000 program awarding $10k grants to veteran-owned businesses.',
    'Deadline: None listed',
    'Link: https://x.com/MSBIntel/status/2077013500858450111',
  ].join('\n');

  const parsed = parseBatchEntries(content);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, 'GOAT Network $1M Agent Builder Grants');
  assert.match(parsed[0].description, /^Grants for agent builders/);
  assert.equal(parsed[0].sourceUrl, 'https://x.com/GOATNetwork/status/2076968094736511177');
  assert.equal(parsed[1].name, 'Ripple Effect Certified Veteran Employer Grants');
});

test('parseBatchEntries preserves a plain first-line name when later prose contains a dash', () => {
  const content = [
    'The Following Fund:',
    'Funding for maintainers — including security work and release engineering.',
    'Deadline: Rolling',
    'Link: https://example.org/maintenance-fund',
    'Scan Results Grants:',
    'Funding for data tooling — including open-source indexers.',
    'Deadline: Rolling',
    'Link: https://example.org/scan-results-grants',
  ].join('\n');

  const parsed = parseBatchEntries(content);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, 'The Following Fund:');
  assert.equal(parsed[1].name, 'Scan Results Grants:');
});

test('parseBatchEntries ignores Grok totals lines between concatenated scan blocks', () => {
  const content = [
    'Ripple XRPL Grants Program — Rolling grants for XRPL builders.',
    'Deadline: Rolling',
    'Link: https://x.com/xrp_herald/status/2075497085332279724',
    'Total: 8 results after dedup and filtering.',
    'Stacks Endowment Community Grants Round — Community grants for Stacks projects.',
    'Deadline: July 26, 2026',
    'Link: https://zeroauthoritydao.com/funding/degrants',
  ].join('\n');

  const parsed = parseBatchEntries(content);
  assert.deepEqual(parsed.map(entry => entry.name), [
    'Ripple XRPL Grants Program',
    'Stacks Endowment Community Grants Round',
  ]);
  assert.equal(parsed[1].sourceUrl, 'https://zeroauthoritydao.com/funding/degrants');
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

test('parseBatchEntries strips Grok citation suffixes from direct URLs', () => {
  const content = [
    'Circle Developer Grants Program on Arc — Funding for teams building on Arc. Deadline: None listed Link: https://www.circle.com/grant27',
    'Tether Developer Grants Program — Developer grants on open stack. Deadline: Rolling Link: https://tether.io/news/tether-launches-developer-grants-program-to-fund-local-first-ai-and-payments-infrastructure/37',
  ].join('\n');

  const parsed = parseBatchEntries(content);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].sourceUrl, 'https://www.circle.com/grant');
  assert.equal(parsed[1].sourceUrl, 'https://tether.io/news/tether-launches-developer-grants-program-to-fund-local-first-ai-and-payments-infrastructure');
});

test('parseBatchEntries preserves inline Grok rows with placeholder links', () => {
  const content = [
    'Arbitrum Open House Buildathon & Founder House — Open call for early-stage builders with $415,000 in prizes and grants via 3-week online Buildathon (starts May 25) plus IRL event in London (July 10-12), including direct access to Arbitrum Foundation, workshops, and support for top teams.123 Deadline: May 25 (Buildathon) Link: https://openhouse.arbitrum.io/',
    'Ethereum Foundation Ecosystem Support Program (ESP) — Grants for ecosystem development projects, including Q1 2026 funding for initiatives like Ethereum Korea coordination and integration efforts.10 Deadline: None listed (ongoing) Link: https://esp.ethereum.foundation/funded-projects',
    'Celo Prezenti Frontier Pool — Up to $25,000 per project for teams building protocols, tooling, and infrastructure services for the Celo agent economy (must deploy on Celo mainnet).13 Deadline: June 30, 2026 Link: Post by @prezenti_grants',
    'Gitcoin / Impact Certificates (Hypercerts) — Shift to retroactive funding model using onchain tokens for already-completed work, rewarding verified impact instead of speculative grants, with yield-powered rounds via partners like Octant.721 Deadline: Rolling / None listed Link: Posts by @owockibot and @gitcoin',
    'Protocol Guild / Retro Funding Discussion — Ongoing dialogue on challenges and improvements for retroactive public goods funding (e.g., QF/RPGF) to better support core Ethereum infrastructure and devs.33 Deadline: None listed Link: Post by @trent_vanepps',
    'Total: 5 results after dedup and filtering.',
  ].join('\n');

  const parsed = parseBatchEntries(content);
  assert.equal(parsed.length, 5);
  assert.equal(parsed[0].name, 'Arbitrum Open House Buildathon & Founder House');
  assert.equal(parsed[1].sourceUrl, 'https://esp.ethereum.foundation/funded-projects');
  assert.equal(parsed[2].name, 'Celo Prezenti Frontier Pool');
  assert.match(parsed[2].sourceUrl, /^https:\/\/manual\/needs-source\//);
  assert.match(parsed[2].description, /needs source verification/i);
  assert.equal(parsed[3].name, 'Gitcoin / Impact Certificates (Hypercerts)');
  assert.equal(parsed[4].name, 'Protocol Guild / Retro Funding Discussion');
});

test('unnumbered name-URL pastes route as batches so one duplicate cannot drop the rest', () => {
  const content = [
    'Prezenti AI Sponsorship (Celo) - https://x.com/prezenti_grants/status/2090153678397436206',
    'GOAT Network AI Builder Grants - https://x.com/GOATNetwork/status/2087971190572794275',
    'Stacks Thesis Bounty - https://x.com/zeroauthdao/status/2088309922328903811',
  ].join('\n');

  assert.equal(isBatchMessage(content), true);
  const parsed = parseBatchEntries(content);
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed.map(entry => entry.name), [
    'Prezenti AI Sponsorship (Celo)',
    'GOAT Network AI Builder Grants',
    'Stacks Thesis Bounty',
  ]);
  assert.equal(parsed[0].sourceUrl, 'https://x.com/prezenti_grants/status/2090153678397436206');
  assert.equal(parsed[2].sourceUrl, 'https://x.com/zeroauthdao/status/2088309922328903811');
});

test('compact URL lists accept name/URL pairs, bullets, and a preview duplicate in the mix', () => {
  const pairs = [
    'Base Batches 004',
    'https://x.com/base/status/111',
    'GWDC 2026 Korea Hackathon',
    'https://x.com/gwdc/status/222',
    'QIE Hackathon 3.0',
    'https://x.com/qie/status/333',
  ].join('\n');
  assert.equal(isBatchMessage(pairs), true);
  const pairParsed = parseBatchEntries(pairs);
  assert.deepEqual(pairParsed.map(entry => entry.name), [
    'Base Batches 004',
    'GWDC 2026 Korea Hackathon',
    'QIE Hackathon 3.0',
  ]);
  assert.equal(pairParsed[1].sourceUrl, 'https://x.com/gwdc/status/222');

  const bullets = [
    '• CODE ODYSSEY 2026 - https://x.com/odyssey/status/444',
    '* Monad AI & Blockchain Hackathon (Hyderabad) - https://x.com/monad/status/555',
  ].join('\n');
  assert.equal(isBatchMessage(bullets), true);
  const bulletParsed = parseBatchEntries(bullets);
  assert.equal(bulletParsed[0].name, 'CODE ODYSSEY 2026');
  assert.equal(bulletParsed[1].name, 'Monad AI & Blockchain Hackathon (Hyderabad)');

  const withKnownDupe = [
    'Arbitrum Open House Singapore - https://x.com/arbitrum/status/666',
    'Fresh Builder Grant - https://x.com/fresh/status/777',
  ].join('\n');
  assert.equal(isBatchMessage(withKnownDupe), true);
  assert.equal(parseBatchEntries(withKnownDupe).length, 2);
});

test('a single name-URL paste stays on the single-entry path', () => {
  const single = 'Base Batches 004 - https://x.com/base/status/111';
  assert.equal(isBatchMessage(single), false);
  assert.equal(parseBatchEntries(single).length, 1);
  assert.equal(parseBatchEntries(single)[0].sourceUrl, 'https://x.com/base/status/111');
});

test('Grok Source/Link blocks keep program names and store the Source tweet URL', () => {
  const content = [
    'GitHub Secure Open Source Fund — Application window for OSS maintainers.',
    'Deadline: Rolling',
    'Source: [@HiJulieJennifer](https://x.com/HiJulieJennifer/status/111)',
    'Link: https://x.com/HiJulieJennifer/status/111',
    'OrcaRouter Open Source Program — 5% of user spend revenue share for contributors.',
    'Deadline: Rolling',
    'Source: [@anurag_629](https://x.com/anurag_629/status/2088954196934680924)',
    'Link: https://x.com/anurag_629/status/2088954196934680924',
    'OrcaRouter Contributor Pool — Matching announcement from the project account.',
    'Deadline: Rolling',
    'Source: [@OrcaRouter](https://x.com/OrcaRouter/status/2088962617201271026)',
    'Link: https://x.com/OrcaRouter/status/2088962617201271026',
    'Total: 3 results after dedup and filtering.',
    'https://t.co/9B3tkIF96g',
  ].join('\n');

  assert.equal(isBatchMessage(content), true);
  const parsed = parseBatchEntries(content);
  assert.deepEqual(parsed.map(entry => entry.name), [
    'GitHub Secure Open Source Fund',
    'OrcaRouter Open Source Program',
    'OrcaRouter Contributor Pool',
  ]);
  assert.deepEqual(parsed.map(entry => entry.sourceUrl), [
    'https://x.com/HiJulieJennifer/status/111',
    'https://x.com/anurag_629/status/2088954196934680924',
    'https://x.com/OrcaRouter/status/2088962617201271026',
  ]);
  assert.equal(parsed.some(entry => /t\.co\//.test(entry.sourceUrl)), false);
  assert.equal(parsed.some(entry => entry.name.startsWith('@')), false);
  assert.match(parsed[1].description, /^5% of user spend revenue share/);
  assert.doesNotMatch(parsed[1].description, /Source:/);
});

test('Source tweet wins over a later Link URL in the same Grok block', () => {
  const content = [
    'Secure Open Source Fund — Apply via the GitHub form.',
    'Deadline: Rolling',
    'Source: [@HiJulieJennifer](https://x.com/HiJulieJennifer/status/2089000000000000000)',
    'Link: https://github.com/github/secure-open-source-fund',
    'OrcaRouter Open Source Program — Revenue share for contributors.',
    'Deadline: Rolling',
    'Source: [@OrcaRouter](https://x.com/OrcaRouter/status/2088962617201271026)',
    'Link: https://orcarouter.example/grants',
  ].join('\n');

  const parsed = parseBatchEntries(content);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].name, 'Secure Open Source Fund');
  assert.equal(parsed[0].sourceUrl, 'https://x.com/HiJulieJennifer/status/2089000000000000000');
  assert.equal(parsed[1].sourceUrl, 'https://x.com/OrcaRouter/status/2088962617201271026');
});

test('newsletter markdown title links still parse when they are not Source attribution', () => {
  const content = [
    '[Alpha Grants](https://example.org/alpha) — Funding for OSS tooling',
    '[Beta Fellowship](https://example.org/beta) — Research support',
  ].join('\n');

  assert.equal(isBatchMessage(content), true);
  const parsed = parseBatchEntries(content);
  assert.deepEqual(parsed.map(entry => entry.name), ['Alpha Grants', 'Beta Fellowship']);
  assert.deepEqual(parsed.map(entry => entry.sourceUrl), [
    'https://example.org/alpha',
    'https://example.org/beta',
  ]);
});

test('compact batch keeps later URLs when the first link is already seen', async t => {
  const db = require('../src/db');
  const originalGetAllFeeds = db.getAllFeeds;
  const originalGetPool = db.getPool;
  t.after(() => {
    db.getAllFeeds = originalGetAllFeeds;
    db.getPool = originalGetPool;
  });

  db.getAllFeeds = async () => [{ key: 'crypto' }, { key: 'ai' }, { key: 'oss' }];
  let nextId = 500;
  const client = {
    query: async (sql) => {
      if (/INSERT INTO scan_entries/i.test(sql)) {
        nextId += 1;
        return { rows: [{ id: nextId }], rowCount: 1 };
      }
      if (/INSERT INTO seen_urls/i.test(sql)) {
        return { rows: [{ id: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  db.getPool = () => ({
    connect: async () => client,
    query: async (sql, params) => {
      if (/channel_update_id/i.test(sql)) return { rows: [] };
      if (/FROM seen_urls/i.test(sql)) {
        const normalized = String(params?.[0] || '');
        if (normalized.includes('2090153678397436206')) {
          return {
            rows: [{
              first_seen_entry_id: 11,
              name: 'Prezenti AI Sponsorship (Celo)',
              url: params[0],
            }],
          };
        }
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  const result = await processBatchMessage({
    text: [
      'Prezenti AI Sponsorship (Celo) - https://x.com/prezenti_grants/status/2090153678397436206',
      'GOAT Network AI Builder Grants - https://x.com/GOATNetwork/status/2087971190572794275',
      'Stacks Thesis Bounty - https://x.com/zeroauthdao/status/2088309922328903811',
    ].join('\n'),
    senderId: 'telegram:1',
  });

  assert.equal(result.duplicates, 1);
  assert.equal(result.inserted, 2);
  assert.equal(result.entries[0].isDuplicate, true);
  assert.match(result.entries[0].error, /Already seen as "Prezenti AI Sponsorship \(Celo\)"/);
  assert.ok(result.entries[1].id);
  assert.ok(result.entries[2].id);
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

test('classification prompt asks for operator route separate from content type', () => {
  const prompt = buildClassificationPrompt({
    name: 'Youth AI Hackathon',
    description: 'Two-day local student event with no material funding listed',
    source_url: 'https://example.org/youth-ai-hackathon',
    wire: 'ai',
  });

  assert.match(prompt, /small random hackathons/i);
  assert.match(prompt, /sizable/i);
  assert.match(prompt, /prominent organizations/i);
  assert.match(prompt, /operator_route/i);
  assert.match(prompt, /publish \| source_check \| park \| decline \| relationship_signal/i);
});

test('post-classification queues every operator_route for Telegram intake (wide net, label by route)', () => {
  // New contract: nothing is auto-archived at intake. Every classified item
  // reaches the queue tagged with its route; the operator filters by route in
  // the dashboard rather than the system hiding park/relationship_signal items.
  assert.equal(determinePostClassificationStatus({ classification: 'GRANT', qualityScore: 88, operatorRoute: 'publish' }, 'telegram'), 'queued');
  assert.equal(determinePostClassificationStatus({ classification: 'GRANT', qualityScore: 70, operatorRoute: 'source_check' }, 'telegram'), 'queued');
  assert.equal(determinePostClassificationStatus({ classification: 'GRANT', qualityScore: 52, operatorRoute: 'park' }, 'telegram'), 'queued');
  assert.equal(determinePostClassificationStatus({ classification: 'NEWS', qualityScore: 55, operatorRoute: 'park' }, 'telegram'), 'queued');
  assert.equal(determinePostClassificationStatus({ classification: 'NEWS', qualityScore: 62, operatorRoute: 'relationship_signal' }, 'telegram'), 'queued');
  assert.equal(determinePostClassificationStatus({ classification: 'NOISE', qualityScore: 18, operatorRoute: 'decline' }, 'telegram'), 'queued');
  // Missing route (classifier omitted it) must still be visible, not silently archived.
  assert.equal(determinePostClassificationStatus({ classification: 'UNCHECKED', qualityScore: 0 }, 'telegram'), 'queued');
});

test('post-classification queues every operator_route for manual paste intake too', () => {
  assert.equal(determinePostClassificationStatus({ classification: 'GRANT', qualityScore: 88, operatorRoute: 'publish' }, 'manual-intake'), 'queued');
  assert.equal(determinePostClassificationStatus({ classification: 'GRANT', qualityScore: 70, operatorRoute: 'source_check' }, 'manual-intake'), 'queued');
  assert.equal(determinePostClassificationStatus({ classification: 'NEWS', qualityScore: 68, operatorRoute: 'relationship_signal' }, 'manual-intake'), 'queued');
  assert.equal(determinePostClassificationStatus({ classification: 'GRANT', qualityScore: 52, operatorRoute: 'park' }, 'manual-intake'), 'queued');
  assert.equal(determinePostClassificationStatus({ classification: 'NOISE', qualityScore: 18, operatorRoute: 'decline' }, 'manual-intake'), 'queued');
});

test('source freshness gate parks old non-urgent Grants.gov listings', () => {
  const decision = applySourceFreshnessGate({
    sourceUrl: 'https://www.grants.gov/search-results-detail/359853',
    sourcePublishedAt: '2026-05-21T00:00:00.000Z',
    deadlineParsed: '2026-10-19T00:00:00.000Z',
    classification: 'GRANT',
  }, new Date('2026-07-04T00:00:00.000Z'));

  assert.equal(decision.status, 'archived');
  assert.equal(decision.metadata.archived_reason, 'stale_grants_gov_current_listing');
  assert.equal(decision.metadata.operator_route, 'park');
  assert.equal(decision.metadata.freshness_label, 'current_open_listing_old_source');
});

test('source freshness gate keeps recent or urgent Grants.gov listings visible', () => {
  const recent = applySourceFreshnessGate({
    sourceUrl: 'https://simpler.grants.gov/opportunity/d07ebcd7-96cf-40cb-8ae3-f401b6274080',
    sourcePublishedAt: '2026-06-30T00:00:00.000Z',
    deadlineParsed: '2026-10-19T00:00:00.000Z',
    classification: 'GRANT',
  }, new Date('2026-07-04T00:00:00.000Z'));

  const urgent = applySourceFreshnessGate({
    sourceUrl: 'https://www.grants.gov/search-results-detail/123456',
    sourcePublishedAt: '2026-05-21T00:00:00.000Z',
    deadlineParsed: '2026-07-20T00:00:00.000Z',
    classification: 'GRANT',
  }, new Date('2026-07-04T00:00:00.000Z'));

  assert.equal(recent.status, 'queued');
  assert.deepEqual(recent.metadata, {});
  assert.equal(urgent.status, 'queued');
  assert.equal(urgent.metadata.freshness_label, 'current_open_listing');
});

test('normalizeDeadlineForDb extracts parseable dates and ignores rolling placeholders', () => {
  assert.equal(normalizeDeadlineForDb('Deadline: June 24, 2026'), '2026-06-24');
  assert.equal(normalizeDeadlineForDb('Deadline: May 25 (Buildathon)', '2026-05-15'), '2026-05-25');
  assert.equal(normalizeDeadlineForDb('Rolling / None listed'), null);
  assert.equal(normalizeDeadlineForDb('Not listed (ongoing)'), null);
});

test('semanticBatchKey collapses same program variants before insert', () => {
  assert.equal(semanticBatchKey('OCRA AI Accelerator Grant Program 2026'), semanticBatchKey('OCRA AI Accelerator Grant Program'));
  assert.equal(semanticBatchKey('CDR Hackathon (Story Protocol)'), semanticBatchKey('CDR Hackathon on Story Protocol'));
  assert.equal(semanticBatchKey('Global Majority AI Fellowship 2026'), semanticBatchKey('Global Majority AI Fellowship (Heinrich Böll Foundation)'));
});

test('related opportunity detection flags alternate-source matches without making them duplicates', async () => {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      assert.match(sql, /seen_names/);
      return {
        rows: [{
          entry_id: 456,
          name_original: 'Sovereign Tech Fund Open Source Infrastructure Grants',
          name_tokens: ['sovereign', 'tech', 'fund', 'open', 'source', 'infrastructure', 'grants'],
          source_url: 'https://www.sovereign.tech/programs/open-source-infrastructure',
          status: 'approved',
        }],
      };
    },
  };

  const relation = await findRelatedOpportunity(pool, {
    sourceUrl: 'https://x.com/sovtechfund/status/2055000000000000000',
    name: 'Sovereign Tech Fund Open Source Infrastructure Grants applications open',
    wire: 'oss',
  });

  assert.equal(relation.isRelated, true);
  assert.equal(relation.matchedEntryId, 456);
  assert.equal(relation.relationType, 'alternate_source');
  assert.ok(relation.confidence >= 0.85);
  assert.equal(calls.length, 1);
});

test('related opportunity detection ignores weak same-org matches so organic results stay visible as clean', async () => {
  const pool = {
    query: async () => ({
      rows: [{
        entry_id: 789,
        name_original: 'Optimism Foundation Governance Update',
        name_tokens: ['optimism', 'foundation', 'governance', 'update'],
        source_url: 'https://optimism.io/news/governance-update',
        status: 'approved',
      }],
    }),
  };

  const relation = await findRelatedOpportunity(pool, {
    sourceUrl: 'https://example.org/optimism-developer-grants',
    name: 'Optimism Developer Grants Program',
    wire: 'crypto',
  });

  assert.equal(relation.isRelated, false);
  assert.equal(relation.matchedEntryId, null);
});
