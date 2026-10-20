require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REPLAY_REQUIRED_IDS,
  selectReplayIds,
  evaluateReplay,
  assertReplayReadOnly,
} = require('../src/services/classifier-replay');

function row(id, previous, next) {
  return { id, previous, next };
}

test('replay selection keeps every approved grant, fixture id, and required id', () => {
  const recent = Array.from({ length: 300 }, (_, i) => 30000 - i);
  const approved = Array.from({ length: 180 }, (_, i) => 1000 + i);
  const fixture = [19546, 19856, 19921];
  const ids = selectReplayIds({
    recentQueuedIds: recent,
    approvedGrantIds: approved,
    fixtureIds: fixture,
    limit: 200,
  });
  assert.ok(ids.length >= 200);
  for (const id of approved) assert.ok(ids.includes(id));
  for (const id of fixture) assert.ok(ids.includes(id));
  for (const id of REPLAY_REQUIRED_IDS) assert.ok(ids.includes(id));
  assert.ok(ids.includes(19855));
  assert.equal(new Set(ids).size, ids.length);
});

test('replay selection fills up to the limit when the required set is smaller', () => {
  const ids = selectReplayIds({
    recentQueuedIds: [9, 8, 7, 6],
    approvedGrantIds: [1],
    fixtureIds: [2],
    requiredIds: [19855],
    limit: 4,
  });
  assert.deepEqual(ids, [1, 2, 19855, 9]);
});

test('a GRANT flip to an open call fails, and forthcoming, award, and closure pass', () => {
  const openFlip = evaluateReplay([
    row(1,
      { classification: 'GRANT', inScope: true, lifecycle: 'open', wireArea: '3' },
      { classification: 'NEWS', inScope: true, lifecycle: 'open', wireArea: '5' }),
  ]);
  assert.equal(openFlip.pass, false);
  assert.equal(openFlip.flips[0].kind, 'open_call');

  const allowed = evaluateReplay([
    row(2,
      { classification: 'GRANT', inScope: true, lifecycle: 'open', wireArea: '3' },
      { classification: 'NEWS', inScope: true, lifecycle: 'forthcoming', wireArea: '3' }),
    row(3,
      { classification: 'GRANT', inScope: true, lifecycle: 'open', wireArea: '3' },
      { classification: 'NEWS', inScope: true, lifecycle: 'unknown', wireArea: '2' }),
    row(4,
      { classification: 'GRANT', inScope: true, lifecycle: 'open', wireArea: '3' },
      { classification: 'EXPIRED', inScope: true, lifecycle: 'closed', wireArea: '3' }),
  ]);
  assert.equal(allowed.pass, true);
  assert.deepEqual(allowed.flips.map(flip => flip.kind), ['forthcoming', 'award', 'closure']);
});

test('open-call program finalisation fails when an open row stops being GRANT', () => {
  const kept = evaluateReplay([
    row(10,
      { classification: 'GRANT', inScope: true, lifecycle: 'open', wireArea: '3' },
      { classification: 'GRANT', inScope: true, lifecycle: 'open', wireArea: '3' }),
  ]);
  assert.equal(kept.pass, true);
  assert.deepEqual(kept.open_call_finalised, { previous: 1, next: 1 });

  const dropped = evaluateReplay([
    row(11,
      { classification: 'GRANT', inScope: true, lifecycle: 'open', wireArea: '3' },
      { classification: 'NEWS', inScope: true, lifecycle: 'open', wireArea: '5' }),
  ]);
  assert.equal(dropped.pass, false);
  assert.equal(dropped.open_call_finalised.previous, 1);
  assert.equal(dropped.open_call_finalised.next, 0);
  assert.match(dropped.failures.join('\n'), /open-call program finalisation dropped/);
});

test('the replay read guard refuses writes and allows selects', () => {
  assert.doesNotThrow(() => assertReplayReadOnly('SELECT id FROM scan_entries WHERE status = $1'));
  assert.throws(() => assertReplayReadOnly('UPDATE scan_entries SET lifecycle = $1'), /refused a write/);
  assert.throws(() => assertReplayReadOnly('SELECT id FROM scan_entries FOR UPDATE'), /refused a write/);
});
