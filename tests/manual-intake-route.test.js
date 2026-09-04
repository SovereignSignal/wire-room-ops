process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'test-internal-key-for-auth-tests';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://x:x@127.0.0.1:1/x';
process.env.NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL || 'ops@example.com';
process.env.PRIVY_APP_ID = process.env.PRIVY_APP_ID || 'test-app-id';
process.env.PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET || 'test-app-secret';

require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const intake = require('../src/services/intake-core');
const recheck = require('../src/jobs/decided-recheck');
recheck.runDecidedRecheckForIds = async () => ({ checked: 0 });
const { app } = require('../src/server');

const KEY = process.env.INTERNAL_API_KEY;
const BATCH_TEXT = `1. **X Layer BuildX AI Season Hackathon** — Official crypto/web3 hackathon on X Layer.
Deadline: 2026-08-21
Source: @XLayerOfficial
Link: https://x.com/XLayerOfficial/status/2090362022827565506`;

let server;
let base;
const originals = {};

test.before(async () => {
  originals.processBatchMessage = intake.processBatchMessage;
  originals.processIntakeMessage = intake.processIntakeMessage;
  originals.isBatchMessage = intake.isBatchMessage;
  recheck.runDecidedRecheckForIds = async () => {};

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  intake.processBatchMessage = originals.processBatchMessage;
  intake.processIntakeMessage = originals.processIntakeMessage;
  intake.isBatchMessage = originals.isBatchMessage;
  return new Promise((resolve) => server.close(resolve));
});

function call(path, { key, body, cookie, origin } = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify(body || {}),
  });
}

test('POST /api/scan/manual-intake rejects missing auth', async () => {
  const res = await call('/api/scan/manual-intake', { body: { text: BATCH_TEXT } });
  assert.equal(res.status, 401);
});

test('POST /api/scan/manual-intake rejects an invalid wire', async () => {
  const res = await call('/api/scan/manual-intake', {
    key: KEY,
    body: { text: BATCH_TEXT, wire: 'not-a-wire' },
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.error, /Invalid wire/);
});

test('POST /api/scan/manual-intake uses processBatchMessage with manual-intake + wire hint', async () => {
  let seen;
  intake.isBatchMessage = () => true;
  intake.processBatchMessage = async (msg, scanSource, options) => {
    seen = { senderId: msg.senderId, scanSource, wireHint: options?.wireHint, origin: options?.origin, text: msg.text };
    return {
      inserted: 1,
      duplicates: 0,
      errors: 0,
      retryableErrors: 0,
      failed: 0,
      entries: [{ name: 'New Program', wire: 'ai', id: 99 }],
    };
  };

  const res = await call('/api/scan/manual-intake', {
    key: KEY,
    body: { text: BATCH_TEXT, wire: 'ai' },
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.success, true);
  assert.equal(json.inserted, 1);
  assert.equal(seen.scanSource, 'manual-intake');
  assert.equal(seen.wireHint, 'ai');
  assert.equal(seen.senderId, 'agent:stringer');
  // The dashboard door does not make an internal-key caller an operator.
  assert.equal(seen.origin, 'agent');
  assert.equal(json.processing, 'background');
});

test('POST /api/scan/manual-intake falls through to processIntakeMessage for a single item', async () => {
  intake.isBatchMessage = () => false;
  intake.processIntakeMessage = async (msg, scanSource, options) => {
    assert.equal(scanSource, 'manual-intake');
    assert.equal(options?.origin, 'agent');
    return { status: 'inserted', entryId: 12, confirmText: 'Captured' };
  };

  const res = await call('/api/scan/manual-intake', {
    key: KEY,
    body: { text: 'https://example.org/grant' },
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.success, true);
  assert.equal(json.result.entryId, 12);
});

test('cookie-authenticated writes without Origin are rejected', async () => {
  const res = await call('/api/scan/manual-intake', {
    cookie: 'session=not-a-real-session',
    body: { text: 'https://example.org/grant' },
  });
  assert.equal(res.status, 403);
  const json = await res.json();
  assert.match(json.error, /origin required/);
});
