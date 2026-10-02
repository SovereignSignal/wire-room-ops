import { config } from '../config';
import { closePool, getPool } from '../db';
import { migrateDatabase, SCHEMA_VERSION, STARTUP_MIGRATIONS } from '../db/startup-migrations';
import { describeConnection, resolveMigrationConnection, resolveRuntimeRole } from '../db/migration-connection';
import { applyRuntimeGrants, roleExists, verifyRuntimeGrants } from '../db/runtime-grants';

/**
 * Release migration command. Runs as the schema owner (MIGRATION_DATABASE_URL,
 * falling back to DATABASE_URL), applies pending schema steps, then re-applies
 * and verifies the runtime role's grants. Exits 1 on any failure so Railway
 * keeps the previous deployment serving. Never prints a connection string.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply')) throw new Error('Usage: db:migrate [--apply]');
  const apply = args.includes('--apply');
  const connection = resolveMigrationConnection();
  const runtimeRole = connection ? resolveRuntimeRole(connection) : null;
  const described = connection ? describeConnection(connection.url) : null;
  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    schemaVersion: SCHEMA_VERSION,
    steps: STARTUP_MIGRATIONS.map(step => ({ name: step.name, version: step.version ?? 1 })),
    upgradePolicy: 'Apply only steps newer than the recorded schema version',
    connection: connection
      ? { source: connection.source, user: described?.user, host: described?.host, database: described?.database }
      : 'not set (MIGRATION_DATABASE_URL or DATABASE_URL)',
    runtimeRole: runtimeRole ?? 'same login as migration; grants skipped',
    startsApplication: false,
  }, null, 2));
  if (!apply) return;
  if (!connection) throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL must be supplied for migration');

  // The pool reads config.database.url once. Point it at the owner login before first use.
  config.database.url = connection.url;
  try {
    console.log(`[Schema] Migrating as ${described?.user ?? 'unknown'} via ${connection.source}`);
    await migrateDatabase();
    console.log(`[Schema] Version ${SCHEMA_VERSION} ready`);
    if (runtimeRole) {
      const client = await getPool().connect();
      try {
        if (!(await roleExists(client, runtimeRole))) {
          throw new Error(`Runtime role "${runtimeRole}" does not exist; create it before deploying`);
        }
        await applyRuntimeGrants(client, runtimeRole);
        const missing = await verifyRuntimeGrants(client, runtimeRole);
        if (missing.length) {
          throw new Error(`Runtime role "${runtimeRole}" is missing privileges: ${missing.join(', ')}`);
        }
        console.log(`[Schema] Runtime grants verified for role ${runtimeRole}`);
      } finally {
        client.release();
      }
    } else {
      console.log('[Schema] Runtime grants skipped: migration and runtime use the same login');
    }
  } finally {
    await closePool();
  }
}

main().catch(error => {
  console.error('[Schema] Migration failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
