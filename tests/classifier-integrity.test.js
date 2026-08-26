require('ts-node/register/transpile-only');

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyKnownProgramCycleGuard,
  buildClassificationPrompt,
  parseClassificationResponse,
} = require('../src/services/classifier');
const { determinePostClassificationStatus } = require('../src/services/intake-core');

function processRawStatus(result, scanSource = 'stringer') {
  return result.inScope
    ? determinePostClassificationStatus(result, scanSource)
    : 'archived';
}

function offScopeNoiseReply() {
  return validReply({
    classification: 'NOISE',
    in_scope: false,
    wire: 'off_domain',
    quality_score: 15,
    operator_route: 'decline',
    score_reason: 'Wiki content grant outside OSS software funding.',
    reason: 'Wikimedia Rapid Funds is open-knowledge, not open-source software.',
  });
}

function validReply(overrides = {}) {
  return JSON.stringify({
    classification: 'GRANT',
    in_scope: true,
    wire: 'oss',
    quality_score: 78,
    operator_route: 'publish',
    score_reason: 'Credible open program with complete details.',
    reason: 'Applications are open.',
    tags: ['NLnet'],
    extracted: {},
    ...overrides,
  });
}

test('classification prompt includes structured temporal and funding context', () => {
  const prompt = buildClassificationPrompt({
    name: 'Open Source Fund',
    description: 'Maintainer funding round.',
    source_url: 'https://example.org/fund',
    wire: 'oss',
    amount: '$250,000',
    deadlineParsed: '2026-08-15T00:00:00.000Z',
    sourcePublishedAt: '2026-07-18T12:00:00.000Z',
    currentDate: '2026-07-21T09:30:00.000Z',
  });

  assert.match(prompt, /Current date: 2026-07-21T09:30:00\.000Z/);
  assert.match(prompt, /Structured amount: \$250,000/);
  assert.match(prompt, /Parsed deadline: 2026-08-15T00:00:00\.000Z/);
  assert.match(prompt, /Source publication date: 2026-07-18T12:00:00\.000Z/);
});

test('classifier parser rejects empty, malformed, and core-invalid output', () => {
  assert.throws(() => parseClassificationResponse(''), /empty response/);
  assert.throws(() => parseClassificationResponse('{broken'), /malformed JSON/);
  assert.throws(() => parseClassificationResponse(validReply({ quality_score: '78' })), /quality_score/);
  assert.throws(() => parseClassificationResponse(validReply({ operator_route: 'maybe' })), /operator_route/);
  assert.throws(() => parseClassificationResponse(validReply({ reason: '' })), /reason/);
});

test('off_domain always normalizes to an off-scope decline', () => {
  const result = parseClassificationResponse(validReply({
    in_scope: true,
    wire: 'off_domain',
  }));

  assert.equal(result.inScope, false);
  assert.equal(result.classification, 'NOISE');
  assert.equal(result.operatorRoute, 'decline');
  assert.equal(result.detectedWire, 'off_domain');
});

test('past parsed deadline forces EXPIRED while deadline-today stays open', () => {
  const past = parseClassificationResponse(validReply(), {
    deadlineParsed: '2026-07-20',
    currentDate: '2026-07-21T23:59:59.000Z',
  });
  assert.equal(past.classification, 'EXPIRED');
  assert.equal(past.operatorRoute, 'decline');
  assert.match(past.reason, /predates current date/);

  const today = parseClassificationResponse(validReply(), {
    deadlineParsed: '2026-07-21T00:00:00.000Z',
    currentDate: '2026-07-21T23:59:59.000Z',
  });
  assert.equal(today.classification, 'GRANT');
  assert.equal(today.operatorRoute, 'publish');
});

test('new-cycle Rapid-style official URL is not NOISE-archived', () => {
  const raw = parseClassificationResponse(offScopeNoiseReply());
  assert.equal(raw.classification, 'NOISE');
  assert.equal(raw.inScope, false);
  assert.equal(processRawStatus(raw), 'archived');

  const guarded = applyKnownProgramCycleGuard(raw, {
    name: 'Wikimedia Rapid Funds Cycle 3 FY2026-27',
    sourceUrl: 'https://meta.wikimedia.org/wiki/Grants:Project/Rapid',
    intakeWire: 'oss',
    priorCycle: { entryId: 15496, name: 'Wikimedia Rapid Grants — Cycle 2 2026' },
  });

  assert.equal(guarded.classification, 'GRANT');
  assert.equal(guarded.inScope, true);
  assert.equal(guarded.detectedWire, 'oss');
  assert.equal(guarded.operatorRoute, 'source_check');
  assert.equal(processRawStatus(guarded, 'stringer'), 'queued');
  assert.match(guarded.reason, /not archived as NOISE/);
});

test('new-cycle stamp in operator_notes also keeps a first-party apply URL in review', () => {
  const raw = parseClassificationResponse(offScopeNoiseReply());
  const guarded = applyKnownProgramCycleGuard(raw, {
    name: 'Wikimedia Rapid Funds Cycle 3 FY2026-27',
    sourceUrl: 'https://meta.wikimedia.org/wiki/Grants:Project/Rapid',
    intakeWire: 'oss',
    operatorNotes: 'New cycle of #15496: "Wikimedia Rapid Grants — Cycle 2 2026"',
  });

  assert.equal(guarded.classification, 'GRANT');
  assert.equal(processRawStatus(guarded), 'queued');
});

test('generic no-cycle reprint can still be NOISE-archived', () => {
  const raw = parseClassificationResponse(offScopeNoiseReply());

  const officialReprint = applyKnownProgramCycleGuard(raw, {
    name: 'Wikimedia Rapid Grants',
    sourceUrl: 'https://meta.wikimedia.org/wiki/Grants:Project/Rapid',
    intakeWire: 'oss',
  });
  assert.equal(officialReprint.classification, 'NOISE');
  assert.equal(officialReprint.inScope, false);
  assert.equal(processRawStatus(officialReprint), 'archived');

  const aggregator = applyKnownProgramCycleGuard(raw, {
    name: 'Wikimedia Rapid Funds Cycle 3 FY2026-27',
    sourceUrl: 'https://opportunitydesk.org/wikimedia-rapid-funds',
    intakeWire: 'oss',
    priorCycle: { entryId: 15496, name: 'Wikimedia Rapid Grants — Cycle 2 2026' },
  });
  assert.equal(aggregator.classification, 'NOISE');
  assert.equal(processRawStatus(aggregator), 'archived');
});

test('known-program cycle guard does not rewrite an in-scope GRANT or NEWS label', () => {
  const grant = parseClassificationResponse(validReply());
  const guardedGrant = applyKnownProgramCycleGuard(grant, {
    name: 'R Consortium ISC Grant Program 2026-2',
    sourceUrl: 'https://r-consortium.org/all-projects/callforproposals.html',
    intakeWire: 'oss',
    priorCycle: { entryId: 2092, name: 'ISC Grant Program' },
  });
  assert.equal(guardedGrant, grant);

  const news = parseClassificationResponse(validReply({
    classification: 'NEWS',
    operator_route: 'relationship_signal',
    quality_score: 55,
  }));
  const guardedNews = applyKnownProgramCycleGuard(news, {
    name: 'Wikimedia Rapid Funds Cycle 3 FY2026-27',
    sourceUrl: 'https://meta.wikimedia.org/wiki/Grants:Project/Rapid',
    intakeWire: 'oss',
    priorCycle: { entryId: 15496, name: 'Wikimedia Rapid Grants Cycle 2 2026' },
  });
  assert.equal(guardedNews.classification, 'NEWS');
  assert.equal(guardedNews.inScope, true);
  assert.equal(processRawStatus(guardedNews), 'queued');
});

test('automatic startup rescore is opt-in and queue-only', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'src/server.ts'), 'utf8');
  assert.match(server, /if \(config\.startup\.llmRescoreEnabled\)/);
  assert.match(server, /WHERE status = 'queued'/);
  assert.doesNotMatch(server, /status IN \('queued', 'approved'\)/);
});
