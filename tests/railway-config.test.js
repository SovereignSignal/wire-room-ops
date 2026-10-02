const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const railway = JSON.parse(fs.readFileSync(path.join(root, 'railway.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const migrate = fs.readFileSync(path.join(root, 'src/scripts/migrate-database.ts'), 'utf8');
const startup = fs.readFileSync(path.join(root, 'src/db/startup-migrations.ts'), 'utf8');

// railway.json is read on deploy and overrides the same keys in the dashboard.
// Keep the run settings in the file so a pre-deploy entry cannot drop them.
test('Railway migrates the schema before starting a release', () => {
  assert.equal(railway.build.builder, 'NIXPACKS');
  assert.equal(railway.deploy.startCommand, 'node dist/index.js');
  assert.equal(railway.deploy.startCommand, pkg.scripts.start);
  assert.equal(railway.deploy.healthcheckPath, '/ready');
  assert.equal(railway.deploy.healthcheckTimeout, 300);
  assert.equal(railway.deploy.restartPolicyType, 'ALWAYS');
  assert.ok(railway.deploy.drainingSeconds > 10, 'drain must outlast the 10s forced exit in server.ts');
  assert.equal(railway.deploy.preDeployCommand, 'node dist/scripts/migrate-database.js --apply');
  assert.equal(railway.deploy.preDeployTimeoutSeconds, 300);
  assert.equal(fs.existsSync(path.join(root, 'railway.toml')), false);
  assert.equal(fs.existsSync(path.join(root, '.railway/railway.ts')), false);
});

// ts-node is a devDependency, so the release command has to be the compiled
// script. It uses the process DATABASE_URL and exits 1 on failure.
test('the release migration is the compiled script and fails closed', () => {
  assert.match(migrate, /DATABASE_URL must be supplied for migration/);
  assert.match(migrate, /process\.exit\(1\)/);
  assert.doesNotMatch(migrate, /startServer/);
  assert.doesNotMatch(railway.deploy.preDeployCommand, /ts-node|npm run db:migrate/);
  assert.match(startup, /version === SCHEMA_VERSION\) return/);
});

// `npm run start` put npm and sh between Railway and node, and SIGTERM never
// reached the shutdown handler in server.ts. The service's start command is
// this script's text, so it has to stay a bare node invocation.
test('the start script runs node directly', () => {
  assert.equal(pkg.scripts.start, 'node dist/index.js');
});
