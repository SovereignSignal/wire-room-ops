require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { config } = require('../src/config');
const {
  getCachedProvider,
  getProviderState,
  isProviderExplicitlyDisabled,
  refreshProviderCache,
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
