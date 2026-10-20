import type { PoolClient } from 'pg';
import { sqlEnumList } from '../types/intake';
import { ENTRY_LIFECYCLES } from '../types/lifecycle';

/**
 * Schema version 12. lifecycle is open|forthcoming|closed|unknown.
 * opening_date is the stated date intake starts, when the source gives one.
 * Null is allowed so rows written before this column existed stay unchanged
 * and keep today's send behaviour.
 */
export async function applyEntryLifecycleSchema(client: PoolClient): Promise<void> {
  await client.query(`ALTER TABLE scan_entries ADD COLUMN IF NOT EXISTS lifecycle TEXT`);
  await client.query(`ALTER TABLE scan_entries ADD COLUMN IF NOT EXISTS opening_date DATE`);
  await client.query(`ALTER TABLE scan_entries DROP CONSTRAINT IF EXISTS scan_entries_lifecycle_check`);
  await client.query(`
    ALTER TABLE scan_entries
    ADD CONSTRAINT scan_entries_lifecycle_check
    CHECK (lifecycle IS NULL OR lifecycle IN (${sqlEnumList(ENTRY_LIFECYCLES)}))
  `);
}

export async function ensureEntryLifecycleColumns(): Promise<void> {
  const { getPool } = await import('./index');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('LOCK TABLE scan_entries IN SHARE ROW EXCLUSIVE MODE');
    await applyEntryLifecycleSchema(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
