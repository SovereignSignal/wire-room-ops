require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldBridgeWire } = require('../src/jobs/summary-sync');

test('bridges summaries whose wire is an active feed wire', () => {
  assert.equal(shouldBridgeWire('crypto', ['crypto', 'ai', 'oss']), true);
});

test('does NOT bridge summaries on non-feed wires (digest channels)', () => {
  assert.equal(shouldBridgeWire('repos', ['crypto', 'ai', 'oss']), false);
  assert.equal(shouldBridgeWire('models', ['crypto', 'ai', 'oss']), false);
});

test('legacy null-wire summaries still bridge (keyword inference handles them)', () => {
  assert.equal(shouldBridgeWire(null, ['crypto', 'ai', 'oss']), true);
  assert.equal(shouldBridgeWire(undefined, ['crypto', 'ai', 'oss']), true);
});
