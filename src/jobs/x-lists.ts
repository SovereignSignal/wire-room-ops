/**
 * X List watcher (Watchtower Tier 1). One API call per wire per run: pull new
 * posts from a curated X List via since_id watermark (app_state), feed each
 * through the dumb-pipe intake as scan_source='x-list'. Mirrors account-monitor
 * (same bearer, same intake call) but Lists make it one read per WIRE instead
 * of one per account. Default OFF (X_LISTS_ENABLED) and dry-run (X_LISTS_DRY_RUN).
 *
 * First run per list is a baseline: sets the watermark to the newest post id
 * and submits nothing (same rationale as source-feeds' first-run guard).
 */
import type { Pool } from 'pg';
import { processIntakeMessage } from '../services/intake-core';
import { logApiUsage } from '../services/api-usage';
import { getAppState, setAppState } from '../db';
import { checkBudget, recordTwitterReads } from '../services/budget-guard';
import { config } from '../config';

const X_API_BASE = 'https://api.twitter.com/2';
const MAX_RESULTS = 25; // per run per list; caps worst-case reads at 25 * 3 wires * $0.005 = $0.375/day

interface ListTweet {
  id: string;
  text: string;
  created_at: string;
  author_id?: string;
  entities?: { urls?: Array<{ expanded_url: string }> };
}

export interface XListsResult {
  ran: boolean;
  reason?: string;
  perList: Array<{ wire: string; listId: string; fetched: number; submitted: number; baseline: boolean; error?: string }>;
}

export function parseXListConfig(raw: string): Array<{ wire: string; listId: string }> {
  return (raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(pair => {
      const idx = pair.indexOf(':');
      if (idx <= 0) return null;
      const wire = pair.slice(0, idx).trim().toLowerCase();
      const listId = pair.slice(idx + 1).trim();
      return wire && /^\d+$/.test(listId) ? { wire, listId } : null;
    })
    .filter((x): x is { wire: string; listId: string } => x !== null);
}

export function tweetToIntakeMessage(
  tweet: ListTweet,
  wire: string,
  authorHandle: string,
): { text: string; urls: string[]; senderId: string; channelMessageId: string; forwardedFrom: string } {
  const external = (tweet.entities?.urls || [])
    .map(u => u.expanded_url)
    .filter(u => u && u.startsWith('http') && !u.includes('twitter.com') && !u.includes('x.com'));
  const urls = external.length ? [external[0]] : [`https://x.com/i/status/${tweet.id}`];
  return {
    text: `${tweet.text}\n${urls[0]}`,
    urls,
    senderId: `x-list:${wire}`,
    channelMessageId: tweet.id,
    forwardedFrom: `@${authorHandle}`,
  };
}

async function fetchListTweets(
  listId: string,
  token: string,
  sinceId: string | null,
): Promise<{ tweets: ListTweet[]; authors: Map<string, string> }> {
  const params = new URLSearchParams({
    max_results: String(MAX_RESULTS),
    'tweet.fields': 'created_at,entities,author_id',
    expansions: 'author_id',
  });
  if (sinceId) params.set('since_id', sinceId);
  const resp = await fetch(`${X_API_BASE}/lists/${listId}/tweets?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (resp.status === 429) throw new Error('RATE_LIMITED');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json() as {
    data?: ListTweet[];
    includes?: { users?: Array<{ id: string; username: string }> };
  };
  const authors = new Map<string, string>();
  for (const u of data.includes?.users || []) authors.set(u.id, u.username);
  return { tweets: data.data || [], authors };
}

export async function runXLists(pool: Pool, opts: { dryRun?: boolean } = {}): Promise<XListsResult> {
  const token = process.env.X_BEARER_TOKEN;
  const lists = parseXListConfig(config.watchtower.xListIds);
  const dryRun = opts.dryRun ?? config.watchtower.xListsDryRun;
  if (!token) return { ran: false, reason: 'X_BEARER_TOKEN not set', perList: [] };
  if (!lists.length) return { ran: false, reason: 'X_LIST_IDS not configured', perList: [] };

  const budget = await checkBudget(pool);
  if (!budget.allowed) {
    console.warn(`[XLists] SKIPPED — monthly budget reached ($${budget.spentUsd} of $${budget.capUsd})`);
    return { ran: false, reason: `budget reached ($${budget.spentUsd}/$${budget.capUsd})`, perList: [] };
  }

  const perList: XListsResult['perList'] = [];
  for (const { wire, listId } of lists) {
    const stateKey = `xlist:since:${listId}`;
    const sinceId = await getAppState<string>(stateKey);
    const start = Date.now();
    try {
      const { tweets, authors } = await fetchListTweets(listId, token, sinceId || null);
      logApiUsage({ provider: 'twitter', model: 'list-timeline', purpose: 'watchtower-x-list', wire, duration_ms: Date.now() - start, success: true });
      await recordTwitterReads(tweets.length);

      const baseline = !sinceId;
      let submitted = 0;
      if (!baseline && !dryRun) {
        for (const tweet of tweets) {
          const author = (tweet.author_id && authors.get(tweet.author_id)) || 'unknown';
          const result = await processIntakeMessage(tweetToIntakeMessage(tweet, wire, author), 'x-list');
          if (result.status === 'inserted') submitted++;
        }
      }
      if (tweets.length > 0) {
        await setAppState(stateKey, tweets[0].id); // API returns newest first
      }
      perList.push({ wire, listId, fetched: tweets.length, submitted, baseline });
      console.log(`[XLists] ${wire} (${listId}): ${tweets.length} fetched, ${submitted} submitted${baseline ? ' (baseline run, watermark set)' : ''}${dryRun ? ' [DRY RUN]' : ''}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logApiUsage({ provider: 'twitter', model: 'list-timeline', purpose: 'watchtower-x-list', wire, duration_ms: Date.now() - start, success: false, error_message: msg });
      perList.push({ wire, listId, fetched: 0, submitted: 0, baseline: false, error: msg });
      console.warn(`[XLists] ${wire} (${listId}) failed: ${msg}`);
      if (msg === 'RATE_LIMITED') break; // stop the whole run; retry next cycle
    }
  }
  return { ran: true, perList };
}
