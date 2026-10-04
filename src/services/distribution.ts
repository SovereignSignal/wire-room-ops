/**
 * Distribution orchestrator.
 * Coordinates post generation and dispatch to Telegram + X channels.
 * Newsletter generation is a separate read-only operation.
 */

import { getDistributionConfigs, getUndistributedEntries, logDistribution, claimDistributionLog, finalizeDistributionLog, getDistributionLogs, getPool, getEnabledDistributionChannelsForWire, DistributionChannelRecord } from '../db';
import { getCachedProvider } from './api-provider';
import { generatePosts, templatePosts } from './post-generator';

function getTelegramBotToken(): string {
  return getCachedProvider('telegram')?.api_key || '';
}
import { sendChannelMessage } from './telegram-channel';
import { sendDiscordMessage } from './discord-channel';
import { postTweet, XCredentials } from './x-client';
import { sleep } from '../utils/async';
import type { DistributionConfig, DistributionChannel } from '../types/intake';

export interface DistributeResult {
  wire: string;
  totalEntries: number;
  distributed: number;
  failed: number;
  skipped: number;
  details: Array<{
    entryId: number;
    name: string;
    channels: Record<string, 'success' | 'failed' | 'skipped'>;
  }>;
}

/**
 * Distribute all undistributed approved entries for a wire.
 */
export async function distributeEntries(wire: string): Promise<DistributeResult> {
  const entries = await getUndistributedEntries(wire);
  const result: DistributeResult = { wire, totalEntries: entries.length, distributed: 0, failed: 0, skipped: 0, details: [] };
  for (const entry of entries) {
    try {
      const sent = await distributeEntry(entry.id, wire, true);
      if (sent.distributed) result.distributed++;
      result.failed += sent.failed;
      result.skipped += sent.skipped;
      result.details.push(...sent.details);
    } catch (error) {
      // A receipt failure must not fabricate failed logs for successful sends.
      console.error(`[Distribution] Entry ${entry.id} needs recovery:`, error);
      result.failed++;
    }
    if (entry !== entries[entries.length - 1]) await sleep(3000);
  }
  return result;
}

async function dispatchToManagedChannel(
  mc: DistributionChannelRecord,
  entry: any,
  posts: { tweet: string; telegram: string },
): Promise<'success' | 'failed' | 'skipped'> {
  const channel = mc.channel as DistributionChannel;
  const creds = mc.credentials || {};
  const targetId = mc.targetId;

  if (channel === 'telegram') {
    const token = creds.bot_token || getTelegramBotToken();
    if (!token || !targetId) {
      await logDistribution({
        entryId: entry.id,
        channel: 'telegram',
        channelId: mc.id,
        wire: mc.wire,
        status: 'skipped',
        errorMessage: !token ? 'bot_token not set' : 'target_id not configured',
      });
      return 'skipped';
    }

    return sendAfterClaim({
      entryId: entry.id,
      channel: 'telegram',
      channelId: mc.id,
      wire: mc.wire,
      postText: posts.telegram,
      send: async () => {
        const result = await sendChannelMessage(token, targetId, posts.telegram);
        return result
          ? { ok: true, externalId: String(result.messageId) }
          : { ok: false, errorMessage: 'Telegram API call failed' };
      },
    });
  }

  if (channel === 'discord') {
    const token = creds.bot_token;
    if (!token || !targetId) {
      await logDistribution({
        entryId: entry.id,
        channel: 'discord',
        channelId: mc.id,
        wire: mc.wire,
        status: 'skipped',
        errorMessage: !token ? 'bot_token not set' : 'target_id (channel ID) not configured',
      });
      return 'skipped';
    }

    return sendAfterClaim({
      entryId: entry.id,
      channel: 'discord',
      channelId: mc.id,
      wire: mc.wire,
      postText: posts.telegram,
      send: async () => {
        const result = await sendDiscordMessage(token, targetId, posts.telegram);
        return result
          ? { ok: true, externalId: result.messageId }
          : { ok: false, errorMessage: 'Discord API call failed' };
      },
    });
  }

  if (channel === 'slack') {
    const webhookUrl = creds.webhook_url;
    if (!webhookUrl) {
      await logDistribution({
        entryId: entry.id,
        channel: 'slack',
        channelId: mc.id,
        wire: mc.wire,
        status: 'skipped',
        errorMessage: 'webhook_url not set',
      });
      return 'skipped';
    }

    return sendAfterClaim({
      entryId: entry.id,
      channel: 'slack',
      channelId: mc.id,
      wire: mc.wire,
      postText: posts.telegram,
      send: async () => {
        try {
          const resp = await fetch(webhookUrl, {
            method: 'POST',
            signal: AbortSignal.timeout(30000),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: posts.telegram }),
          });
          return resp.ok
            ? { ok: true }
            : { ok: false, errorMessage: `Slack webhook returned ${resp.status}` };
        } catch (error) {
          return { ok: false, errorMessage: error instanceof Error ? error.message : 'Unknown error' };
        }
      },
    });
  }

  return 'skipped';
}

/**
 * Send a test message to a managed distribution channel.
 */
export async function sendTestMessage(mc: DistributionChannelRecord): Promise<{ success: boolean; error?: string }> {
  const creds = mc.credentials || {};
  const targetId = mc.targetId;
  const testText = `🛰️ Wire Room Test Message\n\nThis is a test from Wire Room Ops.\nChannel: ${mc.name || mc.channel}\nWire: ${mc.wire}\nTimestamp: ${new Date().toISOString()}`;

  if (mc.channel === 'telegram') {
    const token = creds.bot_token || getTelegramBotToken();
    if (!token || !targetId) return { success: false, error: !token ? 'bot_token not set' : 'target_id not configured' };
    const result = await sendChannelMessage(token, targetId, testText);
    return result ? { success: true } : { success: false, error: 'Telegram API call failed' };
  }

  if (mc.channel === 'discord') {
    const token = creds.bot_token;
    if (!token || !targetId) return { success: false, error: !token ? 'bot_token not set' : 'target_id (channel ID) not configured' };
    const result = await sendDiscordMessage(token, targetId, testText);
    return result ? { success: true } : { success: false, error: 'Discord API call failed' };
  }

  if (mc.channel === 'slack') {
    const webhookUrl = creds.webhook_url;
    if (!webhookUrl) return { success: false, error: 'webhook_url not set' };
    try {
      const resp = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: testText }),
      });
      return resp.ok ? { success: true } : { success: false, error: `Slack webhook returned ${resp.status}` };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  return { success: false, error: `Unsupported channel type: ${mc.channel}` };
}

async function dispatchToChannel(
  cfg: DistributionConfig,
  entry: any,
  posts: { tweet: string; telegram: string },
  telegramBotToken?: string
): Promise<'success' | 'failed' | 'skipped'> {
  if (cfg.channel === 'telegram') {
    const token = telegramBotToken;
    const channelId = cfg.config.channelId;
    if (!token || !channelId) {
      await logDistribution({
        entryId: entry.id,
        channel: 'telegram',
        wire: cfg.wire,
        status: 'skipped',
        errorMessage: !token ? 'TELEGRAM_BOT_TOKEN not set' : 'channelId not configured',
      });
      return 'skipped';
    }

    return sendAfterClaim({
      entryId: entry.id,
      channel: 'telegram',
      wire: cfg.wire,
      postText: posts.telegram,
      send: async () => {
        const result = await sendChannelMessage(token, channelId, posts.telegram);
        return result
          ? { ok: true, externalId: String(result.messageId) }
          : { ok: false, errorMessage: 'Telegram API call failed' };
      },
    });
  }

  if (cfg.channel === 'x') {
    const creds: XCredentials = {
      appKey: cfg.config.appKey || '',
      appSecret: cfg.config.appSecret || '',
      accessToken: cfg.config.accessToken || '',
      accessSecret: cfg.config.accessSecret || '',
    };

    if (!creds.appKey || !creds.appSecret || !creds.accessToken || !creds.accessSecret) {
      await logDistribution({
        entryId: entry.id,
        channel: 'x',
        wire: cfg.wire,
        status: 'skipped',
        errorMessage: 'X credentials not fully configured',
      });
      return 'skipped';
    }

    return sendAfterClaim({
      entryId: entry.id,
      channel: 'x',
      wire: cfg.wire,
      postText: posts.tweet,
      send: async () => {
        const result = await postTweet(posts.tweet, creds);
        return result
          ? { ok: true, externalId: result.id }
          : { ok: false, errorMessage: 'X API call failed' };
      },
    });
  }

  return 'skipped';
}

async function sendAfterClaim(params: {
  entryId: number;
  channel: DistributionChannel;
  wire: string;
  channelId?: string;
  postText: string;
  send: () => Promise<{ ok: boolean; externalId?: string; errorMessage?: string }>;
}): Promise<'success' | 'failed' | 'skipped'> {
  const slot = await claimDistributionLog({
    entryId: params.entryId,
    channel: params.channel,
    wire: params.wire,
    channelId: params.channelId,
    postText: params.postText,
  });
  if (!slot) return 'skipped';

  let result;
  try {
    result = await params.send();
  } catch (error) {
    await flagUncertainDelivery(slot.id, error instanceof Error ? error.message : 'Send outcome unknown');
    return 'failed';
  }
  // Legacy adapters return null for both network timeouts and API errors.
  // Without a positive receipt, automatic resend could duplicate publication.
  if (!result.ok) {
    await flagUncertainDelivery(slot.id, result.errorMessage || 'Send outcome unknown');
    return 'failed';
  }
  // Retry only receipt persistence, never a send that already succeeded.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await finalizeDistributionLog(slot.id, {
        status: 'success', postText: params.postText, externalId: result.externalId,
      });
      return 'success';
    } catch (error) {
      if (attempt === 2) {
        console.error(`[Distribution] Receipt for claim ${slot.id} needs reconciliation`, { externalId: result.externalId });
        await flagUncertainDelivery(slot.id, 'Successful send; receipt persistence failed', result.externalId, params.postText);
        throw error;
      }
      await sleep(100 * (attempt + 1));
    }
  }
  return 'failed';
}

/**
 * Distribute a single approved entry immediately to all enabled channels for its wire.
 * Used when an entry is approved via the dashboard — only sends that one entry,
 * not the entire backlog of approved-but-undistributed entries.
 */
export async function distributeEntry(entryId: number, wire: string, wireOnly = false): Promise<DistributeResult> {
  const pool = getPool();
  // Withheld is checked here because the wire run and the retry route reach this without the queue worker.
  const entryResult = await pool.query(
    `SELECT * FROM scan_entries WHERE id = $1 AND status = 'approved' AND distributable IS NOT FALSE
       AND NOT EXISTS (SELECT 1 FROM publication_queue q WHERE q.entry_id = scan_entries.id AND q.status = 'withheld')`,
    [entryId]
  );

  if (entryResult.rows.length === 0) {
    return { wire, totalEntries: 0, distributed: 0, failed: 0, skipped: 0, details: [] };
  }

  const entry = entryResult.rows[0];

  // Multi-wire fan-out: an entry tagged to multiple wires (wires[] column,
  // set via the queue's wire selector) posts to EVERY tagged wire's channels.
  // Single-wire entries behave exactly as before. The unique partial index
  // on distribution_logs (entry_id, channel, channel_id) prevents double-posts
  // to the same channel across repeated calls.
  const wireList: string[] = wireOnly ? [wire] : Array.from(new Set(
    Array.isArray(entry.wires) && entry.wires.length > 0 ? entry.wires : [entry.wire || wire]
  ));

  const telegramBotToken = getTelegramBotToken();
  const detail: DistributeResult['details'][0] = { entryId: entry.id, name: entry.name, channels: {} };
  const result: DistributeResult = { wire, totalEntries: 1, distributed: 0, failed: 0, skipped: 0, details: [detail] };
  const multiWire = wireList.length > 1;
  let storedTelegram: string | null | undefined;

  for (const w of wireList) {
    const configs = await getDistributionConfigs(w);
    const logs = await getDistributionLogs(entryId);
    const settled = (channel: string, channelId?: string) => logs.some(l => {
      if (l.wire !== w || l.channel !== channel) return false;
      const sameSlot = (l.channelId || null) === (channelId || null);
      if (sameSlot && (l.status === 'success' || l.status === 'pending' || l.status === 'acknowledged')) return true;
      // Historical telegram failures have no channel id. Closing one of those
      // covers every telegram destination on this wire.
      return l.status === 'acknowledged' && l.channel === 'telegram' && !l.channelId && channel === 'telegram';
    });
    const enabledConfigs = configs.filter(c => c.enabled && c.channel !== 'newsletter' && !settled(c.channel));
    const managedChannels = (await getEnabledDistributionChannelsForWire(w)).filter(c => !settled(c.channel, c.id));

    if (enabledConfigs.length === 0 && managedChannels.length === 0) continue;

    if (storedTelegram === undefined) {
      const stored = (await pool.query(
        `SELECT post_text FROM publication_queue WHERE entry_id = $1`,
        [entry.id],
      )).rows[0];
      const text = typeof stored?.post_text === 'string' ? stored.post_text.trim() : '';
      storedTelegram = text || null;
    }
    const source = {
      name: entry.name,
      description: entry.description || '',
      amount: entry.amount,
      deadline: entry.deadline,
      sourceUrl: entry.source_url,
    };
    // A frozen queue draft is sent exactly. Missing text is a legacy row.
    const posts = storedTelegram
      ? { tweet: templatePosts(source).tweet, telegram: storedTelegram }
      : await generatePosts(source, w);

    for (const cfg of enabledConfigs) {
      const channelResult = await dispatchToChannel(cfg, entry, posts, telegramBotToken);
      detail.channels[multiWire ? `${w}/${cfg.channel}` : cfg.channel] = channelResult;
      if (channelResult === 'success') result.distributed++;
      if (channelResult === 'failed') result.failed++;
      if (channelResult === 'skipped') result.skipped++;
    }

    for (const mc of managedChannels) {
      const channelResult = await dispatchToManagedChannel(mc, entry, posts);
      const channelKey = multiWire ? `${w}/${mc.channel}:${mc.id.slice(0, 8)}` : `${mc.channel}:${mc.id.slice(0, 8)}`;
      detail.channels[channelKey] = channelResult;
      if (channelResult === 'success') result.distributed++;
      if (channelResult === 'failed') result.failed++;
      if (channelResult === 'skipped') result.skipped++;
    }
  }

  if (Object.keys(detail.channels).length === 0) result.totalEntries = 0;
  return result;
}

export async function retryDistribution(entryId: number, wire: string): Promise<DistributeResult> {
  return distributeEntry(entryId, wire);
}

async function flagUncertainDelivery(id: number, message: string, externalId?: string, postText?: string): Promise<void> {
  await getPool().query(`UPDATE distribution_logs SET needs_review = true, error_message = $2,
    external_id = COALESCE($3, external_id), post_text = COALESCE($4, post_text)
    WHERE id = $1 AND status = 'pending'`, [id, message, externalId || null, postText || null]);
}

/**
 * Generate a newsletter markdown digest of approved entries.
 * Pure read — does NOT write distribution logs.
 * Call confirmNewsletterDistribution() separately to mark entries as distributed.
 */
export async function generateNewsletterMarkdown(
  wire: string,
  feedDisplayName: string
): Promise<{ markdown: string; entryIds: number[] }> {
  // Get approved entries not yet included in a newsletter log
  const entries = await getUndistributedEntries(wire, 'newsletter');

  if (entries.length === 0) {
    return {
      markdown: `# ${feedDisplayName} Newsletter\n\n*No new entries to include.*`,
      entryIds: [],
    };
  }

  const lines: string[] = [
    `# ${feedDisplayName} Newsletter`,
    '',
    `*${entries.length} entries | Generated ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}*`,
    '',
    '---',
    '',
  ];

  const entryIds: number[] = [];

  for (const entry of entries) {
    lines.push(`## ${entry.name}`);
    lines.push('');
    if (entry.description) lines.push(entry.description);
    lines.push('');
    const meta: string[] = [];
    if (entry.amount) meta.push(`**Amount:** ${entry.amount}`);
    if (entry.deadline) meta.push(`**Deadline:** ${entry.deadline}`);
    meta.push(`**Link:** ${entry.source_url}`);
    lines.push(meta.join(' | '));
    lines.push('');
    lines.push('---');
    lines.push('');

    entryIds.push(entry.id);
  }

  return { markdown: lines.join('\n'), entryIds };
}

/**
 * Mark newsletter entries as distributed after the operator confirms.
 */
export async function confirmNewsletterDistribution(
  entryIds: number[],
  wire: string
): Promise<void> {
  for (const entryId of entryIds) {
    await logDistribution({
      entryId,
      channel: 'newsletter',
      wire,
      status: 'success',
    });
  }
}
