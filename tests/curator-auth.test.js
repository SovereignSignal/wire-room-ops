// Boots the real Express app and checks curator-key scope decisions.
// Tokens below are fixtures, not production secrets.
const crypto = require('crypto');

function sha(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const FULL = 'test-curator-token-not-a-secret';
const READ = 'test-curator-readonly-not-a-secret';
const INTAKE = 'test-curator-intake-not-a-secret';
process.env.WIRE_ROOM_CURATOR_KEYS = JSON.stringify([
  {
    id: 'grok-batch', name: 'Grok Batch', sha256: sha(INTAKE),
    scopes: ['intake'],
    expires_at: '2099-01-01T00:00:00.000Z', revoked: false,
  },
  {
    id: 'hedwig', name: 'Hedwig', sha256: sha(FULL),
    scopes: ['read_queue', 'decide', 'propose'],
    expires_at: '2099-01-01T00:00:00.000Z', revoked: false,
  },
  {
    id: 'reader', name: 'Reader', sha256: sha(READ),
    scopes: ['read_queue'],
    expires_at: '2099-01-01T00:00:00.000Z', revoked: false,
  },
]);
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'test-internal-key-for-auth-tests';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://x:x@127.0.0.1:1/x';
process.env.NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL || 'ops@example.com';
process.env.PRIVY_APP_ID = process.env.PRIVY_APP_ID || 'test-app-id';
process.env.PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET || 'test-app-secret';
process.env.DEV_MODE = 'false';

require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../src/server');

const INTERNAL = process.env.INTERNAL_API_KEY;
let server;
let base;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

function call(method, path, { key, body, headers } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(headers || {}),
    },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
}

test('read_queue reaches GET /queue and a read-only key cannot submit', async () => {
  const queue = await call('GET', '/api/scan/queue', { key: READ });
  assert.ok(queue.status !== 401 && queue.status !== 403, `queue auth rejected: ${queue.status}`);

  const submit = await call('POST', '/api/scan/submit', { key: READ, body: {} });
  assert.equal(submit.status, 403);
  const forbidden = await submit.json();
  assert.equal(forbidden.error, 'forbidden');
});

test('a full curator key is forbidden on operator doors', async () => {
  for (const [method, path] of [
    ['POST', '/api/feeds/run'],
    ['POST', '/api/forum/run'],
    ['POST', '/api/scan/run'],
    ['POST', '/api/cohort/run'],
    ['POST', '/api/scan/prompts'],
    ['POST', '/api/scan/telegram-batch'],
    ['POST', '/api/scan/manual-intake'],
    ['POST', '/api/accounts'],
    ['POST', '/api/scan/entries/1/redistribute'],
  ]) {
    const res = await call(method, path, { key: FULL, body: {} });
    assert.equal(res.status, 403, `${method} ${path} returned ${res.status}`);
  }
});

// The Grok Telegram Batch workflow posts here. Its key must open this door and no other.
test('an intake key reaches POST /telegram-batch and nothing else', async () => {
  const batch = await call('POST', '/api/scan/telegram-batch', { key: INTAKE, body: {} });
  assert.equal(batch.status, 400, 'auth should pass and the empty text should be rejected');
  assert.match((await batch.json()).error, /text is required/);

  for (const [method, path] of [
    ['GET', '/api/scan/queue'],
    ['GET', '/api/scan/telegram-batch'],
    ['POST', '/api/scan/submit'],
    ['POST', '/api/scan/manual-intake'],
    ['POST', '/api/scan/submit-batch'],
    ['POST', '/api/scan/entries/1/action'],
    ['POST', '/api/scan/entries/1/curate'],
  ]) {
    const res = await call(method, path, { key: INTAKE, body: {} });
    assert.equal(res.status, 403, `${method} ${path} returned ${res.status}`);
  }
});

test('curator decide without reason is 400 and does not require the database', async () => {
  const res = await call('POST', '/api/scan/entries/1/action', {
    key: FULL,
    body: { action: 'decline' },
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /reason/);
});

test('curator approve without a quote is 400', async () => {
  const res = await call('POST', '/api/scan/entries/1/action', {
    key: FULL,
    body: {
      action: 'approve',
      reason: 'Looks open.',
      sources: ['https://example.org/grants'],
    },
    headers: { 'Idempotency-Key': 'approve-missing-quote' },
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /quote/);
});

test('internal key still reaches POST /api/feeds/run', async () => {
  const res = await call('POST', '/api/feeds/run', { key: INTERNAL, body: { wire: 'zz-phase3-test' } });
  assert.ok(res.status !== 401 && res.status !== 403, `expected auth to pass, got ${res.status}`);
});
