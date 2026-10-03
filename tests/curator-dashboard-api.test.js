// Curator bearer against the pace and outgoing routes. No Telegram calls.
const crypto = require('node:crypto');

function sha(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const TOKEN = 'hedwig-dashboard-test-token';
const READ = 'reader-dashboard-test-token';
process.env.DEV_MODE = 'false';
process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/wireops_test';
process.env.DB_SSL_REJECT_UNAUTHORIZED = 'false';
process.env.NOTIFICATION_EMAIL = 'ops@example.com';
process.env.PRIVY_APP_ID = 'test-app-id';
process.env.PRIVY_APP_SECRET = 'test-app-secret';
process.env.NODE_ENV = 'test';
process.env.INTERNAL_API_KEY = 'internal-dashboard-test-key';
process.env.WIRE_ROOM_CURATOR_KEYS = JSON.stringify([
  {
    id: 'hedwig', name: 'Hedwig', sha256: sha(TOKEN),
    scopes: ['read_queue', 'decide', 'propose'],
    expires_at: '2099-01-01T00:00:00.000Z', revoked: false,
  },
  {
    id: 'reader', name: 'Reader', sha256: sha(READ),
    scopes: ['read_queue'],
    expires_at: '2099-01-01T00:00:00.000Z', revoked: false,
  },
]);

const schema = `curator_dash_${process.pid}`;
process.env.PGOPTIONS = `-c search_path=${schema}`;

require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const admin = new Pool({ connectionString: process.env.DATABASE_URL, options: '' });
let server;
let base;
let db;

test.before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  db = require('../src/db');
  await db.ensureAppStateTable();
  await db.getPool().query(`
    CREATE TABLE scan_entries (
      id integer PRIMARY KEY,
      name text,
      wire text,
      wires text[],
      status text,
      distributable boolean,
      actioned_by text,
      decision_at timestamptz,
      updated_at timestamptz
    );
    CREATE TABLE publication_queue (
      entry_id integer,
      status text,
      available_at timestamptz,
      created_at timestamptz,
      error_message text,
      attempts integer
    );
    CREATE TABLE distribution_channels (
      id uuid PRIMARY KEY,
      wire text,
      name text,
      enabled boolean,
      channel text,
      target_id text
    );
    CREATE TABLE distribution_logs (
      entry_id integer,
      wire text,
      channel text,
      status text,
      external_id text,
      sent_at timestamptz,
      created_at timestamptz,
      channel_id uuid
    );
  `);
  const { app } = require('../src/server');
  server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (db) await db.closePool();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

function call(method, path, { key, body } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
}

test('curator token reads and updates pace, and the audit actor is curator-api', async () => {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.map(String).join(' '));
    original(...args);
  };
  try {
    const read = await call('GET', '/api/distribution/pace', { key: TOKEN });
    assert.equal(read.status, 200);
    const before = await read.json();
    assert.equal(before.pace.intervalMinutes, 20);

    const outgoing = await call('GET', '/api/distribution/outgoing', { key: TOKEN });
    assert.equal(outgoing.status, 200);
    const list = await outgoing.json();
    assert.equal(list.pace.enabled, false);
    assert.equal(list.counts.programsOnly, 0);
    assert.deepEqual(list.programsOnly, []);

    const saved = await call('PUT', '/api/distribution/pace', {
      key: TOKEN,
      body: { intervalMinutes: 25, timezone: 'America/Los_Angeles', enabled: false, paused: false },
    });
    assert.equal(saved.status, 200);
    const body = await saved.json();
    assert.equal(body.pace.intervalMinutes, 25);
    assert.equal(body.changed, true);
    assert.equal(body.changes[0].actor, 'curator-api');
    assert.equal(body.changes[0].from.intervalMinutes, 20);
    assert.equal(body.changes[0].to.intervalMinutes, 25);

    const paceLine = lines.find(line => line.includes('Pace settings changed by curator-api'));
    assert.ok(paceLine, 'pace log line missing');
    assert.match(paceLine, /"intervalMinutes":20.*"intervalMinutes":25/);
    const auditLine = lines.find(line => line.startsWith('[curator-api] PUT /api/distribution/pace'));
    assert.ok(auditLine, 'curator-api audit line missing');
    assert.match(auditLine, /actor=curator-api/);
    assert.match(auditLine, /->/);
    assert.equal(auditLine.includes('sk-'), false);
  } finally {
    console.log = original;
  }
});

test('a read-only curator key can read pace and cannot change it', async () => {
  const read = await call('GET', '/api/distribution/pace', { key: READ });
  assert.equal(read.status, 200);
  const write = await call('PUT', '/api/distribution/pace', { key: READ, body: { paused: true } });
  assert.equal(write.status, 403);
});

test('pace validation fails before a write', async () => {
  const res = await call('PUT', '/api/distribution/pace', { key: TOKEN, body: { dailyCap: 0 } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /dailyCap/);
});
