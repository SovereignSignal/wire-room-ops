/**
 * Account Monitor Job
 *
 * Polls recent tweets from monitored X accounts and feeds new URLs
 * into the intake pipeline. Auto-disables accounts with no approvals
 * in 90 days (auto-sourced only).
 */

import type { Pool } from 'pg';
import { processIntakeMessage } from '../services/intake-core';

const X_API_BASE = 'https://api.twitter.com/2';

interface MonitoredAccount {
  id: string;
  handle: string;
  wire: string | null;
}

interface Tweet {
  id: string;
  text: string;
  created_at: string;
  entities?: {
    urls?: Array<{ expanded_url: string; display_url: string }>;
  };
}

async function fetchWithBearer(url: string, token: string): Promise<Response> {
  return fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function getUserId(handle: string, token: string): Promise<string | null> {
  const resp = await fetchWithBearer(`${X_API_BASE}/users/by/username/${handle}`, token);
  if (!resp.ok) return null;
  const data = await resp.json() as { data?: { id: string } };
  return data.data?.id || null;
}

async function getRecentTweets(userId: string, token: string): Promise<Tweet[]> {
  const url = `${X_API_BASE}/users/${userId}/tweets?max_results=10&tweet.fields=created_at,entities&expansions=attachments.media_keys`;
  const resp = await fetchWithBearer(url, token);
  if (resp.status === 429) throw new Error('RATE_LIMITED');
  if (!resp.ok) return [];
  const data = await resp.json() as { data?: Tweet[] };
  return data.data || [];
}

export interface AccountMonitorResult {
  processed: number;
  submitted: number;
  skipped: number;
  errors: number;
  disabled: number;
}

export async function runAccountMonitor(pool: Pool): Promise<AccountMonitorResult> {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) {
    console.warn('[AccountMonitor] X_BEARER_TOKEN not set, skipping');
    return { processed: 0, submitted: 0, skipped: 0, errors: 0, disabled: 0 };
  }

  const result: AccountMonitorResult = { processed: 0, submitted: 0, skipped: 0, errors: 0, disabled: 0 };

  // Get enabled accounts
  const accountsResult = await pool.query<MonitoredAccount>(
    `SELECT id, handle, wire FROM monitored_accounts WHERE enabled = true ORDER BY last_checked_at ASC NULLS FIRST`
  );
  const accounts = accountsResult.rows;
  console.log(`[AccountMonitor] Checking ${accounts.length} accounts`);

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h ago

  for (const account of accounts) {
    try {
      const userId = await getUserId(account.handle, token);
      if (!userId) {
        result.skipped++;
        continue;
      }

      const tweets = await getRecentTweets(userId, token);
      const recentTweets = tweets.filter(t => new Date(t.created_at) > cutoff);

      // Update last_checked_at
      await pool.query(
        `UPDATE monitored_accounts SET last_checked_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [account.id]
      );

      for (const tweet of recentTweets) {
        const urls = tweet.entities?.urls?.map(u => u.expanded_url).filter(u =>
          !u.includes('twitter.com') && !u.includes('x.com') && u.startsWith('http')
        ) || [];

        for (const url of urls) {
          await processIntakeMessage(
            {
              text: `${tweet.text}\n${url}`,
              urls: [url],
              senderId: `x-monitor:${account.handle}`,
              channelMessageId: tweet.id,
              forwardedFrom: `@${account.handle}`,
            },
            'x-monitor'
          );
          result.submitted++;
        }
      }

      result.processed++;

      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 1000));

    } catch (err) {
      if (err instanceof Error && err.message === 'RATE_LIMITED') {
        console.warn(`[AccountMonitor] Rate limited, stopping early`);
        break;
      }
      console.error(`[AccountMonitor] Error processing @${account.handle}:`, err);
      result.errors++;
    }
  }

  // Auto-disable stale auto-sourced accounts (no approvals in 90 days)
  const disableResult = await pool.query(`
    UPDATE monitored_accounts
    SET enabled = false, updated_at = NOW()
    WHERE source = 'auto'
      AND enabled = true
      AND (last_approved_at IS NULL OR last_approved_at < NOW() - INTERVAL '90 days')
      AND approval_count < 3
    RETURNING handle
  `);
  result.disabled = disableResult.rowCount || 0;
  if (result.disabled > 0) {
    console.log(`[AccountMonitor] Auto-disabled ${result.disabled} stale accounts`);
  }

  console.log(`[AccountMonitor] Complete: ${result.processed} processed, ${result.submitted} submitted, ${result.errors} errors`);
  return result;
}
