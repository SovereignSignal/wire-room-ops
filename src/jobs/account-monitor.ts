/**
 * Account Monitor Job
 *
 * Polls recent tweets from monitored X accounts and feeds new URLs
 * into the intake pipeline. Auto-disables accounts with no approvals
 * in 90 days (auto-sourced only).
 */

import type { Pool } from 'pg';
import { processIntakeMessage } from '../services/intake-core';
import { logApiUsage } from '../services/api-usage';
import { getAppState, setAppState } from '../db';

const X_API_BASE = 'https://api.twitter.com/2';

interface MonitoredAccount {
  id: string;
  handle: string;
  wire: string | null;
  x_user_id: string | null;
  kind?: string;
  person_name?: string | null;
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
  const resp = await fetchWithBearer(`${X_API_BASE}/users/by/username/${encodeURIComponent(handle)}`, token);
  if (resp.status === 429) throw new Error('RATE_LIMITED');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json() as { data?: { id: string } };
  return data.data?.id || null;
}

async function getRecentTweets(userId: string, token: string, sinceId: string | null): Promise<Tweet[]> {
  // max_results=5 (was 10): funder accounts post infrequently; with a daily
  // cadence and dedup, 5 recent tweets per account is plenty and halves reads.
  const params = new URLSearchParams({
    max_results: '5',
    'tweet.fields': 'created_at,entities',
    expansions: 'attachments.media_keys',
  });
  if (sinceId) params.set('since_id', sinceId);
  const url = `${X_API_BASE}/users/${userId}/tweets?${params}`;
  const resp = await fetchWithBearer(url, token);
  if (resp.status === 429) throw new Error('RATE_LIMITED');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
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

export interface AccountMonitorDeps {
  getUserId?: typeof getUserId;
  getRecentTweets?: typeof getRecentTweets;
  getState?: typeof getAppState;
  setState?: typeof setAppState;
  submit?: typeof processIntakeMessage;
  sleep?: (ms: number) => Promise<void>;
}

function sortTweetsOldestFirst(tweets: Tweet[]): Tweet[] {
  return [...tweets].sort((a, b) => {
    try {
      const left = BigInt(a.id);
      const right = BigInt(b.id);
      return left < right ? -1 : left > right ? 1 : 0;
    } catch {
      return a.id.localeCompare(b.id);
    }
  });
}

export async function runAccountMonitor(pool: Pool, deps: AccountMonitorDeps = {}): Promise<AccountMonitorResult> {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) {
    console.warn('[AccountMonitor] X_BEARER_TOKEN not set, skipping');
    return { processed: 0, submitted: 0, skipped: 0, errors: 0, disabled: 0 };
  }

  const result: AccountMonitorResult = { processed: 0, submitted: 0, skipped: 0, errors: 0, disabled: 0 };
  const getUserIdImpl = deps.getUserId ?? getUserId;
  const getRecentTweetsImpl = deps.getRecentTweets ?? getRecentTweets;
  const getStateImpl = deps.getState ?? getAppState;
  const setStateImpl = deps.setState ?? setAppState;
  const submitImpl = deps.submit ?? processIntakeMessage;
  const sleepImpl = deps.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));

  // Get enabled accounts — orgs + the key people behind programs (contacts
  // layer). Cap at 60 (efficiency guard); least-recently-checked first so new
  // additions get picked up promptly and coverage rotates if over the cap.
  const accountsResult = await pool.query<MonitoredAccount>(
    `SELECT id, handle, wire, x_user_id, kind, person_name FROM monitored_accounts WHERE enabled = true ORDER BY last_checked_at ASC NULLS FIRST LIMIT 60`
  );
  const accounts = accountsResult.rows;
  const peopleCount = accounts.filter(a => a.kind === 'person').length;
  console.log(`[AccountMonitor] Checking ${accounts.length} accounts (${peopleCount} people, ${accounts.length - peopleCount} orgs)`);

  for (const account of accounts) {
    try {
      // Use the cached X user_id; only hit the lookup endpoint the first time.
      // This was the biggest waste — re-resolving 100+ handles every run.
      let userId = account.x_user_id;
      if (!userId) {
        const lookupStart = Date.now();
        try {
          userId = await getUserIdImpl(account.handle, token);
          logApiUsage({ provider: 'twitter', model: 'user-lookup', purpose: 'account-monitor', wire: account.wire || undefined, duration_ms: Date.now() - lookupStart, success: !!userId });
        } catch (err) {
          logApiUsage({ provider: 'twitter', model: 'user-lookup', purpose: 'account-monitor', wire: account.wire || undefined, duration_ms: Date.now() - lookupStart, success: false, error_message: err instanceof Error ? err.message : String(err) });
          throw err;
        }
        if (!userId) {
          result.skipped++;
          continue;
        }
        await pool.query(`UPDATE monitored_accounts SET x_user_id = $1 WHERE id = $2`, [userId, account.id]);
      }

      const stateKey = `xmonitor:since:${account.id}`;
      const sinceId = await getStateImpl<string>(stateKey);
      const fetchStart = Date.now();
      let tweets: Tweet[];
      try {
        tweets = await getRecentTweetsImpl(userId, token, sinceId);
        logApiUsage({ provider: 'twitter', model: 'timeline', purpose: 'account-monitor', wire: account.wire || undefined, duration_ms: Date.now() - fetchStart, success: true });
      } catch (err) {
        logApiUsage({ provider: 'twitter', model: 'timeline', purpose: 'account-monitor', wire: account.wire || undefined, duration_ms: Date.now() - fetchStart, success: false, error_message: err instanceof Error ? err.message : String(err) });
        throw err;
      }

      let durableThrough: string | null = null;
      let intakeError: string | null = null;
      for (const tweet of sortTweetsOldestFirst(tweets)) {
        const urls = tweet.entities?.urls?.map(u => u.expanded_url).filter(u =>
          !u.includes('twitter.com') && !u.includes('x.com') && u.startsWith('http')
        ) || [];

        for (const url of urls) {
          let intakeResult;
          try {
            intakeResult = await submitImpl(
              {
                text: `${tweet.text}\n${url}`,
                urls: [url],
                senderId: `x-monitor:${account.handle}`,
                channelMessageId: tweet.id,
                forwardedFrom: `@${account.handle}`,
              },
              'x-monitor',
              { wireHint: account.wire || undefined },
            );
          } catch (err) {
            intakeError = err instanceof Error ? err.message : String(err);
            result.errors++;
            break;
          }
          // Count actual outcomes — 'submitted' must mean an entry was created,
          // not merely that intake was called (the 2026-06-12 inaugural run
          // reported 120 submitted while every insert failed on the scan_source
          // check constraint).
          if (intakeResult.status === 'inserted') {
            result.submitted++;
          } else if (intakeResult.status === 'rejected') {
            result.skipped++;
          } else {
            result.errors++;
            intakeError = intakeResult.errorMessage || `Intake failed for tweet ${tweet.id}`;
            break;
          }
        }
        if (intakeError) break;
        // A tweet with no external URLs is also durably handled: there is
        // nothing for this lane to submit.
        durableThrough = tweet.id;
      }

      if (durableThrough) {
        await setStateImpl(stateKey, durableThrough);
      }

      if (intakeError) {
        console.error(`[AccountMonitor] Intake stopped for @${account.handle}: ${intakeError}`);
        await sleepImpl(1000);
        continue;
      }

      // Scheduling metadata advances only after a clean fetch/intake pass.
      await pool.query(
        `UPDATE monitored_accounts SET last_checked_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [account.id]
      );
      result.processed++;

      // Small delay to avoid rate limits
      await sleepImpl(1000);

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
