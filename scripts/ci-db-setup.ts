/**
 * CI database bootstrap.
 *
 * Creates the schema the integration tests depend on, using the same
 * ensure-* migrations the server runs at startup. Run with DATABASE_URL
 * pointing at a disposable Postgres (the CI service container).
 *
 *   npx ts-node scripts/ci-db-setup.ts
 */

import {
  ensureFeedsTable,
  ensureScanTables,
  ensureClassificationColumns,
  ensureScanPromptsTable,
  ensureScheduleTable,
  ensureDistributionTables,
  ensureAutoSummarizeFailedColumn,
  ensureOperatorNotesColumn,
  ensureAppStateTable,
  ensureMonitoredAccountsTable,
  closePool,
} from '../src/db';
import { ensureEntryActionColumns } from '../src/services/entry-actions';
import { getPool } from '../src/db';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be set');
  }

  await ensureFeedsTable();
  await ensureScanTables();
  await ensureClassificationColumns();
  await ensureScanPromptsTable();
  await ensureScheduleTable();
  await ensureDistributionTables();
  await ensureAutoSummarizeFailedColumn();
  await ensureOperatorNotesColumn();
  await ensureAppStateTable();
  await ensureMonitoredAccountsTable();
  await ensureEntryActionColumns();

  console.log('[CI] Database schema ready');
}

main()
  .then(() => closePool())
  .catch(err => {
    console.error('[CI] Database setup failed:', err);
    process.exit(1);
  });
