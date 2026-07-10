require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifySourceLink } = require('../src/services/source-filter');
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
