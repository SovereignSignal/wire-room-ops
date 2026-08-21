require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { supportsGrokSearchTools, resolveGrokSearchModel, GROK_SEARCH_MODEL } = require('../src/services/grok');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('legacy xAI search tools reject the configured GLM chat model before an API call', () => {
  assert.equal(supportsGrokSearchTools('grok-4.20-beta-0309-non-reasoning'), true);
  assert.equal(supportsGrokSearchTools('grok-4'), true);
  assert.equal(supportsGrokSearchTools('glm-5.2'), false);
  assert.equal(supportsGrokSearchTools('claude-sonnet-4-6'), false);
});

test('search lanes fall back from glm-5.2 without changing the provider chat default', () => {
  assert.equal(resolveGrokSearchModel('glm-5.2'), GROK_SEARCH_MODEL);
  assert.equal(resolveGrokSearchModel('  glm-5.2  '), GROK_SEARCH_MODEL);
  assert.equal(resolveGrokSearchModel(''), GROK_SEARCH_MODEL);
  assert.equal(resolveGrokSearchModel(null), GROK_SEARCH_MODEL);
  assert.equal(resolveGrokSearchModel(undefined), GROK_SEARCH_MODEL);
  assert.equal(resolveGrokSearchModel('grok-4'), 'grok-4');
  assert.equal(resolveGrokSearchModel('grok-4.20-beta-0309-non-reasoning'), 'grok-4.20-beta-0309-non-reasoning');
});

test('org enrichment and contact discovery pin a Grok search model', () => {
  assert.match(read('src/services/org-enricher.ts'), /resolveGrokSearchModel\(/);
  assert.match(read('src/services/contact-discovery.ts'), /resolveGrokSearchModel\(/);
  assert.doesNotMatch(read('src/services/org-enricher.ts'), /const model = provider\.default_model/);
  assert.doesNotMatch(read('src/services/contact-discovery.ts'), /const model = provider\?\.default_model \|\|/);
});

test('Prompt Lab routes all retrieval calls to scan-test telemetry', () => {
  const routes = read('src/routes/scan-prompts.ts');
  const helper = routes.slice(
    routes.indexOf('async function executePromptLabTest'),
    routes.indexOf('// GET / — list prompts'),
  );

  assert.equal((helper.match(/usagePurpose: 'scan-test'/g) || []).length, 3);
});

test('Parallel marks Prompt Lab planning and extraction as test traffic', () => {
  const parallel = read('src/services/parallel.ts');
  assert.match(parallel, /'parallel-test-queries'/);
  assert.match(parallel, /'parallel-test-extract'/);
});

test('production run ledger excludes every Prompt Lab purpose', () => {
  const digest = read('src/jobs/daily-digest.ts');
  assert.match(digest, /WHERE purpose = 'scan' AND created_at/);
  assert.doesNotMatch(digest, /WHERE purpose LIKE 'scan%'/);
  assert.match(digest, /purpose <> 'scan-test'/);
  assert.match(digest, /purpose NOT LIKE 'parallel-test-%'/);
});
