// Pins the route mount-order / auth incident (fixed in 8cc119f): the
// internal-key scan-execution router was prefix-shadowed by session-only
// routers, 401ing the agents' /api/feeds/run and /api/forum/run. These tests
// boot the real Express app (mounted exactly as production) and assert the
// auth layer's decisions — a 401/403 means auth rejected; anything else
// (200/202/409/500) means the request REACHED its handler.
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'test-internal-key-for-auth-tests';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://x:x@127.0.0.1:1/x'; // refused fast if dialed
process.env.NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL || 'ops@example.com';
process.env.PRIVY_APP_ID = process.env.PRIVY_APP_ID || 'test-app-id';
process.env.PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET || 'test-app-secret';

require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { app } = require('../src/server');
const { resolveMaintenanceActor, resolveApprovalForce } = require('../src/routes/scan-entries');
const { canForceApproval } = require('../src/services/entry-actions');

const KEY = process.env.INTERNAL_API_KEY;
let server;
let base;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

const call = (method, path, { key, body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });

// The 'zz-*' wire matches no feed/forum source, so the background job the
// route spawns after responding is an instant no-op (no network, no intake).
test('internal key reaches POST /api/feeds/run (mount order: scan-execution before feeds router)', async () => {
  const res = await call('POST', '/api/feeds/run', { key: KEY, body: { wire: 'zz-phase3-test' } });
  assert.ok(res.status !== 401 && res.status !== 403, `expected auth to pass, got ${res.status}`);
});

test('internal key reaches POST /api/forum/run', async () => {
  const res = await call('POST', '/api/forum/run', { key: KEY, body: { wire: 'zz-phase3-test' } });
  assert.ok(res.status !== 401 && res.status !== 403, `expected auth to pass, got ${res.status}`);
});

test('internal key reaches GET /api/scan/seen-urls', async () => {
  const res = await call('GET', '/api/scan/seen-urls?wire=crypto', { key: KEY });
  assert.ok(res.status !== 401 && res.status !== 403, `expected auth to pass, got ${res.status}`);
});

test('internal key reaches guarded scan maintenance routes', async () => {
  const source = await call('PATCH', '/api/scan/entries/1/source', { key: KEY, body: {} });
  assert.ok(source.status !== 401 && source.status !== 403, `source rewrite auth rejected: ${source.status}`);
  const duplicate = await call('POST', '/api/scan/entries/1/link-duplicate', { key: KEY, body: {} });
  assert.ok(duplicate.status !== 401 && duplicate.status !== 403, `duplicate link auth rejected: ${duplicate.status}`);
});

test('maintenance actor is bound to authenticated middleware state', () => {
  const agentActor = resolveMaintenanceActor({
    agentSession: { userId: 'agent:daily-scan' },
    authSession: { userId: 'user:sov@example.com', isAgent: false },
    body: { actor: 'forged' },
  });
  assert.equal(agentActor, 'agent:daily-scan');

  const userActor = resolveMaintenanceActor({
    authSession: { userId: 'user:sov@example.com', isAgent: false },
    body: { actor: 'forged' },
  });
  assert.equal(userActor, 'user:sov@example.com');
  assert.equal(resolveMaintenanceActor({ body: { actor: 'forged' } }), '');
});

test('internal agents cannot force approval guard bypasses', () => {
  assert.equal(resolveApprovalForce({
    agentSession: { userId: 'agent:daily-scan' },
    query: { force: 'true' },
  }), false);
  assert.equal(resolveApprovalForce({
    authSession: { userId: 'user:sov@example.com', isAgent: false },
    query: { force: 'true' },
  }), true);
  assert.equal(resolveApprovalForce({
    authSession: { userId: 'user:sov@example.com', isAgent: false },
    query: { force: 'false' },
  }), false);
  assert.equal(canForceApproval({ actor: 'agent:daily-scan', force: true }), false);
  assert.equal(canForceApproval({ actor: 'user:sov@example.com', force: true }), true);
});

test('a WRONG internal key is rejected on internal-key routes', async () => {
  const res = await call('POST', '/api/feeds/run', { key: 'wrong-key' });
  assert.equal(res.status, 401);
});

test('no auth is rejected on the scan API', async () => {
  const res = await call('GET', '/api/scan/entries');
  assert.equal(res.status, 401);
});

test('no auth is rejected on POST /api/scan/telegram-batch', async () => {
  const res = await call('POST', '/api/scan/telegram-batch', { body: { text: '1. **X** — crypto grant\nLink: https://x.com/a/status/123456789012345678' } });
  assert.equal(res.status, 401);
});

test('session-only routers stay session-only (internal key must NOT unlock /api/feeds CRUD)', async () => {
  const res = await call('POST', '/api/feeds', { key: KEY });
  assert.equal(res.status, 401, 'internal key should not grant access to the session-only feeds router');
});

test('Telegram webhook without a configured secret returns 401 (not silently accepted)', { skip: Boolean(process.env.TELEGRAM_INTAKE_WEBHOOK_SECRET) }, async () => {
  const res = await call('POST', '/api/telegram/intake-webhook');
  assert.equal(res.status, 401);
});

test('internal key reaches accounts and grants intelligence without unlocking session-only APIs', async () => {
  for (const path of ['/api/accounts/monitored', '/api/grants-intel/summary']) {
    const allowed = await call('GET', path, { key: KEY });
    assert.equal(allowed.status, 200, path);
    assert.equal((await call('GET', path)).status, 401);
  }
  assert.equal((await call('GET', '/api/distribution/review', { key: KEY })).status, 401);
});
