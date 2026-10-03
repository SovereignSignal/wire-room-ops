// Fails when a dashboard UI call is not reachable with a curator bearer.
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

require('ts-node/register/transpile-only');
const { requiredCuratorScope } = require('../src/services/curator-keys');
const { redactSecrets } = require('../src/services/curator-audit');
const { bodyHasNewSecret, curatorConfirmRequired, isEditorialConfirmPath, isSendPath } = require('../src/services/curator-confirm');

const ROOT = path.join(__dirname, '..');
const HEDWIG = new Set(['read_queue', 'decide', 'propose']);

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

function methodsNear(text, index) {
  const window = text.slice(index, index + 400);
  const before = text.slice(Math.max(0, index - 30), index);
  const methods = new Set();
  for (const hit of window.matchAll(/method:\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/g)) methods.add(hit[1]);
  if (/editingId\s*\?\s*['"]PUT['"]\s*:\s*['"]POST['"]/.test(window)) {
    methods.add('PUT');
    methods.add('POST');
  }
  if (/act\(\s*$/.test(before)) methods.add('POST');
  if (methods.size === 0) methods.add('GET');
  return [...methods];
}

function normalizeApiPath(literal) {
  let raw = literal.replace(/\$\{BASE\}/g, '/api');
  raw = raw.replace(/\$\{[^}]+\}/g, (match, offset, whole) => {
    if (match.includes('?')) return '';
    return whole[offset - 1] === '/' ? '1' : '';
  });
  raw = raw.split('?')[0].replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return raw;
}

function uiCalls() {
  const calls = [];
  const literals = /`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g;
  for (const file of walk(path.join(ROOT, 'client/src'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(literals)) {
      const literal = match[0].slice(1, -1);
      if (!literal.includes('/api') && !literal.includes('${BASE}')) continue;
      const raw = normalizeApiPath(literal);
      if (!raw.startsWith('/api/')) continue;
      for (const method of methodsNear(text, match.index)) {
        calls.push({ method, path: raw, file: path.relative(ROOT, file) });
      }
    }
  }
  return calls;
}

function mounts(source) {
  const found = [];
  for (const match of source.matchAll(/app\.use\(\s*'([^']+)'\s*,\s*([^)]+)\)/g)) {
    const args = match[2];
    let auth = null;
    if (args.includes('requireAuthOrCurator')) auth = 'requireAuthOrCurator';
    else if (args.includes('requireAuthOrInternalKey')) auth = 'requireAuthOrInternalKey';
    else if (/\brequireAuth\b/.test(args)) auth = 'requireAuth';
    found.push({ prefix: match[1], auth });
  }
  return found;
}

function sessionOnlyMount(serverSource, apiPath) {
  for (const mount of mounts(serverSource)) {
    if (mount.prefix === '/') continue;
    const matches = apiPath === mount.prefix
      || (mount.prefix !== '/' && apiPath.startsWith(`${mount.prefix}/`));
    if (matches && mount.auth === 'requireAuth') return mount.prefix;
  }
  return null;
}

test('every dashboard UI route accepts a Hedwig curator token', () => {
  const calls = uiCalls();
  assert.ok(calls.length > 20, `expected the dashboard client to call the API, found ${calls.length}`);
  const keys = new Set(calls.map(call => `${call.method} ${call.path}`));
  for (const required of [
    'GET /api/distribution/pace',
    'PUT /api/distribution/pace',
    'GET /api/distribution/outgoing',
    'POST /api/scan/entries/1/action',
    'POST /api/distribution/review/1/resolve',
    'DELETE /api/distribution/channels/1',
  ]) {
    assert.ok(keys.has(required), `extractor missed ${required}`);
  }
  const server = fs.readFileSync(path.join(ROOT, 'src/server.ts'), 'utf8');
  const jobs = fs.readFileSync(path.join(ROOT, 'src/routes/jobs.ts'), 'utf8');
  const seen = new Set();
  for (const call of calls) {
    const key = `${call.method} ${call.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const scope = requiredCuratorScope(call.method, call.path);
    assert.ok(HEDWIG.has(scope), `${key} from ${call.file} needs ${scope}, which Hedwig does not have`);
    const blocked = sessionOnlyMount(server, call.path);
    assert.equal(blocked, null, `${key} is still behind session-only mount ${blocked}`);
    if (call.path.startsWith('/api/job/')) {
      assert.match(jobs, /router\.get\('\/job\/:jobId\/progress',\s*requireAuthOrInternalKey/);
    }
  }

  for (const [method, path, scope] of [
    ['GET', '/api/accounts/monitored', 'read_queue'],
    ['POST', '/api/accounts/monitored', 'decide'],
    ['PATCH', '/api/accounts/monitored/handle', 'decide'],
    ['DELETE', '/api/accounts/monitored/handle', 'decide'],
    ['GET', '/api/registry-watch/pending', 'read_queue'],
    ['GET', '/api/registry-watch/surfaces', 'read_queue'],
    ['PUT', '/api/registry-watch/surfaces/1', 'decide'],
    ['GET', '/api/source-feeds', 'read_queue'],
    ['POST', '/api/source-feeds', 'decide'],
    ['PUT', '/api/source-feeds/octant', 'decide'],
    ['DELETE', '/api/source-feeds/octant', 'decide'],
  ]) {
    assert.equal(requiredCuratorScope(method, path), scope, `${method} ${path}`);
    assert.ok(HEDWIG.has(scope), `${method} ${path}`);
    assert.equal(sessionOnlyMount(server, path), null, `${method} ${path}`);
  }
  assert.match(server, /app\.use\('\/api\/accounts', requireAuthOrCurator/);
  assert.match(server, /app\.use\('\/api\/registry-watch', requireAuthOrCurator/);
  assert.match(server, /app\.use\('\/api\/source-feeds', requireAuthOrCurator/);
});

test('secret fields are redacted and risky writes require confirm', () => {
  const redacted = redactSecrets({
    api_key: 'sk-live-secret-1234',
    nested: { notion_token: 'secret-token', name: 'Notion' },
    note: 'postgres://user:pass@db.internal:5432/wire',
  });
  assert.equal(redacted.api_key, '****');
  assert.equal(redacted.nested.notion_token, '****');
  assert.equal(redacted.nested.name, 'Notion');
  assert.equal(redacted.note, 'postgresql://****');

  assert.equal(bodyHasNewSecret({ api_key: '****abcd' }), false);
  assert.equal(bodyHasNewSecret({ credentials: { bot_token: '****abcd' } }), false);
  assert.equal(bodyHasNewSecret({ credentials: { bot_token: '123:abc' } }), true);
  assert.equal(curatorConfirmRequired('PUT', '/api/distribution/pace', { intervalMinutes: 20 }), false);
  assert.equal(curatorConfirmRequired('DELETE', '/api/feeds/crypto', {}), true);
  assert.equal(curatorConfirmRequired('POST', '/api/distribution/run/crypto', {}), true);
  assert.equal(curatorConfirmRequired('POST', '/api/distribution/queue/18510/enqueue', {}), true);
  assert.equal(curatorConfirmRequired('PATCH', '/api/scan/entries/18106/content', {}), true);
  assert.equal(curatorConfirmRequired('POST', '/api/scan/entries/18106/unwithhold', {}), true);
  assert.equal(isSendPath('PATCH', '/api/scan/entries/18106/content'), false);
  assert.equal(isSendPath('POST', '/api/scan/entries/18106/unwithhold'), false);
  assert.equal(isEditorialConfirmPath('PATCH', '/api/scan/entries/18106/content'), true);
  assert.equal(isEditorialConfirmPath('POST', '/api/scan/entries/18106/unwithhold'), true);
  assert.equal(curatorConfirmRequired('PUT', '/api/providers/grok', { enabled: false }), false);
});
