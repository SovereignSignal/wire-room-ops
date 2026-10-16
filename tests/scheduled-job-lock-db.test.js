require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { acquireScheduledJobLock } = require('../src/services/scheduled-job-lock');

// Never connect this write-bearing test to a deployed database, including a
// remote URL accidentally supplied by the developer's shell or environment.
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol), 'PostgreSQL fixture URL required');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname), 'scheduler DB tests require a loopback host');
  assert.match(decodeURIComponent(parsed.pathname.slice(1)), /^wireops_(?:test|fixture)(?:_[a-z0-9_]+)?$/, 'scheduler DB tests require a dedicated fixture database');
  assert.equal(parsed.search, '', 'fixture connection options must not override the loopback host');
}

test('independent PostgreSQL sessions execute one occurrence once and keep one bounded retry', { skip: !databaseUrl }, async () => {
  const firstPool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5000, options: '-c statement_timeout=5000' });
  const secondPool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5000, options: '-c statement_timeout=5000' });
  const scheduleId = `scheduler-test-${randomUUID()}`;
  const otherId = `scheduler-test-${randomUUID()}`;
  const keys = [scheduleId, otherId].map(id => `scheduler:claim:${id}`);
  const occurrence = new Date('2026-10-16T15:00:00.000Z');
  const nextOccurrence = new Date('2026-10-17T15:00:00.000Z');
  const held = new Set();
  async function claim(pool, id, date, attempt) {
    const lock = await acquireScheduledJobLock(pool, id, date, attempt);
    if (lock) held.add(lock);
    return lock;
  }
  async function release(lock) {
    await lock.release();
    held.delete(lock);
  }
  try {
    const contenders = await Promise.all([
      claim(firstPool, scheduleId, occurrence, 0),
      claim(secondPool, scheduleId, occurrence, 0),
    ]);
    assert.equal(contenders.filter(Boolean).length, 1, 'only one process may execute the occurrence');
    const winner = contenders.find(Boolean);
    const losingPool = contenders[0] ? secondPool : firstPool;
    assert.equal(await claim(losingPool, scheduleId, nextOccurrence, 0), null, 'even a later occurrence cannot overlap the active execution');
    const independent = await claim(losingPool, otherId, occurrence, 0);
    assert.ok(independent, 'different schedules must not share the execution lock');
    await release(independent);
    await release(winner);
    assert.equal(await claim(firstPool, scheduleId, occurrence, 0), null, 'durable claim suppresses a duplicate after the lock is released');
    assert.equal(await claim(secondPool, scheduleId, new Date('2026-10-15T15:00:00.000Z'), 0), null, 'an old callback cannot replace a newer occurrence');
    assert.equal(await claim(firstPool, scheduleId, nextOccurrence, 1), null, 'retry requires a matching original occurrence');
    const retry = await claim(secondPool, scheduleId, occurrence, 1);
    assert.ok(retry, 'one retry is allowed for the original occurrence');
    await release(retry);
    assert.equal(await claim(firstPool, scheduleId, occurrence, 1), null, 'the same retry is never executed twice');
    assert.equal(await claim(secondPool, scheduleId, occurrence, 0), null, 'the initial attempt stays consumed after retry');
    const next = await claim(firstPool, scheduleId, nextOccurrence, 0);
    assert.ok(next, 'the next normal occurrence resets the attempt allowance');
    await release(next);
    const state = (await firstPool.query('SELECT value FROM app_state WHERE key = $1', [keys[0]])).rows[0].value;
    assert.deepEqual(state, { occurrence: nextOccurrence.toISOString(), attempt: 0 });
  } finally {
    const released = await Promise.allSettled([...held].map(lock => lock.release()));
    try { await firstPool.query('DELETE FROM app_state WHERE key = ANY($1::text[])', [keys]); }
    finally { await Promise.all([firstPool.end(), secondPool.end()]); }
    for (const result of released) if (result.status === 'rejected') throw result.reason;
  }
});
