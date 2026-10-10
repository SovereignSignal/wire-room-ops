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
  originals.runDecidedRecheckForIds = recheck.runDecidedRecheckForIds;
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
  recheck.runDecidedRecheckForIds = originals.runDecidedRecheckForIds;
  return new Promise((resolve) => server.close(resolve));
});

function call(path, { key, body } = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body || {}),
  });
}

test('POST /api/scan/telegram-batch rejects missing auth', async () => {
  const res = await call('/api/scan/telegram-batch', { body: { text: BATCH_TEXT } });
  assert.equal(res.status, 401);
});

test('POST /api/scan/telegram-batch rejects a wrong key', async () => {
  const res = await call('/api/scan/telegram-batch', { key: 'wrong-key', body: { text: BATCH_TEXT } });
  assert.equal(res.status, 401);
});

test('POST /api/scan/telegram-batch rejects empty text', async () => {
  const res = await call('/api/scan/telegram-batch', { key: KEY, body: { text: '   ' } });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.error, /text is required/);
});

test('POST /api/scan/telegram-batch rejects oversized text', async () => {
  const res = await call('/api/scan/telegram-batch', { key: KEY, body: { text: 'x'.repeat(20_001) } });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.error, /20000/);
});

test('POST /api/scan/telegram-batch uses processBatchMessage (telegram source, agent origin)', async () => {
  let seen;
  intake.isBatchMessage = () => true;
  intake.processBatchMessage = async (msg, scanSource, options) => {
    seen = { senderId: msg.senderId, scanSource, text: msg.text, origin: options?.origin };
    return {
      inserted: 1,
      duplicates: 1,
      errors: 0,
      retryableErrors: 0,
      failed: 1,
      entries: [
        { name: 'New Program', wire: 'crypto', id: 15380 },
        { name: 'Base Batches 004', wire: 'crypto', isDuplicate: true, error: 'Already seen as "Base Batches 004"' },
      ],
    };
  };

  const res = await call('/api/scan/telegram-batch', { key: KEY, body: { text: BATCH_TEXT } });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.success, true);
  assert.equal(json.inserted, 1);
  assert.equal(json.duplicates, 1);
  assert.equal(json.skippedAlreadySeen, 0);
  assert.equal(json.entries[1].isDuplicate, true);
  assert.equal(seen.scanSource, 'telegram');
  assert.equal(seen.senderId, 'agent:stringer');
  assert.equal(seen.text, BATCH_TEXT);
  // An internal-key caller is an agent: rows start raw and Gate 2 runs in the
  // background, so the receipt must say so and warn against retrying.
  assert.equal(seen.origin, 'agent');
  assert.equal(json.processing, 'background');
  assert.match(json.note, /Do NOT retry/);
});

test('POST /api/scan/telegram-batch returns 503 on retryable persistence errors', async () => {
  intake.isBatchMessage = () => true;
  intake.processBatchMessage = async () => ({
    inserted: 0,
    duplicates: 0,
    errors: 1,
    retryableErrors: 1,
    failed: 1,
    entries: [{ name: 'X', wire: 'crypto', error: 'insert failed', retryable: true }],
  });

  const res = await call('/api/scan/telegram-batch', { key: KEY, body: { text: BATCH_TEXT } });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '5');
  const json = await res.json();
  assert.equal(json.skippedAlreadySeen, 0);
});

test('POST /api/scan/telegram-batch falls through to processIntakeMessage for a single item', async () => {
  intake.isBatchMessage = () => false;
  intake.processIntakeMessage = async (msg, scanSource, options) => {
    assert.equal(scanSource, 'telegram');
    assert.equal(msg.senderId, 'agent:stringer');
    assert.equal(options?.origin, 'agent');
    return { status: 'rejected', errorMessage: 'Duplicate: already seen as "Base Batches 004"' };
  };

  const res = await call('/api/scan/telegram-batch', {
    key: KEY,
    body: { text: 'https://x.com/base/status/2090466387579781370' },
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.success, false);
  assert.equal(json.result.status, 'rejected');
  assert.equal(json.skippedAlreadySeen, undefined);
});

test('POST /api/scan/telegram-batch counts a skipped X post on a single item', async () => {
  intake.isBatchMessage = () => false;
  intake.processIntakeMessage = async () => ({
    status: 'rejected',
    errorMessage: 'Skipped: this X post is already in scan_entries',
    skippedAlreadySeen: true,
  });

  const res = await call('/api/scan/telegram-batch', {
    key: KEY,
    body: { text: 'https://x.com/base/status/2090466387579781370' },
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.inserted, 0);
  assert.equal(json.duplicates, 0);
  assert.equal(json.skippedAlreadySeen, 1);
});
