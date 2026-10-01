require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// estimateCost() reads an in-memory cache that only refreshPricingCache() fills.
// Its only callers used to be ensureApiUsageTables() (a migration step) and the
// pricing upsert route. When boot stopped running migrations on 2026-09-25, the
// cache stayed empty and every api_usage_log row was written with a NULL
// estimated_cost_usd for six days: the cost recap, the usage tab and the
// discovery budget all read zero. Runtime boot must load the cache itself.
test('server startup loads the pricing cache', () => {
  const server = read('src/server.ts');
  assert.match(server, /import \{[^}]*refreshPricingCache[^}]*\} from '\.\/services\/api-usage'/);
  const boot = server.indexOf('await refreshProviderCache()');
  const pricing = server.indexOf('await refreshPricingCache()');
  const scheduler = server.indexOf('// Initialize the scheduler');
  assert.ok(boot > 0 && pricing > boot, 'pricing cache loads after the provider cache');
  assert.ok(scheduler > pricing, 'pricing cache loads before any scheduled job can log usage');
});

test('estimateCost is null on an empty cache and priced after a refresh', async () => {
  const db = require('../src/db');
  const usage = require('../src/services/api-usage');
  const original = db.getPool;
  db.getPool = () => ({ query: async () => ({ rows: [
    { provider: 'grok', model: 'glm-5.2', input_cost_per_1m: '1.4', output_cost_per_1m: '4.4', per_request_cost: null },
    { provider: 'parallel', model: 'task-core', input_cost_per_1m: '0', output_cost_per_1m: '0', per_request_cost: '0.025' },
  ] }) });
  try {
    assert.equal(usage.estimateCost('grok', 'glm-5.2', 1000, 100), null);
    await usage.refreshPricingCache();
    assert.equal(usage.estimateCost('grok', 'glm-5.2', 1_000_000, 0), 1.4);
    assert.equal(usage.estimateCost('parallel', 'task-core'), 0.025);
  } finally {
    db.getPool = original;
  }
});
