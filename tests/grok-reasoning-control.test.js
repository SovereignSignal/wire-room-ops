require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { chatCompletionExtras } = require('../src/services/grok');

// The "grok" provider slot points at Ollama Cloud (glm-5.2), a reasoning model.
// Without reasoning turned off it spends the whole max_tokens budget thinking,
// returns finish_reason=length with empty or truncated content, and every JSON
// caller (classify, decided-recheck, feed extract) logs "malformed JSON".
// Verified live 2026-09-30: reasoning_effort:"none" → 49 output tokens, clean JSON.
test('ollama.com gets reasoning turned off for JSON callers', () => {
  assert.deepEqual(chatCompletionExtras('https://ollama.com/v1'), { reasoning_effort: 'none' });
  assert.deepEqual(chatCompletionExtras('https://OLLAMA.com/v1/'), { reasoning_effort: 'none' });
});

// xAI rejects reasoning_effort on models that do not support it, so the real
// Grok endpoint (and anything unknown) must get an empty extras object.
test('x.ai and unknown hosts get no extra parameters', () => {
  assert.deepEqual(chatCompletionExtras('https://api.x.ai/v1'), {});
  assert.deepEqual(chatCompletionExtras(undefined), {});
  assert.deepEqual(chatCompletionExtras('not a url'), {});
});
