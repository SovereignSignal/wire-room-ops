require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  resolveMigrationConnection,
  describeConnection,
  resolveRuntimeRole,
} = require('../src/db/migration-connection');

const OWNER = 'postgresql://wro_owner:owner-secret@db.internal:5432/railway';
const RUNTIME = 'postgresql://wro_runtime:runtime-secret@db.internal:5432/railway';

test('the migration prefers MIGRATION_DATABASE_URL and falls back to DATABASE_URL', () => {
  assert.deepEqual(resolveMigrationConnection({ MIGRATION_DATABASE_URL: OWNER, DATABASE_URL: RUNTIME }),
    { url: OWNER, source: 'MIGRATION_DATABASE_URL' });
  assert.deepEqual(resolveMigrationConnection({ DATABASE_URL: RUNTIME }), { url: RUNTIME, source: 'DATABASE_URL' });
  assert.deepEqual(resolveMigrationConnection({ MIGRATION_DATABASE_URL: '  ', DATABASE_URL: RUNTIME }),
    { url: RUNTIME, source: 'DATABASE_URL' });
  assert.equal(resolveMigrationConnection({}), null);
});

test('a described connection names the login without the secret', () => {
  const described = describeConnection(OWNER);
  assert.deepEqual(described, { user: 'wro_owner', host: 'db.internal', database: 'railway' });
  assert.doesNotMatch(JSON.stringify(described), /secret/);
  assert.deepEqual(describeConnection('not a url'), { user: null, host: null, database: null });
  assert.equal(describeConnection('postgresql://w%40o:x@h/d').user, 'w@o');
});

test('the runtime role is the DATABASE_URL login when it differs from the migration login', () => {
  const owner = { url: OWNER, source: 'MIGRATION_DATABASE_URL' };
  assert.equal(resolveRuntimeRole(owner, { DATABASE_URL: RUNTIME }), 'wro_runtime');
  assert.equal(resolveRuntimeRole(owner, { DATABASE_URL: OWNER }), null);
  assert.equal(resolveRuntimeRole(owner, {}), null);
  assert.equal(resolveRuntimeRole(owner, { DATABASE_URL: RUNTIME, RUNTIME_DATABASE_ROLE: 'explicit' }), 'explicit');
  const single = { url: RUNTIME, source: 'DATABASE_URL' };
  assert.equal(resolveRuntimeRole(single, { DATABASE_URL: RUNTIME }), null);
  assert.equal(resolveRuntimeRole(single, { DATABASE_URL: RUNTIME, RUNTIME_DATABASE_ROLE: 'explicit' }), 'explicit');
});

// The owner credential is visible to the whole Railway service, so only the
// migration command may read it. The app must keep running as DATABASE_URL.
test('only the migration command reads MIGRATION_DATABASE_URL', () => {
  const root = path.join(__dirname, '..', 'src');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      const rel = path.relative(root, full);
      if (rel === 'db/migration-connection.ts') continue;
      const source = fs.readFileSync(full, 'utf8');
      if (/MIGRATION_DATABASE_URL|RUNTIME_DATABASE_ROLE/.test(source) && !/^scripts\/migrate-database\.ts$/.test(rel)) {
        offenders.push(rel);
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
  const appConfig = fs.readFileSync(path.join(root, 'config/index.ts'), 'utf8');
  assert.match(appConfig, /url: process\.env\.DATABASE_URL \|\| ''/);
});
