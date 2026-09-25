// Pins the tele-sum round-trip contract and the Phase-3 retry fixes.
//
// Contract (broke 2026-05-14 → 06-10, duplicating ~98% of approvals into
// tele-sum): every successful telegram send must land in distribution_logs
// with channel='telegram', status='success', external_id (Telegram message
// id) and wire — tele-sum's distribution_guard.py matches on exactly those.
//
// Phase-3 retry fixes: retryDistribution must consult managed channels (the
// live production path), must NOT delete failed logs (audit trail), and must
// skip channels that already have a success/pending log.
require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('logDistribution writes the tele-sum guard columns (external_id + wire + channel + status)', () => {
  const dbSource = read('src/db/index.ts');
  const insert = dbSource.match(/INSERT INTO distribution_logs \(([^)]+)\)/);
  assert.ok(insert, 'distribution_logs INSERT not found');
  const cols = insert[1].split(',').map(s => s.trim());
  for (const required of ['entry_id', 'channel', 'wire', 'status', 'external_id']) {
    assert.ok(cols.includes(required), `distribution_logs INSERT missing tele-sum contract column '${required}'`);
  }
});

test('live sends claim a pending log before talking to Telegram or X', () => {
  const source = read('src/services/distribution.ts');
  const dbSource = read('src/db/index.ts');
  assert.match(source, /async function sendAfterClaim/);
  assert.match(source, /claimDistributionLog/);
  assert.match(source, /finalizeDistributionLog/);
  assert.match(dbSource, /status: 'pending'/);
  const liveClaims = source.match(/return sendAfterClaim\(/g) || [];
  assert.equal(liveClaims.length, 5, 'telegram/discord/slack managed + telegram/x legacy must claim before send');
});

test('the double-post guard index only covers pending/success — failed logs never block a retry', () => {
  const dbSource = read('src/db/index.ts');
  const idx = dbSource.match(/UNIQUE INDEX[^;]*distribution_logs[^;]*WHERE[^;]*status IN \(([^)]+)\)/i);
  assert.ok(idx, 'unique partial index on distribution_logs not found');
  const statuses = [...idx[1].matchAll(/'([a-z]+)'/g)].map(m => m[1]).sort();
  assert.deepEqual(statuses, ['pending', 'success']);
});

test('retryDistribution keeps failed logs and consults managed channels', async () => {
  const db = require('../src/db');
  const postGen = require('../src/services/post-generator');

  const executed = [];
  const stubPool = {
    query: async (sql, params) => {
      executed.push({ sql, params });
      if (sql.includes('FROM scan_entries')) {
        return { rows: [{ id: 55, name: 'Retry Me', description: 'desc', amount: null, deadline: null, source_url: 'https://example.org/x', wire: 'crypto', wires: ['crypto'] }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  let managedConsulted = 0;
  let postsGenerated = 0;
  const origGetPool = db.getPool;
  const origLogs = db.getDistributionLogs;
  const origConfigs = db.getDistributionConfigs;
  const origManaged = db.getEnabledDistributionChannelsForWire;
  const origGenerate = postGen.generatePosts;
  db.getPool = () => stubPool;
  db.getDistributionLogs = async () => [{ channel: 'telegram', status: 'failed' }];
  db.getDistributionConfigs = async () => [];
  db.getEnabledDistributionChannelsForWire = async () => { managedConsulted++; return []; };
  postGen.generatePosts = async () => { postsGenerated++; return { tweet: 't', telegramHtml: '<b>t</b>' }; };

  try {
    const { retryDistribution } = require('../src/services/distribution');
    const result = await retryDistribution(55, 'crypto');

    assert.equal(managedConsulted, 1, 'retry must consult managed distribution_channels (the live Telegram path)');
    assert.ok(
      !executed.some(c => /DELETE\s+FROM\s+distribution_logs/i.test(c.sql)),
      'retry must NOT delete failed distribution logs (audit trail + tele-sum history)'
    );
    // configs + managed both empty → nothing to send, and no posts generated
    assert.equal(result.distributed, 0);
    assert.equal(postsGenerated, 0);
  } finally {
    db.getPool = origGetPool;
    db.getDistributionLogs = origLogs;
    db.getDistributionConfigs = origConfigs;
    db.getEnabledDistributionChannelsForWire = origManaged;
    postGen.generatePosts = origGenerate;
  }
});

test('retryDistribution skips channels that already have a success or pending log', async () => {
  const db = require('../src/db');
  const postGen = require('../src/services/post-generator');

  const origGetPool = db.getPool;
  const origLogs = db.getDistributionLogs;
  const origConfigs = db.getDistributionConfigs;
  const origManaged = db.getEnabledDistributionChannelsForWire;
  const origGenerate = postGen.generatePosts;

  let postsGenerated = 0;
  db.getPool = () => ({
    query: async (sql) => {
      if (sql.includes('FROM scan_entries')) {
        return { rows: [{ id: 56, name: 'Already Sent', description: 'desc', amount: null, deadline: null, source_url: 'https://example.org/y', wire: 'crypto', wires: ['crypto'] }] };
      }
      return { rows: [], rowCount: 0 };
    },
  });
  db.getDistributionLogs = async () => [{ channel: 'telegram', channelId: 'abcd1234-0000', wire: 'crypto', status: 'success' }];
  db.getDistributionConfigs = async () => [];
  // The exact managed Telegram destination already succeeded, so
  // the retry must treat it as settled and never even generate posts.
  db.getEnabledDistributionChannelsForWire = async () => [{ id: 'abcd1234-0000', channel: 'telegram', wire: 'crypto', enabled: true, credentials: {} }];
  postGen.generatePosts = async () => { postsGenerated++; return { tweet: 't', telegramHtml: '<b>t</b>' }; };

  try {
    const { retryDistribution } = require('../src/services/distribution');
    const result = await retryDistribution(56, 'crypto');
    assert.equal(result.totalEntries, 0, 'settled channel must early-return with nothing to retry');
    assert.equal(postsGenerated, 0, 'no posts may be generated when every channel is settled');
  } finally {
    db.getPool = origGetPool;
    db.getDistributionLogs = origLogs;
    db.getDistributionConfigs = origConfigs;
    db.getEnabledDistributionChannelsForWire = origManaged;
    postGen.generatePosts = origGenerate;
  }
});
