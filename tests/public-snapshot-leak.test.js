require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPublicSnapshot } = require('../src/services/public-snapshot');

// Every value below is a canary. If any appears in the serialised snapshot,
// the projection leaked a field it was never allowed to emit.
const POISON = {
  email: 'canary-person@example.com',
  operatorRead: 'CANARY they have no grants lead, Sov could run it',
  declineReason: 'CANARY declined, funder is hostile',
  description: 'CANARY long internal description',
  actor: 'CANARY agent:stringer',
};

const INPUT = {
  funnel: [
    { status: 'duplicate', n: 143 },
    { status: 'queued', n: 41 },
    { status: 'archived', n: 60 },
    { status: 'incomplete', n: 8 },
    { status: 'approved', n: 20 },
  ],
  buckets: [
    { bucket: new Date('2026-07-30T02:00:00Z'), status: 'duplicate', n: 6 },
    { bucket: new Date('2026-07-30T02:00:00Z'), status: 'queued', n: 4 },
  ],
  publishes: [
    {
      created_at: new Date('2026-07-30T02:33:00Z'),
      name: 'NLnet Commons Fund',
      amount: '€50k',
      wire: 'oss',
      external_id: '4821',
      // fields the projection must ignore even though they are present:
      description: POISON.description,
      quality_score: 91,
      classification: 'GRANT',
      operator_route: 'publish',
      actioned_by: POISON.actor,
      action_reason: POISON.declineReason,
      org_id: 77,
      operator_read: POISON.operatorRead,
      contact_email: POISON.email,
    },
  ],
  stations: [
    { id: 'stringer', last_run_at: new Date('2026-07-30T02:14:00Z'), items_touched: 34 },
  ],
  coverage: { total: 1136, fresh: 412, dark: 204 },
  desk: { weekNumber: 30, wires: ['crypto', 'ai', 'oss'] },
  telegramBase: 'https://t.me/thegrantwire',
};

test('no poisoned value survives the projection', () => {
  const snap = buildPublicSnapshot(INPUT, new Date('2026-07-30T02:41:00Z'));
  const json = JSON.stringify(snap);
  for (const [label, value] of Object.entries(POISON)) {
    assert.ok(!json.includes(value), `leaked ${label}: ${value}`);
  }
  assert.ok(!json.includes('CANARY'), 'a canary string survived');
});

test('forbidden keys never appear anywhere in the output tree', () => {
  const snap = buildPublicSnapshot(INPUT, new Date('2026-07-30T02:41:00Z'));
  const FORBIDDEN = [
    'description', 'quality_score', 'classification', 'operator_route',
    'actioned_by', 'action_reason', 'org_id', 'metadata', 'operator_read',
    'contact_email', 'cost', 'email',
  ];
  const keys = new Set();
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) { keys.add(k); walk(node[k]); }
    }
  })(snap);
  for (const k of FORBIDDEN) assert.ok(!keys.has(k), `forbidden key present: ${k}`);
});

test('published item carries exactly the four allowlisted fields', () => {
  const snap = buildPublicSnapshot(INPUT, new Date('2026-07-30T02:41:00Z'));
  const pub = snap.events.find(e => e.kind === 'publish');
  assert.ok(pub, 'expected a publish event');
  assert.deepEqual(Object.keys(pub.item).sort(), ['amount', 'name', 'url', 'wire']);
});

test('non-publish events never carry an item', () => {
  const snap = buildPublicSnapshot(INPUT, new Date('2026-07-30T02:41:00Z'));
  for (const e of snap.events) {
    if (e.kind !== 'publish') assert.equal(e.item, undefined, `${e.kind} carried an item`);
  }
});
