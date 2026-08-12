require('ts-node/register/transpile-only');

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyReadyCalibration,
  buildClassificationPrompt,
  parseClassificationResponse,
} = require('../src/services/classifier');

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

test('low-precision formats default publish recommendations to source_check', () => {
  const result = {
    classification: 'GRANT', inScope: true, detectedWire: 'ai',
    qualityScore: 80, operatorRoute: 'publish', reason: 'Credible program.',
    scoreReason: 'Strong sponsor.', tags: [], extracted: {},
  };
  const calibrated = applyReadyCalibration({
    name: 'Regional AI Fellowship',
    description: 'A prestigious fellowship from a credible university.',
    source_url: 'https://example.org/fellowship',
    wire: 'ai',
  }, result);
  assert.equal(calibrated.operatorRoute, 'source_check');
  assert.match(calibrated.reason, /Ready calibration/);
});

test('low-precision formats may publish with a concrete applicant path and material benefit', () => {
  const result = {
    classification: 'GRANT', inScope: true, detectedWire: 'ai',
    qualityScore: 86, operatorRoute: 'publish', reason: 'Applications are open.',
    scoreReason: 'Strong sponsor and clear terms.', tags: [],
    extracted: { amount: '$100,000 prize pool', eligibility: 'Apply by September 30' },
  };
  const calibrated = applyReadyCalibration({
    name: 'Global AI Challenge',
    description: 'Applications are open with a public application form and September 30 deadline.',
    source_url: 'https://example.org/apply',
    wire: 'ai',
    amount: '$100,000 prize pool',
  }, result);
  assert.equal(calibrated.operatorRoute, 'publish');
});

test('ordinary direct grants are unchanged by Ready calibration', () => {
  const result = {
    classification: 'GRANT', inScope: true, detectedWire: 'oss',
    qualityScore: 82, operatorRoute: 'publish', reason: 'Open grant.',
    scoreReason: 'Clear application.', tags: [], extracted: {},
  };
  const calibrated = applyReadyCalibration({
    name: 'Maintainer Support Grant',
    description: 'Applications are open for grants to open source maintainers.',
    source_url: 'https://example.org/grants/apply',
    wire: 'oss',
  }, result);
  assert.equal(calibrated.operatorRoute, 'publish');
  assert.equal(calibrated.reason, 'Open grant.');
});

test('automatic startup rescore is opt-in and queue-only', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'src/server.ts'), 'utf8');
  assert.match(server, /if \(config\.startup\.llmRescoreEnabled\)/);
  assert.match(server, /WHERE status = 'queued'/);
  assert.doesNotMatch(server, /status IN \('queued', 'approved'\)/);
});
