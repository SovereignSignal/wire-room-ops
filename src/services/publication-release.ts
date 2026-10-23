/**
 * Verify and release a publication stuck in `review`.
 *
 * A send whose outcome is unknown keeps a `pending` distribution log. That log
 * holds the destination's unique send slot, so neither the worker nor a
 * retry may post again until someone records what happened in the channel.
 * Telegram's Bot API cannot read a channel's history, so the verification is
 * a person (or a curator) looking at the channel, with the post text,
 * destination and claim time supplied here.
 *
 * Release records that answer for every unverified log, then takes the queue
 * row out of `review`. It never enqueues and never sends: an entry that still
 * has an open destination shows on the outgoing list as missing and goes back
 * through the normal paced enqueue, repeat-funder check included.
 */

import type { PoolClient } from 'pg';
import { getPool } from '../db';
import { entryHasOpenDestination } from './publication-queue';

export class PublicationReleaseError extends Error {
  constructor(message: string, public readonly statusCode: 400 | 404 | 409, public readonly details?: unknown) {
    super(message);
    this.name = 'PublicationReleaseError';
  }
}

export interface DeliveryDecision {
  logId: number;
  delivered: boolean;
  /** Telegram message id, or a t.me link to the message. */
  externalId?: string;
}

export type DeliveryVerdict = 'sent' | 'not_sent' | 'unverified' | 'sending' | 'closed' | 'skipped';

export interface DeliveryEvidence {
  logId: number;
  channel: string;
  wire: string;
  destination: string | null;
  targetId: string | null;
  status: string;
  verdict: DeliveryVerdict;
  /** Telegram returned a message id but saving the receipt failed: the post exists. */
  receiptSaysPosted: boolean;
  externalId: string | null;
  messageLink: string | null;
  errorMessage: string | null;
  postText: string | null;
  claimedAt: string | null;
  sentAt: string | null;
  resolvedBy: string | null;
}

export type PublicationState = 'not_queued' | 'scheduled' | 'sending' | 'needs_verification' | 'releasable' | 'withheld' | 'done';

export interface PublicationVerification {
  entryId: number;
  name: string;
  wire: string;
  entryStatus: string;
  queue: { status: string; attempts: number; errorMessage: string | null; updatedAt: string | null } | null;
  state: PublicationState;
  deliveries: DeliveryEvidence[];
  nextStep: string;
}

export interface ReleaseResult {
  entryId: number;
  dryRun: boolean;
  changed: boolean;
  outcome: 'sent' | 'released_for_retry' | 'no_open_destination';
  queueStatus: { before: string | null; after: string | null };
  resolved: { logId: number; delivered: boolean; externalId: string | null }[];
  enqueued: false;
  sent: false;
  nextStep: string;
}

const TELEGRAM_LINK = /^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\/(?:c\/\d+|[A-Za-z0-9_]{4,})\/(\d+)(?:[/?#].*)?$/;

/** A bare message id, or the id at the end of a t.me message link. */
export function parseTelegramMessageId(input: string | undefined | null): string | null {
  const value = (input || '').trim();
  if (/^\d{1,15}$/.test(value)) return value;
  const match = TELEGRAM_LINK.exec(value);
  return match ? match[1] : null;
}

export function telegramMessageLink(targetId: string | null, externalId: string | null): string | null {
  if (!targetId || !externalId || !/^\d+$/.test(externalId)) return null;
  if (/^@[A-Za-z0-9_]{4,}$/.test(targetId)) return `https://t.me/${targetId.slice(1)}/${externalId}`;
  const privateChat = /^-100(\d+)$/.exec(targetId);
  return privateChat ? `https://t.me/c/${privateChat[1]}/${externalId}` : null;
}

interface LogRow {
  id: number;
  channel: string;
  wire: string;
  status: string;
  needs_review: boolean;
  lease_live: boolean;
  external_id: string | null;
  error_message: string | null;
  post_text: string | null;
  created_at: Date | null;
  sent_at: Date | null;
  resolved_by: string | null;
  destination: string | null;
  target_id: string | null;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function verdictOf(row: LogRow): DeliveryVerdict {
  if (row.status === 'success') return 'sent';
  if (row.status === 'failed') return 'not_sent';
  if (row.status === 'acknowledged') return 'closed';
  if (row.status === 'skipped') return 'skipped';
  return row.lease_live && !row.needs_review ? 'sending' : 'unverified';
}

function evidenceOf(row: LogRow): DeliveryEvidence {
  return {
    logId: Number(row.id),
    channel: row.channel,
    wire: row.wire,
    destination: row.destination,
    targetId: row.target_id,
    status: row.status,
    verdict: verdictOf(row),
    receiptSaysPosted: row.status === 'pending' && !!row.external_id,
    externalId: row.external_id,
    messageLink: row.channel === 'telegram' ? telegramMessageLink(row.target_id, row.external_id) : null,
    errorMessage: row.error_message,
    postText: row.post_text,
    claimedAt: iso(row.created_at),
    sentAt: iso(row.sent_at),
    resolvedBy: row.resolved_by,
  };
}

const LOG_SELECT = `SELECT dl.id, dl.channel, dl.wire, dl.status, dl.needs_review,
    (dl.lease_expires_at IS NOT NULL AND dl.lease_expires_at > NOW()) AS lease_live,
    dl.external_id, dl.error_message, dl.post_text, dl.created_at, dl.sent_at, dl.resolved_by,
    dc.name AS destination, dc.target_id
  FROM distribution_logs dl
  LEFT JOIN distribution_channels dc ON dc.id = dl.channel_id
  WHERE dl.entry_id = $1`;

type Queryable = Pick<PoolClient, 'query'>;

async function readQueue(db: Queryable, entryId: number, lock: boolean) {
  return (await db.query(
    `SELECT status, attempts, error_message, updated_at,
            (lease_expires_at IS NOT NULL AND lease_expires_at > NOW()) AS lease_live
     FROM publication_queue WHERE entry_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [entryId],
  )).rows[0] as { status: string; attempts: number; error_message: string | null; updated_at: Date; lease_live: boolean } | undefined;
}

function stateOf(queue: { status: string; lease_live: boolean } | undefined, logs: LogRow[]): PublicationState {
  const verdicts = logs.map(verdictOf);
  if (queue?.status === 'withheld') return 'withheld';
  if ((queue?.status === 'running' && queue.lease_live) || verdicts.includes('sending')) return 'sending';
  if (verdicts.includes('unverified')) return 'needs_verification';
  if (queue?.status === 'review' || queue?.status === 'running') return 'releasable';
  if (queue?.status === 'queued') return 'scheduled';
  if (queue?.status === 'done') return 'done';
  return 'not_queued';
}

function nextStepFor(entryId: number, state: PublicationState): string {
  const release = `POST /api/distribution/queue/${entryId}/release`;
  switch (state) {
    case 'needs_verification':
      return `Open each unverified destination and look for the post text around its claim time. `
        + `Then call ${release} with confirm=true, a reason, and deliveries: [{ logId, delivered, externalId }]. `
        + `delivered=true needs the Telegram message id or t.me link (a delivery with receiptSaysPosted already has one); `
        + `delivered=false frees the slot for a retry.`;
    case 'releasable':
      return `No send is unverified. Call ${release} with confirm=true and a reason to take it out of review; it does not send.`;
    case 'sending':
      return 'A send is in progress. Wait for it to finish or for its lease to expire, then check again.';
    case 'withheld':
      return `Withheld. Use POST /api/scan/entries/${entryId}/unwithhold to release the hold.`;
    case 'scheduled':
      return 'Scheduled on the paced queue. Nothing to release.';
    default:
      return `Not stuck. Enqueue with POST /api/distribution/queue/${entryId}/enqueue if a destination is still unsent.`;
  }
}

export async function getPublicationVerification(entryId: number): Promise<PublicationVerification | null> {
  const pool = getPool();
  const entry = (await pool.query(`SELECT id, name, wire, status FROM scan_entries WHERE id = $1`, [entryId])).rows[0];
  if (!entry) return null;
  const queue = await readQueue(pool, entryId, false);
  const logs = (await pool.query(`${LOG_SELECT} ORDER BY dl.id`, [entryId])).rows as LogRow[];
  const state = stateOf(queue, logs);
  return {
    entryId: Number(entry.id),
    name: entry.name,
    wire: entry.wire,
    entryStatus: entry.status,
    queue: queue
      ? { status: queue.status, attempts: Number(queue.attempts), errorMessage: queue.error_message, updatedAt: iso(queue.updated_at) }
      : null,
    state,
    deliveries: logs.map(evidenceOf),
    nextStep: nextStepFor(entryId, state),
  };
}

/** Parse the request body's deliveries. Throws a 400 for anything malformed. */
export function parseDeliveryDecisions(raw: unknown): DeliveryDecision[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 50) {
    throw new PublicationReleaseError('deliveries must be an array of at most 50 items', 400);
  }
  const seen = new Set<number>();
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new PublicationReleaseError(`deliveries[${index}] must be an object`, 400);
    }
    const value = item as { logId?: unknown; id?: unknown; delivered?: unknown; externalId?: unknown; messageLink?: unknown };
    const logId = Number(value.logId ?? value.id);
    if (!Number.isSafeInteger(logId) || logId < 1) throw new PublicationReleaseError(`deliveries[${index}].logId is required`, 400);
    if (seen.has(logId)) throw new PublicationReleaseError(`deliveries lists log ${logId} twice`, 400);
    seen.add(logId);
    if (typeof value.delivered !== 'boolean') throw new PublicationReleaseError(`deliveries[${index}].delivered must be true or false`, 400);
    const external = value.externalId ?? value.messageLink;
    if (external !== undefined && (typeof external !== 'string' || external.length > 300)) {
      throw new PublicationReleaseError(`deliveries[${index}].externalId must be a string`, 400);
    }
    return { logId, delivered: value.delivered, externalId: typeof external === 'string' ? external.trim() || undefined : undefined };
  });
}

/**
 * Record what happened to each unverified send and take the publication out of
 * review. Idempotent: repeating the same call after it succeeded changes nothing.
 * Holds the entry row lock that every send claim takes, so no send can start
 * for this entry while the release decides.
 */
export async function releaseStuckPublication(
  entryId: number,
  opts: { decisions: DeliveryDecision[]; actor: string; reason: string; dryRun?: boolean },
): Promise<ReleaseResult> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const entry = (await client.query(`SELECT id FROM scan_entries WHERE id = $1 FOR UPDATE`, [entryId])).rows[0];
    if (!entry) throw new PublicationReleaseError('Entry not found', 404);
    const queue = await readQueue(client, entryId, true);
    if (queue?.status === 'withheld') {
      throw new PublicationReleaseError(`Entry is withheld; use POST /api/scan/entries/${entryId}/unwithhold`, 409);
    }
    if (queue?.status === 'running' && queue.lease_live) {
      throw new PublicationReleaseError('A send is in progress for this entry', 409);
    }
    if (queue?.status === 'queued') {
      throw new PublicationReleaseError('Publication is scheduled, not stuck; nothing to release', 409);
    }

    const logs = (await client.query(`${LOG_SELECT} ORDER BY dl.id FOR UPDATE OF dl`, [entryId])).rows as LogRow[];
    const byId = new Map(logs.map(row => [Number(row.id), row]));
    if (logs.some(row => verdictOf(row) === 'sending')) {
      throw new PublicationReleaseError('A send is in progress for this entry', 409);
    }

    const decisions = new Map(opts.decisions.map(decision => [decision.logId, decision]));
    for (const decision of opts.decisions) {
      if (!byId.has(decision.logId)) {
        throw new PublicationReleaseError(`Delivery log ${decision.logId} does not belong to entry ${entryId}`, 404);
      }
    }

    const unverified = logs.filter(row => row.status === 'pending');
    const missing = unverified.filter(row => !decisions.has(Number(row.id)));
    if (missing.length) {
      throw new PublicationReleaseError(
        'verification_required: say whether each unverified send was delivered',
        409,
        { unverified: missing.map(evidenceOf) },
      );
    }

    const updates: { logId: number; delivered: boolean; externalId: string | null }[] = [];
    for (const decision of opts.decisions) {
      const row = byId.get(decision.logId)!;
      if (row.status !== 'pending') {
        const consistent = decision.delivered ? row.status === 'success' : row.status === 'failed' || row.status === 'acknowledged';
        if (!consistent) {
          throw new PublicationReleaseError(`Delivery log ${decision.logId} is already ${row.status}`, 409);
        }
        continue;
      }
      let externalId: string | null = null;
      if (decision.delivered) {
        if (!decision.externalId) externalId = row.external_id;
        else if (row.channel !== 'telegram') externalId = decision.externalId;
        else {
          externalId = parseTelegramMessageId(decision.externalId);
          if (!externalId) {
            throw new PublicationReleaseError(`Delivery log ${decision.logId}: externalId must be a Telegram message id or t.me message link`, 400);
          }
        }
        if (row.channel === 'telegram' && !externalId) {
          throw new PublicationReleaseError(`Delivery log ${decision.logId}: a Telegram message id is required to confirm delivery`, 400);
        }
      }
      updates.push({ logId: decision.logId, delivered: decision.delivered, externalId });
    }

    const stuckQueue = queue?.status === 'review' || queue?.status === 'running';
    const before = queue?.status ?? null;

    if (!updates.length && !stuckQueue) {
      await client.query('ROLLBACK');
      const open = await entryHasOpenDestination(getPool(), entryId);
      const anySent = logs.some(row => row.status === 'success');
      return {
        entryId, dryRun: !!opts.dryRun, changed: false,
        outcome: open ? 'released_for_retry' : anySent ? 'sent' : 'no_open_destination',
        queueStatus: { before, after: before }, resolved: [], enqueued: false, sent: false,
        nextStep: open
          ? `Already released. Enqueue with POST /api/distribution/queue/${entryId}/enqueue when approved to retry.`
          : 'Already released. Nothing is left to send.',
      };
    }

    for (const update of updates) {
      if (update.delivered) {
        await client.query(
          `UPDATE distribution_logs SET status = 'success', external_id = COALESCE($2, external_id),
             needs_review = false, resolved_by = $3, resolved_at = NOW(), error_message = NULL,
             sent_at = COALESCE(sent_at, created_at, NOW())
           WHERE id = $1 AND status = 'pending'`,
          [update.logId, update.externalId, opts.actor],
        );
      } else {
        await client.query(
          `UPDATE distribution_logs SET status = 'failed', needs_review = false, resolved_by = $2,
             resolved_at = NOW(), error_message = 'Operator verified that this message was not delivered'
           WHERE id = $1 AND status = 'pending'`,
          [update.logId, opts.actor],
        );
      }
    }

    const open = await entryHasOpenDestination(client, entryId);
    const anySent = updates.some(update => update.delivered) || logs.some(row => row.status === 'success');
    const outcome: ReleaseResult['outcome'] = open ? 'released_for_retry' : anySent ? 'sent' : 'no_open_destination';
    let after = before;
    if (stuckQueue) {
      const note = `Released by ${opts.actor} (${outcome.replace(/_/g, ' ')}): ${opts.reason.slice(0, 300)}`;
      await client.query(
        `UPDATE publication_queue SET status = 'done', lease_token = NULL, lease_expires_at = NULL,
           error_message = $2, updated_at = NOW()
         WHERE entry_id = $1 AND status IN ('review', 'running')`,
        [entryId, note],
      );
      after = 'done';
    }
    await client.query(
      `UPDATE scan_entries
       SET metadata = jsonb_set(
         COALESCE(metadata, '{}'::jsonb),
         '{publication_releases}',
         COALESCE(metadata->'publication_releases', '[]'::jsonb) || $2::jsonb
       )
       WHERE id = $1`,
      [entryId, JSON.stringify([{
        at: new Date().toISOString(),
        by: opts.actor,
        reason: opts.reason,
        outcome,
        queue_before: before,
        queue_error_before: queue?.error_message ?? null,
        resolved: updates,
      }])],
    );

    const result: ReleaseResult = {
      entryId,
      dryRun: !!opts.dryRun,
      changed: true,
      outcome,
      queueStatus: { before, after },
      resolved: updates,
      enqueued: false,
      sent: false,
      nextStep: outcome === 'released_for_retry'
        ? `Released; nothing was sent. To retry, POST /api/distribution/queue/${entryId}/enqueue with a reason (paced, repeat-funder check applies).`
        : outcome === 'sent'
          ? 'Recorded as sent. Nothing else will post for this entry.'
          : 'Released. No enabled destination is left for this entry.',
    };
    await client.query(opts.dryRun ? 'ROLLBACK' : 'COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
