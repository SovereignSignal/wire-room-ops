import type { PoolClient } from 'pg';
import { sqlEnumList } from '../types/intake';
import { WIRE_AREAS } from '../types/wire-area';

/**
 * Schema version 10. wire_area gates the Telegram wires (1–6 or out).
 * classification GRANT stays the open-program label that feeds grants.watch.
 * Null is allowed so rows decided before this column existed stay unchanged.
 */
export async function applyWireAreaSchema(client: PoolClient): Promise<void> {
  await client.query(`ALTER TABLE scan_entries ADD COLUMN IF NOT EXISTS wire_area TEXT`);
  await client.query(`ALTER TABLE scan_entries DROP CONSTRAINT IF EXISTS scan_entries_wire_area_check`);
  await client.query(`
    ALTER TABLE scan_entries
    ADD CONSTRAINT scan_entries_wire_area_check
    CHECK (wire_area IS NULL OR wire_area IN (${sqlEnumList(WIRE_AREAS)}))
  `);
}

export async function ensureWireAreaColumn(): Promise<void> {
  const { getPool } = await import('./index');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('LOCK TABLE scan_entries IN SHARE ROW EXCLUSIVE MODE');
    await applyWireAreaSchema(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
