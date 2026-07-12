import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../db';

const MAX_ERROR_LENGTH = 2_000;
const ADVISORY_LOCK_NAMESPACE = 'telegram-intake-update';
export const MAX_CONCURRENT_TELEGRAM_UPDATES = 5;
let activeTelegramUpdates = 0;

export type TelegramReceiptResult = 'processed' | 'already_processed';

export interface TelegramReceiptHandlerContext {
  attempt: number;
  isFirstAttempt: boolean;
}

export interface TelegramWebhookUpdateIdentity {
  update_id?: number;
  message?: {
    message_id?: number;
    chat?: { id?: number };
    from?: { id?: number };
  };
}

export class TelegramUpdateBusyError extends Error {
  constructor(public readonly updateId: number) {
    super(`Telegram update ${updateId} is already being processed`);
    this.name = 'TelegramUpdateBusyError';
  }
}

export class TelegramIntakeCapacityError extends Error {
  constructor() {
    super('Telegram intake is at processing capacity');
    this.name = 'TelegramIntakeCapacityError';
  }
}

export class TelegramUpdateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramUpdateValidationError';
  }
}

export async function ensureTelegramIntakeReceiptsTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS telegram_intake_receipts (
      update_id BIGINT PRIMARY KEY,
      message_id BIGINT,
      chat_id BIGINT,
      sender_id BIGINT,
      status TEXT NOT NULL
        CHECK (status IN ('processing', 'succeeded', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      lease_token UUID,
      last_error TEXT,
      first_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processing_started_at TIMESTAMPTZ,
      processed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_telegram_intake_receipts_status_updated
      ON telegram_intake_receipts(status, updated_at DESC)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_entries_telegram_update_item
      ON scan_entries (
        (metadata->>'channel_update_id'),
        (metadata->>'channel_item_key')
      )
      WHERE scan_source = 'telegram'
        AND metadata->>'channel_update_id' IS NOT NULL
        AND metadata->>'channel_item_key' IS NOT NULL
  `);
  console.log('[DB] Telegram intake receipts ready');
}

function requireUpdateId(update: TelegramWebhookUpdateIdentity): number {
  const updateId = update?.update_id;
  if (!Number.isSafeInteger(updateId) || (updateId as number) < 0) {
    throw new TelegramUpdateValidationError('Telegram update_id must be a non-negative safe integer');
  }
  return updateId as number;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, MAX_ERROR_LENGTH);
}

/**
 * Process one Telegram webhook update with a durable receipt and a session
 * advisory lock. The lock prevents concurrent replay and disappears when a
 * worker or database connection dies. The durable receipt lets the next worker
 * distinguish a completed update from an interrupted one.
 *
 * The HTTP route waits for this function before acknowledging Telegram, so an
 * uncaught handler failure produces a retry instead of silent data loss.
 */
export async function processTelegramUpdateWithReceipt(
  update: TelegramWebhookUpdateIdentity,
  handler: (context: TelegramReceiptHandlerContext) => Promise<void>,
  pool: Pick<Pool, 'connect'> = getPool()
): Promise<TelegramReceiptResult> {
  const updateId = requireUpdateId(update);
  const leaseToken = randomUUID();
  const message = update.message;
  const lockKey = `${ADVISORY_LOCK_NAMESPACE}:${updateId}`;
  if (activeTelegramUpdates >= MAX_CONCURRENT_TELEGRAM_UPDATES) {
    throw new TelegramIntakeCapacityError();
  }
  activeTelegramUpdates++;
  let client: PoolClient | undefined;
  let lockAcquired = false;

  try {
    client = await pool.connect();
    const lock = await client.query(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired`,
      [lockKey]
    );
    lockAcquired = lock.rows[0]?.acquired === true;
    if (!lockAcquired) {
      throw new TelegramUpdateBusyError(updateId);
    }

    const claimed = await client.query(
      `INSERT INTO telegram_intake_receipts (
         update_id, message_id, chat_id, sender_id,
         status, attempts, lease_token, processing_started_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'processing', 1, $5, NOW(), NOW())
       ON CONFLICT (update_id) DO UPDATE SET
         status = 'processing',
         attempts = telegram_intake_receipts.attempts + 1,
         lease_token = EXCLUDED.lease_token,
         last_error = NULL,
         processing_started_at = NOW(),
         processed_at = NULL,
         updated_at = NOW()
       WHERE telegram_intake_receipts.status <> 'succeeded'
       RETURNING update_id, attempts`,
      [
        updateId,
        message?.message_id ?? null,
        message?.chat?.id ?? null,
        message?.from?.id ?? null,
        leaseToken,
      ]
    );

    if (claimed.rowCount === 0) {
      const existing = await client.query(
        `SELECT status FROM telegram_intake_receipts WHERE update_id = $1`,
        [updateId]
      );
      if (existing.rows[0]?.status === 'succeeded') {
        return 'already_processed';
      }
      throw new TelegramUpdateBusyError(updateId);
    }

    const attempt = Number(claimed.rows[0]?.attempts);
    if (!Number.isSafeInteger(attempt) || attempt < 1) {
      throw new Error(`Invalid receipt attempt for Telegram update ${updateId}`);
    }

    try {
      await handler({ attempt, isFirstAttempt: attempt === 1 });
      const completed = await client.query(
        `UPDATE telegram_intake_receipts
         SET status = 'succeeded', lease_token = NULL, last_error = NULL,
             processed_at = NOW(), updated_at = NOW()
         WHERE update_id = $1 AND lease_token = $2`,
        [updateId, leaseToken]
      );
      if (completed.rowCount !== 1) {
        throw new Error(`Lost receipt ownership for Telegram update ${updateId}`);
      }
      return 'processed';
    } catch (error) {
      try {
        await client.query(
          `UPDATE telegram_intake_receipts
           SET status = 'failed', lease_token = NULL, last_error = $3,
               processed_at = NOW(), updated_at = NOW()
           WHERE update_id = $1 AND lease_token = $2`,
          [updateId, leaseToken, errorText(error)]
        );
      } catch (receiptError) {
        console.error(`[TelegramIntake] Could not record failed receipt for update ${updateId}:`, receiptError);
      }
      throw error;
    }
  } finally {
    try {
      if (client && lockAcquired) {
        await client.query(
          `SELECT pg_advisory_unlock(hashtextextended($1, 0))`,
          [lockKey]
        );
      }
    } finally {
      client?.release();
      activeTelegramUpdates--;
    }
  }
}
