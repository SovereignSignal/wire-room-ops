require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  processTelegramUpdateWithReceipt,
  MAX_CONCURRENT_TELEGRAM_UPDATES,
  TelegramIntakeCapacityError,
  TelegramUpdateBusyError,
  TelegramUpdateValidationError,
} = require('../src/services/telegram-intake-receipts');
const {
  buildIntakeMetadata,
  findTelegramReplayEntry,
  telegramReplayPlaceholder,
} = require('../src/services/intake-core');

function receiptPool({ lock = true, claim = true, existingStatus = null, attempts = 1 } = {}) {
  const calls = [];
  let connects = 0;
  let releases = 0;
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('pg_try_advisory_lock')) {
        return { rows: [{ acquired: lock }], rowCount: 1 };
      }
      if (sql.includes('pg_advisory_unlock')) {
        return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO telegram_intake_receipts')) {
        return { rows: claim ? [{ update_id: params[0], attempts }] : [], rowCount: claim ? 1 : 0 };
      }
      if (sql.includes('SELECT status FROM telegram_intake_receipts')) {
        return { rows: existingStatus ? [{ status: existingStatus }] : [], rowCount: existingStatus ? 1 : 0 };
      }
      if (sql.includes('UPDATE telegram_intake_receipts')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
    release: () => { releases += 1; },
  };
  return {
    calls,
    get connects() { return connects; },
    get releases() { return releases; },
    connect: async () => {
      connects += 1;
      return client;
    },
  };
}

function update(updateId = 501) {
  return {
    update_id: updateId,
    message: {
      message_id: 77,
      chat: { id: 394395765 },
      from: { id: 394395765 },
    },
  };
}

test('new Telegram update is locked and durably claimed before the handler, then marked succeeded', async () => {
  const pool = receiptPool();
  let handled = false;

  const result = await processTelegramUpdateWithReceipt(update(), async () => {
    const lockCall = pool.calls.find(call => call.sql.includes('pg_try_advisory_lock'));
    const claimCall = pool.calls.find(call => call.sql.includes('INSERT INTO telegram_intake_receipts'));
    assert.ok(lockCall, 'handler ran before the advisory lock');
    assert.ok(claimCall, 'handler ran before the durable receipt claim');
    handled = true;
  }, pool);

  assert.equal(result, 'processed');
  assert.equal(handled, true);
  const claim = pool.calls.find(call => call.sql.includes('INSERT INTO telegram_intake_receipts'));
  const success = pool.calls.find(call => call.sql.includes("status = 'succeeded'"));
  const unlock = pool.calls.find(call => call.sql.includes('pg_advisory_unlock'));
  assert.ok(success, 'receipt was not marked succeeded');
  assert.ok(unlock, 'advisory lock was not released');
  assert.equal(claim.params[0], 501);
  assert.equal(claim.params[1], 77);
  assert.equal(pool.releases, 1);
});

test('durable receipt tells the handler whether this is the first delivery attempt', async () => {
  const firstPool = receiptPool({ attempts: 1 });
  const retryPool = receiptPool({ attempts: 4 });
  let firstAttempt;
  let retryAttempt;

  await processTelegramUpdateWithReceipt(update(701), async context => {
    firstAttempt = context.isFirstAttempt;
  }, firstPool);
  await processTelegramUpdateWithReceipt(update(702), async context => {
    retryAttempt = context.isFirstAttempt;
  }, retryPool);

  assert.equal(firstAttempt, true);
  assert.equal(retryAttempt, false);
});

test('successful duplicate update is acknowledged without running the handler twice', async () => {
  const pool = receiptPool({ claim: false, existingStatus: 'succeeded' });
  let handled = false;

  const result = await processTelegramUpdateWithReceipt(update(), async () => {
    handled = true;
  }, pool);

  assert.equal(result, 'already_processed');
  assert.equal(handled, false);
  assert.equal(pool.releases, 1);
});

test('active duplicate update asks Telegram to retry when another worker owns the advisory lock', async () => {
  const pool = receiptPool({ lock: false });

  await assert.rejects(
    processTelegramUpdateWithReceipt(update(), async () => {}, pool),
    error => error instanceof TelegramUpdateBusyError && error.updateId === 501
  );
  assert.equal(pool.calls.some(call => call.sql.includes('INSERT INTO telegram_intake_receipts')), false);
  assert.equal(pool.releases, 1);
});

test('an interrupted processing receipt is immediately reclaimable once its advisory lock is free', async () => {
  const pool = receiptPool({ lock: true, claim: true });
  const result = await processTelegramUpdateWithReceipt(update(), async () => {}, pool);

  assert.equal(result, 'processed');
  const claim = pool.calls.find(call => call.sql.includes('INSERT INTO telegram_intake_receipts'));
  assert.match(claim.sql, /status <> 'succeeded'/);
  assert.doesNotMatch(claim.sql, /INTERVAL|processing_started_at </);
});

test('handler failure marks the receipt failed and remains retryable', async () => {
  const pool = receiptPool();

  await assert.rejects(
    processTelegramUpdateWithReceipt(update(), async () => {
      throw new Error('simulated intake failure');
    }, pool),
    /simulated intake failure/
  );

  const failed = pool.calls.find(call => call.sql.includes('UPDATE telegram_intake_receipts') && call.sql.includes("status = 'failed'"));
  assert.ok(failed, 'receipt was not marked failed');
  assert.equal(failed.params[2], 'simulated intake failure');
  assert.ok(pool.calls.some(call => call.sql.includes('pg_advisory_unlock')));
  assert.equal(pool.releases, 1);
});

test('invalid update IDs fail before opening a database connection', async () => {
  const pool = receiptPool();

  await assert.rejects(
    processTelegramUpdateWithReceipt({ update_id: -1 }, async () => {}, pool),
    TelegramUpdateValidationError
  );
  assert.equal(pool.connects, 0);
  assert.equal(pool.calls.length, 0);
});

test('bounded Telegram processing leaves database pool capacity for handlers', async () => {
  let entered = 0;
  let releaseHandlers;
  let allEntered;
  const gate = new Promise(resolve => { releaseHandlers = resolve; });
  const started = new Promise(resolve => { allEntered = resolve; });
  const active = Array.from({ length: MAX_CONCURRENT_TELEGRAM_UPDATES }, (_, index) => {
    const pool = receiptPool();
    return processTelegramUpdateWithReceipt(update(600 + index), async () => {
      entered++;
      if (entered === MAX_CONCURRENT_TELEGRAM_UPDATES) allEntered();
      await gate;
    }, pool);
  });

  await started;
  const overflowPool = receiptPool();
  await assert.rejects(
    processTelegramUpdateWithReceipt(update(999), async () => {}, overflowPool),
    TelegramIntakeCapacityError,
  );
  assert.equal(overflowPool.connects, 0);

  releaseHandlers();
  await Promise.all(active);
});

test('Telegram replay placeholders and row lookup are stable per update item', async () => {
  assert.equal(
    telegramReplayPlaceholder('501', 'batch:example grant'),
    'https://manual/needs-source/telegram-501-batch%3Aexample%20grant',
  );
  const calls = [];
  const db = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ id: 42 }] };
    },
  };
  assert.equal(await findTelegramReplayEntry(db, '501', 'single'), 42);
  assert.deepEqual(calls[0].params, ['501', 'single']);
  assert.match(calls[0].sql, /channel_item_key/);
});

test('intake metadata carries Telegram update and message lineage', () => {
  assert.deepEqual(buildIntakeMetadata({
    name: 'Example Grant',
    description: 'Example',
    sourceUrl: 'https://example.org/grant',
    wire: 'oss',
    scanDate: '2026-07-11',
    submittedBy: 'telegram:394395765',
    scanSource: 'telegram',
    sourceNeedsVerification: false,
    operatorRoute: 'publish',
    channelMessageId: '77',
    channelUpdateId: '501',
    channelItemKey: 'single',
    forwardedFrom: 'Example Channel',
  }), {
    source_needs_verification: false,
    operator_route: 'publish',
    channel_message_id: '77',
    channel_update_id: '501',
    channel_item_key: 'single',
    forwarded_from: 'Example Channel',
  });
});
