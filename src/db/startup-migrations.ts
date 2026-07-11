/**
 * THE single ordered list of startup schema migrations.
 *
 * Three callers iterate this exact list, in this exact order:
 *   1. src/server.ts startServer()      — production boot (non-fatal per step)
 *   2. scripts/ci-db-setup.ts           — CI test-database bootstrap (fatal)
 *   3. (scheduler init no longer runs its own ensures — it relies on this)
 *
 * Adding a table/column? Add ONE entry here — every environment picks it up.
 * Do NOT call ensure* functions ad hoc from startup code paths; scattered
 * callers are how the June-2026 constraint-drift incidents happened.
 *
 * Order matters: scan-tables must exist before the column ALTERs that follow,
 * and feeds before anything that reads the wire list.
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
  ensureSourceNeedsVerificationColumn,
  ensureAppStateTable,
  ensureMonitoredAccountsTable,
  ensureWatchSurfacesTable,
} from './index';
import { ensureSessionsTable } from '../services/auth';
import { ensureOrgProfilesTable } from '../services/org-extractor';
import { ensureIntegrationConfigTable } from '../services/notion-sync';
import { ensureEntryActionColumns } from '../services/entry-actions';
import { ensureApiProviderTables } from '../services/api-provider';
import { ensureApiUsageTables } from '../services/api-usage';
import { ensureTelegramIntakeReceiptsTable } from '../services/telegram-intake-receipts';

export const STARTUP_MIGRATIONS: ReadonlyArray<{ name: string; run: () => Promise<void> }> = [
  { name: 'sessions', run: ensureSessionsTable },
  { name: 'feeds', run: ensureFeedsTable },
  { name: 'scan-tables', run: ensureScanTables },
  { name: 'telegram-intake-receipts', run: ensureTelegramIntakeReceiptsTable },
  { name: 'classification-columns', run: ensureClassificationColumns },
  { name: 'scan-prompts', run: ensureScanPromptsTable },
  { name: 'schedules', run: ensureScheduleTable },
  { name: 'distribution', run: ensureDistributionTables },
  { name: 'org-profiles', run: ensureOrgProfilesTable },
  { name: 'watch-surfaces', run: ensureWatchSurfacesTable },
  { name: 'integration-config', run: ensureIntegrationConfigTable },
  { name: 'entry-action-columns', run: ensureEntryActionColumns },
  { name: 'auto-summarize-failed-column', run: ensureAutoSummarizeFailedColumn },
  { name: 'operator-notes-column', run: ensureOperatorNotesColumn },
  { name: 'source-needs-verification-column', run: ensureSourceNeedsVerificationColumn },
  { name: 'app-state', run: ensureAppStateTable },
  { name: 'monitored-accounts', run: ensureMonitoredAccountsTable },
  { name: 'api-providers', run: ensureApiProviderTables },
  { name: 'api-usage', run: ensureApiUsageTables },
];

/**
 * Run every startup migration in order.
 * fatal=false (production boot): a failed step logs and the rest continue —
 * a single bad migration must not prevent the app from serving.
 * fatal=true (CI): any failure throws so the pipeline goes red.
 */
export async function runStartupMigrations(opts: { fatal?: boolean } = {}): Promise<void> {
  for (const m of STARTUP_MIGRATIONS) {
    try {
      await m.run();
    } catch (err) {
      if (opts.fatal) {
        throw new Error(`[Migrations] '${m.name}' failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      console.error(`[Migrations] '${m.name}' failed (non-fatal):`, err);
    }
  }
  console.log(`[Migrations] ${STARTUP_MIGRATIONS.length} startup migrations processed`);
}
