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
const { resolveMaintenanceActor } = require('../src/routes/scan-entries');

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

test('maintenance actor is bound to the authenticated agent principal', () => {
  const actor = resolveMaintenanceActor({
    agentSession: { userId: 'agent:daily-scan', isAgent: true },
    body: { actor: 'sov' },
  });
  assert.equal(actor, 'agent:daily-scan');
});

test('a WRONG internal key is rejected on internal-key routes', async () => {
  const res = await call('POST', '/api/feeds/run', { key: 'wrong-key' });
  assert.equal(res.status, 401);
});

test('no auth is rejected on the scan API', async () => {
  const res = await call('GET', '/api/scan/entries');
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
