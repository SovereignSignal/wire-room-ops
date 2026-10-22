require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const { llmProviderOverride } = require('../src/services/api-provider');

test('LLM_PROVIDER unset or grok leaves the grok slot alone', () => {
  assert.equal(llmProviderOverride({ WRO_OLLAMA_API_KEY: 'k' }), null);
  assert.equal(llmProviderOverride({ LLM_PROVIDER: 'grok', WRO_OLLAMA_API_KEY: 'k' }), null);
});

test('LLM_PROVIDER=ollama without WRO_OLLAMA_API_KEY does not override', () => {
  assert.equal(llmProviderOverride({ LLM_PROVIDER: 'ollama' }), null);
});

test('LLM_PROVIDER=ollama routes the grok slot to Ollama Cloud with defaults', () => {
  const p = llmProviderOverride({ LLM_PROVIDER: 'Ollama', WRO_OLLAMA_API_KEY: 'k' });
  assert.equal(p.api_key, 'k');
  assert.equal(p.base_url, 'https://ollama.com/v1');
  assert.equal(p.default_model, 'deepseek-v4.1-flash');
  assert.equal(p.enabled, true);
});

test('model and base URL are configurable', () => {
  const p = llmProviderOverride({ LLM_PROVIDER: 'ollama', WRO_OLLAMA_API_KEY: 'k', LLM_OLLAMA_MODEL: 'gpt-oss:120b', LLM_OLLAMA_BASE_URL: 'https://example.test/v1/' });
  assert.equal(p.default_model, 'gpt-oss:120b');
  assert.equal(p.base_url, 'https://example.test/v1');
});
