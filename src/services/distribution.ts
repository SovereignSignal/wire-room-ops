/**
 * Distribution orchestrator.
 *
 * When an entry is approved, generates AI-crafted posts and publishes
 * to the matching Telegram channel and X account. Fire-and-forget from
 * the approve endpoint — failures never block the approval.
 *
 * Config is read from the distribution_config DB table (managed via dashboard).
 */

import { config } from '../config';
import { getPool, insertDistributionLog, updateDistributionLog, getDistributionLogs, deleteDistributionLogs, getDistributionConfig } from '../db';
import { generatePosts } from './post-generator';
import { postTweet } from './x-client';
import { sendMessage } from './telegram';
import type { DistributionLog, DistributionResult } from '../types/intake';

/**
 * Distribute an approved entry to Telegram + X.
 * Idempotent: skips channels that already have a 'success' log row.
 */
export async function distributeEntry(entryId: number): Promise<DistributionResult> {
  const result: DistributionResult = {
    entryId,
    telegram: { status: 'skipped' },
    x: { status: 'skipped' },
  };

  // Fetch entry from DB
  const pool = getPool();
  const entryRes = await pool.query(
    `SELECT id, name, description, source_url, amount, deadline, wire FROM scan_entries WHERE id = $1`,
    [entryId]
  );
  if (entryRes.rows.length === 0) {
    console.error(`[Distribution] Entry ${entryId} not found`);
    return result;
  }
  const entry = entryRes.rows[0];
  const wire: string = entry.wire;

  // Load per-wire config from DB
  const distConfig = await getDistributionConfig(wire);
  if (!distConfig?.enabled) {
    console.log(`[Distribution] Wire "${wire}" distribution disabled, skipping entry ${entryId}`);
    return result;
  }

  // Idempotency check: skip channels with existing success or in-progress logs
  const existingLogs = await getDistributionLogs(entryId);
  const tgDone = existingLogs.some(l => l.channel === 'telegram' && (l.status === 'success' || l.status === 'pending'));
  const xDone = existingLogs.some(l => l.channel === 'x' && (l.status === 'success' || l.status === 'pending'));

  if (tgDone && xDone) {
    console.log(`[Distribution] Entry ${entryId} already distributed or in progress, skipping`);
    result.telegram = { status: 'success' };
    result.x = { status: 'success' };
    return result;
  }

  // Use narrower check for per-channel skip below
  const tgSuccess = existingLogs.some(l => l.channel === 'telegram' && l.status === 'success');
  const xSuccess = existingLogs.some(l => l.channel === 'x' && l.status === 'success');

  // Check channel availability from DB config
  const telegramChannelId = distConfig.telegramChannelId;
  const hasTelegram = !!telegramChannelId && !!config.telegram.botToken;
  const hasX = !!(distConfig.xApiKey && distConfig.xApiSecret && distConfig.xAccessToken && distConfig.xAccessTokenSecret);

  // Generate posts (only if at least one channel needs it)
  const needsGeneration = (!tgSuccess && hasTelegram) || (!xSuccess && hasX);
  let posts: { tweet: string; telegram: string } | null = null;

  if (needsGeneration) {
    posts = await generatePosts({
      name: entry.name,
      description: entry.description || '',
      amount: entry.amount || null,
      deadline: entry.deadline || null,
      sourceUrl: entry.source_url,
      wire,
    });
  }

  // Build X credentials from DB config
  const xCreds = hasX ? {
    apiKey: distConfig.xApiKey,
    apiSecret: distConfig.xApiSecret,
    accessToken: distConfig.xAccessToken,
    accessTokenSecret: distConfig.xAccessTokenSecret,
  } : undefined;

  // Dispatch both channels in parallel
  const [tgResult, xResult] = await Promise.allSettled([
    distributeTelegram(entryId, wire, telegramChannelId, hasTelegram, tgSuccess, posts),
    distributeX(entryId, wire, hasX, xSuccess, posts, entry.source_url, xCreds, distConfig.xHandle),
  ]);

  if (tgResult.status === 'fulfilled') result.telegram = tgResult.value;
  if (xResult.status === 'fulfilled') result.x = xResult.value;

  console.log(`[Distribution] Entry ${entryId} (${wire}): TG=${result.telegram.status}, X=${result.x.status}`);
  return result;
}

async function distributeTelegram(
  entryId: number,
  wire: string,
  channelId: string | undefined,
  hasChannel: boolean,
  alreadyDone: boolean,
  posts: { telegram: string } | null,
): Promise<{ status: 'success' | 'failed' | 'skipped'; url?: string; error?: string }> {
  if (alreadyDone) return { status: 'success' };
  if (!hasChannel || !channelId) {
    await insertDistributionLog({ entryId, channel: 'telegram', wire, status: 'skipped' });
    return { status: 'skipped' };
  }

  let log;
  try {
    log = await insertDistributionLog({
      entryId,
      channel: 'telegram',
      wire,
      status: 'pending',
      postText: posts?.telegram,
    });
  } catch (error: any) {
    if (error?.code === '23505') {
      console.log(`[Distribution] Telegram already in progress for entry ${entryId}, skipping`);
      return { status: 'skipped' };
    }
    throw error;
  }

  if (!posts) {
    await updateDistributionLog(log.id, { status: 'failed', errorMessage: 'Post generation returned null' });
    return { status: 'failed', error: 'No post content generated' };
  }

  try {
    await sendMessage(channelId, posts.telegram, 'HTML');
    await updateDistributionLog(log.id, { status: 'success' });
    return { status: 'success' };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await updateDistributionLog(log.id, { status: 'failed', errorMessage: errMsg });
    return { status: 'failed', error: errMsg };
  }
}

async function distributeX(
  entryId: number,
  wire: string,
  hasCredentials: boolean,
  alreadyDone: boolean,
  posts: { tweet: string } | null,
  sourceUrl: string,
  creds?: { apiKey: string; apiSecret: string; accessToken: string; accessTokenSecret: string },
  handle?: string,
): Promise<{ status: 'success' | 'failed' | 'skipped'; url?: string; error?: string }> {
  if (alreadyDone) return { status: 'success' };
  if (!hasCredentials) {
    await insertDistributionLog({ entryId, channel: 'x', wire, status: 'skipped' });
    return { status: 'skipped' };
  }

  if (!posts) {
    try {
      const log = await insertDistributionLog({ entryId, channel: 'x', wire, status: 'failed' });
      await updateDistributionLog(log.id, { errorMessage: 'Post generation returned null' });
    } catch (error: any) {
      if (error?.code === '23505') return { status: 'skipped' };
      throw error;
    }
    return { status: 'failed', error: 'No post content generated' };
  }

  // Append source URL to tweet
  const tweetText = `${posts.tweet}\n${sourceUrl}`;
  let log;
  try {
    log = await insertDistributionLog({
      entryId,
      channel: 'x',
      wire,
      status: 'pending',
      postText: tweetText,
    });
  } catch (error: any) {
    if (error?.code === '23505') {
      console.log(`[Distribution] X already in progress for entry ${entryId}, skipping`);
      return { status: 'skipped' };
    }
    throw error;
  }

  try {
    const tweetResult = await postTweet(wire, tweetText, creds, handle);
    if (!tweetResult) {
      await updateDistributionLog(log.id, { status: 'skipped', errorMessage: 'No credentials at runtime' });
      return { status: 'skipped' };
    }
    await updateDistributionLog(log.id, {
      status: 'success',
      externalId: tweetResult.tweetId,
      externalUrl: tweetResult.url,
    });
    return { status: 'success', url: tweetResult.url };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await updateDistributionLog(log.id, { status: 'failed', errorMessage: errMsg });
    return { status: 'failed', error: errMsg };
  }
}

/**
 * Get distribution status for an entry.
 */
export async function getDistributionStatus(entryId: number): Promise<DistributionLog[]> {
  return getDistributionLogs(entryId);
}

/**
 * Retry distribution for an entry. Clears failed logs and re-runs.
 */
export async function retryDistribution(entryId: number): Promise<DistributionResult> {
  // Validate entry exists and is approved before deleting logs
  const pool = getPool();
  const entryRes = await pool.query(
    `SELECT id FROM scan_entries WHERE id = $1 AND status = 'approved'`,
    [entryId]
  );
  if (entryRes.rows.length === 0) {
    throw new Error(`Entry ${entryId} not found or not approved`);
  }

  await deleteDistributionLogs(entryId, 'failed');
  return distributeEntry(entryId);
}
