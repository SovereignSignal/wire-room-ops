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
  sendMessage,
  settleHistoryWithinBudget,
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
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
  });

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
    entries: [{
      name: 'Broken Batch Item',
      wire: 'oss',
      error: 'database constraint failed',
      retryable: true,
    }],
  });
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
  });

  await assert.rejects(
    handleTelegramUpdate({
      ...baseUpdate,
      message: { ...baseUpdate.message, text: 'batch payload' },
    }),
    error => error instanceof TelegramIntakeRetryableError
      && /Broken Batch Item/.test(error.message)
      && /database constraint failed/.test(error.message),
  );
});

test('Telegram adapter suppresses the preliminary batch acknowledgement on a retry', async t => {
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
    inserted: 0,
    duplicates: 0,
    errors: 1,
    retryableErrors: 1,
    failed: 1,
    entries: [{
      name: 'Retrying Item',
      wire: 'oss',
      error: 'database unavailable',
      retryable: true,
    }],
  });
  let sends = 0;
  global.fetch = async () => {
    sends++;
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  await assert.rejects(
    handleTelegramUpdate({
      ...baseUpdate,
      message: { ...baseUpdate.message, text: 'batch payload' },
    }, { sendBatchAcknowledgement: false }),
    TelegramIntakeRetryableError,
  );
  assert.equal(sends, 0);
});

test('Telegram adapter keeps the durable receipt retryable until one settled follow up sends', async t => {
  const db = require('../src/db');
  const decidedRecheck = require('../src/jobs/decided-recheck');
  const originalBatchCheck = intakeCore.isBatchMessage;
  const originalProcessBatch = intakeCore.processBatchMessage;
  const originalGetPool = db.getPool;
  const originalRun = decidedRecheck.runDecidedRecheckForIds;
  const originalFetch = global.fetch;
  t.after(() => {
    intakeCore.isBatchMessage = originalBatchCheck;
    intakeCore.processBatchMessage = originalProcessBatch;
    db.getPool = originalGetPool;
    decidedRecheck.runDecidedRecheckForIds = originalRun;
    global.fetch = originalFetch;
  });

  let settled = false;
  const reports = [];
  intakeCore.isBatchMessage = () => true;
  intakeCore.processBatchMessage = async () => ({
    inserted: 1,
    duplicates: 0,
    errors: 0,
    retryableErrors: 0,
    failed: 0,
    entries: [{ id: 301, name: 'Fresh Grant', wire: 'oss' }],
  });
  db.getPool = () => ({
    query: async () => ({
      rows: [{
        id: 301,
        status: 'queued',
        duplicate_of_id: null,
        duplicate_reason: null,
        decided_recheck: settled ? { verdict: 'distinct' } : null,
        duplicate_chain_error: null,
      }],
    }),
  });
  decidedRecheck.runDecidedRecheckForIds = async () => ({
    checked: 0,
    duplicates: 0,
    updates: 0,
    distinct: 0,
    errors: 0,
  });
  global.fetch = async (_url, options) => {
    reports.push(JSON.parse(options.body).text);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  const batchUpdate = {
    ...baseUpdate,
    message: { ...baseUpdate.message, text: 'batch payload' },
  };
  await assert.rejects(
    handleTelegramUpdate(batchUpdate),
    error => error instanceof TelegramIntakeRetryableError
      && /history checks still outstanding/.test(error.message),
  );
  assert.equal(reports.length, 1, 'first attempt sends only the acknowledgement');
  assert.match(reports[0], /Batch received/);

  await assert.rejects(
    handleTelegramUpdate(batchUpdate, { sendBatchAcknowledgement: false }),
    TelegramIntakeRetryableError,
  );
  assert.equal(reports.length, 1, 'unsettled replays stay silent');

  settled = true;
  await assert.doesNotReject(
    handleTelegramUpdate(batchUpdate, { sendBatchAcknowledgement: false }),
  );
  assert.equal(reports.length, 2, 'settled replay sends exactly one follow up');
  assert.match(reports[1], /Intake settled:/);
  assert.match(reports[1], /1 queued/);
  assert.doesNotMatch(reports[1], /checks outstanding/);
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
  let requestOptions;
  global.fetch = async (_url, options) => {
    requestOptions = options;
    return {
      ok: false,
      status: 503,
      json: async () => ({
        ok: false,
        error_code: 503,
        description: 'temporary Telegram failure',
      }),
    };
  };

  await assert.rejects(
    handleTelegramUpdate(baseUpdate),
    error => error instanceof TelegramIntakeRetryableError
      && /temporary Telegram failure/.test(error.message),
  );
  assert.ok(requestOptions.signal instanceof AbortSignal);
});

test('Telegram adapter does not retry permanent Bot API failures', async t => {
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
    ok: false,
    status: 400,
    json: async () => ({
      ok: false,
      error_code: 400,
      description: "Bad Request: can't parse entities",
    }),
  });

  await assert.doesNotReject(handleTelegramUpdate(baseUpdate));
});

test('Telegram send classification rejects unknown, transient, and contradictory responses', async t => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const response = (status, payload, ok = status >= 200 && status < 300) => ({
    ok,
    status,
    json: async () => payload,
  });
  const retryableCases = [
    ['HTTP 200 with an unexplained API failure', () => response(200, { ok: false })],
    ['HTTP 200 success payload contradicting API code 400', () => response(200, { ok: true, error_code: 400 })],
    ['HTTP 200 success payload contradicting API code 408', () => response(200, { ok: true, error_code: 408 })],
    ['HTTP 200 success payload contradicting API code 429', () => response(200, { ok: true, error_code: 429 })],
    ['HTTP 200 success payload contradicting API code 500', () => response(200, { ok: true, error_code: 500 })],
    ['HTTP 200 success payload with a malformed API code', () => response(200, { ok: true, error_code: '400' })],
    ['HTTP 200 success payload with a null API code', () => response(200, { ok: true, error_code: null })],
    ['HTTP 200 contradicting API code 400', () => response(200, { ok: false, error_code: 400 })],
    ['HTTP 200 with an invalid API code', () => response(200, { ok: false, error_code: '400' })],
    ['HTTP 503 contradicting API code 400', () => response(503, { ok: false, error_code: 400 })],
    ['HTTP 500 contradicting an API success payload', () => response(500, { ok: true })],
    ['HTTP 400 contradicting an API success payload', () => response(400, { ok: true })],
    ['HTTP 400 contradicting API code 500', () => response(400, { ok: false, error_code: 500 })],
    ['HTTP 408', () => response(408, { ok: false, error_code: 408 })],
    ['HTTP 429', () => response(429, { ok: false, error_code: 429 })],
    ['malformed HTTP 503 body', () => ({
      ok: false,
      status: 503,
      json: async () => { throw new SyntaxError('invalid JSON'); },
    })],
  ];

  for (const [name, makeResponse] of retryableCases) {
    await t.test(name, async () => {
      global.fetch = async () => makeResponse();
      await assert.rejects(
        sendMessage(394395765, 'test'),
        TelegramIntakeRetryableError,
      );
    });
  }

  await t.test('network rejection', async () => {
    global.fetch = async () => { throw new Error('network down'); };
    await assert.rejects(
      sendMessage(394395765, 'test'),
      TelegramIntakeRetryableError,
    );
  });
});

test('Telegram send classification accepts only aligned success and confirmed permanent 4xx', async t => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  await t.test('aligned HTTP and API success', async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    await assert.doesNotReject(sendMessage(394395765, 'test'));
  });

  await t.test('aligned permanent API failure', async () => {
    global.fetch = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, error_code: 400, description: 'bad request' }),
    });
    await assert.doesNotReject(sendMessage(394395765, 'test'));
  });

  await t.test('non JSON permanent HTTP failure', async () => {
    global.fetch = async () => ({
      ok: false,
      status: 400,
      json: async () => { throw new SyntaxError('invalid JSON'); },
    });
    await assert.doesNotReject(sendMessage(394395765, 'test'));
  });
});

test('history settlement returns pending when the webhook budget expires', async t => {
  const db = require('../src/db');
  const decidedRecheck = require('../src/jobs/decided-recheck');
  const originalGetPool = db.getPool;
  const originalRun = decidedRecheck.runDecidedRecheckForIds;
  t.after(() => {
    db.getPool = originalGetPool;
    decidedRecheck.runDecidedRecheckForIds = originalRun;
  });

  db.getPool = () => ({});
  decidedRecheck.runDecidedRecheckForIds = async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    return { checked: 0, duplicates: 0, updates: 0, distinct: 0, errors: 0 };
  };

  const startedAt = Date.now();
  const outcome = await settleHistoryWithinBudget([42], 5);
  assert.equal(outcome, 'pending');
  assert.ok(Date.now() - startedAt < 40);
  await new Promise(resolve => setTimeout(resolve, 55));
});
