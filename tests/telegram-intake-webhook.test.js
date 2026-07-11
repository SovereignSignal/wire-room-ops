process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'test-internal-key';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://x:***@127.0.0.1:1/x';
process.env.NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL || 'ops@example.com';
process.env.PRIVY_APP_ID = process.env.PRIVY_APP_ID || 'test-app-id';
process.env.PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET || 'test-app-secret';
process.env.TELEGRAM_INTAKE_WEBHOOK_SECRET = 'test-telegram-secret';

require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const receipts = require('../src/services/telegram-intake-receipts');
const { app } = require('../src/server');

let server;
let base;

const update = {
  update_id: 501,
  message: {
    message_id: 77,
    text: 'https://example.org/grant',
    chat: { id: 394395765 },
    from: { id: 394395765 },
  },
};

test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise(resolve => server.close(resolve)));

function call(secret = 'test-telegram-secret') {
  return fetch(`${base}/api/telegram/intake-webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-telegram-bot-api-secret-token': secret,
    },
    body: JSON.stringify(update),
  });
}

test('webhook waits for durable intake completion before returning 200', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  receipts.processTelegramUpdateWithReceipt = async () => {
    await gate;
    return 'processed';
  };

  let settled = false;
  const responsePromise = call().then(response => {
    settled = true;
    return response;
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(settled, false, 'webhook acknowledged before intake completed');

  release();
  const response = await responsePromise;
  assert.equal(response.status, 200);
});

test('webhook acknowledges a previously succeeded update', async () => {
  receipts.processTelegramUpdateWithReceipt = async () => 'already_processed';
  const response = await call();
  assert.equal(response.status, 200);
});

test('webhook returns retryable 503 while another worker owns the update', async () => {
  receipts.processTelegramUpdateWithReceipt = async () => {
    throw new receipts.TelegramUpdateBusyError(501);
  };
  const response = await call();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '5');
});

test('webhook returns 500 on intake failure so Telegram retries', async () => {
  receipts.processTelegramUpdateWithReceipt = async () => {
    throw new Error('simulated intake crash');
  };
  const response = await call();
  assert.equal(response.status, 500);
});

test('webhook rejects malformed update IDs without acknowledging them', async () => {
  receipts.processTelegramUpdateWithReceipt = async () => {
    throw new receipts.TelegramUpdateValidationError('bad update');
  };
  const response = await call();
  assert.equal(response.status, 400);
});

test('webhook keeps secret validation in front of receipt processing', async () => {
  let called = false;
  receipts.processTelegramUpdateWithReceipt = async () => {
    called = true;
    return 'processed';
  };
  const response = await call('wrong-secret');
  assert.equal(response.status, 200, 'invalid secrets are quietly acknowledged to avoid retry storms');
  assert.equal(called, false);
});
