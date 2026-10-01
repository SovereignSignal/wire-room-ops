const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// The run settings live on the Railway service itself (see "Railway run
// settings" in CLAUDE.md). A Config as Code file overrides them for as long as
// Railway still reads it, then stops applying on 2026-12-01, so one must not
// come back.
test('no Railway Config as Code file overrides the service settings', () => {
  for (const name of ['railway.json', 'railway.toml']) {
    assert.equal(fs.existsSync(path.join(root, name)), false, `${name} must not exist`);
  }
});

// `npm run start` put npm and sh between Railway and node, and SIGTERM never
// reached the shutdown handler in server.ts. The service's start command is
// this script's text, so it has to stay a bare node invocation.
test('the start script runs node directly', () => {
  assert.equal(pkg.scripts.start, 'node dist/index.js');
});
