require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const { OSS_PARALLEL_DISCOVERY_PROMPT, ossParallelPromptNeedsRefresh } = require('../src/services/parallel-prompts');

test('the OSS Parallel prompt uses a 21-day window and drops watched funders', () => {
  assert.match(OSS_PARALLEL_DISCOVERY_PROMPT, /last 21 days/);
  assert.match(OSS_PARALLEL_DISCOVERY_PROMPT, /Search queries:/);
  assert.match(OSS_PARALLEL_DISCOVERY_PROMPT, /Do not search NLnet/);
  assert.doesNotMatch(OSS_PARALLEL_DISCOVERY_PROMPT, /nlnet ngi|sovereign tech fellowship|openssf alpha-omega|open source endowment/i);
  assert.equal(ossParallelPromptNeedsRefresh(OSS_PARALLEL_DISCOVERY_PROMPT), false);
});

test('an old OSS Parallel prompt is refreshed and a rewritten 21-day prompt is not', () => {
  assert.equal(ossParallelPromptNeedsRefresh('Search NLnet NGI and Sovereign Tech Fellowship and OpenSSF Alpha-Omega and the open source endowment.'), true);
  assert.equal(ossParallelPromptNeedsRefresh('Find OSS grants.'), true);
  assert.equal(ossParallelPromptNeedsRefresh('Find maintainer grants from the last 21 days. Search queries: "open source" fellowship announced'), false);
});
