import type { PoolClient } from 'pg';

const ACKNOWLEDGED_STATUS_CHECK = `CHECK (status IN ('pending', 'success', 'failed', 'skipped', 'acknowledged'))`;

/**
 * Schema version 9. A failed send can be closed without becoming a success.
 * The destination unique index stays limited to pending and success, so this
 * update does not collide with a receipt that already holds the slot.
 */
export async function applyAcknowledgedDistributionSchema(client: PoolClient): Promise<void> {
  await client.query(`ALTER TABLE distribution_logs ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ`);
  await client.query(`ALTER TABLE distribution_logs ADD COLUMN IF NOT EXISTS acknowledged_by TEXT`);
  await client.query(`ALTER TABLE distribution_logs ADD COLUMN IF NOT EXISTS acknowledged_reason TEXT`);
  await client.query(`
    DO $$
    DECLARE name text;
    BEGIN
      FOR name IN
        SELECT con.conname
        FROM pg_constraint con
        JOIN pg_attribute att
          ON att.attrelid = con.conrelid
         AND att.attnum = ANY (con.conkey)
         AND NOT att.attisdropped
        WHERE con.conrelid = 'distribution_logs'::regclass
          AND con.contype = 'c'
          AND att.attname = 'status'
      LOOP
        EXECUTE format('ALTER TABLE distribution_logs DROP CONSTRAINT %I', name);
      END LOOP;
    END $$
  `);
  await client.query(`
    ALTER TABLE distribution_logs
    ADD CONSTRAINT distribution_logs_status_check
    ${ACKNOWLEDGED_STATUS_CHECK}
  `);
}

export async function ensureAcknowledgedDistribution(): Promise<void> {
  const { getPool } = await import('./index');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('LOCK TABLE distribution_logs IN SHARE ROW EXCLUSIVE MODE');
    await applyAcknowledgedDistributionSchema(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
