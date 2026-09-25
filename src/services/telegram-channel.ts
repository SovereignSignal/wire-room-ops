/**
 * Telegram channel posting via Bot API.
 * Uses native fetch — no additional dependencies.
 */

const TELEGRAM_API = 'https://api.telegram.org';

interface TelegramResult {
  messageId: number;
}

export async function sendChannelMessage(
  botToken: string,
  channelId: string,
  html: string
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

    const data = await resp.json() as { ok: boolean; result?: { message_id: number }; description?: string };

    if (!data.ok) {
      console.error(`[Telegram] sendMessage failed: ${data.description}`);
      return null;
    }

    return { messageId: data.result!.message_id };
  } catch (error) {
    console.error('[Telegram] sendMessage error:', error);
    return null;
  }
}
