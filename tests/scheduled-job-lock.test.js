require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { acquireScheduledJobLock } = require('../src/services/scheduled-job-lock');

const occurrence = new Date('2026-10-16T15:00:37.123Z');
const tick = '2026-10-16T15:00:00.000Z';

function fixture(options = {}) {
  const client = new EventEmitter();
  const calls = [];
  const releases = [];
  let connections = 0;
  let state = options.previous;
  client.query = async (sql, values) => {
    calls.push({ sql, values });
    if (/pg_try_advisory_lock/.test(sql)) {
      if (options.lockError) throw options.lockError;
      return { rows: [{ acquired: options.acquired ?? true }] };
    }
    if (/pg_advisory_unlock/.test(sql)) {
      if (options.unlockError) throw options.unlockError;
      return { rows: [{ unlocked: options.unlocked ?? true }] };
    }
    if (/SELECT value FROM app_state/.test(sql)) {
      if (options.readError) throw options.readError;
      return { rows: state === undefined ? [] : [{ value: state }] };
    }
    if (/INSERT INTO app_state/.test(sql)) {
      if (options.writeError) throw options.writeError;
      state = JSON.parse(values[1]);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  client.release = destroy => { releases.push(destroy); };
  const pool = { connect: async () => { connections++; return client; } };
  return { pool, client, calls, releases, state: () => state, connections: () => connections };
}

test('claim pins a client until idempotent release and normalizes the cron occurrence to its minute', async () => {
  const f = fixture();
  const lock = await acquireScheduledJobLock(f.pool, 'digest', occurrence, 0);
  assert.ok(lock);
  assert.equal(lock.client, f.client);
  assert.equal(f.connections(), 1);
  assert.equal(f.client.listenerCount('error'), 1);
  assert.deepEqual(f.releases, []);
  assert.deepEqual(f.state(), { occurrence: tick, attempt: 0 });
  for (const call of f.calls) assert.equal(call.values[0], 'scheduler:claim:digest');
  await lock.release();
  await lock.release();
  assert.deepEqual(f.releases, [false]);
  assert.equal(f.calls.filter(call => /pg_advisory_unlock/.test(call.sql)).length, 1);
  assert.equal(f.client.listenerCount('error'), 0);
});

test('contention releases its session without reading or updating the occurrence claim', async () => {
  const f = fixture({ acquired: false });
  assert.equal(await acquireScheduledJobLock(f.pool, 'digest', occurrence, 0), null);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.releases, [false]);
  assert.equal(f.client.listenerCount('error'), 0);
});

test('already claimed and stale occurrences unlock without replacing the durable receipt', async t => {
  const cases = [
    [{ occurrence: tick, attempt: 0 }, 0],
    [{ occurrence: tick, attempt: 1 }, 0],
    [{ occurrence: tick, attempt: 1 }, 1],
    [{ occurrence: '2026-10-17T15:00:00.000Z', attempt: 0 }, 0],
  ];
  for (const [previous, attempt] of cases) {
    await t.test(`${previous.occurrence} attempt ${previous.attempt} rejects incoming attempt ${attempt}`, async () => {
      const f = fixture({ previous });
      assert.equal(await acquireScheduledJobLock(f.pool, 'digest', occurrence, attempt), null);
      assert.deepEqual(f.state(), previous);
      assert.equal(f.calls.filter(call => /INSERT/.test(call.sql)).length, 0);
      assert.equal(f.calls.filter(call => /pg_advisory_unlock/.test(call.sql)).length, 1);
      assert.deepEqual(f.releases, [false]);
    });
  }
});

test('a retry needs the matching initial attempt and cannot create a new occurrence', async t => {
  for (const previous of [undefined, { occurrence: '2026-10-15T15:00:00.000Z', attempt: 0 }]) {
    await t.test(previous ? 'different occurrence' : 'no original attempt', async () => {
      const f = fixture({ previous });
      assert.equal(await acquireScheduledJobLock(f.pool, 'digest', occurrence, 1), null);
      assert.deepEqual(f.state(), previous);
      assert.equal(f.calls.filter(call => /INSERT/.test(call.sql)).length, 0);
      assert.deepEqual(f.releases, [false]);
    });
  }
});

test('failed acquisition or receipt queries fail closed and destroy the pinned client', async t => {
  for (const failure of ['lockError', 'readError', 'writeError']) {
    await t.test(failure, async () => {
      const error = new Error(`${failure} fixture`);
      const f = fixture({ [failure]: error });
      await assert.rejects(acquireScheduledJobLock(f.pool, 'digest', occurrence, 0), thrown => thrown === error);
      assert.deepEqual(f.releases, [true]);
      assert.equal(f.client.listenerCount('error'), 0);
    });
  }
});

test('invalid durable claims fail closed instead of silently starting a second run', async t => {
  for (const previous of [{ occurrence: 'not a date', attempt: 0 }, { occurrence: tick, attempt: 2 }, 'corrupt']) {
    await t.test(JSON.stringify(previous), async () => {
      const f = fixture({ previous });
      await assert.rejects(acquireScheduledJobLock(f.pool, 'digest', occurrence, 0), /Invalid stored scheduled job claim/);
      assert.equal(f.calls.filter(call => /INSERT/.test(call.sql)).length, 0);
      assert.deepEqual(f.releases, [true]);
    });
  }
});

test('unlock failures destroy the client and cannot release it to the pool twice', async t => {
  for (const options of [{ unlockError: new Error('unlock failed') }, { unlocked: false }]) {
    await t.test(options.unlockError ? 'query failed' : 'ownership lost', async () => {
      const f = fixture(options);
      const lock = await acquireScheduledJobLock(f.pool, 'digest', occurrence, 0);
      await assert.rejects(lock.release(), options.unlockError ? /unlock failed/ : /lock was lost/);
      await lock.release();
      assert.deepEqual(f.releases, [true]);
      assert.equal(f.client.listenerCount('error'), 0);
    });
  }
});

test('a session error while work is running forces destruction during release', async () => {
  const f = fixture();
  const lock = await acquireScheduledJobLock(f.pool, 'digest', occurrence, 0);
  const error = new Error('connection terminated');
  f.client.emit('error', error);
  await assert.rejects(lock.release(), thrown => thrown === error);
  await lock.release();
  assert.deepEqual(f.releases, [true]);
  assert.equal(f.calls.filter(call => /pg_advisory_unlock/.test(call.sql)).length, 0);
  assert.equal(f.client.listenerCount('error'), 0);
});

test('invalid claim inputs never acquire a database connection', async () => {
  const f = fixture();
  for (const [id, date, attempt] of [['', occurrence, 0], ['digest', new Date(NaN), 0], ['digest', occurrence, 2]]) {
    await assert.rejects(acquireScheduledJobLock(f.pool, id, date, attempt), /Invalid scheduled job claim/);
  }
  assert.equal(f.connections(), 0);
});
