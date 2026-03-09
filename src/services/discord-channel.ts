/**
 * Discord channel posting via REST API.
 * Uses native fetch — no additional dependencies.
 */

const DISCORD_API = 'https://discord.com/api/v10';

interface DiscordResult {
  messageId: string;
}

export async function sendDiscordMessage(
  botToken: string,
  channelId: string,
  content: string
): Promise<DiscordResult | null> {
  try {
    const resp = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bot ${botToken}`,
      },
      body: JSON.stringify({ content }),
    });

    if (!resp.ok) {
      const errorBody = await resp.text();
      console.error(`[Discord] sendMessage failed (${resp.status}): ${errorBody}`);
      return null;
    }

    const data = await resp.json() as { id: string };
    return { messageId: data.id };
  } catch (error) {
    console.error('[Discord] sendMessage error:', error);
    return null;
  }
}
