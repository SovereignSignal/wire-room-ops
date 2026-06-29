/**
 * Telegram adapter — thin layer between Telegram Bot API and intake-core.
 *
 * All Telegram-specific API calls live here. Business logic (wire detection,
 * DB insert) is delegated to intake-core.ts.
 */

import { config } from '../config';
import { getCachedProvider } from './api-provider';
import { processIntakeMessage, isBatchMessage, processBatchMessage } from './intake-core';

function getIntakeBotToken(): string {
  return getCachedProvider('telegram-intake')?.api_key || config.telegramIntake.botToken;
}
import type { IntakeResult } from './intake-core';

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
    await sendMessage(message.chat.id, '⏳ Processing batch… hold tight.');
    const batch = await processBatchMessage(intakeMsg, 'telegram');
    const summaryParts = [`✅ ${batch.inserted} added`];
    if (batch.duplicates > 0) summaryParts.push(`🔄 ${batch.duplicates} duplicate${batch.duplicates !== 1 ? 's' : ''}`);
    if (batch.errors > 0) summaryParts.push(`❌ ${batch.errors} error${batch.errors !== 1 ? 's' : ''}`);
    const lines = [`Batch complete: ${summaryParts.join(', ')}\n`];
    for (const e of batch.entries) {
      if (e.id) {
        lines.push(`• ✅ #${e.id} [${e.wire}] ${e.name}`);
      } else if (e.isDuplicate) {
        lines.push(`• 🔄 ${e.name} — ${e.error}`);
      } else {
        lines.push(`• ❌ ${e.name} — ${e.error}`);
      }
    }
    await sendMessage(message.chat.id, lines.join('\n').slice(0, 4000));
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

