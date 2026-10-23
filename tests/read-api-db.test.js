// Read API (/api/read/*) against a freshly migrated database. Curator bearers only.
const crypto = require('node:crypto');

function sha(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const READER = 'read-api-reader-token';
const PRODUCER = 'read-api-intake-token';
const baseUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/wireops_test';
const database = `wro_read_api_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
const dbUrl = new URL(baseUrl);
dbUrl.pathname = `/${database}`;

process.env.DEV_MODE = 'false';
process.env.DATABASE_URL = dbUrl.toString();
process.env.DB_SSL_REJECT_UNAUTHORIZED = 'false';
process.env.NOTIFICATION_EMAIL = 'ops@example.com';
process.env.PRIVY_APP_ID = 'test-app-id';
process.env.PRIVY_APP_SECRET = 'test-app-secret';
process.env.NODE_ENV = 'test';
process.env.INTERNAL_API_KEY = 'read-api-internal-key';
process.env.WIRE_ROOM_CURATOR_KEYS = JSON.stringify([
  {
    id: 'reader', name: 'Ops Reader', sha256: sha(READER),
    scopes: ['read_queue'],
    expires_at: '2099-01-01T00:00:00.000Z', revoked: false,
  },
  {
    id: 'producer', name: 'Producer', sha256: sha(PRODUCER),
    scopes: ['intake'],
    expires_at: '2099-01-01T00:00:00.000Z', revoked: false,
  },
]);

require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const admin = new Pool({ connectionString: baseUrl });
let server;
let origin;
let db;
const ids = {};
let promptId;

const ago = hours => new Date(Date.now() - hours * 3600 * 1000);

async function seed() {
  const { normalizeUrl } = require('../src/utils/url');
  const client = await db.getPool().connect();
  try {
    // Fixture timestamps: the decision-date trigger would stamp NOW() on approved rows.
    await client.query("SET session_replication_role = 'replica'");
    promptId = (await client.query(
      `INSERT INTO scan_prompts (wire, label, prompt_text) VALUES ('crypto', 'Crypto discovery', 'find grants') RETURNING id`,
    )).rows[0].id;
    const rows = [
      ['queued', 'Alpha Grants Round 3', 'crypto', 'claude-code', 'agent:grant-wire-scout', 2, null, {
        quality_breakdown: { scoreReason: 'clear open call' },
        metadata: { operator_route: 'publish', curator: { route: 'publish', confidence: 'high' }, amount: '$50k' },
        source_url: 'https://alpha.example/grants', prompt_id: promptId,
      }],
      ['approved', 'Beta Fund', 'crypto', 'telegram', null, 30, 3, { actioned_by: 'user:ops@example.com' }],
      ['approved', 'Gamma Program', 'ai', 'grok-scout', 'agent:grant-wire-grok', 240, 216, { actioned_by: 'agent:hedwig' }],
      ['declined', 'Delta Grants', 'crypto', 'claude-code', 'agent:grant-wire-scout', 72, 70, { variant: 'B', quality_score: 40 }],
      ['duplicate', 'Alpha Grants Round 3', 'crypto', 'claude-code', 'agent:grant-wire-scout', 24, null, { quality_score: null }],
      ['archived', 'Old Archived Thing', 'crypto', 'grok-scout', null, 200 * 24, null, {}],
      ['raw', 'Epsilon OSS', 'oss', 'feed', null, 1, null, {}],
    ];
    for (const [status, name, wire, source, submittedBy, createdHoursAgo, decidedHoursAgo, extra] of rows) {
      const created = ago(createdHoursAgo);
      const { rows: [row] } = await client.query(
        `INSERT INTO scan_entries
           (name, description, source_url, wire, prompt_variant, scan_source, scan_date, status, submitted_by,
            quality_score, quality_breakdown, metadata, raw_output, actioned_by, decision_at, prompt_id,
            created_at, updated_at)
         VALUES ($1, $2, $3, $4, $15, $5, $6::date, $7, $8, $16, $9, $10, 'RAW MODEL OUTPUT', $11, $12, $13, $14, $14)
         RETURNING id`,
        [
          name, `${name} description`, extra.source_url || `https://example.org/${encodeURIComponent(name)}-${status}`,
          wire, source, created.toISOString().slice(0, 10), status, submittedBy,
          extra.quality_breakdown || null, extra.metadata || {}, extra.actioned_by || null,
          decidedHoursAgo == null ? null : ago(decidedHoursAgo), extra.prompt_id || null, created,
          extra.variant || 'A', extra.quality_score === undefined ? 70 : extra.quality_score,
        ],
      );
      ids[`${status}:${name}`] = row.id;
    }
    const beta = ids['approved:Beta Fund'];
    await client.query(
      `INSERT INTO distribution_logs (entry_id, channel, wire, status, post_text, external_id, sent_at, created_at)
       VALUES ($1, 'telegram', 'crypto', 'success', 'Beta Fund is open', '101', $2, $2),
              ($1, 'x', 'crypto', 'failed', 'Beta Fund post', NULL, NULL, $3)`,
      [beta, ago(2), ago(1)],
    );
    await client.query(`INSERT INTO publication_queue (entry_id, status, attempts) VALUES ($1, 'done', 1)`, [beta]);
    const alpha = ids['queued:Alpha Grants Round 3'];
    const seen = [
      ['https://alpha.example/grants', alpha, ago(2)],
      ['https://seed.example/program', null, ago(400 * 24)],
    ];
    for (const [url, entryId, created] of seen) {
      await client.query(
        `INSERT INTO seen_urls (url, normalized_url, first_seen_entry_id, first_seen_date, wire, created_at)
         VALUES ($1, $2, $3, $4::timestamptz::date, 'crypto', $4::timestamptz)`,
        [url, normalizeUrl(url), entryId, created],
      );
    }
    await client.query(
      `INSERT INTO api_usage_log (provider, model, purpose, job, tokens_in, tokens_out, estimated_cost_usd, wire, duration_ms, success, created_at)
       VALUES ('grok', 'grok-4', 'classify', 'process-raw', 100, 20, 0.5, 'crypto', 10, true, $1),
              ('grok', 'grok-4', 'classify', 'process-raw', 50, 10, 0.25, 'crypto', 10, false, $1),
              ('ollama', 'deepseek', 'summary', NULL, 10, 5, NULL, 'ai', 10, true, $2)`,
      [ago(1), ago(72)],
    );
  } finally {
    await client.query("SET session_replication_role = 'origin'").catch(() => {});
    client.release();
  }
}

test.before(async () => {
  await admin.query(`CREATE DATABASE ${database}`);
  db = require('../src/db');
  await require('../src/db/startup-migrations').migrateDatabase();
  await seed();
  const { app } = require('../src/server');
  server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (db) await db.closePool();
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.end();
});

async function get(pathname, key = READER) {
  const res = await fetch(`${origin}${pathname}`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body };
}

test('read API needs a session or a read_queue curator key, and only answers GET', async () => {
  assert.equal((await get('/api/read/entries', null)).status, 401);
  assert.equal((await get('/api/read/entries', PRODUCER)).status, 403);
  assert.equal((await get('/api/read/entries', 'not-a-key')).status, 401);
  assert.equal((await get('/api/read/entries', process.env.INTERNAL_API_KEY)).status, 401,
    'the internal master key does not open the read API');
  assert.equal((await get('/api/read/entries')).status, 200);

  const post = await fetch(`${origin}/api/read/entries`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${READER}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(post.status, 403);

  const { requiredCuratorScope } = require('../src/services/curator-keys');
  assert.equal(requiredCuratorScope('GET', '/api/read/intake-counts?days=7'), 'read_queue');
  assert.equal(requiredCuratorScope('HEAD', '/api/read/entries'), 'read_queue');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(requiredCuratorScope(method, '/api/read/entries'), 'forbidden');
  }
});

test('entries: queue rows by status carry triage fields and never raw_output', async () => {
  const { status, body } = await get('/api/read/entries?status=queued');
  assert.equal(status, 200);
  assert.deepEqual(body.entries.map(e => e.name), ['Alpha Grants Round 3']);
  const [row] = body.entries;
  assert.equal(row.quality_reason, 'clear open call');
  assert.equal(row.operator_route, 'publish');
  assert.deepEqual(row.curator, { route: 'publish', confidence: 'high' });
  assert.equal(row.submitted_by, 'agent:grant-wire-scout');
  assert.equal(row.raw_output, undefined);
  assert.equal(row.metadata, undefined, 'metadata is opt-in');
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T/);

  const withMeta = await get('/api/read/entries?status=queued&include=metadata');
  assert.equal(withMeta.body.entries[0].metadata.amount, '$50k');
  assert.equal(withMeta.body.entries[0].raw_output, undefined);
});

test('entries: producer window, newest first, with an id cursor', async () => {
  const recent = await get('/api/read/entries?source=claude-code&hours=48');
  assert.deepEqual(recent.body.entries.map(e => e.id), [
    ids['duplicate:Alpha Grants Round 3'],
    ids['queued:Alpha Grants Round 3'],
  ]);
  assert.equal(recent.body.has_more, false);
  assert.ok(recent.body.window.since);

  const first = await get('/api/read/entries?wire=crypto&limit=2');
  assert.equal(first.body.count, 2);
  assert.equal(first.body.has_more, true);
  const second = await get(`/api/read/entries?wire=crypto&limit=2&before_id=${first.body.next.before_id}`);
  assert.ok(second.body.entries.every(e => e.id < first.body.next.before_id));

  const oldest = await get('/api/read/entries?order=oldest&limit=1');
  assert.equal(oldest.body.entries[0].id, Math.min(...Object.values(ids)));
  assert.ok(oldest.body.next.after_id);

  const byProducer = await get('/api/read/entries?submitted_by=agent:grant-wire-grok');
  assert.deepEqual(byProducer.body.entries.map(e => e.name), ['Gamma Program']);
});

test('entries: bad filters are 400, not a silent full scan', async () => {
  for (const query of [
    'status=bogus', 'source=nope', 'wire=sports', 'hours=abc', 'hours=0', 'hours=1&since=2026-01-01',
    'since=yesterday', 'limit=501', 'order=random', 'classification=MAYBE', 'include=raw_output',
    'since=2026-02-01&until=2026-01-01',
  ]) {
    const { status } = await get(`/api/read/entries?${query}`);
    assert.equal(status, 400, query);
  }
});

test('entries/:id returns metadata, deliveries, and the publication row', async () => {
  const alpha = await get(`/api/read/entries/${ids['queued:Alpha Grants Round 3']}`);
  assert.equal(alpha.status, 200);
  assert.equal(alpha.body.entry.metadata.operator_route, 'publish');
  assert.equal(alpha.body.entry.raw_output, undefined);
  assert.deepEqual(alpha.body.deliveries, []);
  assert.equal(alpha.body.publication, null);

  const beta = await get(`/api/read/entries/${ids['approved:Beta Fund']}`);
  assert.deepEqual(beta.body.deliveries.map(d => [d.channel, d.status, d.external_id]), [
    ['telegram', 'success', '101'],
    ['x', 'failed', null],
  ]);
  assert.equal(beta.body.publication.status, 'done');
  assert.equal(beta.body.publication.lease_token, undefined);

  assert.equal((await get('/api/read/entries/99999999')).status, 404);
  assert.equal((await get('/api/read/entries/abc')).status, 400);
});

test('approvals: recorded decisions in the window with delivery state', async () => {
  const day = await get('/api/read/approvals');
  assert.equal(day.status, 200);
  assert.deepEqual(day.body.approvals.map(a => a.name), ['Beta Fund']);
  const [beta] = day.body.approvals;
  assert.equal(beta.actioned_by, 'user:ops@example.com');
  assert.equal(beta.publication_status, 'done');
  assert.deepEqual(beta.deliveries.map(d => d.status), ['success', 'failed']);

  const month = await get('/api/read/approvals?days=30');
  assert.deepEqual(month.body.approvals.map(a => a.name), ['Beta Fund', 'Gamma Program']);
  const hedwig = await get('/api/read/approvals?days=30&actioned_by=agent:hedwig');
  assert.deepEqual(hedwig.body.approvals.map(a => a.name), ['Gamma Program']);
  assert.equal((await get('/api/read/approvals?days=91')).status, 400);
});

test('deliveries: logs by status and channel, post text opt-in', async () => {
  const all = await get('/api/read/deliveries');
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.deliveries.map(d => d.channel), ['x', 'telegram']);
  assert.equal(all.body.deliveries[0].entry_name, 'Beta Fund');
  assert.equal(all.body.deliveries[0].post_text, undefined);

  const sent = await get('/api/read/deliveries?status=success&channel=telegram&include=post_text');
  assert.equal(sent.body.count, 1);
  assert.equal(sent.body.deliveries[0].external_id, '101');
  assert.equal(sent.body.deliveries[0].post_text, 'Beta Fund is open');

  assert.equal((await get('/api/read/deliveries?status=sent')).status, 400);
  assert.equal((await get('/api/read/deliveries?channel=email')).status, 400);
});

test('seen-urls: exact lookup across URL spellings, and an incremental list', async () => {
  const hit = await get(`/api/read/seen-urls?url=${encodeURIComponent('http://www.alpha.example/grants/')}`);
  assert.equal(hit.status, 200);
  assert.equal(hit.body.seen, true);
  assert.equal(hit.body.matches[0].first_seen_entry_id, ids['queued:Alpha Grants Round 3']);
  assert.equal(hit.body.matches[0].entry_status, 'queued');

  const bare = await get(`/api/read/seen-urls?url=${encodeURIComponent('alpha.example/grants')}&wire=crypto`);
  assert.equal(bare.body.seen, true);
  const otherWire = await get(`/api/read/seen-urls?url=${encodeURIComponent('alpha.example/grants')}&wire=ai`);
  assert.equal(otherWire.body.seen, false);

  const miss = await get(`/api/read/seen-urls?url=${encodeURIComponent('https://never.example/x')}`);
  assert.equal(miss.body.seen, false);
  assert.deepEqual(miss.body.matches, []);

  const seed = await get('/api/read/seen-urls?scope=seed');
  assert.deepEqual(seed.body.urls.map(u => u.url), ['https://seed.example/program']);

  const page1 = await get('/api/read/seen-urls?limit=1');
  assert.equal(page1.body.has_more, true);
  const page2 = await get(`/api/read/seen-urls?limit=1&after_id=${page1.body.next.after_id}`);
  assert.equal(page2.body.has_more, false);
  assert.notEqual(page2.body.urls[0].id, page1.body.urls[0].id);

  const recent = await get('/api/read/seen-urls?hours=24');
  assert.deepEqual(recent.body.urls.map(u => u.url), ['https://alpha.example/grants']);

  assert.equal((await get('/api/read/seen-urls?url=not%20a%20url')).status, 400);
  assert.equal((await get('/api/read/seen-urls?scope=everything')).status, 400);
});

test('intake-counts: per-source status split with approval and duplicate rates', async () => {
  const week = await get('/api/read/intake-counts?days=7');
  assert.equal(week.status, 200);
  assert.deepEqual(week.body.by, ['source']);
  const bySource = Object.fromEntries(week.body.groups.map(g => [g.source, g]));
  assert.deepEqual(bySource['claude-code'].by_status, { declined: 1, duplicate: 1, queued: 1 });
  assert.equal(bySource['claude-code'].total, 3);
  assert.equal(bySource['claude-code'].approval_rate, 0);
  assert.equal(bySource['claude-code'].dup_rate, 0.333);
  assert.equal(bySource['claude-code'].avg_quality_score, 55, 'null scores are left out of the average');
  assert.equal(bySource['claude-code'].score_sum, undefined);
  assert.equal(bySource.telegram.approval_rate, 1);
  assert.equal(bySource['grok-scout'], undefined, 'outside the window');
  assert.equal(week.body.totals.total, 5);

  const fed = await get('/api/read/intake-counts?hours=48&wire=crypto&source=claude-code,grok-scout&by=wire');
  assert.deepEqual(fed.body.groups.map(g => [g.wire, g.total]), [['crypto', 2]]);

  const prompts = await get('/api/read/intake-counts?days=7&by=prompt');
  const prompt = prompts.body.groups.find(g => g.prompt_id === promptId);
  assert.equal(prompt.prompt_label, 'Crypto discovery');
  assert.equal(prompt.total, 1);

  const daily = await get('/api/read/intake-counts?days=7&by=day,source&submitted_by=agent:grant-wire-scout');
  assert.ok(daily.body.groups.every(g => /^\d{4}-\d{2}-\d{2}$/.test(g.day) && g.source === 'claude-code'));

  // scoreboard.sh and ab-score.sh: week x source x wire x variant, and variant alone.
  const board = await get('/api/read/intake-counts?days=30&by=week,source,wire,variant&source=claude-code,grok-scout');
  assert.equal(board.status, 200);
  assert.ok(board.body.groups.every(g => /^\d{4}-\d{2}-\d{2}$/.test(g.week) && new Date(`${g.week}T00:00:00Z`).getUTCDay() === 1));
  const ab = await get('/api/read/intake-counts?days=30&by=variant&source=claude-code');
  const byVariant = Object.fromEntries(ab.body.groups.map(g => [g.variant, g]));
  assert.deepEqual(byVariant.A.by_status, { duplicate: 1, queued: 1 });
  assert.deepEqual(byVariant.B.by_status, { declined: 1 });
  assert.equal(byVariant.B.avg_quality_score, 40);
  assert.equal(ab.body.totals.avg_quality_score, 55);

  assert.equal((await get('/api/read/intake-counts?by=model')).status, 400);
});

test('backlog: raw and queued rows per wire with the oldest age', async () => {
  const { status, body } = await get('/api/read/backlog');
  assert.equal(status, 200);
  assert.deepEqual(body.statuses, ['raw', 'queued']);
  assert.deepEqual(body.backlog.map(b => [b.wire, b.status, b.count]), [['crypto', 'queued', 1], ['oss', 'raw', 1]]);
  assert.ok(body.backlog[0].oldest_created_at);
});

test('names: decided names plus the caller\'s own rows, own rows first', async () => {
  const known = await get('/api/read/names?wire=crypto&status=approved,declined,archived,duplicate,deduped&source=claude-code&days=120');
  assert.equal(known.status, 200);
  const names = known.body.names.map(n => [n.name, n.origin]);
  assert.deepEqual(names.slice(0, 2).map(n => n[1]), ['self', 'self']);
  assert.deepEqual(new Set(names.map(n => n[0])), new Set(['Alpha Grants Round 3', 'Delta Grants', 'Beta Fund']));
  assert.deepEqual(known.body.names.find(n => n.name === 'Alpha Grants Round 3').statuses, ['duplicate', 'queued']);

  const rejected = await get('/api/read/names?wire=crypto&status=declined,archived&days=180');
  assert.deepEqual(rejected.body.names.map(n => [n.name, n.origin]), [['Delta Grants', 'decided']]);
  const older = await get('/api/read/names?wire=crypto&status=declined,archived&days=365');
  assert.equal(older.body.count, 2);

  assert.equal((await get('/api/read/names?status=declined')).status, 400);
  assert.equal((await get('/api/read/names?wire=crypto')).status, 400);
});

test('usage-daily: spend per UTC day, provider, model, and job', async () => {
  const { status, body } = await get('/api/read/usage-daily');
  assert.equal(status, 200);
  const grok = body.days.find(d => d.provider === 'grok');
  assert.equal(grok.calls, 2);
  assert.equal(grok.errors, 1);
  assert.equal(grok.estimated_cost_usd, 0.75);
  assert.equal(grok.tokens_in, 150);
  const ollama = body.days.find(d => d.provider === 'ollama');
  assert.equal(ollama.unpriced_calls, 1);
  assert.equal(ollama.job, null);

  const cryptoWire = await get('/api/read/usage-daily?wire=crypto&hours=48');
  assert.deepEqual(cryptoWire.body.days.map(d => d.provider), ['grok']);
  assert.equal((await get('/api/read/usage-daily?days=120')).status, 400);
});

test('every read API query runs inside a read-only transaction', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'read-api.ts'), 'utf8');
  assert.ok(source.includes("db.query('BEGIN READ ONLY')"));
  assert.ok(source.includes('SET LOCAL statement_timeout'));
  assert.ok(!/getPool\(\)\.query/.test(source), 'queries must go through readOnly()');
  assert.ok(!/router\.(post|put|patch|delete)\(/.test(source), 'the read API has no write routes');
  assert.ok(!/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|GRANT)\s/.test(source));
});
