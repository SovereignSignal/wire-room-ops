require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseNotionScanPage,
  mapCohortWire,
  shouldPromoteRow,
  routingForRow,
  dedupeKeyForRow,
  buildCohortRunId,
  selectCohortSince,
  rowIsInWindow,
  runCohortBridge,
  COHORT_SEEN_STATE_KEY,
  COHORT_TRACK,
} = require('../src/jobs/cohort-bridge');
const { COHORT_HEALTH_STATE_KEY, COHORT_SOURCE_NAME } = require('../src/jobs/cohort-health');

function page(overrides = {}) {
  const properties = {
    Name: { title: [{ plain_text: 'SSI Fellowship Programme 2027' }] },
    Wire: { select: { name: 'OSS' } },
    Section: { select: { name: 'Verified' } },
    'Primary URL': { url: 'https://www.software.ac.uk/news/ssi-fellowship-programme-2027-applications-open-10-august' },
    Summary: { rich_text: [{ plain_text: 'About 20 research software fellows. Applications close October 5.' }] },
    'Date Found': { date: { start: '2026-08-18' } },
    Deadline: { date: { start: '2026-10-05' } },
    'Source Date': { date: { start: '2026-08-10' } },
    ...overrides.properties,
  };
  return {
    id: overrides.id || 'page-ssi',
    created_time: overrides.created_time || '2026-08-18T16:00:00.000Z',
    properties,
  };
}

function fakeState(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async getAppState(key) { return store.has(key) ? store.get(key) : null; },
    async setAppState(key, value) { store.set(key, value); },
  };
}

function fakePool() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/INSERT INTO opportunity_observations/i.test(sql)) return { rowCount: 1, rows: [{ id: 1 }] };
      if (/INSERT INTO source_runs/i.test(sql)) return { rowCount: 1, rows: [{ id: 1 }] };
      return { rowCount: 0, rows: [] };
    },
  };
}

test('mapCohortWire normalizes producer labels', () => {
  assert.equal(mapCohortWire('OSS'), 'oss');
  assert.equal(mapCohortWire('AI'), 'ai');
  assert.equal(mapCohortWire('Crypto'), 'crypto');
  assert.equal(mapCohortWire('Other'), null);
});

test('parseNotionScanPage reads the Cowork + Codex table shape', () => {
  const row = parseNotionScanPage(page());
  assert.equal(row.name, 'SSI Fellowship Programme 2027');
  assert.equal(row.wire, 'oss');
  assert.equal(row.section, 'Verified');
  assert.match(row.url, /software\.ac\.uk/);
  assert.equal(row.deadline, '2026-10-05');
  assert.equal(row.dateFound, '2026-08-18');
});

test('parseNotionScanPage drops untitled pages', () => {
  assert.equal(parseNotionScanPage(page({ properties: { Name: { title: [] } } })), null);
});

test('shouldPromoteRow skips unmarked Deferred and URL-less rows', () => {
  const ok = parseNotionScanPage(page());
  assert.equal(shouldPromoteRow(ok), true);
  const deferred = parseNotionScanPage(page({ properties: { Section: { select: { name: 'Deferred' } } } }));
  assert.equal(shouldPromoteRow(deferred), false);
  const noUrl = parseNotionScanPage(page({ properties: { 'Primary URL': { url: null } } }));
  assert.equal(shouldPromoteRow(noUrl), false);
});

test('shouldPromoteRow admits explicit review candidates while retaining source checks', () => {
  const candidate = parseNotionScanPage(page({ properties: {
    Section: { select: { name: ' Deferred ' } },
    Summary: { rich_text: [{ plain_text: '  NEEDS REVIEW: Eligibility and deadline unresolved.' }] },
  } }));
  assert.equal(shouldPromoteRow(candidate), true);
  assert.equal(shouldPromoteRow({ ...candidate, summary: 'Maybe this needs review: parked.' }), false);
  assert.equal(shouldPromoteRow({ ...candidate, url: '' }), false);
  assert.equal(shouldPromoteRow({ ...candidate, url: 'not-a-url' }), false);
  assert.equal(shouldPromoteRow({ ...candidate, wire: null }), false);
  assert.equal(shouldPromoteRow({ ...candidate, name: ' ' }), false);
});

test('routingForRow keeps unpromoted Deferred on the landscape lane', () => {
  const deferred = parseNotionScanPage(page({ properties: { Section: { select: { name: 'Deferred' } } } }));
  assert.equal(routingForRow(deferred, false), 'raw_only');
  assert.equal(routingForRow({ ...deferred, summary: 'Needs review: Check eligibility.' }, true), 'wire_queue_candidate');
  const verified = parseNotionScanPage(page());
  assert.equal(routingForRow(verified, true), 'wire_queue_candidate');
});

test('runCohortBridge sends review candidates through normal intake once with caveats intact', async () => {
  const now = new Date('2026-08-20T14:15:30Z');
  const pool = fakePool();
  const state = fakeState();
  const summary = 'Needs review: Funding proposal; approval and applicant route unresolved.';
  const candidate = page({
    id: 'page-review',
    created_time: '2026-08-20T12:00:00Z',
    properties: {
      Section: { select: { name: 'Deferred' } },
      Summary: { rich_text: [{ plain_text: summary }] },
      Deadline: { date: null },
    },
  });
  const submissions = [];
  const deps = {
    getAppState: state.getAppState,
    setAppState: state.setAppState,
    async getCredentials() { return { token: 'ntn', databaseId: 'db' }; },
    async queryPages() { return [candidate, { ...candidate, id: 'same-source' }]; },
    isEnabled: () => true,
    async runIntake(p, input) {
      submissions.push(input);
      return { runDate: '2026-08-20', wire: 'oss', totalIngested: 1, duplicatesFound: 0,
        newUnique: 1, averageQualityScore: 0, highQualityCount: 0, byPrompt: {}, topFinds: [] };
    },
  };

  const first = await runCohortBridge(pool, { now }, deps);
  assert.equal(first.promoted, 1);
  assert.equal(first.observations, 1);
  const raw = submissions[0][0].results[0];
  assert.equal(raw.description, summary);
  assert.equal(raw.deadline, null);
  assert.equal(raw.metadata.cohort_bridge.section, 'Deferred');
  assert.equal(raw.metadata.cohort_bridge.notion_page_id, 'page-review');
  const observation = pool.calls.find(c => /INSERT INTO opportunity_observations/i.test(c.sql));
  assert.equal(observation.params[7], summary);
  assert.equal(observation.params[11], 'Deferred');
  assert.equal(observation.params[12], 'wire_queue_candidate');

  const again = await runCohortBridge(pool, { now: new Date('2026-08-20T14:16:30Z') }, deps);
  assert.equal(again.promoted, 0);
  assert.equal(again.observations, 0);
  assert.equal(submissions.length, 1);
});

test('dedupeKeyForRow prefers the normalized URL', () => {
  const row = parseNotionScanPage(page());
  assert.match(dedupeKeyForRow(row), /^https:\/\/www\.software\.ac\.uk\//);
});

test('buildCohortRunId stamps backfill into recovery runs', () => {
  const now = new Date('2026-08-20T14:15:30.483Z');
  assert.equal(buildCohortRunId(now, false), 'claude-cohort-2026-08-20T141530Z');
  assert.equal(buildCohortRunId(now, true), 'claude-cohort-backfill-2026-08-20T141530Z');
});

test('selectCohortSince prefers the pending replay cursor', () => {
  const now = new Date('2026-08-20T14:15:30Z');
  assert.equal(
    selectCohortSince({ pendingBackfillFrom: '2026-08-17T12:01:28.483Z', lastSuccessfulFinishedAt: '2026-08-19T12:00:00Z', now }),
    '2026-08-17T12:01:28.483Z',
  );
  assert.equal(
    selectCohortSince({ lastSuccessfulFinishedAt: '2026-08-19T12:01:00.000Z', now }),
    '2026-08-19T12:01:00.000Z',
  );
  assert.equal(
    selectCohortSince({ now, fallbackMs: 36 * 60 * 60 * 1000 }),
    '2026-08-19T02:15:30.000Z',
  );
});

test('rowIsInWindow includes date-only Date Found on the cursor day', () => {
  const row = parseNotionScanPage(page());
  assert.equal(rowIsInWindow(row, '2026-08-17T12:01:28.483Z'), true);
  assert.equal(rowIsInWindow(row, '2026-08-19T00:00:00.000Z'), false);
});

test('runCohortBridge writes a backfill heartbeat and promotes Verified rows', async () => {
  const now = new Date('2026-08-20T14:15:30Z');
  const pool = fakePool();
  const state = fakeState({
    [COHORT_HEALTH_STATE_KEY]: {
      lastSuccessfulRunId: 'claude-cohort-2026-08-17T120125Z',
      lastSuccessfulFinishedAt: '2026-08-17T12:01:28.483Z',
      lastCheckedAt: '2026-08-20T13:45:00.000Z',
      pendingBackfillFrom: '2026-08-17T12:01:28.483Z',
      pendingSince: '2026-08-18T13:45:00.000Z',
      historyInitialized: true,
    },
  });
  const intakeCalls = [];
  const pages = [
    page(),
    page({
      id: 'page-deferred',
      properties: {
        Name: { title: [{ plain_text: 'Noise Item' }] },
        Wire: { select: { name: 'AI' } },
        Section: { select: { name: 'Deferred' } },
        'Primary URL': { url: 'https://example.com/deferred-program' },
        Summary: { rich_text: [{ plain_text: 'parked' }] },
        'Date Found': { date: { start: '2026-08-19' } },
      },
    }),
  ];

  const result = await runCohortBridge(pool, { now }, {
    getAppState: state.getAppState,
    setAppState: state.setAppState,
    async getCredentials() { return { token: 'ntn', databaseId: 'db' }; },
    async queryPages() { return pages; },
    isEnabled: () => true,
    async runIntake(p, submissions) {
      intakeCalls.push(submissions);
      return {
        runDate: '2026-08-20', wire: 'oss', totalIngested: 1, duplicatesFound: 0, newUnique: 1,
        averageQualityScore: 80, highQualityCount: 1, byPrompt: {}, topFinds: [],
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.isBackfill, true);
  assert.equal(result.runId, 'claude-cohort-backfill-2026-08-20T141530Z');
  assert.equal(result.fetched, 2);
  assert.equal(result.promoted, 1);
  assert.equal(intakeCalls.length, 1);
  assert.equal(intakeCalls[0][0].source, 'claude-cohort-notion');
  assert.equal(intakeCalls[0][0].wire, 'oss');
  assert.equal(intakeCalls[0][0].results[0].name, 'SSI Fellowship Programme 2027');

  const sourceRun = pool.calls.find(c => /INSERT INTO source_runs/i.test(c.sql));
  assert.ok(sourceRun);
  assert.equal(sourceRun.params[0], 'claude-cohort-backfill-2026-08-20T141530Z');
  assert.equal(sourceRun.params[1], COHORT_TRACK);
  assert.equal(sourceRun.params[2], COHORT_SOURCE_NAME);
  assert.equal(sourceRun.params[5], 'ok');

  const observationSql = pool.calls.filter(c => /INSERT INTO opportunity_observations/i.test(c.sql));
  assert.equal(observationSql.length, 2);
  assert.equal(observationSql[0].params[12], 'wire_queue_candidate');
  assert.equal(observationSql[1].params[12], 'raw_only');

  const seen = state.store.get(COHORT_SEEN_STATE_KEY);
  assert.ok(seen.urls.some(u => u.includes('software.ac.uk')));
});

test('runCohortBridge records an error heartbeat when Notion is unreachable', async () => {
  const now = new Date('2026-08-20T14:15:30Z');
  const pool = fakePool();
  const state = fakeState();

  const result = await runCohortBridge(pool, { now }, {
    getAppState: state.getAppState,
    setAppState: state.setAppState,
    async getCredentials() { return { token: 'ntn', databaseId: 'db' }; },
    async queryPages() { throw new Error('Notion API 404: object_not_found'); },
    isEnabled: () => true,
    async runIntake() { throw new Error('intake should not run'); },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /object_not_found/);
  const sourceRun = pool.calls.find(c => /INSERT INTO source_runs/i.test(c.sql));
  assert.equal(sourceRun.params[5], 'error');
  assert.match(sourceRun.params[8], /object_not_found/);
});

test('runCohortBridge dry-run does not write source_runs or intake', async () => {
  const now = new Date('2026-08-20T14:15:30Z');
  const pool = fakePool();
  const state = fakeState();
  let intakeCalled = false;

  const result = await runCohortBridge(pool, { now, dryRun: true }, {
    getAppState: state.getAppState,
    setAppState: state.setAppState,
    async getCredentials() { return { token: 'ntn', databaseId: 'db' }; },
    async queryPages() {
      return [page({
        properties: {
          'Date Found': { date: { start: '2026-08-20' } },
          Section: { select: { name: 'Deferred' } },
          Summary: { rich_text: [{ plain_text: 'Needs review: Check applicant route.' }] },
        },
        created_time: '2026-08-20T12:00:00.000Z',
      })];
    },
    isEnabled: () => true,
    async runIntake() { intakeCalled = true; throw new Error('nope'); },
  });

  assert.equal(result.ok, true);
  assert.equal(result.promoted, 1);
  assert.equal(intakeCalled, false);
  assert.equal(pool.calls.length, 0);
  assert.equal(state.store.has(COHORT_SEEN_STATE_KEY), false);
});

test('runCohortBridge no-ops when the lane is disabled', async () => {
  const pool = fakePool();
  const result = await runCohortBridge(pool, { now: new Date('2026-08-20T14:15:30Z') }, {
    async getAppState() { throw new Error('should not read state'); },
    async setAppState() { throw new Error('should not write state'); },
    async getCredentials() { throw new Error('should not read credentials'); },
    async queryPages() { throw new Error('should not query'); },
    async runIntake() { throw new Error('should not intake'); },
    isEnabled: () => false,
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'disabled');
  assert.equal(result.ok, true);
  assert.equal(pool.calls.length, 0);
});
