import { randomUUID } from 'crypto';
import { getPool } from '../db';
import { distributeEntry } from './distribution';

let running = false;

/** A lease expiring means outcome unknown, never permission to resend. */
export async function reconcileStaleDeliveries(): Promise<void> {
  await getPool().query(`UPDATE distribution_logs SET needs_review = true,
    error_message = COALESCE(error_message, 'Send interrupted; verify destination before retrying')
    WHERE status = 'pending' AND NOT needs_review
      AND (lease_expires_at IS NULL OR lease_expires_at < NOW())`);
}

/** Bounded worker for approvals durably enqueued in the status-change statement. */
export async function drainPublicationQueue(): Promise<void> {
  if (running) return;
  running = true;
  const pool = getPool();
  try {
    await reconcileStaleDeliveries();
    for (let i = 0; i < 10; i++) {
      const token = randomUUID();
      const claimed = await pool.query(`UPDATE publication_queue SET status = 'running',
        attempts = attempts + 1, lease_token = $1, lease_expires_at = NOW() + INTERVAL '20 minutes', updated_at = NOW()
        WHERE entry_id = (SELECT entry_id FROM publication_queue
          WHERE (status = 'queued' AND available_at <= NOW()) OR (status = 'running' AND lease_expires_at < NOW())
          ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING entry_id, attempts`, [token]);
      if (!claimed.rows.length) break;
      const job = claimed.rows[0];
      const heartbeat = setInterval(() => {
        void pool.query(`UPDATE publication_queue SET lease_expires_at = NOW() + INTERVAL '20 minutes' WHERE entry_id = $1 AND lease_token = $2`, [job.entry_id, token]).catch(error => console.error('[PublicationQueue] Lease renewal failed', error));
      }, 60_000);
      heartbeat.unref();
      let state = 'done';
      let error: string | null = null;
      try {
        const entry = (await pool.query("SELECT wire FROM scan_entries WHERE id = $1 AND status = 'approved' AND distributable IS NOT FALSE", [job.entry_id])).rows[0];
        if (entry) {
          const result = await distributeEntry(job.entry_id, entry.wire);
          const unresolved = await pool.query(`SELECT id FROM distribution_logs
            WHERE entry_id = $1 AND status = 'pending'`, [job.entry_id]);
          if (unresolved.rows.length) { state = 'review'; error = 'A send needs verification before retrying'; }
          else if (result.failed || result.skipped || (result.totalEntries === 0 && !(await pool.query("SELECT id FROM distribution_logs WHERE entry_id = $1 AND status = 'success' LIMIT 1", [job.entry_id])).rows.length)) {
            state = 'review'; error = 'No new delivery confirmed; check destinations and receipts';
          }
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        state = job.attempts < 2 ? 'queued' : 'review';
      } finally { clearInterval(heartbeat); }
      await pool.query(`UPDATE publication_queue SET status = $2, error_message = $3,
        available_at = NOW() + INTERVAL '5 minutes', lease_expires_at = NULL, updated_at = NOW()
        WHERE entry_id = $1 AND lease_token = $4`, [job.entry_id, state, error, token]);
    }
  } finally { running = false; }
}

export async function listPublicationReview(): Promise<unknown[]> {
  await reconcileStaleDeliveries();
  return (await getPool().query(`SELECT dl.id, dl.entry_id, se.name, dl.wire, dl.channel,
    dc.name AS destination, dl.external_id, dl.error_message, dl.post_text, dl.created_at
    FROM distribution_logs dl JOIN scan_entries se ON se.id = dl.entry_id
    LEFT JOIN distribution_channels dc ON dc.id = dl.channel_id
    WHERE dl.status = 'pending' AND dl.needs_review ORDER BY dl.created_at`)).rows;
}

/** Human confirmation is recorded; only confirmed non-delivery can be retried. */
export async function resolvePublication(id: number, delivered: boolean, externalId: string | undefined, actor: string): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query(`SELECT * FROM distribution_logs WHERE id = $1
      AND status = 'pending' AND needs_review FOR UPDATE`, [id])).rows[0];
    if (!row) throw new Error('Delivery is not awaiting review');
    if (delivered && row.channel === 'telegram' && !(externalId || row.external_id)) {
      throw new Error('Telegram message ID is required to confirm delivery');
    }
    await client.query(`UPDATE distribution_logs SET status = $2, external_id = COALESCE($3, external_id),
      needs_review = false, resolved_by = $4, resolved_at = NOW(), error_message = $5 WHERE id = $1`,
    [id, delivered ? 'success' : 'failed', externalId || null, actor,
      delivered ? null : 'Operator verified that this message was not delivered']);
    await client.query(`INSERT INTO publication_queue (entry_id) VALUES ($1)
      ON CONFLICT (entry_id) DO UPDATE SET status = 'queued', attempts = 0, lease_token = NULL,
      available_at = NOW(), updated_at = NOW()`, [row.entry_id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function listQueuedPublicationReview(): Promise<unknown[]> {
  return (await getPool().query(`SELECT q.entry_id, se.name, q.error_message FROM publication_queue q
    JOIN scan_entries se ON se.id = q.entry_id WHERE q.status = 'review'
    AND NOT EXISTS (SELECT 1 FROM distribution_logs dl WHERE dl.entry_id = q.entry_id AND dl.status = 'pending')
    ORDER BY q.updated_at`)).rows;
}
export async function retryQueuedPublication(entryId: number): Promise<void> {
  const result = await getPool().query(`UPDATE publication_queue SET status = 'queued', attempts = 0,
    available_at = NOW(), updated_at = NOW() WHERE entry_id = $1 AND status = 'review'
    AND NOT EXISTS (SELECT 1 FROM distribution_logs WHERE entry_id = $1 AND status = 'pending')`, [entryId]);
  if (!result.rowCount) throw new Error('Resolve uncertain deliveries before retrying');
}
