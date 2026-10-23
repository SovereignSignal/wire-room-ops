/**
 * Telegram channel posting via Bot API.
 * Uses native fetch — no additional dependencies.
 */

const TELEGRAM_API = 'https://api.telegram.org';

interface TelegramResult {
  messageId: number;
}

export interface SendChannelMessageOptions {
  /**
   * Called before returning null when Telegram answered ok:false with a 4xx
   * error_code. Telegram creates no message in that case, so the caller may
   * record a definite failure. Timeouts, network errors, 5xx and unreadable
   * bodies stay unknown and never call this.
   */
  onRejected?: (description: string) => void;
}

export function isDefiniteTelegramRejection(data: unknown): data is { ok: false; error_code: number; description?: string } {
  if (!data || typeof data !== 'object') return false;
  const body = data as { ok?: unknown; error_code?: unknown };
  return body.ok === false
    && typeof body.error_code === 'number'
    && body.error_code >= 400 && body.error_code < 500;
}

export async function sendChannelMessage(
  botToken: string,
  channelId: string,
  html: string,
  opts: SendChannelMessageOptions = {},
): Promise<TelegramResult | null> {
  try {
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

    if (!data.ok) {
      console.error(`[Telegram] sendMessage failed: ${data.description}`);
      if (isDefiniteTelegramRejection(data)) {
        opts.onRejected?.(`${data.error_code}: ${data.description || 'rejected'}`);
      }
      return null;
    }

    return { messageId: data.result!.message_id };
  } catch (error) {
    console.error('[Telegram] sendMessage error:', error);
    return null;
  }
}
