/**
 * CI test-database bootstrap.
 * Runs THE canonical startup-migration list (src/db/startup-migrations.ts) —
 * the exact schema path production boots with — against DATABASE_URL, fatally.
 */
import { runStartupMigrations } from '../src/db/startup-migrations';
import { closePool } from '../src/db';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be set');
  }
  await runStartupMigrations({ fatal: true });
  await closePool();
  console.log('[CI] Database schema ready');
}

main().catch((err) => {
  console.error('[CI] DB setup failed:', err);
  process.exit(1);
});
