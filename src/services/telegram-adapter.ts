/**
 * Telegram adapter — thin layer between Telegram Bot API and intake-core.
 *
 * All Telegram-specific API calls live here. Business logic (wire detection,
 * DB insert) is delegated to intake-core.ts.
 */

import { config } from '../config';
import { getPool } from '../db';
import { runDecidedRecheckForIds } from '../jobs/decided-recheck';
import { getCachedProvider } from './api-provider';
import { processIntakeMessage, isBatchMessage, processBatchMessage } from './intake-core';
import type { BatchIntakeResult, IntakeResult } from './intake-core';

function getIntakeBotToken(): string {
  return getCachedProvider('telegram-intake')?.api_key || config.telegramIntake.botToken;
}

const TELEGRAM_API = 'https://api.telegram.org';

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

// ────────────────────────────────────────────────────────────────────────────
// Telegram API helpers
// ────────────────────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendMessage(chatId: number, text: string, replyMarkup?: object): Promise<void> {
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json() as { ok: boolean; description?: string };
    if (!data.ok) {
      console.error(`[TelegramAdapter] sendMessage failed: ${data.description}`);
    }
  } catch (error) {
    console.error('[TelegramAdapter] sendMessage error:', error);
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
    const safeName = escapeHtml(entry.name);
    const safeWire = escapeHtml(entry.wire);
    if (entry.isDuplicate) {
      lines.push(`• 🔄 ${safeName} — ${escapeHtml(entry.error || 'duplicate')}`);
      continue;
    }
    if (!entry.id) {
      lines.push(`• ❌ ${safeName} — ${escapeHtml(entry.error || 'processing failed')}`);
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
      lines.push(`• ℹ️ #${entry.id} [${safeWire}] ${safeName} — ${escapeHtml(settled.status)}`);
    }
  }
  return lines.join('\n').slice(0, 4000);
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
export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
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
    forwardedFrom,
  };

  // Batch mode: numbered list, bold-name, or structured (Link:) format
  if (isBatchMessage(text)) {
    console.log(`[TelegramAdapter] Batch message detected from user ${userId}`);
    await sendMessage(message.chat.id, '📥 Batch received. Running intake and history checks…');
    const batch = await processBatchMessage(intakeMsg, 'telegram');
    const acceptedIds = batch.entries
      .filter(entry => entry.id && !entry.isDuplicate)
      .map(entry => entry.id!);

    let settled: SettledBatchEntry[] = [];
    try {
      await runDecidedRecheckForIds(getPool(), acceptedIds);
    } catch (error) {
      console.error('[TelegramAdapter] Immediate history check failed:', error);
    }

    if (acceptedIds.length > 0) {
      try {
        settled = (await getPool().query(
          `SELECT id, status, duplicate_of_id, duplicate_reason,
                  metadata -> 'decided_recheck' AS decided_recheck,
                  metadata -> 'duplicate_chain_error' AS duplicate_chain_error
           FROM scan_entries
           WHERE id = ANY($1::bigint[])`,
          [acceptedIds],
        )).rows as SettledBatchEntry[];
      } catch (error) {
        console.error('[TelegramAdapter] Final batch status read failed:', error);
      }
    }

    await sendMessage(message.chat.id, formatSettledBatchReport(batch, settled));
    return;
  }

  const result = await processIntakeMessage(intakeMsg, 'telegram');

  // Inserted, rejected, or error — send reply
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

