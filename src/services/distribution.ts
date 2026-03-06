/**
 * Distribution orchestrator.
 * Coordinates post generation and dispatch to Telegram + X channels.
 * Newsletter generation is a separate read-only operation.
 */

import { getDistributionConfigs, getUndistributedEntries, logDistribution, deleteFailedDistributionLogs, getDistributionLogs, getPool } from '../db';
import { config } from '../config';
import { generatePosts } from './post-generator';
import { sendChannelMessage } from './telegram-channel';
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

  if (enabledConfigs.length === 0) {
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

  const telegramBotToken = config.telegram.botToken;

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

      for (const cfg of enabledConfigs) {
        const channelResult = await dispatchToChannel(cfg, entry, posts, telegramBotToken);
        detail.channels[cfg.channel] = channelResult;
        if (channelResult === 'success') anySuccess = true;
        if (channelResult === 'failed') result.failed++;
        if (channelResult === 'skipped') result.skipped++;
      }

      if (anySuccess) result.distributed++;
    } catch (error) {
      console.error(`[Distribution] Failed to distribute entry ${entry.id}:`, error);
      // Log failures for each enabled channel
      for (const cfg of enabledConfigs) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        await logDistribution({
          entryId: entry.id,
          channel: cfg.channel,
          wire,
          status: 'failed',
          errorMessage: errorMsg,
        });
        detail.channels[cfg.channel] = 'failed';
        result.failed++;
      }
    }

    result.details.push(detail);

    // Rate-pacing: 3s delay between entries (X rate limits)
    if (i < entries.length - 1) {
      await sleep(3000);
    }
  }

  return result;
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
export async function retryDistribution(entryId: number, wire: string): Promise<DistributeResult> {
  // Identify which channels already succeeded — only retry the rest
  const existingLogs = await getDistributionLogs(entryId);
  const succeededChannels = new Set(
    existingLogs.filter(l => l.status === 'success').map(l => l.channel)
  );

  await deleteFailedDistributionLogs(entryId);

  const configs = await getDistributionConfigs(wire);
  const retryConfigs = configs.filter(
    c => c.enabled && c.channel !== 'newsletter' && !succeededChannels.has(c.channel)
  );

  const pool = getPool();
  const entryResult = await pool.query(
    `SELECT * FROM scan_entries WHERE id = $1 AND status = 'approved'`,
    [entryId]
  );

  if (entryResult.rows.length === 0 || retryConfigs.length === 0) {
    return { wire, totalEntries: 0, distributed: 0, failed: 0, skipped: 0, details: [] };
  }

  const entry = entryResult.rows[0];
  const telegramBotToken = config.telegram.botToken;
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
 */
export async function generateNewsletterMarkdown(
  wire: string,
  feedDisplayName: string
): Promise<string> {
  // Get approved entries not yet included in a newsletter log
  const entries = await getUndistributedEntries(wire, 'newsletter');

  if (entries.length === 0) {
    return `# ${feedDisplayName} Newsletter\n\n*No new entries to include.*`;
  }

  const lines: string[] = [
    `# ${feedDisplayName} Newsletter`,
    '',
    `*${entries.length} entries | Generated ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}*`,
    '',
    '---',
    '',
  ];

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

    // Log as newsletter-distributed
    await logDistribution({
      entryId: entry.id,
      channel: 'newsletter',
      wire,
      status: 'success',
    });
  }

  return lines.join('\n');
}
