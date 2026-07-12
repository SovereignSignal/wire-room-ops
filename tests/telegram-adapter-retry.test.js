process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'test-internal-key';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://x:***@127.0.0.1:1/x';
process.env.NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL || 'ops@example.com';
process.env.PRIVY_APP_ID = process.env.PRIVY_APP_ID || 'test-app-id';
process.env.PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET || 'test-app-secret';
process.env.TELEGRAM_INTAKE_ALLOWED_USER_ID = process.env.TELEGRAM_INTAKE_ALLOWED_USER_ID || '394395765';

require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const intakeCore = require('../src/services/intake-core');
const {
  handleTelegramUpdate,
  TelegramIntakeRetryableError,
} = require('../src/services/telegram-adapter');

const baseUpdate = {
  update_id: 501,
  message: {
    message_id: 77,
    text: 'https://example.org/grant',
    chat: { id: 394395765 },
    from: { id: 394395765 },
  },
};

test('Telegram adapter propagates single item persistence failures for webhook retry', async t => {
  const originalBatchCheck = intakeCore.isBatchMessage;
  const originalProcess = intakeCore.processIntakeMessage;
  const originalFetch = global.fetch;
  t.after(() => {
    intakeCore.isBatchMessage = originalBatchCheck;
    intakeCore.processIntakeMessage = originalProcess;
    global.fetch = originalFetch;
  });
  intakeCore.isBatchMessage = () => false;
  intakeCore.processIntakeMessage = async () => ({
    status: 'error',
    errorMessage: 'database unavailable',
  });
  global.fetch = async () => ({ json: async () => ({ ok: true }) });

  await assert.rejects(
    handleTelegramUpdate(baseUpdate),
    error => error instanceof TelegramIntakeRetryableError && /database unavailable/.test(error.message),
  );
});

test('Telegram adapter propagates batch persistence failures for webhook retry', async t => {
  const originalBatchCheck = intakeCore.isBatchMessage;
  const originalProcessBatch = intakeCore.processBatchMessage;
  const originalFetch = global.fetch;
  t.after(() => {
    intakeCore.isBatchMessage = originalBatchCheck;
    intakeCore.processBatchMessage = originalProcessBatch;
    global.fetch = originalFetch;
  });
  intakeCore.isBatchMessage = () => true;
  intakeCore.processBatchMessage = async () => ({
    inserted: 1,
    duplicates: 0,
    errors: 1,
    retryableErrors: 1,
    failed: 1,
    entries: [],
  });
  global.fetch = async () => ({ json: async () => ({ ok: true }) });

  await assert.rejects(
    handleTelegramUpdate({
      ...baseUpdate,
      message: { ...baseUpdate.message, text: 'batch payload' },
    }),
    TelegramIntakeRetryableError,
  );
});

test('Telegram adapter propagates reply delivery failures for webhook retry', async t => {
  const originalBatchCheck = intakeCore.isBatchMessage;
  const originalProcess = intakeCore.processIntakeMessage;
  const originalFetch = global.fetch;
  t.after(() => {
    intakeCore.isBatchMessage = originalBatchCheck;
    intakeCore.processIntakeMessage = originalProcess;
    global.fetch = originalFetch;
  });
  intakeCore.isBatchMessage = () => false;
  intakeCore.processIntakeMessage = async () => ({
    status: 'inserted',
    entryId: 42,
    detectedWire: 'oss',
    confirmText: 'Saved entry #42',
  });
  global.fetch = async () => ({
    json: async () => ({ ok: false, description: 'temporary Telegram failure' }),
  });

  await assert.rejects(
    handleTelegramUpdate(baseUpdate),
    error => error instanceof TelegramIntakeRetryableError
      && /temporary Telegram failure/.test(error.message),
  );
});
