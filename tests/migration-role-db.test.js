require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const { SCHEMA_VERSION } = require('../src/db/startup-migrations');
const grants = require('../src/db/runtime-grants');

const dbUrl = process.env.DATABASE_URL;
const root = path.join(__dirname, '..');

function runMigrate(env, args = ['--apply']) {
  const result = spawnSync(process.execPath, [
    '-r', 'ts-node/register/transpile-only', 'src/scripts/migrate-database.ts', ...args,
  ], {
    cwd: root,
    encoding: 'utf8',
    // A clean environment: no .env override of the URLs under test.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', ...env },
  });
  return result;
}

test('the release migration runs as the owner and leaves the runtime role usable', { skip: !dbUrl }, async () => {
  const suffix = `${process.pid}_${randomBytes(4).toString('hex')}`;
  const database = `wro_migrate_test_${suffix}`;
  const role = `wro_rt_${suffix}`;
  const password = randomBytes(24).toString('hex');
  const admin = new Pool({ connectionString: dbUrl });
  let owner;
  let runtime;
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    const ownerUrlObj = new URL(dbUrl);
    ownerUrlObj.pathname = `/${database}`;
    const ownerUrl = ownerUrlObj.toString();
    const ownerUser = decodeURIComponent(ownerUrlObj.username);
    const runtimeUrlObj = new URL(ownerUrl);
    runtimeUrlObj.username = role;
    runtimeUrlObj.password = password;
    const runtimeUrl = runtimeUrlObj.toString();
    owner = new Pool({ connectionString: ownerUrl });
    await owner.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');

    // 1. The restricted login cannot migrate: the command fails closed.
    const denied = runMigrate({ DATABASE_URL: runtimeUrl });
    assert.notEqual(denied.status, 0, denied.stdout + denied.stderr);
    assert.match(denied.stderr, /\[Schema\] Migration failed: permission denied/);
    assert.equal((await owner.query("SELECT to_regclass('public.wro_schema_migrations') AS t")).rows[0].t, null);

    // 2. Dry run never needs the database and reports the chosen login only.
    const dry = runMigrate({ MIGRATION_DATABASE_URL: ownerUrl, DATABASE_URL: runtimeUrl }, []);
    assert.equal(dry.status, 0, dry.stderr);
    const plan = JSON.parse(dry.stdout);
    assert.equal(plan.mode, 'dry-run');
    assert.equal(plan.connection.source, 'MIGRATION_DATABASE_URL');
    assert.equal(plan.connection.user, ownerUser);
    assert.equal(plan.runtimeRole, role);
    assert.doesNotMatch(dry.stdout, new RegExp(password));

    // 3. The owner login migrates and grants the runtime role.
    const first = runMigrate({ MIGRATION_DATABASE_URL: ownerUrl, DATABASE_URL: runtimeUrl });
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(first.stdout, new RegExp(`\\[Schema\\] Migrating as ${ownerUser} via MIGRATION_DATABASE_URL`));
    assert.match(first.stdout, new RegExp(`\\[Schema\\] Version ${SCHEMA_VERSION} ready`));
    assert.match(first.stdout, new RegExp(`\\[Schema\\] Runtime grants verified for role ${role}`));
    assert.doesNotMatch(first.stdout + first.stderr, new RegExp(password));
    assert.doesNotMatch(first.stdout + first.stderr, /postgres(ql)?:\/\//);

    const versions = (await owner.query('SELECT version FROM wro_schema_migrations ORDER BY version')).rows;
    assert.deepEqual(versions.map(row => row.version), [SCHEMA_VERSION]);
    const columns = (await owner.query(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'publication_queue' AND column_name = 'created_at')
          OR (table_name = 'distribution_logs' AND column_name = 'sent_at'))
      ORDER BY table_name`)).rows;
    assert.deepEqual(columns, [
      { table_name: 'distribution_logs', column_name: 'sent_at' },
      { table_name: 'publication_queue', column_name: 'created_at' },
    ]);
    assert.equal((await owner.query(
      "SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_publication_queue_due'",
    )).rows.length, 1);

    const client = await owner.connect();
    try {
      assert.deepEqual(await grants.verifyRuntimeGrants(client, role), []);
    } finally {
      client.release();
    }

    // 4. The runtime role can do its job and still cannot change the schema.
    runtime = new Pool({ connectionString: runtimeUrl });
    await runtime.query("INSERT INTO app_state(key, value) VALUES ('migration-role-test', '{}'::jsonb)");
    const seq = await runtime.query(
      "INSERT INTO scan_entries(name, wire, status, scan_source, source_url, description, prompt_variant, scan_date) VALUES ('t', 'crypto', 'approved', 'manual-intake', 'https://example.org/t', 'd', 'N', CURRENT_DATE) RETURNING id",
    );
    await runtime.query(
      'INSERT INTO publication_queue(entry_id, status) VALUES ($1, $2)', [seq.rows[0].id, 'withheld'],
    );
    await runtime.query(
      "INSERT INTO distribution_logs(entry_id, channel, wire, status, external_id) VALUES ($1, 'telegram', 'crypto', 'success', '42')",
      [seq.rows[0].id],
    );
    assert.equal((await runtime.query('SELECT version FROM wro_schema_migrations')).rows[0].version, SCHEMA_VERSION);
    for (const sql of [
      'ALTER TABLE publication_queue ADD COLUMN denied text',
      'INSERT INTO wro_schema_migrations(version) VALUES (99)',
      'CREATE TABLE denied(id int)',
    ]) await assert.rejects(runtime.query(sql), error => error.code === '42501');

    // 5. Re-running is a no-op that keeps rows and the version record intact.
    const before = {
      queue: (await owner.query('SELECT entry_id, status, available_at, created_at, updated_at FROM publication_queue')).rows,
      logs: (await owner.query('SELECT id, entry_id, external_id, created_at, sent_at FROM distribution_logs')).rows,
    };
    await owner.query(`REVOKE INSERT ON publication_queue FROM ${role}`);
    const second = runMigrate({ MIGRATION_DATABASE_URL: ownerUrl, DATABASE_URL: runtimeUrl });
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.match(second.stdout, /Runtime grants verified/);
    assert.deepEqual(
      (await owner.query('SELECT version FROM wro_schema_migrations ORDER BY version')).rows.map(row => row.version),
      [SCHEMA_VERSION],
    );
    assert.deepEqual(
      (await owner.query('SELECT entry_id, status, available_at, created_at, updated_at FROM publication_queue')).rows,
      before.queue,
    );
    assert.deepEqual(
      (await owner.query('SELECT id, entry_id, external_id, created_at, sent_at FROM distribution_logs')).rows,
      before.logs,
    );
    // The revoked grant was re-applied.
    assert.equal((await owner.query(
      'SELECT has_table_privilege($1, $2, $3) AS ok', [role, 'public.publication_queue', 'INSERT'],
    )).rows[0].ok, true);

    // 6. A missing runtime role fails the release instead of starting an app that cannot read.
    const ghost = runMigrate({ MIGRATION_DATABASE_URL: ownerUrl, DATABASE_URL: runtimeUrl, RUNTIME_DATABASE_ROLE: `${role}_missing` });
    assert.notEqual(ghost.status, 0);
    assert.match(ghost.stderr, /does not exist; create it before deploying/);
  } finally {
    if (runtime) await runtime.end();
    if (owner) await owner.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  }
});
