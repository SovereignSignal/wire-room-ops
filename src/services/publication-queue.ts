import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { getPool } from '../db';
import { distributeEntry } from './distribution';
import { getDistributionPace } from './distribution-pace';

let running = false;

const DUE_TARGETS = `
  SELECT q.entry_id, q.available_at, q.status,
         COALESCE(array_agg(DISTINCT dc.target_id) FILTER (WHERE dc.target_id IS NOT NULL AND dc.target_id <> ''), ARRAY[]::text[]) AS targets
  FROM publication_queue q
  JOIN scan_entries se ON se.id = q.entry_id
  LEFT JOIN distribution_channels dc
    ON dc.enabled AND dc.channel = 'telegram' AND dc.target_id <> ''
   AND (dc.wire = se.wire OR dc.wire = ANY(COALESCE(se.wires, ARRAY[]::text[])))
  WHERE (
    (q.status = 'queued' AND q.available_at <= NOW())
    OR (q.status = 'running' AND q.lease_expires_at < NOW())
  )
    AND se.status = 'approved' AND se.distributable IS NOT FALSE
  GROUP BY q.entry_id, q.available_at, q.status
  ORDER BY q.available_at, q.entry_id
`;

function targetsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return ['unconfigured'];
  const targets = value.filter((target): target is string => typeof target === 'string' && target !== '');
  return targets.length ? targets : ['unconfigured'];
}

/** A lease expiring means outcome unknown, never permission to resend. */
export async function reconcileStaleDeliveries(): Promise<void> {
  await getPool().query(`UPDATE distribution_logs SET needs_review = true,
    error_message = COALESCE(error_message, 'Send interrupted; verify destination before retrying')
    WHERE status = 'pending' AND NOT needs_review
      AND (lease_expires_at IS NULL OR lease_expires_at < NOW())`);
}

async function runClaimedJob(pool: Pool, job: { entry_id: number; attempts: number }, token: string): Promise<void> {
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

async function claimEntry(pool: Pool, entryId: number, token: string): Promise<{ entry_id: number; attempts: number } | null> {
  const claimed = await pool.query(`UPDATE publication_queue SET status = 'running',
    attempts = attempts + 1, lease_token = $1, lease_expires_at = NOW() + INTERVAL '20 minutes', updated_at = NOW()
    WHERE entry_id = (SELECT entry_id FROM publication_queue
      WHERE entry_id = $2 AND (
        (status = 'queued' AND available_at <= NOW())
        OR (status = 'running' AND lease_expires_at < NOW())
      )
      FOR UPDATE SKIP LOCKED)
    RETURNING entry_id, attempts`, [token, entryId]);
  return claimed.rows[0] ?? null;
}

/** Due rows whose entry is no longer publishable finish without a send, matching the unpaced worker. */
async function completeUnpublishable(pool: Pool): Promise<void> {
  await pool.query(`UPDATE publication_queue q
    SET status = 'done', error_message = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
    WHERE (
      (q.status = 'queued' AND q.available_at <= NOW())
      OR (q.status = 'running' AND q.lease_expires_at < NOW())
    )
    AND NOT EXISTS (
      SELECT 1 FROM scan_entries se
      WHERE se.id = q.entry_id AND se.status = 'approved' AND se.distributable IS NOT FALSE
    )`);
}

/** One due post per Telegram chat, then push the other overdue rows forward so a restart cannot burst. */
async function drainPaced(pool: Pool, intervalMinutes: number): Promise<void> {
  await completeUnpublishable(pool);
  const due = (await pool.query(DUE_TARGETS)).rows as { entry_id: number; targets: string[] | null }[];
  const taken = new Set<string>();
  for (const row of due) {
    const targets = targetsOf(row.targets);
    if (targets.some(target => taken.has(target))) continue;
    const token = randomUUID();
    const job = await claimEntry(pool, row.entry_id, token);
    if (!job) continue;
    for (const target of targets) taken.add(target);
    await runClaimedJob(pool, job, token);
  }
  if (!taken.size) return;
  const overdue = (await pool.query(`
    SELECT q.entry_id, q.available_at,
           COALESCE(array_agg(DISTINCT dc.target_id) FILTER (WHERE dc.target_id IS NOT NULL AND dc.target_id <> ''), ARRAY[]::text[]) AS targets
    FROM publication_queue q
    JOIN scan_entries se ON se.id = q.entry_id
    LEFT JOIN distribution_channels dc
      ON dc.enabled AND dc.channel = 'telegram' AND dc.target_id <> ''
     AND (dc.wire = se.wire OR dc.wire = ANY(COALESCE(se.wires, ARRAY[]::text[])))
    WHERE q.status = 'queued' AND q.available_at <= NOW()
    GROUP BY q.entry_id, q.available_at
    ORDER BY q.available_at, q.entry_id
  `)).rows as { entry_id: number; targets: string[] | null }[];
  const byTarget = new Map<string, number[]>();
  for (const row of overdue) {
    for (const target of targetsOf(row.targets)) {
      if (!taken.has(target)) continue;
      const list = byTarget.get(target) ?? [];
      list.push(row.entry_id);
      byTarget.set(target, list);
    }
  }
  const now = Date.now();
  const assigned = new Map<number, number>();
  for (const ids of byTarget.values()) {
    ids.forEach((id, index) => {
      const at = now + (index + 1) * intervalMinutes * 60_000;
      const previous = assigned.get(id);
      if (previous === undefined || at > previous) assigned.set(id, at);
    });
  }
  if (!assigned.size) return;
  const ids = [...assigned.keys()];
  await pool.query(
    `UPDATE publication_queue q SET available_at = v.at, updated_at = NOW()
     FROM unnest($1::int[], $2::timestamptz[]) AS v(entry_id, at)
     WHERE q.entry_id = v.entry_id AND q.status = 'queued'`,
    [ids, ids.map(id => new Date(assigned.get(id)!).toISOString())],
  );
}

/** Bounded worker for approvals durably enqueued in the status-change statement. */
export async function drainPublicationQueue(): Promise<void> {
  if (running) return;
  running = true;
  const pool = getPool();
  try {
    await reconcileStaleDeliveries();
    const pace = await getDistributionPace();
    if (pace.enabled) {
      if (!pace.paused) await drainPaced(pool, pace.intervalMinutes);
      return;
    }
    for (let i = 0; i < 10; i++) {
      const token = randomUUID();
      const claimed = await pool.query(`UPDATE publication_queue SET status = 'running',
        attempts = attempts + 1, lease_token = $1, lease_expires_at = NOW() + INTERVAL '20 minutes', updated_at = NOW()
        WHERE entry_id = (SELECT entry_id FROM publication_queue
          WHERE (status = 'queued' AND available_at <= NOW()) OR (status = 'running' AND lease_expires_at < NOW())
          ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING entry_id, attempts`, [token]);
      if (!claimed.rows.length) break;
      await runClaimedJob(pool, claimed.rows[0], token);
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
      needs_review = false, resolved_by = $4, resolved_at = NOW(), error_message = $5,
      sent_at = CASE WHEN $2 = 'success' THEN COALESCE(sent_at, NOW()) ELSE sent_at END
      WHERE id = $1`,
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
