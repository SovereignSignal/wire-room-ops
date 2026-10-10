require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyEvergreenRegistryRoute } = require('../src/services/evergreen-route');

function route(overrides = {}) {
  return applyEvergreenRegistryRoute({
    scanSource: 'web-search',
    promptVariant: 'P',
    classification: 'GRANT',
    wireArea: '3',
    status: 'queued',
    deadline: 'Rolling',
    deadlineParsed: null,
    name: 'OpenSats',
    description: 'A standing program that is always open.',
    ...overrides,
  });
}

test('a Parallel evergreen grant leaves the wire queue for grants.watch', () => {
  const decision = route();
  assert.equal(decision.status, 'archived');
  assert.equal(decision.metadata.registry_lane, 'grants.watch');
  assert.equal(decision.metadata.archived_reason, 'evergreen_open_program');
  assert.equal(decision.metadata.operator_route, 'park');
  assert.match(decision.reasonSuffix, /grants\.watch/);
});

test('a dated window, a new cycle, or a non-Parallel row stays on the wire', () => {
  assert.equal(route({ deadlineParsed: '2026-12-01', deadline: '2026-12-01' }), null);
  assert.equal(route({ hasNewCycle: true }), null);
  assert.equal(route({ description: 'Applications are now open for round 4.' }), null);
  assert.equal(route({ promptVariant: 'W' }), null);
  assert.equal(route({ scanSource: 'feed' }), null);
  assert.equal(route({ classification: 'NEWS' }), null);
  assert.equal(route({ wireArea: '2' }), null);
  assert.equal(route({ status: 'archived' }), null);
  assert.equal(route({ deadline: null, description: 'A grant program.' }), null);
});

test('an unset wire area with standing language still routes', () => {
  const decision = route({ wireArea: null, deadline: null, description: 'Ongoing year-round fund.' });
  assert.equal(decision.status, 'archived');
});
