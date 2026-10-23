/**
 * Telegram channel posting via Bot API.
 * Uses native fetch — no additional dependencies.
 */

const TELEGRAM_API = 'https://api.telegram.org';

interface TelegramResult {
  messageId: number;
}

/** Longest retry_after waited out inside one send; longer waits go back to the caller. */
export const MAX_INLINE_RETRY_AFTER_SECONDS = 30;
export const MAX_RATE_LIMIT_RETRIES = 2;
/** Used when a 429 carries no usable retry_after. */
export const DEFAULT_RETRY_AFTER_SECONDS = 60;

export interface SendChannelMessageOptions {
  /**
   * Called before returning null when Telegram answered ok:false with a 4xx
   * error_code other than 429. Telegram creates no message in that case, so
   * the caller may record a definite failure. Timeouts, network errors, 5xx
   * and unreadable bodies stay unknown and never call this.
   */
  onRejected?: (description: string) => void;
  /**
   * Called before returning null when Telegram is still rate limiting (429)
   * after the inline retries. No message was created; the send may be retried
   * after `retryAfterSeconds`.
   */
  onRateLimited?: (retryAfterSeconds: number, description: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

type TelegramBody = {
  ok?: unknown;
  error_code?: unknown;
  description?: string;
  parameters?: { retry_after?: unknown };
};

/** 429 is retryable, not a rejection; every other 4xx (400, 401, 403, ...) is definite. */
export function isDefiniteTelegramRejection(data: unknown): data is { ok: false; error_code: number; description?: string } {
  if (!data || typeof data !== 'object') return false;
  const body = data as TelegramBody;
  return body.ok === false
    && typeof body.error_code === 'number'
    && body.error_code >= 400 && body.error_code < 500
    && body.error_code !== 429;
}

/** Seconds to wait from a 429 body, or null when the body is not a rate limit. */
export function telegramRetryAfterSeconds(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null;
  const body = data as TelegramBody;
  if (body.ok !== false || body.error_code !== 429) return null;
  const raw = Number(body.parameters?.retry_after);
  return Number.isFinite(raw) && raw >= 0 ? Math.ceil(raw) : DEFAULT_RETRY_AFTER_SECONDS;
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function sendChannelMessage(
  botToken: string,
  channelId: string,
  html: string,
  opts: SendChannelMessageOptions = {},
): Promise<TelegramResult | null> {
  const sleep = opts.sleep ?? defaultSleep;
  try {
    for (let attempt = 0; ; attempt++) {
      const resp = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
        method: 'POST',
        signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: channelId,
          text: html,
          parse_mode: 'HTML',
          disable_web_page_preview: false,
        }),
      });

      const data = await resp.json() as { ok: boolean; result?: { message_id: number }; description?: string; error_code?: number };

      if (data.ok) return { messageId: data.result!.message_id };

      console.error(`[Telegram] sendMessage failed: ${data.description}`);
      const retryAfter = telegramRetryAfterSeconds(data);
      if (retryAfter !== null) {
        if (attempt < MAX_RATE_LIMIT_RETRIES && retryAfter <= MAX_INLINE_RETRY_AFTER_SECONDS) {
          await sleep(retryAfter * 1000);
          continue;
        }
        opts.onRateLimited?.(retryAfter, `429: ${data.description || 'Too Many Requests'}`);
        return null;
      }
      if (isDefiniteTelegramRejection(data)) {
        opts.onRejected?.(`${data.error_code}: ${data.description || 'rejected'}`);
      }
      return null;
    }
  } catch (error) {
    console.error('[Telegram] sendMessage error:', error);
    return null;
  }
}
