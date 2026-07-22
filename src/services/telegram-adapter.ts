/**
 * Telegram adapter — thin layer between Telegram Bot API and intake-core.
 *
 * All Telegram-specific API calls live here. Business logic (wire detection,
 * DB insert) is delegated to intake-core.ts.
 */

import type { Pool } from 'pg';
import { config } from '../config';
import { getPool } from '../db';
import { runDecidedRecheckForIds } from '../jobs/decided-recheck';
import { getCachedProvider } from './api-provider';
import { processIntakeMessage, isBatchMessage, processBatchMessage } from './intake-core';
import type { BatchIntakeResult, IntakeResult } from './intake-core';

function getIntakeBotToken(): string {
  return getCachedProvider('telegram-intake')?.api_key || '';
}

const TELEGRAM_API = 'https://api.telegram.org';
const TELEGRAM_SEND_TIMEOUT_MS = 10_000;
const HISTORY_SETTLE_BUDGET_MS = 15_000;
const TELEGRAM_TEXT_LIMIT = 4_000;

export class TelegramIntakeRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramIntakeRetryableError';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Minimal Telegram types (only what we need)
// ────────────────────────────────────────────────────────────────────────────

interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name?: string };
  chat: { id: number };
  text?: string;
  caption?: string;
  forward_date?: number;
  forward_from?: { id: number; first_name?: string };
  forward_from_chat?: { id: number; title?: string };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramUpdateHandlingOptions {
  sendBatchAcknowledgement?: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Telegram API helpers
// ────────────────────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function sendMessage(chatId: number, text: string, replyMarkup?: object): Promise<void> {
  const botToken = getIntakeBotToken();
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    };
    if (replyMarkup) body.reply_markup = replyMarkup;

    const resp = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
      method: 'POST',
      signal: AbortSignal.timeout(TELEGRAM_SEND_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const httpStatus = Number(resp.status);
    const permanentHttpFailure = Number.isInteger(httpStatus)
      && httpStatus >= 400
      && httpStatus < 500
      && httpStatus !== 408
      && httpStatus !== 429;

    let data: { ok?: unknown; error_code?: unknown; description?: unknown };
    try {
      const parsed = await resp.json() as unknown;
      data = parsed !== null && typeof parsed === 'object'
        ? parsed as { ok?: unknown; error_code?: unknown; description?: unknown }
        : {};
    } catch {
      const reason = `Telegram send failed: invalid response body (HTTP ${Number.isFinite(httpStatus) ? httpStatus : 'unknown'})`;
      if (permanentHttpFailure) {
        console.error(`[TelegramAdapter] Permanent send failure (${httpStatus}): ${reason}`);
        return;
      }
      throw new TelegramIntakeRetryableError(reason);
    }

    const hasApiCode = Object.prototype.hasOwnProperty.call(data, 'error_code');
    const apiCode = typeof data.error_code === 'number' && Number.isInteger(data.error_code)
      ? data.error_code
      : null;
    const httpSucceeded = resp.ok === true
      && httpStatus >= 200
      && httpStatus < 300;
    if (httpSucceeded && data.ok === true && !hasApiCode) return;

    const permanentApiFailure = apiCode !== null
      && apiCode >= 400
      && apiCode < 500
      && apiCode !== 408
      && apiCode !== 429;
    const transientApiFailure = apiCode === 408
      || apiCode === 429
      || (apiCode !== null && apiCode >= 500);
    const reason = `Telegram send failed: ${typeof data.description === 'string' ? data.description : 'unknown error'}`;

    // A permanent result must be confirmed by the HTTP 4xx status and must
    // not contradict a successful or transient Bot API payload. Unknown,
    // malformed, contradictory, 408, 429, and 5xx responses remain retryable.
    if (permanentHttpFailure
      && data.ok !== true
      && !transientApiFailure
      && (apiCode === null || permanentApiFailure)) {
      console.error(`[TelegramAdapter] Permanent send failure (${httpStatus}): ${reason}`);
      return;
    }

    throw new TelegramIntakeRetryableError(reason);
  } catch (error) {
    console.error('[TelegramAdapter] sendMessage error:', error);
    if (error instanceof TelegramIntakeRetryableError) throw error;
    throw new TelegramIntakeRetryableError(
      `Telegram send failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface SettledBatchEntry {
  id: number;
  status: string;
  duplicate_of_id: number | null;
  duplicate_reason: string | null;
  decided_recheck: { verdict?: string } | null;
  duplicate_chain_error: unknown | null;
}

type SettledBatchPool = Pick<Pool, 'query'>;

async function readSettledBatchEntries(
  pool: SettledBatchPool,
  acceptedIds: number[],
): Promise<SettledBatchEntry[]> {
  if (acceptedIds.length === 0) return [];
  const result = await pool.query(
    `SELECT id, status, duplicate_of_id, duplicate_reason,
            metadata -> 'decided_recheck' AS decided_recheck,
            metadata -> 'duplicate_chain_error' AS duplicate_chain_error
     FROM scan_entries
     WHERE id = ANY($1::bigint[])`,
    [acceptedIds],
  );
  return result.rows as SettledBatchEntry[];
}

function outstandingHistoryCheckIds(
  acceptedIds: number[],
  settledEntries: SettledBatchEntry[],
): number[] {
  const settledById = new Map(settledEntries.map(entry => [Number(entry.id), entry]));
  return acceptedIds.filter(id => {
    const settled = settledById.get(id);
    if (!settled) return true;
    if (settled.status !== 'queued') return false;
    return !settled.decided_recheck && !settled.duplicate_chain_error;
  });
}

export function hasOutstandingHistoryChecks(
  acceptedIds: number[],
  settledEntries: SettledBatchEntry[],
): boolean {
  return outstandingHistoryCheckIds(acceptedIds, settledEntries).length > 0;
}

function escapedField(text: string, maxRawLength: number): string {
  const suffix = text.length > maxRawLength ? '…' : '';
  return escapeHtml(text.slice(0, maxRawLength)) + suffix;
}

function fitTelegramHtmlLines(lines: string[]): string {
  if (lines.length === 0) return '';
  const included = [lines[0]];

  for (let index = 1; index < lines.length; index++) {
    const remaining = lines.length - index;
    const footer = `… ${remaining} more result${remaining === 1 ? '' : 's'} omitted`;
    const candidate = [...included, lines[index]];
    const hasMore = index < lines.length - 1;
    const rendered = hasMore ? [...candidate, footer].join('\n') : candidate.join('\n');
    if (rendered.length > TELEGRAM_TEXT_LIMIT) break;
    included.push(lines[index]);
  }

  let omitted = lines.length - included.length;
  if (omitted > 0) {
    let footer = `… ${omitted} more result${omitted === 1 ? '' : 's'} omitted`;
    while (included.length > 1 && [...included, footer].join('\n').length > TELEGRAM_TEXT_LIMIT) {
      included.pop();
      omitted = lines.length - included.length;
      footer = `… ${omitted} more result${omitted === 1 ? '' : 's'} omitted`;
    }
    included.push(footer);
  }
  return included.join('\n');
}

export async function settleHistoryWithinBudget(
  acceptedIds: number[],
  budgetMs = HISTORY_SETTLE_BUDGET_MS,
): Promise<'settled' | 'pending' | 'failed'> {
  if (acceptedIds.length === 0) return 'settled';

  let timer: NodeJS.Timeout | undefined;
  const recheck = runDecidedRecheckForIds(getPool(), acceptedIds)
    .then(() => 'settled' as const)
    .catch(error => {
      console.error('[TelegramAdapter] Immediate history check failed:', error);
      return 'failed' as const;
    });
  const budget = new Promise<'pending'>(resolve => {
    timer = setTimeout(() => resolve('pending'), budgetMs);
    timer.unref();
  });
  const outcome = await Promise.race([recheck, budget]);
  if (timer) clearTimeout(timer);
  if (outcome === 'pending') {
    console.warn(`[TelegramAdapter] History check exceeded ${budgetMs}ms; requesting receipt retry`);
  }
  return outcome;
}

/** Build the final Telegram receipt from settled database state. */
export function formatSettledBatchReport(batch: BatchIntakeResult, settledEntries: SettledBatchEntry[]): string {
  const settledById = new Map(settledEntries.map(entry => [Number(entry.id), entry]));
  const accepted = batch.entries.filter(entry => entry.id && !entry.isDuplicate);
  const movedToDuplicate = accepted.filter(entry => settledById.get(entry.id!)?.status === 'duplicate').length;
  const queuedEntries = accepted.filter(entry => settledById.get(entry.id!)?.status === 'queued');
  const needsCheck = queuedEntries.filter(entry => {
    const settled = settledById.get(entry.id!);
    return !settled?.decided_recheck
      || settled.decided_recheck.verdict === 'skipped-error'
      || Boolean(settled.duplicate_chain_error);
  });
  const queued = queuedEntries.length - needsCheck.length;
  const duplicates = batch.duplicates + movedToDuplicate;
  const accountedIds = new Set(settledEntries.map(entry => Number(entry.id)));
  const unavailable = accepted.filter(entry => !accountedIds.has(entry.id!)).length;
  const other = accepted.filter(entry => {
    const status = settledById.get(entry.id!)?.status;
    return status && status !== 'queued' && status !== 'duplicate';
  }).length;
  const errors = batch.errors + unavailable;

  const summaryParts: string[] = [];
  if (queued > 0) summaryParts.push(`✅ ${queued} queued`);
  if (duplicates > 0) summaryParts.push(`🔄 ${duplicates} duplicate${duplicates === 1 ? '' : 's'}`);
  if (needsCheck.length > 0) {
    summaryParts.push(`⚠️ ${needsCheck.length} need${needsCheck.length === 1 ? 's' : ''} check${needsCheck.length === 1 ? '' : 's'}`);
  }
  if (other > 0) summaryParts.push(`ℹ️ ${other} other`);
  if (errors > 0) summaryParts.push(`❌ ${errors} error${errors === 1 ? '' : 's'}`);
  if (summaryParts.length === 0) summaryParts.push('No entries accepted');

  const heading = needsCheck.length > 0 || unavailable > 0
    ? '<b>Intake saved, checks outstanding:</b>'
    : '<b>Intake settled:</b>';
  const lines = [`${heading} ${summaryParts.join(', ')}\n`];
  for (const entry of batch.entries) {
    const safeName = escapedField(entry.name, 180);
    const safeWire = escapedField(entry.wire, 60);
    if (entry.isDuplicate) {
      lines.push(`• 🔄 ${safeName} — ${escapedField(entry.error || 'duplicate', 500)}`);
      continue;
    }
    if (!entry.id) {
      lines.push(`• ❌ ${safeName} — ${escapedField(entry.error || 'processing failed', 500)}`);
      continue;
    }

    const settled = settledById.get(entry.id);
    if (!settled) {
      lines.push(`• ❌ #${entry.id} ${safeName} — final status unavailable`);
    } else if (settled.status === 'duplicate') {
      const parent = settled.duplicate_of_id ? ` of #${settled.duplicate_of_id}` : '';
      lines.push(`• 🔄 #${entry.id} ${safeName} — duplicate${parent}`);
    } else if (settled.status === 'queued' && settled.duplicate_chain_error) {
      lines.push(`• ⚠️ #${entry.id} [${safeWire}] ${safeName} — duplicate chain needs review`);
    } else if (settled.status === 'queued' && !settled.decided_recheck) {
      lines.push(`• ⚠️ #${entry.id} [${safeWire}] ${safeName} — history check pending`);
    } else if (settled.status === 'queued' && settled.decided_recheck?.verdict === 'skipped-error') {
      lines.push(`• ⚠️ #${entry.id} [${safeWire}] ${safeName} — history check failed`);
    } else if (settled.status === 'queued') {
      lines.push(`• ✅ #${entry.id} [${safeWire}] ${safeName}`);
    } else {
      lines.push(`• ℹ️ #${entry.id} [${safeWire}] ${safeName} — ${escapedField(settled.status, 80)}`);
    }
  }
  return fitTelegramHtmlLines(lines);
}

/**
 * Format an IntakeResult as a Telegram reply message.
 */
function formatReply(result: IntakeResult): string {
  switch (result.status) {
    case 'inserted':
      return result.confirmText
        ? `<b>${escapeHtml(result.detectedWire || '')}</b> — ${escapeHtml(result.confirmText)}`
        : 'Entry saved.';
    case 'error':
      return result.errorMessage || 'Something went wrong. Try again.';
    case 'rejected':
      return result.errorMessage || 'Please send a URL or text to submit.';
    default:
      return '';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Webhook handlers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Handle an incoming Telegram webhook update (message or callback).
 */
export async function handleTelegramUpdate(
  update: TelegramUpdate,
  options: TelegramUpdateHandlingOptions = {},
): Promise<void> {
  const message = update.message;
  if (!message?.from) return;

  const userId = message.from.id;
  const allowedUserId = config.telegramIntake.allowedUserId;

  // Verify sender
  if (allowedUserId && String(userId) !== allowedUserId) {
    console.log(`[TelegramAdapter] Rejected message from unauthorized user ${userId}`);
    await sendMessage(message.chat.id, 'You are not authorized to submit entries.');
    return;
  }

  const text = message.text || message.caption || '';
  if (!text.trim()) {
    await sendMessage(message.chat.id, 'Please send a URL or text to submit.');
    return;
  }

  // Derive forwarded-from name
  const forwardedFrom = message.forward_from?.first_name
    || (message.forward_from_chat as { title?: string } | undefined)?.title
    || undefined;

  const intakeMsg = {
    text,
    senderId: `telegram:${userId}`,
    channelMessageId: String(message.message_id),
    channelUpdateId: String(update.update_id),
    forwardedFrom,
  };

  // Batch mode: numbered list, bold-name, or structured (Link:) format
  if (isBatchMessage(text)) {
    console.log(`[TelegramAdapter] Batch message detected from user ${userId}`);
    if (options.sendBatchAcknowledgement !== false) {
      await sendMessage(message.chat.id, '📥 Batch received. Running intake and history checks…');
    }
    const batch = await processBatchMessage(intakeMsg, 'telegram');
    if (batch.retryableErrors > 0) {
      const failures = batch.entries
        .filter(entry => entry.retryable)
        .slice(0, 3)
        .map(entry => {
          const name = entry.name.replace(/\s+/g, ' ').trim().slice(0, 160);
          const reason = (entry.error || 'unknown persistence error')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 500);
          return `${name}: ${reason}`;
        });
      const detail = failures.length > 0 ? `: ${failures.join('; ')}` : '';
      throw new TelegramIntakeRetryableError(
        `Batch intake had ${batch.retryableErrors} retryable persistence error${batch.retryableErrors === 1 ? '' : 's'}${detail}`,
      );
    }

    const acceptedIds = batch.entries
      .filter(entry => entry.id && !entry.isDuplicate)
      .map(entry => entry.id!);

    let settled: SettledBatchEntry[] = [];
    await settleHistoryWithinBudget(acceptedIds);

    if (acceptedIds.length > 0) {
      try {
        settled = await readSettledBatchEntries(getPool(), acceptedIds);
      } catch (error) {
        console.error('[TelegramAdapter] Final batch status read failed:', error);
      }
    }

    if (hasOutstandingHistoryChecks(acceptedIds, settled)) {
      // Keep the durable receipt retryable without sending a stale partial
      // result. Telegram replays safely through stable item keys, and the user
      // receives one follow-up only after every history check has settled.
      throw new TelegramIntakeRetryableError(
        `Batch history checks still outstanding for IDs ${acceptedIds.join(',')}`,
      );
    }

    await sendMessage(message.chat.id, formatSettledBatchReport(batch, settled));
    return;
  }

  const result = await processIntakeMessage(intakeMsg, 'telegram');

  if (result.status === 'error') {
    throw new TelegramIntakeRetryableError(result.errorMessage || 'Telegram intake failed');
  }

  // Inserted or permanently rejected — send reply
  const reply = formatReply(result);
  if (reply) {
    await sendMessage(message.chat.id, reply);
  }

  if (result.status === 'inserted') {
    console.log(`[TelegramAdapter] Inserted entry #${result.entryId} (${result.detectedWire}) from user ${userId}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Webhook registration
// ────────────────────────────────────────────────────────────────────────────

/**
 * Register the intake webhook with Telegram.
 */
export async function registerIntakeWebhook(): Promise<void> {
  const botToken = getIntakeBotToken();
  const { webhookSecret } = config.telegramIntake;
  if (!botToken) return;

  const webhookUrl = `${config.app.url}/api/telegram/intake-webhook`;

  try {
    const resp = await fetch(`${TELEGRAM_API}/bot${botToken}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: webhookSecret,
      }),
    });
    const data = await resp.json() as { ok: boolean; description?: string };
    if (data.ok) {
      console.log(`[TelegramAdapter] Webhook registered: ${webhookUrl}`);
    } else {
      console.error(`[TelegramAdapter] Webhook registration failed: ${data.description}`);
    }
  } catch (error) {
    console.error('[TelegramAdapter] Webhook registration error:', error);
  }
}
