// Scout ledger: schema version 14 (fresh and adopted), /api/scout writes,
// /api/read/scout-* reads, and the one-time copy script.
const crypto = require('node:crypto');

function sha(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const SCOUT = 'scout-ledger-claude-token';
const GROK = 'scout-ledger-grok-token';
const READER = 'scout-ledger-reader-token';
const baseUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/wireops_test';
const suffix = `${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
const databases = { main: `wro_scout_${suffix}`, adopt: `wro_scout_adopt_${suffix}`, source: `wro_scout_source_${suffix}` };
const urlFor = name => {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
};

process.env.DEV_MODE = 'false';
process.env.DATABASE_URL = urlFor(databases.main);
process.env.DB_SSL_REJECT_UNAUTHORIZED = 'false';
process.env.NOTIFICATION_EMAIL = 'ops@example.com';
process.env.PRIVY_APP_ID = 'test-app-id';
process.env.PRIVY_APP_SECRET = 'test-app-secret';
process.env.NODE_ENV = 'test';
process.env.INTERNAL_API_KEY = 'scout-ledger-internal-key';
const key = (id, name, token, scopes) => ({
  id, name, sha256: sha(token), scopes, expires_at: '2099-01-01T00:00:00.000Z', revoked: false,
});
process.env.WIRE_ROOM_CURATOR_KEYS = JSON.stringify([
  key('scout', 'grant-wire-scout', SCOUT, ['read_queue', 'propose', 'ledger']),
  key('grok', 'grant-wire-grok', GROK, ['ledger']),
  key('reader', 'Ops Reader', READER, ['read_queue']),
]);

require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const admin = new Pool({ connectionString: baseUrl });
const pools = {};
let server;
let origin;
let db;

// The shape grant-wire-scout's ledger.py and notify.py write to, before the funnel columns.
const LEGACY_DDL = `
  CREATE TABLE scout_runs (
    id SERIAL PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE,
    wire TEXT NOT NULL,
    variant TEXT,
    model TEXT,
    status TEXT NOT NULL,
    opportunity_count INTEGER,
    error_class TEXT,
    cost_usd NUMERIC(10,4),
    duration_ms INTEGER,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE scout_alerts (
    subject TEXT NOT NULL,
    body TEXT,
    channels_ok TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );`;

const LEDGER_PY_INSERT = `INSERT INTO scout_runs
    (run_id, wire, variant, model, status, opportunity_count, error_class, cost_usd, duration_ms, started_at, finished_at, created_at)
  VALUES ($1, $2, 'A', 'claude-opus', $3, $4, NULL, 1.25, 600000, $5, $5, $5)
  ON CONFLICT (run_id) DO UPDATE SET status = EXCLUDED.status, finished_at = now()`;

async function seedLegacy(pool, runs, alerts) {
  await pool.query(LEGACY_DDL);
  for (const [runId, wire, status, opps, at] of runs) await pool.query(LEDGER_PY_INSERT, [runId, wire, status, opps, at]);
  for (const [subject, channels, at] of alerts) {
    await pool.query('INSERT INTO scout_alerts (subject, body, channels_ok, created_at) VALUES ($1, $2, $3, $4)', [subject, `${subject} body`, channels, at]);
  }
}

const ago = hours => new Date(Date.now() - hours * 3600 * 1000);

test.before(async () => {
  for (const name of Object.values(databases)) await admin.query(`CREATE DATABASE ${name}`);
  pools.adopt = new Pool({ connectionString: urlFor(databases.adopt) });
  pools.source = new Pool({ connectionString: urlFor(databases.source) });
  db = require('../src/db');
  await require('../src/db/startup-migrations').migrateDatabase();
  const { app } = require('../src/server');
  server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (db) await db.closePool();
  for (const pool of Object.values(pools)) await pool.end();
  for (const name of Object.values(databases)) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
});

async function call(method, pathname, { token = SCOUT, body, headers = {} } = {}) {
  const res = await fetch(`${origin}${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body: json, headers: res.headers };
}

const putRun = (runId, body, opts = {}) => call('PUT', `/api/scout/runs/${encodeURIComponent(runId)}`, { body, ...opts });
const postAlert = (body, opts = {}) => call('POST', '/api/scout/alerts', { body, ...opts });

test('a fresh migration creates both tables with run_id unique and the runtime grants listed', async () => {
  const { rows } = await db.getPool().query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name IN ('scout_runs', 'scout_alerts')`,
  );
  const columns = table => rows.filter(r => r.table_name === table).map(r => r.column_name).sort();
  assert.deepEqual(columns('scout_runs'), [
    'cost_usd', 'created_at', 'dedup_dropped', 'duration_ms', 'error_class', 'finished_at', 'found_count',
    'model', 'opportunity_count', 'recorded_by', 'run_id', 'started_at', 'status', 'variant', 'wire',
  ]);
  assert.deepEqual(columns('scout_alerts'), ['body', 'channels_ok', 'created_at', 'id', 'idempotency_key', 'recorded_by', 'subject']);
  const grants = require('../src/db/runtime-grants');
  assert.ok(grants.RUNTIME_WRITABLE_TABLES.includes('scout_runs'));
  assert.ok(grants.RUNTIME_INSERT_ONLY_TABLES.includes('scout_alerts'), 'alerts are append-only for the app');
});

test('the migration adopts hand-made ledger tables in place and keeps their rows', async () => {
  const { applyScoutLedgerSchema } = require('../src/db/scout-ledger');
  await seedLegacy(pools.adopt, [
    ['claude-code-2026-10-20T041500Z', 'crypto', 'ok', 3, ago(72)],
    ['claude-code-2026-10-21T041500Z', '', 'timeout', null, ago(48)],
  ], [['Grant Wire Scout AUTH', 'resend', ago(30)], ['Grant Wire Scout QUOTA', 'none', ago(20)]]);

  const apply = async () => {
    const client = await pools.adopt.connect();
    try {
      await client.query('BEGIN');
      await applyScoutLedgerSchema(client);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  };
  await apply();
  await apply();

  const cols = async table => Object.fromEntries((await pools.adopt.query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table],
  )).rows.map(r => [r.column_name, r.data_type]));
  const runs = await cols('scout_runs');
  assert.equal(runs.found_count, 'integer');
  assert.equal(runs.dedup_dropped, 'integer');
  assert.equal(runs.recorded_by, 'text');
  assert.equal(runs.duration_ms, 'integer', 'an existing column keeps its type');
  assert.equal(runs.id, 'integer', 'columns this repo does not use are left alone');
  const alerts = await cols('scout_alerts');
  assert.equal(alerts.id, 'bigint');
  assert.equal(alerts.idempotency_key, 'text');

  const uniqueOnRunId = async () => (await pools.adopt.query(
    `SELECT count(*)::int AS n FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
     WHERE i.indrelid = 'scout_runs'::regclass AND i.indisunique AND i.indnkeyatts = 1 AND a.attname = 'run_id'`,
  )).rows[0].n;
  assert.equal(await uniqueOnRunId(), 1, 'no second unique index on run_id');

  assert.equal((await pools.adopt.query('SELECT count(*)::int AS n FROM scout_runs')).rows[0].n, 2);
  const legacyAlerts = (await pools.adopt.query('SELECT id, subject FROM scout_alerts ORDER BY id')).rows;
  assert.deepEqual(legacyAlerts.map(r => r.subject), ['Grant Wire Scout AUTH', 'Grant Wire Scout QUOTA']);
  assert.ok(legacyAlerts.every(r => Number(r.id) > 0), 'existing alerts get ids');

  // ledger.py keeps writing directly until the scout switches, and the API can then take the row over.
  await pools.adopt.query(LEDGER_PY_INSERT, ['claude-code-2026-10-22T041500Z', 'oss', 'ok', 2, ago(1)]);
  const { parseScoutRun, upsertScoutRun } = require('../src/services/scout-ledger');
  const taken = await upsertScoutRun(pools.adopt, parseScoutRun('claude-code-2026-10-21T041500Z', { status: 'ok', wire: 'ai', found_count: 4 }), 'agent:grant-wire-scout');
  assert.equal(taken.created, false);
  assert.equal(taken.run.wire, 'ai', 'an empty wire is filled in');
  assert.equal(taken.run.found_count, 4);
  assert.equal(taken.run.recorded_by, 'agent:grant-wire-scout');

  await pools.adopt.query('ALTER TABLE scout_runs DROP CONSTRAINT scout_runs_run_id_key');
  await apply();
  assert.equal(await uniqueOnRunId(), 1, 'a missing unique index on run_id is created');
});

test('ledger writes need a curator key with the ledger scope', async () => {
  const body = { status: 'ok', wire: 'crypto' };
  assert.equal((await putRun('claude-code-auth-check', body, { token: null })).status, 401);
  assert.equal((await putRun('claude-code-auth-check', body, { token: READER })).status, 403);
  assert.equal((await putRun('claude-code-auth-check', body, { token: 'not-a-key' })).status, 401);
  assert.equal((await putRun('claude-code-auth-check', body, { token: process.env.INTERNAL_API_KEY })).status, 401,
    'the internal master key does not open the ledger');
  assert.equal((await postAlert({ subject: 'x' }, { token: READER })).status, 403);
  assert.equal((await call('GET', '/api/scout/runs/claude-code-auth-check')).status, 403);
  assert.equal((await call('DELETE', '/api/scout/runs/claude-code-auth-check')).status, 403);

  const { requiredCuratorScope } = require('../src/services/curator-keys');
  assert.equal(requiredCuratorScope('PUT', '/api/scout/runs/claude-code-2026-10-23T041500Z'), 'ledger');
  assert.equal(requiredCuratorScope('POST', '/api/scout/alerts'), 'ledger');
  for (const [method, path] of [
    ['GET', '/api/scout/runs/x'], ['POST', '/api/scout/runs/x'], ['PUT', '/api/scout/runs/x/y'],
    ['PUT', '/api/scout/alerts'], ['GET', '/api/scout/alerts'], ['POST', '/api/scout'], ['POST', '/api/scan/submit-batch'],
  ]) {
    assert.equal(requiredCuratorScope(method, path), 'forbidden', `${method} ${path}`);
  }
  assert.equal(requiredCuratorScope('POST', '/api/scan/submit'), 'propose', 'ledger does not widen other doors');
});

test('PUT /api/scout/runs/:runId upserts by run id the way ledger.py does', async () => {
  const runId = 'claude-code-2026-10-23T041500Z';
  const started = ago(1).toISOString();
  const first = await putRun(runId, {
    status: 'timeout', wire: '', variant: 'A', model: 'claude-opus-4', error_class: 'TIMEOUT',
    started_at: started, duration_ms: 2_400_000,
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.created, true);
  assert.equal(first.body.run.run_id, runId);
  assert.equal(first.body.run.wire, '');
  assert.equal(first.body.run.recorded_by, 'agent:grant-wire-scout');
  assert.equal(first.body.run.duration_ms, 2_400_000);
  assert.equal(first.body.run.started_at, started);
  assert.ok(first.body.run.finished_at, 'finished_at defaults to now');

  const finished = new Date().toISOString();
  const second = await putRun(runId, {
    run_id: runId, status: 'ok', wire: 'oss', variant: 'B', opportunity_count: 2, found_count: 5, dedup_dropped: 3,
    cost_usd: 1.5, duration_ms: 1000, error_class: 'timeout-salvaged', started_at: finished, finished_at: finished,
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.created, false);
  const run = second.body.run;
  assert.equal(run.status, 'ok');
  assert.equal(run.wire, 'oss', 'an unknown wire is filled in');
  assert.equal(run.variant, 'A', 'a recorded variant is kept');
  assert.equal(run.started_at, started, 'the earliest start is kept');
  assert.equal(run.finished_at, finished);
  assert.deepEqual([run.opportunity_count, run.found_count, run.dedup_dropped, run.cost_usd], [2, 5, 3, 1.5]);

  const replay = await putRun(runId, {
    status: 'ok', wire: 'oss', opportunity_count: 2, found_count: 5, dedup_dropped: 3, cost_usd: 1.5,
    duration_ms: 1000, error_class: 'timeout-salvaged', finished_at: finished,
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body.run, run, 'a retried PUT leaves the row as it was');

  const other = await putRun(runId, { status: 'failed' }, { token: GROK });
  assert.equal(other.status, 409, 'another key cannot overwrite this run');
  const grok = await putRun('grok-build-2026-10-23T051500Z', { status: 'quota', wire: 'crypto' }, { token: GROK });
  assert.equal(grok.status, 201);
  assert.equal(grok.body.run.recorded_by, 'agent:grant-wire-grok');
});

test('PUT /api/scout/runs rejects malformed runs with 400', async () => {
  const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const cases = [
    ['claude-code-x', { wire: 'crypto' }],
    ['claude-code-x', { status: 'great' }],
    ['claude-code-x', { status: 'ok', wire: 'sports' }],
    ['claude-code-x', { status: 'ok', opportunity_count: -1 }],
    ['claude-code-x', { status: 'ok', found_count: 1.5 }],
    ['claude-code-x', { status: 'ok', duration_ms: '10' }],
    ['claude-code-x', { status: 'ok', cost_usd: 'free' }],
    ['claude-code-x', { status: 'ok', started_at: 'yesterday' }],
    ['claude-code-x', { status: 'ok', finished_at: future }],
    ['claude-code-x', { status: 'ok', started_at: ago(1).toISOString(), finished_at: ago(2).toISOString() }],
    ['claude-code-x', { status: 'ok', run_id: 'claude-code-y' }],
    ['claude-code-x', { status: 'ok', variant: 'A B' }],
    ['claude-code-x', { status: 'ok', error_class: 'has space' }],
    ['claude-code-x', { status: 'ok', extra: true }],
    ['claude-code-x', [{ status: 'ok' }]],
    ['-leading-dash', { status: 'ok' }],
    ['has space', { status: 'ok' }],
    ['x'.repeat(201), { status: 'ok' }],
  ];
  for (const [runId, body] of cases) {
    const res = await putRun(runId, body);
    assert.equal(res.status, 400, `${runId} ${JSON.stringify(body)}`);
    assert.equal(typeof res.body.error, 'string');
  }
  const { rows } = await db.getPool().query(`SELECT count(*)::int AS n FROM scout_runs WHERE run_id = 'claude-code-x'`);
  assert.equal(rows[0].n, 0);
});

test('POST /api/scout/alerts records alerts, and an Idempotency-Key makes retries safe', async () => {
  const plain = await postAlert({ subject: '⚠️ Grant Wire Scout AUTH', body: 'token rejected', channels_ok: 'resend' });
  assert.equal(plain.status, 201);
  assert.equal(plain.body.alert.subject, '⚠️ Grant Wire Scout AUTH');
  assert.equal(plain.body.alert.channels_ok, 'resend');
  assert.equal(plain.body.alert.recorded_by, 'agent:grant-wire-scout');
  const again = await postAlert({ subject: '⚠️ Grant Wire Scout AUTH', body: 'token rejected', channels_ok: 'resend' });
  assert.notEqual(again.body.alert.id, plain.body.alert.id, 'without a key every POST is a new alert');

  const headers = { 'Idempotency-Key': 'alert-0b5c9d2e-quota' };
  const first = await postAlert({ subject: 'QUOTA', body: 'cap hit' }, { headers });
  assert.equal(first.status, 201);
  assert.equal(first.body.alert.channels_ok, 'none', 'channels_ok defaults to none');
  const retry = await postAlert({ subject: 'QUOTA', body: 'cap hit' }, { headers });
  assert.equal(retry.status, 200);
  assert.equal(retry.headers.get('idempotent-replayed'), 'true');
  assert.equal(retry.body.alert.id, first.body.alert.id);
  assert.equal(retry.body.created, false);
  assert.equal((await postAlert({ subject: 'QUOTA', body: 'different' }, { headers })).status, 409);
  const otherKey = await postAlert({ subject: 'QUOTA', body: 'cap hit' }, { headers, token: GROK });
  assert.equal(otherKey.status, 201, 'idempotency keys are per scout key');

  const scrubbed = await postAlert({ subject: 'FAILED', body: 'psycopg2: postgresql://u:p@host:5432/db refused' });
  const stored = await db.getPool().query('SELECT body FROM scout_alerts WHERE id = $1', [scrubbed.body.alert.id]);
  assert.equal(stored.rows[0].body, 'psycopg2: postgresql://**** refused');

  for (const [body, opts] of [
    [{ body: 'no subject' }, {}],
    [{ subject: '   ' }, {}],
    [{ subject: 's'.repeat(501) }, {}],
    [{ subject: 'ok', body: 'b'.repeat(32_001) }, {}],
    [{ subject: 'ok', body: 7 }, {}],
    [{ subject: 'ok', channels_ok: 'Resend Email' }, {}],
    [{ subject: 'ok', severity: 'high' }, {}],
    [{ subject: 'ok' }, { headers: { 'Idempotency-Key': 'short' } }],
  ]) {
    assert.equal((await postAlert(body, opts)).status, 400, JSON.stringify(body));
  }
});

test('GET /api/read/scout-runs serves the heartbeat and digest reads', async () => {
  const pool = db.getPool();
  const insert = (runId, wire, status, opps, hoursAgo, cost = null) => pool.query(
    `INSERT INTO scout_runs (run_id, wire, variant, model, status, opportunity_count, cost_usd, created_at)
     VALUES ($1, $2, 'A', 'claude-opus-4', $3, $4, $5, $6)`,
    [runId, wire, status, opps, cost, ago(hoursAgo)],
  );
  await insert('claude-code-2026-10-01T041500Z', 'crypto', 'ok', 4, 20 * 24, 2.25);
  await insert('claude-code-2026-10-22T041500Z', 'ai', 'skipped', 0, 30);
  await insert('grok-build-2026-10-22T051500Z', 'ai', 'auth', 0, 29);
  await insert('manual-2026-10-22', 'oss', 'other', 0, 28);

  const window = await call('GET', '/api/read/scout-runs?hours=60&run_id_prefix=claude-code-,grok-build-', { token: READER });
  assert.equal(window.status, 200);
  assert.deepEqual(window.body.runs.map(r => r.run_id), [
    'claude-code-2026-10-22T041500Z', 'grok-build-2026-10-22T051500Z', 'claude-code-2026-10-23T041500Z', 'grok-build-2026-10-23T051500Z',
  ], 'oldest first, both lanes, nothing outside the prefixes');
  const row = window.body.runs[0];
  for (const field of ['wire', 'variant', 'model', 'status', 'opportunity_count', 'found_count', 'dedup_dropped',
    'error_class', 'cost_usd', 'duration_ms', 'started_at', 'finished_at', 'created_at', 'recorded_by']) {
    assert.ok(field in row, field);
  }
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T/);

  const trend = await call('GET', '/api/read/scout-runs?days=30&status=ok,skipped&run_id_prefix=claude-code-', { token: READER });
  assert.deepEqual(trend.body.runs.map(r => r.run_id), [
    'claude-code-2026-10-01T041500Z', 'claude-code-2026-10-22T041500Z', 'claude-code-2026-10-23T041500Z',
  ]);
  assert.equal(trend.body.runs[0].cost_usd, 2.25);

  const newest = await call('GET', '/api/read/scout-runs?days=31&wire=ai&order=newest&limit=1', { token: READER });
  assert.equal(newest.body.count, 1);
  assert.equal(newest.body.truncated, true);
  assert.equal(newest.body.runs[0].run_id, 'grok-build-2026-10-22T051500Z');

  assert.equal((await call('GET', '/api/read/scout-runs', { token: SCOUT })).status, 200, 'the scout key reads its own ledger');
  for (const query of ['status=great', 'run_id_prefix=claude%25', 'run_id_prefix=a%20b', 'wire=sports', 'order=random', 'limit=5001', 'days=401']) {
    assert.equal((await call('GET', `/api/read/scout-runs?${query}`, { token: READER })).status, 400, query);
  }
  assert.equal((await call('GET', '/api/read/scout-runs', { token: GROK })).status, 403, 'ledger alone does not read');
});

test('GET /api/read/scout-alerts lists alerts newest first with an id cursor', async () => {
  const pool = db.getPool();
  await pool.query(`INSERT INTO scout_alerts (subject, body, channels_ok, created_at) VALUES ('Old heartbeat', 'b', 'none', $1)`, [ago(10 * 24)]);

  const week = await call('GET', '/api/read/scout-alerts', { token: READER });
  assert.equal(week.status, 200);
  const ids = week.body.alerts.map(a => a.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
  assert.ok(!week.body.alerts.some(a => a.subject === 'Old heartbeat'), 'default window is 7 days');
  assert.equal(week.body.alerts.find(a => a.subject === 'QUOTA' && a.recorded_by === 'agent:grant-wire-scout').body, 'cap hit');

  const undelivered = await call('GET', '/api/read/scout-alerts?days=30&undelivered=true', { token: READER });
  assert.ok(undelivered.body.alerts.length >= 2);
  assert.ok(undelivered.body.alerts.every(a => a.channels_ok === 'none'));

  const grok = await call('GET', '/api/read/scout-alerts?recorded_by=agent:grant-wire-grok', { token: READER });
  assert.deepEqual(grok.body.alerts.map(a => a.subject), ['QUOTA']);

  const page1 = await call('GET', '/api/read/scout-alerts?limit=1', { token: READER });
  assert.equal(page1.body.has_more, true);
  const page2 = await call('GET', `/api/read/scout-alerts?limit=1&before_id=${page1.body.next.before_id}`, { token: READER });
  assert.ok(page2.body.alerts[0].id < page1.body.alerts[0].id);

  assert.equal((await call('GET', '/api/read/scout-alerts?undelivered=false', { token: READER })).status, 400);
  assert.equal((await call('POST', '/api/read/scout-alerts', { token: READER, body: {} })).status, 403);
});

test('copy-scout-ledger copies rows from another database once, and finds nothing to copy in the same one', async () => {
  const { copyScoutLedger, COPIED_BY } = require('../src/scripts/copy-scout-ledger');
  const target = db.getPool();
  await seedLegacy(pools.source, [
    ['claude-code-2026-09-01T041500Z', 'crypto', 'ok', 3, ago(50 * 24)],
    ['claude-code-2026-09-02T041500Z', 'ai', 'quota', 0, ago(49 * 24)],
    ['claude-code-2026-10-23T041500Z', 'oss', 'failed', 0, ago(1)],
  ], [['Scout AUTH (old db)', 'resend', ago(40 * 24)], ['Scout EMPTY (old db)', 'none', ago(39 * 24)]]);
  const count = async (sql, params = []) => (await target.query(sql, params)).rows[0].n;
  const runsBefore = await count('SELECT count(*)::int AS n FROM scout_runs');
  const alertsBefore = await count('SELECT count(*)::int AS n FROM scout_alerts');

  const dry = await copyScoutLedger({ source: pools.source, target, apply: false });
  const [runs, alerts] = dry;
  assert.deepEqual([runs.table, runs.source_rows, runs.already_here, runs.to_copy, runs.copied], ['scout_runs', 3, 1, 2, 0]);
  assert.ok(!runs.columns.includes('found_count'), 'only columns the source has');
  assert.deepEqual([alerts.table, alerts.source_rows, alerts.to_copy, alerts.copied], ['scout_alerts', 2, 2, 0]);
  assert.equal(await count('SELECT count(*)::int AS n FROM scout_runs'), runsBefore, 'a dry run writes nothing');

  const applied = await copyScoutLedger({ source: pools.source, target, apply: true });
  assert.deepEqual(applied.map(r => r.copied), [2, 2]);
  assert.equal(await count('SELECT count(*)::int AS n FROM scout_runs WHERE recorded_by = $1', [COPIED_BY]), 2);
  assert.equal(await count('SELECT count(*)::int AS n FROM scout_alerts WHERE recorded_by = $1', [COPIED_BY]), 2);
  const kept = (await target.query(`SELECT status, recorded_by FROM scout_runs WHERE run_id = 'claude-code-2026-10-23T041500Z'`)).rows[0];
  assert.deepEqual(kept, { status: 'ok', recorded_by: 'agent:grant-wire-scout' }, 'a row already here wins');
  const copied = (await target.query(`SELECT wire, cost_usd::float8 AS cost, created_at FROM scout_runs WHERE run_id = 'claude-code-2026-09-01T041500Z'`)).rows[0];
  assert.equal(copied.wire, 'crypto');
  assert.equal(copied.cost, 1.25);

  const rerun = await copyScoutLedger({ source: pools.source, target, apply: true });
  assert.deepEqual(rerun.map(r => [r.to_copy, r.copied]), [[0, 0], [0, 0]]);
  assert.equal(await count('SELECT count(*)::int AS n FROM scout_alerts'), alertsBefore + 2);

  const same = await copyScoutLedger({ source: target, target, apply: false });
  assert.deepEqual(same.map(r => r.to_copy), [0, 0], 'same database: nothing to copy');
});
