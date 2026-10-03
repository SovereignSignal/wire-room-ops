import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { getPool } from '../db';
import { distributeEntry } from './distribution';
import { bookPacedQueue, getDistributionPace, mergeQueueNote, paceRules, planQueue, sentTodayByTarget, UNSENT_TELEGRAM_DESTINATION_SQL, type DistributionPace } from './distribution-pace';
import { composeStoredPost, fillMissingPublicationPost } from './publication-post';
import { enforceRepeatFunderHold, recordRepeatFunderOverride } from './repeat-funder';

export const PACING_REQUIRED_ERROR = 'pacing must be on and not paused';

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

/**
 * Push queued rows that would send inside quiet hours or past the daily cap.
 * Overdue rows keep a single due slot per chat; the rest move forward by the interval.
 * A row that is already due and still allowed to send is left where it is, so the claim below can take it.
 */
async function enforcePaceWindow(pool: Pool, pace: DistributionPace): Promise<void> {
  const now = new Date();
  const rules = paceRules(pace, now);
  const queued = (await pool.query(`
    SELECT q.entry_id, q.available_at, q.error_message,
           COALESCE(array_agg(DISTINCT dc.target_id) FILTER (WHERE dc.target_id IS NOT NULL AND dc.target_id <> ''), ARRAY[]::text[]) AS targets
    FROM publication_queue q
    JOIN scan_entries se ON se.id = q.entry_id
    LEFT JOIN distribution_channels dc
      ON dc.enabled AND dc.channel = 'telegram' AND dc.target_id <> ''
     AND (dc.wire = se.wire OR dc.wire = ANY(COALESCE(se.wires, ARRAY[]::text[])))
    WHERE q.status = 'queued'
    GROUP BY q.entry_id, q.available_at, q.error_message
    ORDER BY q.available_at, q.entry_id
  `)).rows as { entry_id: number; available_at: Date; error_message: string | null; targets: string[] | null }[];
  if (!queued.length) return;
  const sentToday = await sentTodayByTarget(pool, pace, now);
  const planned = planQueue(queued.map(row => ({
    id: row.entry_id,
    at: new Date(row.available_at),
    targets: targetsOf(row.targets),
  })), sentToday, rules);
  const current = new Map(queued.map(row => [row.entry_id, row]));
  const ids: number[] = [];
  const ats: string[] = [];
  const notes: (string | null)[] = [];
  for (const item of planned) {
    const row = current.get(item.id);
    if (!row) continue;
    const nextAt = item.at.getTime();
    const dueAndSendable = nextAt <= now.getTime() + 2000 && new Date(row.available_at).getTime() <= now.getTime() + 2000;
    const note = mergeQueueNote(row.error_message, item.reason);
    const timeChanged = !dueAndSendable && Math.abs(nextAt - new Date(row.available_at).getTime()) > 1500;
    if (!timeChanged && note === row.error_message) continue;
    ids.push(item.id);
    ats.push((dueAndSendable ? new Date(row.available_at) : item.at).toISOString());
    notes.push(note ?? '');
  }
  if (!ids.length) return;
  await pool.query(
    `UPDATE publication_queue q
     SET available_at = v.at, error_message = NULLIF(v.note, ''), updated_at = NOW()
     FROM unnest($1::int[], $2::timestamptz[], $3::text[]) AS v(entry_id, at, note)
     WHERE q.entry_id = v.entry_id AND q.status = 'queued'`,
    [ids, ats, notes],
  );
}

/** One due post per Telegram chat. Quiet hours, the daily cap, and catch-up spacing are applied first. */
async function drainPaced(pool: Pool, pace: DistributionPace): Promise<void> {
  await completeUnpublishable(pool);
  await enforcePaceWindow(pool, pace);
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
      if (!pace.paused) await drainPaced(pool, pace);
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
export async function resolvePublication(
  id: number,
  delivered: boolean,
  externalId: string | undefined,
  actor: string,
  opts: { overrideRepeatFunder?: boolean; reason?: string } = {},
): Promise<void> {
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
    const repeatOverrides = delivered ? [] : await enforceRepeatFunderHold(client, [Number(row.entry_id)], {
      override: opts.overrideRepeatFunder,
      reason: opts.reason,
    });
    await client.query(`INSERT INTO publication_queue (entry_id) VALUES ($1)
      ON CONFLICT (entry_id) DO UPDATE SET status = 'queued', attempts = 0, lease_token = NULL,
      available_at = NOW(), updated_at = NOW()`, [row.entry_id]);
    if (repeatOverrides.length) await recordRepeatFunderOverride(client, repeatOverrides, actor, opts.reason || '');
    await client.query('COMMIT');
    await fillMissingPublicationPost(Number(row.entry_id));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export class WithholdConflictError extends Error {
  constructor(public readonly blocked: { id: number; reason: string }[]) {
    super(`Cannot withhold ${blocked.length} ${blocked.length === 1 ? 'entry' : 'entries'}; nothing was changed`);
    this.name = 'WithholdConflictError';
  }
}

export interface WithholdResult {
  success: true;
  action: 'withhold';
  dryRun: boolean;
  withheld: number[];
  alreadyWithheld: number[];
}

function withholdBlock(row: { status: string; distributable: boolean | null; queue_status: string | null; unsent: boolean } | undefined): string | null {
  if (!row) return 'not found';
  if (row.status !== 'approved') return `${row.status}, not approved`;
  if (row.distributable === false) return 'approved for programs only, so it is not on the wires';
  if (row.queue_status === 'running') return 'sending now';
  if (row.queue_status === 'review') return 'awaiting delivery review; resolve that first';
  if (row.queue_status !== 'queued' && row.queue_status !== 'withheld' && !row.unsent) return 'nothing left to send';
  return null;
}

/**
 * Take approved entries off the Telegram stream. The approval and its audit trail stay as they are:
 * the queue row carries the note and metadata.withheld carries who, why and the sources.
 * Covers a scheduled row and an approved entry that never reached the queue. All or nothing.
 */
export async function withholdPublications(
  entryIds: number[],
  opts: { actor?: string; reason?: string; evidence?: { sources: string[]; quotes: unknown[] } | null; dryRun?: boolean } = {},
): Promise<WithholdResult> {
  const ids = [...new Set(entryIds)];
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const rows = (await client.query(
      `SELECT se.id, se.status, se.distributable, q.status AS queue_status,
              ${UNSENT_TELEGRAM_DESTINATION_SQL} AS unsent
       FROM scan_entries se
       LEFT JOIN publication_queue q ON q.entry_id = se.id
       WHERE se.id = ANY($1::int[])
       FOR UPDATE OF se`,
      [ids],
    )).rows;
    const byId = new Map(rows.map(row => [Number(row.id), row]));
    const blocked = ids
      .map(id => ({ id, reason: withholdBlock(byId.get(id)) }))
      .filter((row): row is { id: number; reason: string } => row.reason !== null);
    if (blocked.length) throw new WithholdConflictError(blocked);

    const alreadyWithheld = ids.filter(id => byId.get(id).queue_status === 'withheld');
    const withheld = ids.filter(id => byId.get(id).queue_status !== 'withheld');
    const result: WithholdResult = { success: true, action: 'withhold', dryRun: !!opts.dryRun, withheld, alreadyWithheld };
    if (opts.dryRun || !withheld.length) {
      await client.query('ROLLBACK');
      return result;
    }

    const actor = opts.actor || 'unknown';
    const reason = opts.reason?.trim() || null;
    const note = `Withheld by ${actor}${reason ? `: ${reason.slice(0, 300)}` : ''}`;
    // The status guard catches a worker claim that landed after the read above.
    const moved = await client.query(
      `INSERT INTO publication_queue (entry_id, status, error_message)
       SELECT id, 'withheld', $2 FROM unnest($1::int[]) AS t(id)
       ON CONFLICT (entry_id) DO UPDATE
         SET status = 'withheld', error_message = EXCLUDED.error_message,
             lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
         WHERE publication_queue.status IN ('queued', 'done')
       RETURNING entry_id`,
      [withheld, note],
    );
    if (moved.rowCount !== withheld.length) {
      const done = new Set(moved.rows.map(row => Number(row.entry_id)));
      throw new WithholdConflictError(withheld.filter(id => !done.has(id)).map(id => ({ id, reason: 'changed while withholding; try again' })));
    }
    await client.query(
      `UPDATE scan_entries
       SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('withheld', $1::jsonb)
       WHERE id = ANY($2::int[])`,
      [JSON.stringify({ reason, sources: opts.evidence?.sources ?? [], quotes: opts.evidence?.quotes ?? [], by: actor, at: new Date().toISOString() }), withheld],
    );
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export class EnqueueConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnqueueConflictError';
  }
}

export interface EnqueuedPublication {
  entryId: number;
  availableAt: string;
  note: string | null;
}

/**
 * Put one approved entry on the paced queue. Books the next slot and returns.
 * Does not drain the queue and does not send. Pacing must already be on.
 */
export async function enqueuePacedPublication(
  entryId: number,
  opts: { actor?: string; reason?: string; sources?: string[]; overrideRepeatFunder?: boolean } = {},
): Promise<EnqueuedPublication> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query(
      `SELECT se.id, se.status, se.wire, se.wires, se.name, se.description, se.amount, se.deadline, se.source_url,
              q.status AS queue_status,
              ${UNSENT_TELEGRAM_DESTINATION_SQL} AS unsent,
              EXISTS (
                SELECT 1 FROM distribution_logs dl
                WHERE dl.entry_id = se.id
                  AND dl.channel = 'telegram'
                  AND dl.status = 'success'
              ) AS telegram_sent
       FROM scan_entries se
       LEFT JOIN publication_queue q ON q.entry_id = se.id
       WHERE se.id = $1
       FOR UPDATE OF se`,
      [entryId],
    )).rows[0];

    if (!row || row.status !== 'approved') {
      throw new EnqueueConflictError(row ? `Entry is ${row.status}, not approved` : 'Entry is not approved');
    }
    const pace = await getDistributionPace();
    if (!pace.enabled || pace.paused) throw new EnqueueConflictError(PACING_REQUIRED_ERROR);
    const queueStatus = typeof row.queue_status === 'string' ? row.queue_status : null;
    if (queueStatus === 'withheld') throw new EnqueueConflictError('Entry is withheld');
    if (queueStatus === 'queued' || queueStatus === 'running' || queueStatus === 'review') {
      throw new EnqueueConflictError(`Entry already has a ${queueStatus} publication`);
    }
    if (row.telegram_sent) throw new EnqueueConflictError('Entry already has a successful Telegram send');
    if (!row.unsent) throw new EnqueueConflictError('No unsent Telegram destination is left');
    const repeatOverrides = await enforceRepeatFunderHold(client, [entryId], {
      override: opts.overrideRepeatFunder,
      reason: opts.reason,
    });

    const actor = opts.actor || 'unknown';
    const stamp = {
      by: actor,
      at: new Date().toISOString(),
      reason: opts.reason ?? null,
      sources: opts.sources ?? [],
    };
    await client.query(
      `UPDATE scan_entries
       SET distributable = true,
           actioned_by = COALESCE(actioned_by, $2),
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('enqueued', $3::jsonb),
           updated_at = NOW()
       WHERE id = $1`,
      [entryId, actor, JSON.stringify(stamp)],
    );
    const post = await composeStoredPost({
      name: row.name,
      description: row.description || '',
      amount: row.amount,
      deadline: row.deadline,
      sourceUrl: row.source_url,
    }, row.wire || 'crypto');
    await bookPacedQueue(client, [{
      id: Number(row.id),
      wire: row.wire,
      wires: Array.isArray(row.wires) ? row.wires : null,
    }], pace, new Map([[Number(row.id), post]]));
    if (repeatOverrides.length) await recordRepeatFunderOverride(client, repeatOverrides, actor, opts.reason || '');
    const booked = (await client.query(
      `SELECT status, available_at, error_message FROM publication_queue WHERE entry_id = $1`,
      [entryId],
    )).rows[0];
    if (!booked || booked.status !== 'queued') {
      throw new EnqueueConflictError('Enqueue did not book a paced slot');
    }
    await client.query('COMMIT');
    return {
      entryId: Number(row.id),
      availableAt: new Date(booked.available_at).toISOString(),
      note: booked.error_message || null,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listQueuedPublicationReview(): Promise<unknown[]> {
  return (await getPool().query(`SELECT q.entry_id, se.name, q.error_message FROM publication_queue q
    JOIN scan_entries se ON se.id = q.entry_id WHERE q.status = 'review'
    AND NOT EXISTS (SELECT 1 FROM distribution_logs dl WHERE dl.entry_id = q.entry_id AND dl.status = 'pending')
    ORDER BY q.updated_at`)).rows;
}
export async function retryQueuedPublication(
  entryId: number,
  opts: { overrideRepeatFunder?: boolean; reason?: string; actor?: string } = {},
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const repeatOverrides = await enforceRepeatFunderHold(client, [entryId], {
      override: opts.overrideRepeatFunder,
      reason: opts.reason,
    });
    const result = await client.query(`UPDATE publication_queue SET status = 'queued', attempts = 0,
      available_at = NOW(), updated_at = NOW() WHERE entry_id = $1 AND status = 'review'
      AND NOT EXISTS (SELECT 1 FROM distribution_logs WHERE entry_id = $1 AND status = 'pending')`, [entryId]);
    if (!result.rowCount) throw new Error('Resolve uncertain deliveries before retrying');
    if (repeatOverrides.length) {
      await recordRepeatFunderOverride(client, repeatOverrides, opts.actor || 'unknown', opts.reason || '');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await fillMissingPublicationPost(entryId);
}
