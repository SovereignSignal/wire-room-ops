/**
 * Telegram intake webhook handler.
 * Receives forwarded URLs/articles/text from the ingestion bot
 * and inserts them as raw scan_entries for pipeline processing.
 * Uses native fetch — no additional dependencies.
 */

import { getPool } from '../db';
import { config } from '../config';

const TELEGRAM_API = 'https://api.telegram.org';

// Pending entries waiting for wire selection via inline keyboard
const pendingEntries = new Map<string, PendingEntry>();

interface PendingEntry {
  name: string;
  description: string;
  sourceUrl: string;
  scanDate: string;
  submittedBy: string;
  chatId: number;
  createdAt: number;
}

// Wire detection keyword sets
const WIRE_KEYWORDS: Record<string, RegExp> = {
  crypto: /\b(grant|protocol|defi|ethereum|solana|arbitrum|optimism|dao|web3|blockchain|uniswap|aave|crypto|token|staking)\b/i,
  ai: /\b(llm|openai|anthropic|gpt|machine learning|artificial intelligence|foundation model|deep learning|neural|transformer)\b/i,
  oss: /\b(open source|github|apache|linux|cncf|mozilla|open-source|foss|libre)\b/i,
};

/**
 * Extract the first URL from a text string.
 */
function extractUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"{}|\\^`\[\]]+/i);
  return match ? match[0] : null;
}

/**
 * Detect wire/vertical from message text.
 * Returns the wire key if a single match is found, null if ambiguous or none.
 */
function detectWire(text: string): string | null {
  const matches: string[] = [];
  for (const [wire, regex] of Object.entries(WIRE_KEYWORDS)) {
    if (regex.test(text)) matches.push(wire);
  }
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Build the entry name from message text.
 */
function buildName(text: string, url: string | null): string {
  const firstLine = text.split('\n')[0].trim();
  if (firstLine && firstLine !== url) {
    return firstLine.slice(0, 120);
  }
  if (url) {
    try {
      const domain = new URL(url).hostname.replace('www.', '');
      return `Manual: ${domain}`;
    } catch {
      return 'Manual submission';
    }
  }
  return 'Manual submission';
}

/**
 * Get the message text from a Telegram update, handling forwarded messages.
 */
function getMessageText(message: TelegramMessage): string {
  return message.text || message.caption || '';
}

/**
 * Insert a scan entry into the database.
 */
async function insertEntry(entry: {
  name: string;
  description: string;
  sourceUrl: string;
  wire: string;
  scanDate: string;
  submittedBy: string;
}): Promise<number> {
  const pool = getPool();
  const res = await pool.query(
    `INSERT INTO scan_entries
     (name, description, source_url, wire, prompt_variant, scan_source, scan_date, status, submitted_by)
     VALUES ($1, $2, $3, $4, 'N', 'telegram-intake', $5, 'raw', $6)
     RETURNING id`,
    [entry.name, entry.description, entry.sourceUrl, entry.wire, entry.scanDate, entry.submittedBy]
  );
  return res.rows[0].id;
}

/**
 * Send a message via the intake bot.
 */
async function sendMessage(chatId: number, text: string, replyMarkup?: object): Promise<void> {
  const botToken = config.telegramIntake.botToken;
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
      console.error(`[TelegramIntake] sendMessage failed: ${data.description}`);
    }
  } catch (error) {
    console.error('[TelegramIntake] sendMessage error:', error);
  }
}

/**
 * Send inline keyboard asking user to pick a wire.
 */
async function askForWire(chatId: number, pendingKey: string): Promise<void> {
  await sendMessage(chatId, 'Which beat does this belong to?', {
    inline_keyboard: [
      [
        { text: 'Crypto', callback_data: `wire:${pendingKey}:crypto` },
        { text: 'AI', callback_data: `wire:${pendingKey}:ai` },
        { text: 'OSS', callback_data: `wire:${pendingKey}:oss` },
      ],
    ],
  });
}

/**
 * Answer a callback query (dismiss the loading spinner on inline buttons).
 */
async function answerCallbackQuery(callbackQueryId: string): Promise<void> {
  const botToken = config.telegramIntake.botToken;
  try {
    await fetch(`${TELEGRAM_API}/bot${botToken}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    });
  } catch (error) {
    console.error('[TelegramIntake] answerCallbackQuery error:', error);
  }
}

// Minimal Telegram types (only what we need)
interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name?: string };
  chat: { id: number };
  text?: string;
  caption?: string;
  forward_date?: number;
  forward_from?: { id: number };
  forward_from_chat?: { id: number };
}

interface TelegramCallbackQuery {
  id: string;
  from: { id: number };
  message?: { chat: { id: number }; message_id: number };
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

/**
 * Main handler for incoming Telegram webhook updates.
 */
export async function handleTelegramIntakeUpdate(update: TelegramUpdate): Promise<void> {
  // Handle callback queries (wire selection from inline keyboard)
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }

  const message = update.message;
  if (!message?.from) return;

  const userId = message.from.id;
  const allowedUserId = config.telegramIntake.allowedUserId;

  // Verify sender is allowed
  if (allowedUserId && String(userId) !== allowedUserId) {
    console.log(`[TelegramIntake] Rejected message from unauthorized user ${userId}`);
    await sendMessage(message.chat.id, 'You are not authorized to submit entries.');
    return;
  }

  const text = getMessageText(message);
  if (!text.trim()) {
    await sendMessage(message.chat.id, 'Please send a URL or text to submit.');
    return;
  }

  const url = extractUrl(text);
  const name = buildName(text, url);
  const sourceUrl = url || `https://t.me/manual/${Date.now()}`;
  const scanDate = new Date().toISOString().slice(0, 10);
  const submittedBy = `telegram:${userId}`;
  const wire = detectWire(text);

  if (wire) {
    // Wire detected — insert directly
    try {
      const id = await insertEntry({ name, description: text, sourceUrl, wire, scanDate, submittedBy });
      console.log(`[TelegramIntake] Inserted entry #${id} (${wire}) from user ${userId}`);
      await sendMessage(message.chat.id,
        `Captured <b>${wire}</b> entry #${id}:\n<code>${escapeHtml(name)}</code>${url ? `\n${escapeHtml(url)}` : ''}`
      );
    } catch (error) {
      console.error('[TelegramIntake] Insert failed:', error);
      await sendMessage(message.chat.id, 'Failed to save entry. Try again.');
    }
  } else {
    // Ambiguous or no wire detected — ask via inline keyboard
    const pendingKey = `${message.chat.id}_${message.message_id}`;
    pendingEntries.set(pendingKey, {
      name,
      description: text,
      sourceUrl,
      scanDate,
      submittedBy,
      chatId: message.chat.id,
      createdAt: Date.now(),
    });
    console.log(`[TelegramIntake] Pending wire selection for key ${pendingKey}`);
    await askForWire(message.chat.id, pendingKey);
  }
}

/**
 * Handle callback query from inline keyboard wire selection.
 */
async function handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
  await answerCallbackQuery(query.id);

  const data = query.data;
  if (!data?.startsWith('wire:')) return;

  const parts = data.split(':');
  if (parts.length !== 3) return;

  const pendingKey = parts[1];
  const wire = parts[2];

  const entry = pendingEntries.get(pendingKey);
  if (!entry) {
    if (query.message) {
      await sendMessage(query.message.chat.id, 'This selection has expired. Please resend the message.');
    }
    return;
  }

  pendingEntries.delete(pendingKey);

  try {
    const id = await insertEntry({ ...entry, wire });
    console.log(`[TelegramIntake] Inserted entry #${id} (${wire}) via callback`);
    await sendMessage(entry.chatId,
      `Captured <b>${wire}</b> entry #${id}:\n<code>${escapeHtml(entry.name)}</code>`
    );
  } catch (error) {
    console.error('[TelegramIntake] Callback insert failed:', error);
    await sendMessage(entry.chatId, 'Failed to save entry. Try again.');
  }
}

/**
 * Register the webhook with Telegram.
 */
export async function registerIntakeWebhook(): Promise<void> {
  const { botToken, webhookSecret } = config.telegramIntake;
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
      console.log(`[TelegramIntake] Webhook registered: ${webhookUrl}`);
    } else {
      console.error(`[TelegramIntake] Webhook registration failed: ${data.description}`);
    }
  } catch (error) {
    console.error('[TelegramIntake] Webhook registration error:', error);
  }
}

/**
 * Cleanup expired pending entries (older than 1 hour).
 */
export function cleanupPendingEntries(): void {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [key, entry] of pendingEntries.entries()) {
    if (entry.createdAt < oneHourAgo) {
      pendingEntries.delete(key);
    }
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
