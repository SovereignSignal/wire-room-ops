require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const grok = require('../src/services/grok');
const budgetGuard = require('../src/services/budget-guard');
const dailyIntake = require('../src/jobs/daily-intake');

const originals = {
  getAllScanPrompts: db.getAllScanPrompts,
  executeScanPrompt: grok.executeScanPrompt,
  checkBudget: budgetGuard.checkBudget,
  withDiscoveryBudget: budgetGuard.withDiscoveryBudget,
  runDailyIntake: dailyIntake.runDailyIntake,
};

const prompt = (id, label, sortOrder) => ({
  id,
  wire: 'oss',
  label,
  promptText: `prompt ${id}`,
  responseFormat: null,
  variant: 'A',
  toolType: 'x_search',
  model: null,
  outputFormat: 'text',
  intent: 'discovery',
  isActive: true,
  sortOrder,
  createdAt: new Date(),
  updatedAt: new Date(),
});

test('quota exhaustion after a successful prompt ingests completed results and returns a structured partial result', async () => {
  db.getAllScanPrompts = async () => [
    prompt('00000000-0000-0000-0000-000000000001', 'completed', 0),
    prompt('00000000-0000-0000-0000-000000000002', 'quota', 1),
    prompt('00000000-0000-0000-0000-000000000003', 'skipped', 2),
  ];
  budgetGuard.withDiscoveryBudget = async (_pool, run) => run();
  budgetGuard.checkBudget = async () => ({ allowed: true, spentUsd: 1, capUsd: 20 });

  let providerCalls = 0;
  grok.executeScanPrompt = async () => {
    providerCalls++;
    if (providerCalls === 1) {
      return {
        content: [
          '1. **Durable Open Call** - Funding for open source maintainers',
          'Deadline: 2026-09-01',
          'Link: https://example.org/open-call',
        ].join('\n'),
      };
    }
    throw new Error('Resource has been exhausted for this account');
  };

  let capturedSubmissions;
  dailyIntake.runDailyIntake = async (_pool, submissions) => {
    capturedSubmissions = submissions;
    return {
      runDate: '2026-07-21',
      wire: 'oss',
      totalIngested: 1,
      duplicatesFound: 0,
      newUnique: 1,
      averageQualityScore: 80,
      highQualityCount: 1,
      byPrompt: {},
      topFinds: [],
    };
  };

  const { runScanExecution } = require('../src/jobs/scan-execution');
  const result = await runScanExecution({});

  assert.equal(result.partial, true);
  assert.match(result.partialReason, /resource has been exhausted/i);
  assert.equal(result.promptsExecuted, 1);
  assert.equal(result.promptsFailed, 2);
  assert.equal(result.totalResults, 1);
  assert.equal(capturedSubmissions.length, 1, 'completed prompt output must reach intake');
  assert.equal(capturedSubmissions[0].results[0].sourceUrl, 'https://example.org/open-call');
  assert.match(result.perPrompt[2].error, /Skipped after fatal quota error/);
});

test.after(() => {
  db.getAllScanPrompts = originals.getAllScanPrompts;
  grok.executeScanPrompt = originals.executeScanPrompt;
  budgetGuard.checkBudget = originals.checkBudget;
  budgetGuard.withDiscoveryBudget = originals.withDiscoveryBudget;
  dailyIntake.runDailyIntake = originals.runDailyIntake;
});
