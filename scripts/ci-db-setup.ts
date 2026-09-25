/**
 * CI test-database bootstrap.
 * Runs the same explicit migration command as release preparation against
 * DATABASE_URL. Application startup subsequently verifies its schema version.
 */
import { migrateDatabase } from '../src/db/startup-migrations';
import { closePool } from '../src/db';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be set');
  }
  await migrateDatabase();
  await closePool();
  console.log('[CI] Database schema ready');
}

main().catch((err) => {
  console.error('[CI] DB setup failed:', err);
  process.exit(1);
});
