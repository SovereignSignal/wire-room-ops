require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
const { nextSlot, assignSlots, normalizePace, parsePaceUpdate, planQueue, PaceValidationError } = require('../src/services/distribution-pace');

const quiet = { start: '22:00', end: '08:00', timezone: 'America/Los_Angeles' };

test('missing or non-boolean pace config stays disabled', () => {
  assert.equal(normalizePace(null).enabled, false);
  assert.equal(normalizePace({ enabled: 'true' }).enabled, false);
  assert.equal(normalizePace({ enabled: 1 }).enabled, false);
  assert.equal(normalizePace({}).intervalMinutes, 20);
  assert.equal(normalizePace({}).paused, false);
  assert.equal(normalizePace({ enabled: true, intervalMinutes: 0 }).intervalMinutes, 1);
  assert.equal(normalizePace({ enabled: true, intervalMinutes: 999 }).intervalMinutes, 180);
  assert.equal(normalizePace({ dailyCap: 0 }).dailyCap, null);
  assert.equal(normalizePace({ paused: 'yes' }).paused, false);
  assert.equal(normalizePace({ enabled: true, paused: true }).paused, true);
});

test('next slot is now when the chat has no history', () => {
  const now = new Date('2026-10-02T17:00:00.000Z');
  const slot = nextSlot({ now, intervalMinutes: 20, bookedAt: [], lastSentAt: null, quiet: null });
  assert.equal(slot.toISOString(), now.toISOString());
});

test('next slot waits out the latest booking and the last send', () => {
  const now = new Date('2026-10-02T17:00:00.000Z');
  const booked = new Date(now.getTime() + 60 * 60 * 1000);
  const afterBooked = nextSlot({ now, intervalMinutes: 20, bookedAt: [new Date(now.getTime() + 10 * 60 * 1000), booked], lastSentAt: null, quiet: null });
  assert.equal(afterBooked.toISOString(), new Date(booked.getTime() + 20 * 60 * 1000).toISOString());
  const lastSent = new Date(now.getTime() - 5 * 60 * 1000);
  const afterSend = nextSlot({ now, intervalMinutes: 20, bookedAt: [], lastSentAt: lastSent, quiet: null });
  assert.equal(afterSend.toISOString(), new Date(now.getTime() + 15 * 60 * 1000).toISOString());
});

test('quiet hours push an evening slot to the next morning and leave midday alone', () => {
  const evening = new Date('2026-10-02T06:30:00.000Z');
  const morning = nextSlot({ now: evening, intervalMinutes: 20, bookedAt: [], lastSentAt: null, quiet });
  assert.equal(morning.toISOString(), '2026-10-02T15:00:00.000Z');
  const early = new Date('2026-10-02T14:00:00.000Z');
  assert.equal(nextSlot({ now: early, intervalMinutes: 20, bookedAt: [], lastSentAt: null, quiet }).toISOString(), '2026-10-02T15:00:00.000Z');
  const midday = new Date('2026-10-02T17:00:00.000Z');
  assert.equal(nextSlot({ now: midday, intervalMinutes: 20, bookedAt: [], lastSentAt: null, quiet }).toISOString(), midday.toISOString());
});

test('assignSlots spaces one chat in selection order and lets two chats share a moment', () => {
  const now = new Date('2026-10-02T17:00:00.000Z');
  const clock = { now, intervalMinutes: 20, booked: new Map(), lastSent: new Map(), quiet: null };
  const slots = assignSlots([
    { id: 3, targets: ['crypto'] },
    { id: 8, targets: ['ai'] },
    { id: 5, targets: ['crypto'] },
  ], clock);
  assert.deepEqual(slots.map(slot => slot.id), [3, 8, 5]);
  assert.equal(slots[0].at.toISOString(), now.toISOString());
  assert.equal(slots[1].at.toISOString(), now.toISOString());
  assert.equal(slots[2].at.toISOString(), new Date(now.getTime() + 20 * 60 * 1000).toISOString());
});

test('an entry on two chats takes the later slot and books both', () => {
  const now = new Date('2026-10-02T17:00:00.000Z');
  const booked = new Map([['ai', [new Date(now.getTime() + 30 * 60 * 1000)]]]);
  const [slot] = assignSlots([{ id: 1, targets: ['crypto', 'ai'] }], {
    now, intervalMinutes: 20, booked, lastSent: new Map(), quiet: null,
  });
  assert.equal(slot.at.toISOString(), new Date(now.getTime() + 50 * 60 * 1000).toISOString());
});

test('pacing stays off until the dashboard turns it on', () => {
  const pace = fs.readFileSync(path.join(__dirname, '../src/services/distribution-pace.ts'), 'utf8');
  const migrations = fs.readFileSync(path.join(__dirname, '../src/db/startup-migrations.ts'), 'utf8');
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/paced-distribution.ts'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '../client/src/components/dashboard/PaceSettings.tsx'), 'utf8');
  const tab = fs.readFileSync(path.join(__dirname, '../client/src/components/dashboard/DistributionTab.tsx'), 'utf8');
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/distribution.ts'), 'utf8');
  const actions = fs.readFileSync(path.join(__dirname, '../src/services/entry-actions.ts'), 'utf8');
  assert.match(pace, /enabled: false/);
  assert.match(migrations, /SCHEMA_VERSION = 12/);
  assert.match(migrations, /version: 5, run: ensurePacedDistribution/);
  assert.doesNotMatch(schema, /distribution:pace/);
  assert.doesNotMatch(migrations, /distribution:pace/);
  assert.match(actions, /available_at = NOW\(\)/);
  assert.match(route, /\/distribution\/pace/);
  assert.match(client, /Minutes between posts/);
  assert.match(client, /Quiet hours/);
  assert.match(client, /Daily cap per chat/);
  assert.match(client, /Resume/);
  assert.match(tab, /PaceSettings/);
  assert.match(tab, /OutgoingDistribution/);
  assert.doesNotMatch(schema, /UPDATE distribution_logs SET sent_at/);
});

const la = 'America/Los_Angeles';
const overnight = { start: '22:00', end: '08:00', timezone: la };
const rulesFor = (now, extra = {}) => ({
  now, intervalMinutes: 20, quiet: overnight, dailyCap: null, timezone: la, ...extra,
});

test('quiet hours that cross midnight hold the boundary and the morning', () => {
  const slot = (iso) => nextSlot({
    now: new Date(iso), intervalMinutes: 20, bookedAt: [], lastSentAt: null, quiet: overnight, timezone: la,
  }).toISOString();
  assert.equal(slot('2026-10-03T04:59:00.000Z'), '2026-10-03T04:59:00.000Z');
  assert.equal(slot('2026-10-03T05:00:00.000Z'), '2026-10-03T15:00:00.000Z');
  assert.equal(slot('2026-10-02T14:59:00.000Z'), '2026-10-02T15:00:00.000Z');
  assert.equal(slot('2026-10-02T15:00:00.000Z'), '2026-10-02T15:00:00.000Z');
});

test('rows due inside overnight quiet hours land at the end, spaced, and do not bunch up', () => {
  const now = new Date('2026-10-02T06:30:00.000Z');
  const planned = planQueue(
    [1, 2, 3, 4].map(id => ({ id, at: new Date(now.getTime() - id * 60_000), targets: ['crypto'] })),
    new Map(),
    rulesFor(now),
  ).sort((a, b) => a.at - b.at);
  assert.deepEqual(planned.map(row => row.at.toISOString()), [
    '2026-10-02T15:00:00.000Z',
    '2026-10-02T15:20:00.000Z',
    '2026-10-02T15:40:00.000Z',
    '2026-10-02T16:00:00.000Z',
  ]);
  assert.ok(planned.every(row => row.reason === 'quiet hours'));
});

test('a same-day quiet window pushes to its end and leaves the rest of the day alone', () => {
  const quiet = { start: '12:00', end: '13:00', timezone: la };
  const inside = nextSlot({
    now: new Date('2026-10-02T19:30:00.000Z'), intervalMinutes: 20, bookedAt: [], lastSentAt: null, quiet, timezone: la,
  });
  assert.equal(inside.toISOString(), '2026-10-02T20:00:00.000Z');
  const before = new Date('2026-10-02T18:30:00.000Z');
  assert.equal(nextSlot({
    now: before, intervalMinutes: 20, bookedAt: [], lastSentAt: null, quiet, timezone: la,
  }).toISOString(), before.toISOString());
});

test('quiet hours follow the clock through the spring-forward gap and the fall-back overlap', () => {
  const args = { intervalMinutes: 20, bookedAt: [], lastSentAt: null, quiet: overnight, timezone: la };
  assert.equal(nextSlot({ ...args, now: new Date('2026-03-08T06:30:00.000Z') }).toISOString(), '2026-03-08T15:00:00.000Z');
  assert.equal(nextSlot({ ...args, now: new Date('2026-11-01T05:30:00.000Z') }).toISOString(), '2026-11-01T16:00:00.000Z');
  assert.equal(nextSlot({ ...args, now: new Date('2026-11-01T08:30:00.000Z') }).toISOString(), '2026-11-01T16:00:00.000Z');
  assert.equal(nextSlot({ ...args, now: new Date('2026-11-01T09:30:00.000Z') }).toISOString(), '2026-11-01T16:00:00.000Z');
  const gap = { start: '01:00', end: '02:30', timezone: la };
  const landed = nextSlot({
    now: new Date('2026-03-08T09:30:00.000Z'), intervalMinutes: 20, bookedAt: [], lastSentAt: null, quiet: gap, timezone: la,
  });
  assert.ok(landed.getTime() >= new Date('2026-03-08T10:00:00.000Z').getTime());
  assert.equal(nextSlot({
    now: landed, intervalMinutes: 20, bookedAt: [], lastSentAt: null, quiet: gap, timezone: la,
  }).toISOString(), landed.toISOString());
});

test('a full daily cap rolls the rest to the next open morning, still spaced', () => {
  const now = new Date('2026-10-02T17:00:00.000Z');
  const clock = {
    now, intervalMinutes: 20, booked: new Map(), lastSent: new Map(),
    quiet: overnight, dailyCap: 2, timezone: la, sentToday: new Map([['crypto', 2]]),
  };
  const slots = assignSlots([
    { id: 1, targets: ['crypto'] },
    { id: 2, targets: ['crypto'] },
    { id: 3, targets: ['crypto'] },
  ], clock);
  assert.equal(slots[0].at.toISOString(), '2026-10-03T15:00:00.000Z');
  assert.equal(slots[1].at.toISOString(), '2026-10-03T15:20:00.000Z');
  assert.equal(slots[2].at.toISOString(), '2026-10-04T15:00:00.000Z');
});

test('a daily cap leaves room today and only the overflow waits for tomorrow', () => {
  const now = new Date('2026-10-02T17:00:00.000Z');
  const slots = assignSlots([
    { id: 1, targets: ['crypto'] },
    { id: 2, targets: ['crypto'] },
    { id: 3, targets: ['crypto'] },
  ], {
    now, intervalMinutes: 20, booked: new Map(), lastSent: new Map(),
    quiet: null, dailyCap: 2, timezone: la, sentToday: new Map(),
  });
  assert.equal(slots[0].at.toISOString(), now.toISOString());
  assert.equal(slots[1].at.toISOString(), new Date(now.getTime() + 20 * 60_000).toISOString());
  assert.equal(slots[2].at.toISOString(), '2026-10-03T07:00:00.000Z');
});

test('an entry on two chats waits for the chat that has hit its cap', () => {
  const now = new Date('2026-10-02T17:00:00.000Z');
  const [slot] = assignSlots([{ id: 1, targets: ['crypto', 'ai'] }], {
    now, intervalMinutes: 20, booked: new Map(), lastSent: new Map(),
    quiet: overnight, dailyCap: 2, timezone: la, sentToday: new Map([['ai', 2]]),
  });
  assert.equal(slot.at.toISOString(), '2026-10-03T15:00:00.000Z');
});

test('PUT validation clamps the interval and rejects a bad zone, clock, cap, or switch', () => {
  const current = normalizePace(null);
  assert.equal(parsePaceUpdate({ intervalMinutes: 0 }, current).intervalMinutes, 1);
  assert.equal(parsePaceUpdate({ intervalMinutes: 999 }, current).intervalMinutes, 180);
  assert.equal(parsePaceUpdate({ quietHours: null }, current).quietHours, null);
  assert.deepEqual(parsePaceUpdate({ quietHours: { start: '9:05', end: '17:00' } }, current).quietHours, { start: '09:05', end: '17:00' });
  assert.equal(parsePaceUpdate({ dailyCap: null }, current).dailyCap, null);
  assert.equal(parsePaceUpdate({ dailyCap: 4 }, current).dailyCap, 4);
  assert.equal(parsePaceUpdate({ enabled: true, paused: false }, current).enabled, true);
  assert.equal(normalizePace({ quietHours: null }).quietHours, null);
  for (const body of [
    { timezone: 'Not/AZone' },
    { timezone: '' },
    { quietHours: { start: '25:00', end: '08:00' } },
    { quietHours: { start: '22:00', end: null } },
    { quietHours: { start: '08:00', end: '08:00' } },
    { dailyCap: 0 },
    { dailyCap: -3 },
    { dailyCap: 1.5 },
    { dailyCap: '5' },
    { paused: 'yes' },
    { enabled: 1 },
  ]) {
    assert.throws(() => parsePaceUpdate(body, current), PaceValidationError);
  }
});
