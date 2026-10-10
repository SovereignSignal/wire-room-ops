require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifySourceLink } = require('../src/services/source-filter');
const { processIntakeMessage } = require('../src/services/intake-core');
const { validateForApproval } = require('../src/services/approval-guard');
const { isCompletionSufficient } = require('../src/jobs/process-raw');
const { isUsefulUrl } = require('../src/services/intake');

const complete = source_url => ({
  name: 'Open Source Fellowship 2026',
  description: 'Applications are open for maintainers building public infrastructure.',
  source_url,
});

test('all source gates agree that manual needs-source is a placeholder', () => {
  const url = 'https://manual/needs-source/1749700000-abc123';
  assert.equal(classifySourceLink(url), 'placeholder');
  assert.equal(isUsefulUrl(url), false);
  assert.equal(isCompletionSufficient(complete(url)).passes, false);
});

test('social primary evidence remains allowed while classified for review', () => {
  const url = 'https://x.com/program/status/1234567890123456789';
  assert.equal(classifySourceLink(url), 'tweet-only');
  assert.equal(isUsefulUrl(url), true);
  assert.equal(isCompletionSufficient(complete(url)).passes, true);
});

test('stable first-party source passes all source gates', () => {
  const url = 'https://foundation.example.org/programs/open-source-fellowship';
  assert.equal(classifySourceLink(url), 'ok');
  assert.equal(isUsefulUrl(url), true);
  assert.equal(isCompletionSufficient(complete(url)).passes, true);
});

for (const url of ['not a url', 'javascript:alert(1)', 'ftp://example.com/program']) {
  test(`invalid source is blocked by every source gate: ${url}`, () => {
    assert.equal(classifySourceLink(url), 'invalid');
    assert.equal(isUsefulUrl(url), false);
    assert.equal(isCompletionSufficient(complete(url)).passes, false);
    const approval = validateForApproval({
      id: 1,
      ...complete(url),
      classification: 'ACTIVE',
      quality_score: 80,
      deadline: null,
    });
    assert.equal(approval.valid, false);
    assert.match(approval.errors.join(' '), /invalid/i);
  });
}

test('case-variant internal source scheme remains a placeholder', () => {
  const url = 'SCAN://needs-source/123';
  assert.equal(classifySourceLink(url), 'placeholder');
  assert.equal(isUsefulUrl(url), false);
  assert.equal(isCompletionSufficient(complete(url)).passes, false);
});

test('source classifier rejects malformed and non-public HTTP host syntax', () => {
  const invalid = [
    'https:example.com/program',
    'https:/example.com/program',
    'https://localhost/program',
    'https://127.0.0.1/program',
    'https://10.1.2.3/program',
    'https://wire-room.railway.internal/program',
    'https://singlelabel/program',
    'https://user:pass@example.com/program',
    'https://exa_mple.com/program',
    'https://Example.COM./program',
  ];
  for (const value of invalid) {
    const sourceClass = classifySourceLink(value);
    assert.equal(sourceClass, 'invalid', value);
    assert.equal(isUsefulUrl(value), false, value);
    assert.equal(isCompletionSufficient(complete(value)).passes, false, value);
    assert.equal(validateForApproval(complete(value)).valid, false, value);
  }
  const publicSource = classifySourceLink('https://example.com/program');
  assert.equal(publicSource, 'ok');
  assert.equal(validateForApproval(complete('https://example.com/program')).valid, true);
});

test('single-message intake rejects caller-supplied malformed URLs before database access', async () => {
  for (const sourceUrl of ['not a url', 'ftp://example.com/program', 'https://[::1']) {
    const result = await processIntakeMessage({
      text: 'Potential grant program',
      urls: [sourceUrl],
      senderId: 'source-integrity-test',
      channelMessageId: `invalid-${sourceUrl}`,
    });
    assert.equal(result.status, 'rejected', sourceUrl);
    assert.match(result.errorMessage, /invalid source url/i, sourceUrl);
  }
});

for (const url of [
  'https://prometheus-september-ai-2.devpost.com/',
  'https://www.programaleonardo.com/',
  'https://glow.xrpl-commons.org/',
  'https://arkiv.devfolio.co/',
  'https://hefty-hacks.devfolio.co/',
  'https://hacker-house-goa-2026.devfolio.co/',
]) {
  test(`programme homepage reaches cohort intake and raw processing: ${url}`, () => {
    const { shouldPromoteRow } = require('../src/jobs/cohort-bridge');
    assert.equal(isUsefulUrl(url), true);
    assert.equal(isCompletionSufficient(complete(url)).passes, true);
    assert.equal(shouldPromoteRow({
      name: complete(url).name, wire: 'crypto', section: 'Deferred', url,
      summary: 'Needs review: Funding terms and eligibility remain unresolved.',
    }), true);
  });
}

test('truncated X status links remain blocked', () => {
  assert.equal(isUsefulUrl('https://x.com/program/status/12345'), false);
  assert.equal(isUsefulUrl('https://x.com/i/statu/1234567890123456789'), false);
});
