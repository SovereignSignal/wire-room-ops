import { closePool } from '../db';
import { migrateDatabase, SCHEMA_VERSION, STARTUP_MIGRATIONS } from '../db/startup-migrations';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply')) throw new Error('Usage: db:migrate [--apply]');
  console.log(JSON.stringify({
    mode: args.includes('--apply') ? 'apply' : 'dry-run',
    schemaVersion: SCHEMA_VERSION,
    steps: STARTUP_MIGRATIONS.map(step => ({ name: step.name, version: step.version ?? 1 })),
    upgradePolicy: 'Apply only steps newer than the recorded schema version',
    connection: 'DATABASE_URL supplied to this process only',
    startsApplication: false,
  }, null, 2));
  if (!args.includes('--apply')) return;
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be supplied for migration');
  try {
    await migrateDatabase();
    console.log(`[Schema] Version ${SCHEMA_VERSION} ready`);
  } finally {
    await closePool();
  }
}

main().catch(error => {
  console.error('[Schema] Migration failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
