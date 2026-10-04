require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { config } = require('../src/config');
const {
  getCachedProvider,
  getProviderState,
  getAllProviders,
  isProviderExplicitlyDisabled,
  refreshProviderCache,
  testProviderConnection,
  upsertProvider,
} = require('../src/services/api-provider');

test('disabled DB provider masks an environment key and survives refresh failure', async (t) => {
  const previousKey = config.apis.grok.apiKey;
  t.after(async () => {
    config.apis.grok.apiKey = previousKey;
    t.mock.restoreAll();
    t.mock.method(db, 'getPool', () => ({
      query: async () => ({ rows: [] }),
    }));
    await refreshProviderCache();
    t.mock.restoreAll();
  });
  config.apis.grok.apiKey = 'env-secret-that-must-not-resolve';

  const disabledRow = {
    id: '00000000-0000-0000-0000-000000000001',
    provider: 'grok',
    display_name: 'Grok (xAI)',
    api_key: '',
    base_url: null,
    default_model: null,
    enabled: false,
    created_at: '2026-07-21T00:00:00.000Z',
    updated_at: '2026-07-21T00:00:00.000Z',
  };

  t.mock.method(db, 'getPool', () => ({
    query: async () => ({ rows: [disabledRow] }),
  }));
  await refreshProviderCache();

  assert.equal(getCachedProvider('grok'), null);
  assert.equal(isProviderExplicitlyDisabled('grok'), true);
  assert.equal(getProviderState('grok').source, 'db');
  assert.equal(getProviderState('grok').api_key, '');

  t.mock.restoreAll();
  t.mock.method(console, 'error', () => {});
  t.mock.method(db, 'getPool', () => ({
    query: async () => { throw new Error('transient database failure'); },
  }));
  await refreshProviderCache();
  assert.equal(getCachedProvider('grok'), null);
  assert.equal(isProviderExplicitlyDisabled('grok'), true);
});

test('a stored anthropic row cannot resolve or be re-enabled', async (t) => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    throw new Error(`unexpected request ${url}`);
  };
  t.after(async () => {
    global.fetch = originalFetch;
    t.mock.restoreAll();
    t.mock.method(db, 'getPool', () => ({
      query: async () => ({ rows: [] }),
    }));
    await refreshProviderCache();
    t.mock.restoreAll();
  });

  const row = {
    id: '00000000-0000-0000-0000-0000000000aa',
    provider: 'anthropic',
    display_name: 'Claude (Anthropic)',
    api_key: 'sk-ant-stored',
    base_url: null,
    default_model: 'claude-opus-4-8',
    enabled: true,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  };
  t.mock.method(db, 'getPool', () => ({
    query: async () => ({ rows: [row] }),
  }));
  await refreshProviderCache();

  assert.equal(getCachedProvider('anthropic'), null);
  assert.equal(getProviderState('anthropic'), null);
  assert.equal(isProviderExplicitlyDisabled('anthropic'), false);
  const listed = await getAllProviders();
  assert.equal(listed.some(provider => provider.provider === 'anthropic'), false);

  const ping = await testProviderConnection('anthropic');
  assert.equal(ping.success, false);
  assert.equal(ping.error, 'Provider is disabled');
  assert.deepEqual(calls, []);

  await assert.rejects(
    () => upsertProvider('anthropic', { api_key: 'sk-ant-stored', enabled: true }),
    /retired/,
  );
});

function storedGrokRow(overrides = {}) {
  return {
    id: '00000000-0000-0000-0000-0000000000g1',
    provider: 'grok',
    display_name: 'Grok (xAI)',
    api_key: 'stored-grok-key-1234',
    base_url: 'https://ollama.com/v1',
    default_model: 'glm-5.2',
    enabled: true,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

async function withProviderDb(t, row, query) {
  t.after(async () => {
    t.mock.restoreAll();
    t.mock.method(db, 'getPool', () => ({ query: async () => ({ rows: [] }) }));
    await refreshProviderCache();
    t.mock.restoreAll();
  });
  t.mock.method(db, 'getPool', () => ({ query }));
}

test('omitted provider fields keep stored values and a blank or masked key is not replaced', async (t) => {
  const calls = [];
  await withProviderDb(t, null, async (sql, params) => {
    calls.push({ sql, params });
    if (String(sql).includes('SELECT')) return { rows: [storedGrokRow({ enabled: false })] };
    return { rows: [] };
  });

  await upsertProvider('grok', { api_key: '****1234' });
  const masked = calls.find(call => String(call.sql).includes('INSERT INTO api_providers'));
  assert.ok(masked, 'upsert must write');
  assert.equal(masked.params[2], '', 'masked key is stored as blank so SQL keeps the existing key');
  assert.equal(masked.params[3], null, 'omitted base_url must not be replaced with the xAI default');
  assert.equal(masked.params[4], null, 'omitted default_model must not be replaced with the code default');
  assert.equal(masked.params[5], null, 'omitted enabled must not be forced back to true');
  assert.match(masked.sql, /api_key = CASE WHEN \$3 = '' THEN api_providers\.api_key ELSE \$3 END/);
  assert.match(masked.sql, /base_url = COALESCE\(\$4, api_providers\.base_url\)/);
  assert.match(masked.sql, /default_model = COALESCE\(\$5, api_providers\.default_model\)/);
  assert.match(masked.sql, /enabled = COALESCE\(\$6, api_providers\.enabled\)/);
  assert.doesNotMatch(String(masked.params[3]), /api\.x\.ai/);
  assert.notEqual(masked.params[4], 'grok-4.20-beta-0309-non-reasoning');

  calls.length = 0;
  await upsertProvider('grok', {});
  const blank = calls.find(call => String(call.sql).includes('INSERT INTO api_providers'));
  assert.equal(blank.params[2], '');
  assert.equal(blank.params[3], null);
  assert.equal(blank.params[4], null);
  assert.equal(blank.params[5], null);

  calls.length = 0;
  await upsertProvider('grok', {
    api_key: 'new-grok-key-9876',
    base_url: 'https://ollama.com/api',
    default_model: 'deepseek-v4',
    enabled: false,
  });
  const explicit = calls.find(call => String(call.sql).includes('INSERT INTO api_providers'));
  assert.equal(explicit.params[2], 'new-grok-key-9876');
  assert.equal(explicit.params[3], 'https://ollama.com/api');
  assert.equal(explicit.params[4], 'deepseek-v4');
  assert.equal(explicit.params[5], false);
});

test('grok connection test uses chat completions on an Ollama base and api-key on xAI', async (t) => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  t.after(async () => {
    global.fetch = originalFetch;
    t.mock.restoreAll();
    t.mock.method(db, 'getPool', () => ({ query: async () => ({ rows: [] }) }));
    await refreshProviderCache();
    t.mock.restoreAll();
  });

  async function load(row) {
    t.mock.restoreAll();
    t.mock.method(db, 'getPool', () => ({
      query: async () => ({ rows: [row] }),
    }));
    await refreshProviderCache();
  }

  await load(storedGrokRow());
  const ollama = await testProviderConnection('grok');
  assert.equal(ollama.success, true);
  assert.equal(calls[0].url, 'https://ollama.com/v1/chat/completions');
  assert.equal(calls[0].init.method, 'POST');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.max_tokens, 1);
  assert.equal(body.messages[0].content, 'ping');
  assert.equal(body.model, 'glm-5.2');
  assert.equal(calls.some(call => call.url.includes('/api-key')), false);

  calls.length = 0;
  await load(storedGrokRow({ base_url: 'https://api.x.ai/v1', default_model: 'grok-4.7' }));
  const xai = await testProviderConnection('grok');
  assert.equal(xai.success, true);
  assert.equal(calls[0].url, 'https://api.x.ai/v1/api-key');
  assert.equal(calls[0].init.method, undefined);
});
