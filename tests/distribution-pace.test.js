require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');
const { nextSlot, assignSlots, normalizePace } = require('../src/services/distribution-pace');

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

test('phase 1 wires pacing off by default and shows the outgoing list', () => {
  const pace = fs.readFileSync(path.join(__dirname, '../src/services/distribution-pace.ts'), 'utf8');
  const migrations = fs.readFileSync(path.join(__dirname, '../src/db/startup-migrations.ts'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '../client/src/components/dashboard/OutgoingDistribution.tsx'), 'utf8');
  const tab = fs.readFileSync(path.join(__dirname, '../client/src/components/dashboard/DistributionTab.tsx'), 'utf8');
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/distribution.ts'), 'utf8');
  assert.match(pace, /enabled: false/);
  assert.match(pace, /quiet: null/);
  assert.match(migrations, /SCHEMA_VERSION = 5/);
  assert.match(migrations, /version: 5, run: ensurePacedDistribution/);
  assert.match(route, /\/distribution\/outgoing/);
  assert.match(client, /Pacing off — approvals publish immediately/);
  assert.match(tab, /OutgoingDistribution/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../src/db/paced-distribution.ts'), 'utf8'), /UPDATE distribution_logs SET sent_at/);
});
