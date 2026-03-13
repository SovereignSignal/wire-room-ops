/**
 * Distribution orchestrator.
 * Coordinates post generation and dispatch to Telegram + X channels.
 * Newsletter generation is a separate read-only operation.
 */

import { getDistributionConfigs, getUndistributedEntries, logDistribution, deleteFailedDistributionLogs, getDistributionLogs, getPool, getEnabledDistributionChannelsForWire, DistributionChannelRecord } from '../db';
import { config } from '../config';
import { getCachedProvider } from './api-provider';
import { generatePosts } from './post-generator';

function getTelegramBotToken(): string {
  return getCachedProvider('telegram')?.api_key || config.telegram.botToken;
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
  const configs = await getDistributionConfigs(wire);
  const enabledConfigs = configs.filter(c => c.enabled && c.channel !== 'newsletter');

  // Also load managed channels from distribution_channels table
  const managedChannels = await getEnabledDistributionChannelsForWire(wire);

  if (enabledConfigs.length === 0 && managedChannels.length === 0) {
    return { wire, totalEntries: 0, distributed: 0, failed: 0, skipped: 0, details: [] };
  }

  // Get entries undistributed to ANY enabled channel
  const entries = await getUndistributedEntries(wire);
  const result: DistributeResult = {
    wire,
    totalEntries: entries.length,
    distributed: 0,
    failed: 0,
    skipped: 0,
    details: [],
  };

  const telegramBotToken = getTelegramBotToken();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const detail: DistributeResult['details'][0] = {
      entryId: entry.id,
      name: entry.name,
      channels: {},
    };

    try {
      const posts = await generatePosts({
        name: entry.name,
        description: entry.description || '',
        amount: entry.amount,
        deadline: entry.deadline,
        sourceUrl: entry.source_url,
      }, wire);

      let anySuccess = false;

      // Dispatch to legacy distribution_config channels
      for (const cfg of enabledConfigs) {
        const channelResult = await dispatchToChannel(cfg, entry, posts, telegramBotToken);
        detail.channels[cfg.channel] = channelResult;
        if (channelResult === 'success') anySuccess = true;
        if (channelResult === 'failed') result.failed++;
        if (channelResult === 'skipped') result.skipped++;
      }

      // Dispatch to managed distribution_channels
      for (const mc of managedChannels) {
        const channelResult = await dispatchToManagedChannel(mc, entry, posts);
        const channelKey = `${mc.channel}:${mc.id.slice(0, 8)}`;
        detail.channels[channelKey] = channelResult;
        if (channelResult === 'success') anySuccess = true;
        if (channelResult === 'failed') result.failed++;
        if (channelResult === 'skipped') result.skipped++;
      }

      if (anySuccess) result.distributed++;
    } catch (error) {
      console.error(`[Distribution] Failed to distribute entry ${entry.id}:`, error);
      // Log failures for each channel (entry-level failure, count once)
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      for (const cfg of enabledConfigs) {
        await logDistribution({
          entryId: entry.id,
          channel: cfg.channel,
          wire,
          status: 'failed',
          errorMessage: errorMsg,
        });
        detail.channels[cfg.channel] = 'failed';
      }
      for (const mc of managedChannels) {
        await logDistribution({
          entryId: entry.id,
          channel: mc.channel as DistributionChannel,
          channelId: mc.id,
          wire,
          status: 'failed',
          errorMessage: errorMsg,
        });
        detail.channels[`${mc.channel}:${mc.id.slice(0, 8)}`] = 'failed';
      }
      result.failed++;
    }

    result.details.push(detail);

    // Rate-pacing: 3s delay between entries (X rate limits)
    if (i < entries.length - 1) {
      await sleep(3000);
    }
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

    const result = await sendChannelMessage(token, targetId, posts.telegram);
    await logDistribution({
      entryId: entry.id,
      channel: 'telegram',
      channelId: mc.id,
      wire: mc.wire,
      status: result ? 'success' : 'failed',
      postText: posts.telegram,
      externalId: result ? String(result.messageId) : undefined,
      errorMessage: result ? undefined : 'Telegram API call failed',
    });
    return result ? 'success' : 'failed';
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

    const result = await sendDiscordMessage(token, targetId, posts.telegram);
    await logDistribution({
      entryId: entry.id,
      channel: 'discord',
      channelId: mc.id,
      wire: mc.wire,
      status: result ? 'success' : 'failed',
      postText: posts.telegram,
      externalId: result ? result.messageId : undefined,
      errorMessage: result ? undefined : 'Discord API call failed',
    });
    return result ? 'success' : 'failed';
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

    try {
      const resp = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: posts.telegram }),
      });

      const ok = resp.ok;
      await logDistribution({
        entryId: entry.id,
        channel: 'slack',
        channelId: mc.id,
        wire: mc.wire,
        status: ok ? 'success' : 'failed',
        postText: posts.telegram,
        errorMessage: ok ? undefined : `Slack webhook returned ${resp.status}`,
      });
      return ok ? 'success' : 'failed';
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      await logDistribution({
        entryId: entry.id,
        channel: 'slack',
        channelId: mc.id,
        wire: mc.wire,
        status: 'failed',
        errorMessage: errorMsg,
      });
      return 'failed';
    }
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

    const result = await sendChannelMessage(token, channelId, posts.telegram);
    await logDistribution({
      entryId: entry.id,
      channel: 'telegram',
      wire: cfg.wire,
      status: result ? 'success' : 'failed',
      postText: posts.telegram,
      externalId: result ? String(result.messageId) : undefined,
      errorMessage: result ? undefined : 'Telegram API call failed',
    });
    return result ? 'success' : 'failed';
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

    const result = await postTweet(posts.tweet, creds);
    await logDistribution({
      entryId: entry.id,
      channel: 'x',
      wire: cfg.wire,
      status: result ? 'success' : 'failed',
      postText: posts.tweet,
      externalId: result?.id,
      errorMessage: result ? undefined : 'X API call failed',
    });
    return result ? 'success' : 'failed';
  }

  return 'skipped';
}

/**
 * Retry distribution for a single entry (delete failed logs, re-run only failed channels).
 */
/**
 * Distribute a single approved entry immediately to all enabled channels for its wire.
 * Used when an entry is approved via the dashboard — only sends that one entry,
 * not the entire backlog of approved-but-undistributed entries.
 */
export async function distributeEntry(entryId: number, wire: string): Promise<DistributeResult> {
  const configs = await getDistributionConfigs(wire);
  const enabledConfigs = configs.filter(c => c.enabled && c.channel !== 'newsletter');
  const managedChannels = await getEnabledDistributionChannelsForWire(wire);

  if (enabledConfigs.length === 0 && managedChannels.length === 0) {
    return { wire, totalEntries: 0, distributed: 0, failed: 0, skipped: 0, details: [] };
  }

  const pool = getPool();
  const entryResult = await pool.query(
    `SELECT * FROM scan_entries WHERE id = $1 AND status = 'approved'`,
    [entryId]
  );

  if (entryResult.rows.length === 0) {
    return { wire, totalEntries: 0, distributed: 0, failed: 0, skipped: 0, details: [] };
  }

  const entry = entryResult.rows[0];
  const telegramBotToken = getTelegramBotToken();
  const posts = await generatePosts({
    name: entry.name,
    description: entry.description || '',
    amount: entry.amount,
    deadline: entry.deadline,
    sourceUrl: entry.source_url,
  }, wire);

  const detail: DistributeResult['details'][0] = { entryId: entry.id, name: entry.name, channels: {} };
  const result: DistributeResult = { wire, totalEntries: 1, distributed: 0, failed: 0, skipped: 0, details: [detail] };

  for (const cfg of enabledConfigs) {
    const channelResult = await dispatchToChannel(cfg, entry, posts, telegramBotToken);
    detail.channels[cfg.channel] = channelResult;
    if (channelResult === 'success') result.distributed++;
    if (channelResult === 'failed') result.failed++;
    if (channelResult === 'skipped') result.skipped++;
  }

  for (const mc of managedChannels) {
    const channelResult = await dispatchToManagedChannel(mc, entry, posts);
    const channelKey = `${mc.channel}:${mc.id.slice(0, 8)}`;
    detail.channels[channelKey] = channelResult;
    if (channelResult === 'success') result.distributed++;
    if (channelResult === 'failed') result.failed++;
    if (channelResult === 'skipped') result.skipped++;
  }

  return result;
}

export async function retryDistribution(entryId: number, wire: string): Promise<DistributeResult> {
  // Validate entry exists before deleting any logs
  const pool = getPool();
  const entryResult = await pool.query(
    `SELECT * FROM scan_entries WHERE id = $1 AND status = 'approved'`,
    [entryId]
  );

  if (entryResult.rows.length === 0) {
    return { wire, totalEntries: 0, distributed: 0, failed: 0, skipped: 0, details: [] };
  }

  // Identify which channels already succeeded — only retry the rest
  const existingLogs = await getDistributionLogs(entryId);
  const succeededChannels = new Set(
    existingLogs.filter(l => l.status === 'success').map(l => l.channel)
  );

  const configs = await getDistributionConfigs(wire);
  const retryConfigs = configs.filter(
    c => c.enabled && c.channel !== 'newsletter' && !succeededChannels.has(c.channel)
  );

  if (retryConfigs.length === 0) {
    return { wire, totalEntries: 0, distributed: 0, failed: 0, skipped: 0, details: [] };
  }

  await deleteFailedDistributionLogs(entryId);

  const entry = entryResult.rows[0];
  const telegramBotToken = getTelegramBotToken();
  const posts = await generatePosts({
    name: entry.name,
    description: entry.description || '',
    amount: entry.amount,
    deadline: entry.deadline,
    sourceUrl: entry.source_url,
  }, wire);

  const detail: DistributeResult['details'][0] = {
    entryId: entry.id,
    name: entry.name,
    channels: {},
  };

  const result: DistributeResult = {
    wire,
    totalEntries: 1,
    distributed: 0,
    failed: 0,
    skipped: 0,
    details: [detail],
  };

  for (const cfg of retryConfigs) {
    const channelResult = await dispatchToChannel(cfg, entry, posts, telegramBotToken);
    detail.channels[cfg.channel] = channelResult;
    if (channelResult === 'success') result.distributed++;
    if (channelResult === 'failed') result.failed++;
    if (channelResult === 'skipped') result.skipped++;
  }

  return result;
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
