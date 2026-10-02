import type { PoolClient } from 'pg';
import { getPool } from './index';

/**
 * Schema version 5. Idempotent and safe on rows that already exist:
 * created_at is filled by the column default (one timestamp for the
 * pre-existing queue), sent_at is left null, and the status check is a
 * superset of the previous values.
 */
export async function applyPacedDistributionSchema(client: PoolClient): Promise<void> {
  await client.query(`ALTER TABLE publication_queue ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await client.query(`ALTER TABLE distribution_logs ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ`);
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
        WHERE con.conrelid = 'publication_queue'::regclass
          AND con.contype = 'c'
          AND att.attname = 'status'
      LOOP
        EXECUTE format('ALTER TABLE publication_queue DROP CONSTRAINT %I', name);
      END LOOP;
    END $$
  `);
  await client.query(`
    ALTER TABLE publication_queue
    ADD CONSTRAINT publication_queue_status_check
    CHECK (status IN ('queued', 'running', 'done', 'review', 'withheld'))
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_publication_queue_due
    ON publication_queue (available_at)
    WHERE status = 'queued'
  `);
}

export async function ensurePacedDistribution(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('LOCK TABLE publication_queue, distribution_logs IN SHARE ROW EXCLUSIVE MODE');
    await applyPacedDistributionSchema(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
