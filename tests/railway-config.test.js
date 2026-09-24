const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const railway = JSON.parse(fs.readFileSync(path.join(__dirname, '../railway.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));

// Railway admits a deploy once this path returns 200. /ready checks the DB and
// the startup migrations; /health is a static liveness probe that always passes.
test('Railway gates deploys on /ready, not the static /health probe', () => {
  assert.equal(railway.deploy.healthcheckPath, '/ready');
});

// `npm run start` put npm and sh between Railway and node, and SIGTERM never
// reached the shutdown handler in server.ts. Railway's default drain is 0s.
test('Railway starts node directly and gives the shutdown handler time to run', () => {
  assert.equal(railway.deploy.startCommand, pkg.scripts.start);
  assert.match(railway.deploy.startCommand, /^node /);
  assert.ok(railway.deploy.drainingSeconds > 10, 'drain must outlast the 10s forced exit in server.ts');
});

test('Railway restarts the service after any exit', () => {
  assert.equal(railway.deploy.restartPolicyType, 'ALWAYS');
});
