require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Pool } = require('pg');

const dbUrl = process.env.DATABASE_URL;

test('schema migration and normal runtime use separate privileges', { skip: !dbUrl }, async () => {
  const suffix = `${process.pid}_${randomBytes(4).toString('hex')}`;
  const database = `wro_access_test_${suffix}`;
  const role = `wro_access_test_${suffix}`;
  const password = randomBytes(24).toString('hex');
  const admin = new Pool({ connectionString: dbUrl });
  let owner, runtime;
  const db = require('../src/db');
  const { config } = require('../src/config');
  const originalUrl = config.database.url;
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(dbUrl);
    url.pathname = `/${database}`;
    const ownerUrl = url.toString();
    owner = new Pool({ connectionString: url.toString() });
    await db.closePool();
    config.database.url = ownerUrl;
    const schema = require('../src/db/startup-migrations');
    await assert.rejects(schema.verifyDatabaseSchema(), /wro_schema_migrations/);
    assert.equal(schema.getStartupMigrationHealth().failed, 1);

    const failure = { name: 'injected-failure', run: async () => { throw new Error('test failure'); } };
    schema.STARTUP_MIGRATIONS.push(failure);
    try {
      await assert.rejects(schema.migrateDatabase(), /injected-failure/);
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM wro_schema_migrations')).rows[0].n, 0);
    } finally {
      schema.STARTUP_MIGRATIONS.pop();
    }
    await schema.migrateDatabase();
    await schema.migrateDatabase();
    assert.equal((await owner.query('SELECT count(*)::int AS n FROM wro_schema_migrations')).rows[0].n, 1);

    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    await owner.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await owner.query(`GRANT SELECT ON wro_schema_migrations, integration_config TO ${role}`);
    await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON generated_files, scan_entries, org_profiles, discovered_contacts TO ${role}`);
    await owner.query(`GRANT USAGE ON SEQUENCE org_profiles_id_seq, discovered_contacts_id_seq TO ${role}`);
    url.username = role;
    url.password = password;
    runtime = new Pool({ connectionString: url.toString() });
    await db.closePool();
    config.database.url = url.toString();
    await schema.verifyDatabaseSchema();
    assert.deepEqual(schema.getStartupMigrationHealth(), { ran: true, failed: 0, errors: [] });
    for (const sql of [
      'CREATE TABLE denied(id int)',
      'ALTER TABLE scan_entries ADD COLUMN denied text',
      'UPDATE wro_schema_migrations SET version=version',
      'INSERT INTO wro_schema_migrations(version) VALUES (99)',
    ]) await assert.rejects(runtime.query(sql), error => error.code === '42501');

    const { storeFile, getFile } = require('../src/services/storage');
    const file = await storeFile('permission test', { start: new Date(), end: new Date() }, 'permission-test.md');
    assert.equal((await getFile(file.id)).content, 'permission test');
    const { runOrgExtraction } = require('../src/services/org-extractor');
    assert.equal((await runOrgExtraction()).processed, 0);
    const { runContactDiscovery, recordDiscoveredContact } = require('../src/services/contact-discovery');
    assert.equal((await runContactDiscovery(runtime)).orgsProcessed, 0);
    const org = await runtime.query("INSERT INTO org_profiles(name, slug) VALUES ('Permission test', 'permission-test') RETURNING id");
    await recordDiscoveredContact(runtime, { orgId: org.rows[0].id, name: 'Fixture', xHandle: null, notionPageId: null });
    assert.equal((await runtime.query('SELECT count(*)::int AS n FROM discovered_contacts')).rows[0].n, 1);

    await owner.query('UPDATE wro_schema_migrations SET version=version+1');
    await assert.rejects(schema.verifyDatabaseSchema(), /Expected schema version/);
    await db.closePool();
    config.database.url = ownerUrl;
    await assert.rejects(schema.migrateDatabase(), /refusing to downgrade/);

    await owner.query('ALTER TABLE distribution_config RENAME TO distribution_config_current');
    await owner.query('CREATE TABLE distribution_config(legacy_value text)');
    await owner.query("INSERT INTO distribution_config VALUES ('preserve me')");
    await assert.rejects(db.ensureDistributionTables(), /explicit data-preserving migration/);
    assert.equal((await owner.query('SELECT legacy_value FROM distribution_config')).rows[0].legacy_value, 'preserve me');
    assert.equal((await owner.query("SELECT to_regclass('public.distribution_logs') AS t")).rows[0].t, 'distribution_logs');
  } finally {
    await db.closePool();
    config.database.url = originalUrl;
    if (runtime) await runtime.end();
    if (owner) await owner.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  }
});
