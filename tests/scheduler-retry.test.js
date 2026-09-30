require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const cron = require('node-cron');
const scheduler = require('../src/services/scheduler');
const scan = require('../src/jobs/scan-execution');

test('one occurrence retries once, persists health, and a new occurrence resets the allowance', async (t) => {
  let execute, attempts = 0;
  const timers = new Set();
  const health = [];
  t.mock.method(db, 'getPool', () => ({ query: async () => ({ rows: [{ enabled: true }] }) }));
  t.mock.method(db, 'createSchedule', async data => ({ ...data, id: 'retry-fixture' }));
  t.mock.method(db, 'setAppState', async (key, value) => { health.push({ ...value }); });
  const stub = (_cron, callback) => { execute = callback; return { start() {}, stop() {} }; };
  t.mock.method(cron, 'schedule', stub);
  if (cron.default) t.mock.method(cron.default, 'schedule', stub);
  t.mock.method(scan, 'runScanExecution', async () => { attempts++; throw new Error('temporary upstream failure'); });
  t.mock.method(require('../src/services/email'), 'sendScheduledJobFailureEmail', async () => {});
  await scheduler.addSchedule({ enabled: true, name: 'Retry fixture', scheduleType: 'scan-execution' });
  const realTimeout = global.setTimeout;
  t.mock.method(global, 'setTimeout', (callback, ms, ...args) => {
    if (ms !== 300000) return realTimeout(callback, ms, ...args);
    const timer = { callback, unref() {} }; timers.add(timer); return timer;
  });
  t.mock.method(global, 'clearTimeout', timer => timers.delete(timer));
  try {
    await execute(); assert.equal(attempts, 1); assert.equal(timers.size, 1);
    const timer = [...timers][0]; timers.delete(timer); timer.callback();
    for (let i = 0; i < 30 && health.length < 2; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(attempts, 2); assert.equal(timers.size, 0);
    assert.equal(health[1].retried, true); assert.equal(health[1].status, 'failed');
    assert.equal(typeof health[1].durationMs, 'number');
    await execute(); assert.equal(attempts, 3); assert.equal(timers.size, 1);
    scheduler.stopScheduler(); assert.equal(timers.size, 0);
  } finally { scheduler.stopScheduler(); }
});
