/**
 * Schema version 8. The Telegram text is frozen on the queue row so a
 * curator can read it before the worker sends it.
 */
import type { PoolClient } from 'pg';
import { getPool } from './index';

export async function applyPublicationPostSchema(client: PoolClient): Promise<void> {
  await client.query(`ALTER TABLE publication_queue ADD COLUMN IF NOT EXISTS post_text TEXT`);
  await client.query(`ALTER TABLE publication_queue ADD COLUMN IF NOT EXISTS generated_at TIMESTAMPTZ`);
  await client.query(`ALTER TABLE publication_queue ADD COLUMN IF NOT EXISTS model TEXT`);
  await client.query(`ALTER TABLE publication_queue ADD COLUMN IF NOT EXISTS check_result JSONB`);
  await client.query(`ALTER TABLE publication_queue ADD COLUMN IF NOT EXISTS verifier_result JSONB`);
}

export async function ensurePublicationPostColumns(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('LOCK TABLE publication_queue IN SHARE ROW EXCLUSIVE MODE');
    await applyPublicationPostSchema(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
