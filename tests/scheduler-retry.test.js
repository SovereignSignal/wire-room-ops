require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const cron = require('node-cron');
const scheduler = require('../src/services/scheduler');
const locks = require('../src/services/scheduled-job-lock');
const scan = require('../src/jobs/scan-execution');

async function fixture(t, id, run) {
  let execute;
  const timers = new Set();
  const health = [];
  const claims = [];
  const releases = [];
  let enabled = true;
  let checkError;
  let claimError;
  let lastClaim;
  const pool = { query: async () => { throw new Error('enabled check must use the claimed client'); } };
  t.mock.method(db, 'getPool', () => pool);
  t.mock.method(db, 'createSchedule', async data => ({ ...data, id }));
  t.mock.method(db, 'setAppState', async (key, value) => { health.push({ key, ...value }); });
  t.mock.method(locks, 'acquireScheduledJobLock', async (receivedPool, scheduleId, occurrence, attempt) => {
    assert.equal(receivedPool, pool);
    assert.equal(scheduleId, id);
    const claim = { occurrence: occurrence.toISOString(), attempt };
    claims.push(claim);
    if (claimError) throw claimError;
    if (lastClaim && (claim.occurrence < lastClaim.occurrence ||
      (claim.occurrence === lastClaim.occurrence && claim.attempt <= lastClaim.attempt))) return null;
    if (attempt === 1 && (!lastClaim || claim.occurrence !== lastClaim.occurrence || lastClaim.attempt !== 0)) return null;
    lastClaim = claim;
    return {
      client: { query: async () => {
        if (checkError) throw checkError;
        return { rows: [{ enabled }] };
      } },
      release: async () => { releases.push(claim); },
    };
  });
  const stub = (_cron, callback) => { execute = callback; return { start() {}, stop() {} }; };
  t.mock.method(cron, 'schedule', stub);
  if (cron.default) t.mock.method(cron.default, 'schedule', stub);
  t.mock.method(scan, 'runScanExecution', run);
  t.mock.method(require('../src/services/email'), 'sendScheduledJobFailureEmail', async () => {});
  await scheduler.addSchedule({ enabled: true, name: 'Scheduler fixture', scheduleType: 'scan-execution' });
  const realTimeout = global.setTimeout;
  t.mock.method(global, 'setTimeout', (callback, ms, ...args) => {
    if (ms !== 300000) return realTimeout(callback, ms, ...args);
    const timer = { callback, unref() {} }; timers.add(timer); return timer;
  });
  t.mock.method(global, 'clearTimeout', timer => timers.delete(timer));
  t.after(() => scheduler.stopScheduler());
  return {
    execute: date => execute({ date }), timers, health, claims, releases,
    setEnabled: value => { enabled = value; },
    failCheck: error => { checkError = error; },
    failClaim: error => { claimError = error; },
  };
}

async function settleUntil(predicate) {
  for (let i = 0; i < 30 && !predicate(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(predicate(), 'asynchronous retry settled');
}

test('one occurrence retries once, keeps its original occurrence, and a later occurrence resets the allowance', async t => {
  let attempts = 0;
  const f = await fixture(t, 'retry-fixture', async () => { attempts++; throw new Error('temporary upstream failure'); });
  const occurrence = new Date('2026-10-16T15:00:00.000Z');
  await f.execute(occurrence);
  assert.equal(attempts, 1);
  assert.equal(f.timers.size, 1);
  assert.equal(f.releases.length, 1);
  // A duplicate callback must not cancel the original occurrence's retry.
  await f.execute(occurrence);
  assert.equal(attempts, 1);
  assert.equal(f.health.length, 1);
  assert.equal(f.timers.size, 1);
  const timer = [...f.timers][0];
  f.timers.delete(timer);
  timer.callback();
  await settleUntil(() => f.health.length === 2 && f.releases.length === 2);
  assert.equal(attempts, 2);
  assert.equal(f.timers.size, 0);
  assert.equal(f.health[1].retried, true);
  assert.equal(f.health[1].status, 'failed');
  assert.equal(typeof f.health[1].durationMs, 'number');
  assert.deepEqual(f.claims.at(-1), { occurrence: occurrence.toISOString(), attempt: 1 });
  await f.execute(occurrence);
  assert.equal(attempts, 2);
  assert.equal(f.health.length, 2);
  await f.execute(new Date('2026-10-17T15:00:00.000Z'));
  assert.equal(attempts, 3);
  assert.equal(f.timers.size, 1);
  assert.equal(f.claims.at(-1).attempt, 0);
  scheduler.stopScheduler();
  assert.equal(f.timers.size, 0);
});

test('duplicate and disabled callbacks do no work, preserve health, and release only acquired locks', async t => {
  let attempts = 0;
  const f = await fixture(t, 'skip-fixture', async () => {
    attempts++;
    return { partial: false, promptsExecuted: 0, totalResults: 0, intakeSummary: { newUnique: 0 } };
  });
  const occurrence = new Date('2026-10-16T15:00:00.000Z');
  await f.execute(occurrence);
  assert.equal(attempts, 1);
  assert.equal(f.health.length, 1);
  assert.equal(f.health[0].status, 'success');
  const health = structuredClone(f.health);
  await f.execute(occurrence);
  assert.equal(attempts, 1);
  assert.deepEqual(f.health, health);
  assert.equal(f.releases.length, 1);
  f.setEnabled(false);
  await f.execute(new Date('2026-10-17T15:00:00.000Z'));
  assert.equal(attempts, 1);
  assert.deepEqual(f.health, health);
  assert.equal(f.releases.length, 2);
  assert.equal(f.timers.size, 0);
});

test('failed claim or enabled check fails closed without overwriting run health or scheduling a retry', async t => {
  let attempts = 0;
  const f = await fixture(t, 'database-error-fixture', async () => { attempts++; });
  f.failClaim(new Error('database unavailable'));
  await f.execute(new Date('2026-10-16T15:00:00.000Z'));
  assert.equal(attempts, 0);
  assert.equal(f.health.length, 0);
  assert.equal(f.releases.length, 0);
  assert.equal(f.timers.size, 0);
  f.failClaim(undefined);
  f.failCheck(new Error('enabled read failed'));
  await f.execute(new Date('2026-10-17T15:00:00.000Z'));
  assert.equal(attempts, 0);
  assert.equal(f.health.length, 0);
  assert.equal(f.releases.length, 1);
  assert.equal(f.timers.size, 0);
});
