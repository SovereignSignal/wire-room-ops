const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

// Callers that deliberately send no reasoning control. Adding a file here is a
// decision, not a formality: say why.
const EXEMPT = new Set([
  'services/grok.ts',           // defines the helper; its own call writes prose summaries
  'services/api-provider.ts',   // connection test against whichever provider is being configured
  'services/perplexity.ts',     // Perplexity API, not the grok provider slot
  'migrations/dedup-org-profiles.ts', // historical one-off, never run by the server
]);

// The grok provider slot serves a reasoning model on Ollama Cloud. A JSON-only
// caller that omits chatCompletionExtras() lets the model spend its budget
// thinking and return empty or truncated content. Four callers were fixed on
// 2026-09-30; a fifth (program-identity) kept failing 20% of the time for
// another day because nothing enumerated the call sites. This does.
test('every chat-completion caller passes the reasoning control or is explicitly exempt', () => {
  const callers = walk(SRC)
    .filter(file => fs.readFileSync(file, 'utf8').includes('/chat/completions'))
    .map(file => path.relative(SRC, file));
  const missing = callers.filter(rel =>
    !EXEMPT.has(rel) && !fs.readFileSync(path.join(SRC, rel), 'utf8').includes('...chatCompletionExtras('));
  assert.deepEqual(missing, [], `JSON callers without chatCompletionExtras: ${missing.join(', ')}`);
  const staleExemptions = [...EXEMPT].filter(rel => !callers.includes(rel));
  assert.deepEqual(staleExemptions, [], 'exempt list names files that no longer call chat/completions');
});
