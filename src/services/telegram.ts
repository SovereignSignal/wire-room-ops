/**
 * Telegram Bot Service
 *
 * Raw HTTP integration with Telegram Bot API — no npm dependency.
 * Handles webhook registration and incoming message processing.
 *
 * Users send a URL, the bot scrapes + extracts grant info,
 * runs it through the intake pipeline, and replies with results.
 */

import { config } from '../config';
import { processUrl } from './url-processor';
import { runDailyIntake } from '../jobs/daily-intake';
import { getPool } from '../db';
import type { ScanSubmission } from '../types/intake';

const TELEGRAM_API = 'https://api.telegram.org/bot';

// ============================================================
// Telegram API helpers
// ============================================================

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name?: string; username?: string };
    chat: { id: number; type: string };
    text?: string;
    date: number;
  };
}

export async function sendMessage(chatId: number | string, text: string, parseMode: string = 'HTML'): Promise<void> {
  const url = `${TELEGRAM_API}${config.telegram.botToken}/sendMessage`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[Telegram] sendMessage failed: ${resp.status} - ${err}`);
    }
  } catch (e) {
    console.error(`[Telegram] sendMessage error:`, e);
  }
}

// ============================================================
// Webhook Registration
// ============================================================

/**
 * Register the webhook URL with Telegram.
 * Called on server startup if TELEGRAM_BOT_TOKEN is set.
 */
export async function registerTelegramWebhook(): Promise<void> {
  const webhookUrl = `${config.app.url}/webhook/telegram`;
  const url = `${TELEGRAM_API}${config.telegram.botToken}/setWebhook`;

  const body: Record<string, unknown> = { url: webhookUrl };
  if (config.telegram.webhookSecret) {
    body.secret_token = config.telegram.webhookSecret;
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Telegram setWebhook failed: ${resp.status} - ${err}`);
  }

  const data = await resp.json() as { ok: boolean; description?: string };
  if (!data.ok) {
    throw new Error(`Telegram setWebhook failed: ${data.description}`);
  }

  console.log(`[Telegram] Webhook registered: ${webhookUrl}`);
}

// ============================================================
// Message Handling
// ============================================================

/**
 * Handle an incoming Telegram update (webhook payload).
 * Processes asynchronously — caller should return 200 immediately.
 */
export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message || !message.text || !message.from) return;

  const userId = String(message.from.id);
  const chatId = message.chat.id;
  const text = message.text.trim();

  // Access control
  if (!config.telegram.allowedUserIds.includes(userId)) {
    await sendMessage(chatId, 'Access denied. Your user ID is not in the allowlist.');
    console.log(`[Telegram] Rejected user ${userId} (${message.from.username || 'unknown'})`);
    return;
  }

  // Command handling
  if (text === '/start' || text === '/help') {
    await sendMessage(chatId, formatHelpMessage());
    return;
  }

  if (text === '/status') {
    await handleStatusCommand(chatId, userId);
    return;
  }

  // Extract URL from message
  const urlMatch = text.match(/https?:\/\/[^\s]+/);
  if (!urlMatch) {
    await sendMessage(chatId, 'Please send a URL to process. Use /help for usage info.');
    return;
  }

  const url = urlMatch[0].replace(/[.,;:!?)]+$/, ''); // Clean trailing punctuation
  await processUrlSubmission(chatId, userId, url);
}

/**
 * Process a URL submission from Telegram.
 */
async function processUrlSubmission(chatId: number, userId: string, url: string): Promise<void> {
  await sendMessage(chatId, `Processing: ${escapeHtml(url)}\nThis may take a moment...`);

  try {
    const { result, detectedWire } = await processUrl(url);
    const wire = detectedWire || config.telegram.defaultWire;
    const today = new Date().toISOString().split('T')[0];

    const submission: ScanSubmission = {
      wire,
      promptVariant: 'N',
      scanDate: today,
      source: 'telegram',
      results: [result],
      submittedBy: `telegram:${userId}`,
    };

    const pool = getPool();
    const summary = await runDailyIntake(pool, [submission]);

    // Build reply
    const isDupe = summary.duplicatesFound > 0;
    const topFind = summary.topFinds[0] as any;
    const score = topFind?.quality_score ?? topFind?.qualityScore ?? summary.averageQualityScore;
    const status = isDupe ? 'Duplicate' : (score >= 40 ? 'Queued' : 'Archived');

    let reply = `<b>${escapeHtml(result.name)}</b>\n\n`;
    reply += `${escapeHtml(result.description)}\n\n`;
    if (result.amount) reply += `Amount: ${escapeHtml(result.amount)}\n`;
    if (result.deadline) reply += `Deadline: ${escapeHtml(result.deadline)}\n`;
    reply += `Wire: <code>${escapeHtml(wire)}</code>\n`;
    reply += `Score: ${score ?? '-'}\n`;
    reply += `Status: <b>${status}</b>`;

    if (isDupe) {
      reply += `\n\n<i>This entry was flagged as a duplicate.</i>`;
    }

    await sendMessage(chatId, reply);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Telegram] URL processing failed:`, errMsg);
    await sendMessage(chatId, `Failed to process URL: ${escapeHtml(errMsg.substring(0, 200))}`);
  }
}

/**
 * Handle /status command — show recent submission stats.
 */
async function handleStatusCommand(chatId: number, userId: string): Promise<void> {
  try {
    const pool = getPool();
    const res = await pool.query(
      `SELECT
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE status = 'queued') as queued,
         COUNT(*) FILTER (WHERE status = 'duplicate') as dupes,
         COUNT(*) FILTER (WHERE status = 'archived') as archived
       FROM scan_entries
       WHERE scan_source = 'telegram' AND submitted_by = $1`,
      [`telegram:${userId}`]
    );

    const stats = res.rows[0];
    let reply = `<b>Your Telegram Submissions</b>\n\n`;
    reply += `Total: ${stats.total}\n`;
    reply += `Queued: ${stats.queued}\n`;
    reply += `Duplicates: ${stats.dupes}\n`;
    reply += `Archived: ${stats.archived}`;

    await sendMessage(chatId, reply);
  } catch (error) {
    console.error(`[Telegram] Status query failed:`, error);
    await sendMessage(chatId, 'Failed to retrieve status.');
  }
}

function formatHelpMessage(): string {
  return `<b>The Wire Room Bot</b>

Send me a URL to a grant or funding opportunity and I'll extract the details and add it to the pipeline.

<b>Commands:</b>
/help — Show this message
/status — Your submission stats

<b>Usage:</b>
Just paste a URL (X.com posts, web pages, etc.) and I'll:
1. Scrape the page content
2. Extract grant details (name, amount, deadline)
3. Run it through dedup and quality scoring
4. Add qualifying entries to the review queue`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
