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
