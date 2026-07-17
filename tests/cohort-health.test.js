require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  checkCohortHealth,
  COHORT_HEALTH_STATE_KEY,
} = require('../src/jobs/cohort-health');

const HOUR = 60 * 60 * 1000;

function fakeState(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    deps: {
      async getAppState(key) { return store.has(key) ? store.get(key) : null; },
      async setAppState(key, value) { store.set(key, value); },
    },
  };
}

function fakePool(rows) {
  return {
    calls: [],
    async query(sql, params) {
      this.calls.push({ sql, params });
      return { rows };
    },
  };
}

function run(runId, finishedAt, status = 'ok') {
  return {
    run_id: runId,
    status,
    started_at: new Date(Date.parse(finishedAt) - 1000),
    finished_at: status === 'ok' ? new Date(finishedAt) : null,
  };
}

test('fresh daily heartbeat persists a successful high-water mark', async () => {
  const now = new Date('2026-07-17T13:00:00Z');
  const pool = fakePool([
    run('claude-cohort-2026-07-17T120100Z', '2026-07-17T12:01:00Z'),
    run('claude-cohort-2026-07-16T120100Z', '2026-07-16T12:01:00Z'),
  ]);
  const { deps, store } = fakeState();

  const result = await checkCohortHealth(pool, deps, now);

  assert.deepEqual(result.lane, { key: 'cohort', state: 'ok', detail: 'cohort ✓' });
  assert.deepEqual(result.anomalies, []);
  const saved = store.get(COHORT_HEALTH_STATE_KEY);
  assert.equal(saved.lastSuccessfulRunId, 'claude-cohort-2026-07-17T120100Z');
  assert.equal(saved.lastSuccessfulFinishedAt, '2026-07-17T12:01:00.000Z');
  assert.equal(saved.pendingBackfillFrom, undefined);
  assert.equal(saved.historyInitialized, true);
  assert.deepEqual(pool.calls[0].params, ['claude-cohort-notion']);
});

test('stale heartbeat opens a durable backfill cursor and raises an anomaly', async () => {
  const now = new Date('2026-07-17T20:00:00Z');
  const finishedAt = new Date(now.getTime() - 31 * HOUR).toISOString();
  const pool = fakePool([run('claude-cohort-old', finishedAt)]);
  const { deps, store } = fakeState();

  const result = await checkCohortHealth(pool, deps, now);

  assert.equal(result.lane.state, 'fail');
  assert.equal(result.backfillFrom, finishedAt);
  assert.match(result.anomalies[0], /31h old/);
  assert.equal(store.get(COHORT_HEALTH_STATE_KEY).pendingBackfillFrom, finishedAt);
});

test('historical missed windows are detected on first deployment', async () => {
  const now = new Date('2026-07-17T13:00:00Z');
  const pool = fakePool([
    run('claude-cohort-2026-07-17', '2026-07-17T12:01:00Z'),
    run('claude-cohort-2026-07-16', '2026-07-16T12:01:00Z'),
    run('claude-cohort-2026-07-15', '2026-07-15T12:01:00Z'),
    run('claude-cohort-2026-07-14', '2026-07-14T12:01:00Z'),
    run('claude-cohort-2026-07-13', '2026-07-13T12:01:00Z'),
    run('claude-cohort-2026-07-12', '2026-07-12T12:01:00Z'),
    run('claude-cohort-2026-07-11', '2026-07-11T12:01:00Z'),
    run('claude-cohort-2026-07-10', '2026-07-10T12:01:00Z'),
    run('claude-cohort-2026-07-02', '2026-07-02T12:01:00Z'),
  ]);
  const { deps, store } = fakeState();

  const result = await checkCohortHealth(pool, deps, now);

  assert.equal(result.lane.detail, 'cohort replay pending');
  assert.equal(result.backfillFrom, '2026-07-02T12:01:00.000Z');
  assert.match(result.anomalies[0], /replay remains pending/);
  assert.equal(store.get(COHORT_HEALTH_STATE_KEY).pendingBackfillFrom, '2026-07-02T12:01:00.000Z');
});

test('a successful replay run clears the pending cursor', async () => {
  const now = new Date('2026-07-17T13:00:00Z');
  const { deps, store } = fakeState({
    [COHORT_HEALTH_STATE_KEY]: {
      lastSuccessfulRunId: 'claude-cohort-2026-07-16',
      lastSuccessfulFinishedAt: '2026-07-16T12:01:00.000Z',
      lastCheckedAt: '2026-07-16T13:00:00.000Z',
      pendingBackfillFrom: '2026-07-02T12:01:00.000Z',
      pendingSince: '2026-07-16T13:00:00.000Z',
    },
  });
  const pool = fakePool([
    run('claude-cohort-backfill-2026-07-17', '2026-07-17T12:05:00Z'),
    run('claude-cohort-2026-07-17', '2026-07-17T12:01:00Z'),
  ]);

  const result = await checkCohortHealth(pool, deps, now);

  assert.equal(result.lane.state, 'ok');
  assert.equal(result.backfillFrom, null);
  assert.equal(store.get(COHORT_HEALTH_STATE_KEY).pendingBackfillFrom, undefined);
});

test('state write failure is an alert because the cursor is not durable', async () => {
  const now = new Date('2026-07-17T13:00:00Z');
  const pool = fakePool([run('claude-cohort-2026-07-17', '2026-07-17T12:01:00Z')]);
  const deps = {
    async getAppState() { return null; },
    async setAppState() { throw new Error('db write failed'); },
  };

  const result = await checkCohortHealth(pool, deps, now);

  assert.equal(result.lane.detail, 'cohort cursor not durable');
  assert.match(result.anomalies[0], /failed to persist/);
});
