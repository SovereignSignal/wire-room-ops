/**
 * THE single ordered list of startup schema migrations.
 *
 * The explicit migration command and CI iterate this list. Application startup
 * only verifies the recorded schema version; it never changes table structure.
 *
 * Adding a table/column? Add ONE entry here and increment SCHEMA_VERSION.
 * Do NOT call ensure* functions ad hoc from startup code paths; scattered
 * callers are how the June-2026 constraint-drift incidents happened.
 *
 * Order matters: scan-tables must exist before the column ALTERs that follow,
 * and feeds before anything that reads the wire list.
 */
import {
  getPool,
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
import { ensureProgramsTable } from '../services/program-identity';
import { ensureIntegrationConfigTable } from '../services/notion-sync';
import { ensureEntryActionColumns } from '../services/entry-actions';
import { ensureApiProviderTables } from '../services/api-provider';
import { ensureApiUsageTables } from '../services/api-usage';
import { ensureTelegramIntakeReceiptsTable } from '../services/telegram-intake-receipts';
import { ensureGrantsIntelTables } from '../routes/grants-intel';
import { ensureFilesTable } from '../services/storage';
import { ensureDiscoveredContactsTable } from '../services/contact-discovery';

// Increment whenever the schema contract changes, including enum constants.
export const SCHEMA_VERSION = 1;

export const STARTUP_MIGRATIONS: ReadonlyArray<{ name: string; run: () => Promise<void> }> = [
  { name: 'sessions', run: ensureSessionsTable },
  { name: 'feeds', run: ensureFeedsTable },
  { name: 'scan-tables', run: ensureScanTables },
  { name: 'classification-columns', run: ensureClassificationColumns },
  { name: 'telegram-intake-receipts', run: ensureTelegramIntakeReceiptsTable },
  { name: 'grants-intel', run: ensureGrantsIntelTables },
  { name: 'scan-prompts', run: ensureScanPromptsTable },
  { name: 'schedules', run: ensureScheduleTable },
  { name: 'distribution', run: ensureDistributionTables },
  { name: 'org-profiles', run: ensureOrgProfilesTable },
  { name: 'discovered-contacts', run: () => ensureDiscoveredContactsTable(getPool()) },
  { name: 'programs', run: ensureProgramsTable },
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
  { name: 'generated-files', run: ensureFilesTable },
];

export interface StartupMigrationHealth {
  ran: boolean;
  failed: number;
  errors: string[];
}

let lastStartupMigrationHealth: StartupMigrationHealth = {
  ran: false,
  failed: 0,
  errors: [],
};

/** Last migration or read-only schema check. Used by /ready. */
export function getStartupMigrationHealth(): StartupMigrationHealth {
  return lastStartupMigrationHealth;
}

/** Read-only startup gate. A missing/outdated migration must stop background work. */
export async function verifyDatabaseSchema(): Promise<void> {
  try {
    const { rows } = await getPool().query<{ version: number }>(
      'SELECT version FROM public.wro_schema_migrations ORDER BY version DESC LIMIT 1',
    );
    if (rows[0]?.version !== SCHEMA_VERSION) {
      throw new Error(`Expected schema version ${SCHEMA_VERSION}; run the database migration command before starting this release`);
    }
    lastStartupMigrationHealth = { ran: true, failed: 0, errors: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lastStartupMigrationHealth = { ran: true, failed: 1, errors: [message] };
    throw new Error(`[Schema] ${message}`);
  }
}

/** Run with a separately supplied migration-owner connection, never from the server. */
export async function migrateDatabase(): Promise<void> {
  const client = await getPool().connect();
  let locked = false;
  try {
    // A session lock covers the ensure functions even though they use pooled clients.
    const { rows } = await client.query('SELECT pg_try_advisory_lock(184736, 1) AS locked');
    locked = rows[0].locked;
    if (!locked) throw new Error('Another database migration is already running');
    await client.query(`CREATE TABLE IF NOT EXISTS public.wro_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const applied = await client.query<{ version: number }>('SELECT version FROM public.wro_schema_migrations ORDER BY version DESC LIMIT 1');
    if ((applied.rows[0]?.version ?? 0) > SCHEMA_VERSION) {
      throw new Error('Database schema is newer than this migration command; refusing to downgrade');
    }
    if (applied.rows[0]?.version === SCHEMA_VERSION) return;
    await runStartupMigrations({ fatal: true });
    await client.query('INSERT INTO public.wro_schema_migrations(version) VALUES ($1)', [SCHEMA_VERSION]);
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock(184736, 1)');
    } finally {
      client.release();
    }
  }
}

/**
 * Run every startup migration in order.
 * fatal=true (release command and CI): any failure throws before recording the
 * version. Diagnostic callers may collect every error with fatal=false.
 */
export async function runStartupMigrations(opts: { fatal?: boolean } = {}): Promise<void> {
  const errors: string[] = [];
  for (const m of STARTUP_MIGRATIONS) {
    try {
      await m.run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${m.name}: ${message}`);
      if (opts.fatal) {
        lastStartupMigrationHealth = { ran: true, failed: errors.length, errors };
        throw new Error(`[Migrations] '${m.name}' failed: ${message}`);
      }
      console.error(`[Migrations] '${m.name}' failed (non-fatal):`, err);
    }
  }
  lastStartupMigrationHealth = { ran: true, failed: errors.length, errors };
  console.log(`[Migrations] ${STARTUP_MIGRATIONS.length} startup migrations processed`);
}
