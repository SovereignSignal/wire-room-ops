/**
 * Schema version 13. summaries.title was varchar(100) (tele-sum).
 * Approved entry names are written there and can be longer, so the column is text.
 * A database without that sibling table is left unchanged.
 */
import type { PoolClient } from 'pg';

export async function applySummaryTitleSchema(client: PoolClient): Promise<void> {
  await client.query(`ALTER TABLE summaries ALTER COLUMN title TYPE TEXT`);
}

export async function ensureSummaryTitleColumn(): Promise<void> {
  const { getPool } = await import('./index');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const found = await client.query<{ rel: string | null }>(`SELECT to_regclass('summaries') AS rel`);
    if (found.rows[0]?.rel) {
      await client.query(`SET LOCAL lock_timeout = '5s'`);
      await client.query('LOCK TABLE summaries IN SHARE ROW EXCLUSIVE MODE');
      await applySummaryTitleSchema(client);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
