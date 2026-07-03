/**
 * X List watcher (Watchtower Tier 1). One API call per wire per run: pull the
 * latest posts from a curated X List and filter client-side against an id
 * watermark (app_state), feed each new post through the dumb-pipe intake as
 * scan_source='x-list'. Mirrors account-monitor (same bearer, same intake
 * call) but Lists make it one read per WIRE instead of one per account.
 * Default OFF (X_LISTS_ENABLED) and dry-run (X_LISTS_DRY_RUN).
 *
 * GET /2/lists/:id/tweets has no since_id support, so every run fetches up
 * to MAX_RESULTS of the newest posts regardless of watermark; filterNewTweets()
 * then drops anything at or below the watermark before the submit loop. The
 * read (and its budget cost) happens every run either way — only what reaches
 * intake is new.
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
const MAX_RESULTS = 25; // per run per list; every run pays for up to MAX_RESULTS reads (client-side filtering), bounded by the monthly budget guard

export interface ListTweet {
  id: string;
  text: string;
  created_at: string;
  author_id?: string;
  entities?: { urls?: Array<{ expanded_url: string }> };
}

export interface XListsResult {
  ran: boolean;
  reason?: string;
  perList: Array<{ wire: string; listId: string; fetched: number; fresh: number; submitted: number; baseline: boolean; error?: string }>;
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

/** Tweets newer than the watermark id (API returns newest first; ids are numeric strings). */
export function filterNewTweets(tweets: ListTweet[], sinceId: string | null): ListTweet[] {
  if (!sinceId) return tweets;
  let since: bigint;
  try { since = BigInt(sinceId); } catch { return tweets; }
  return tweets.filter(t => { try { return BigInt(t.id) > since; } catch { return false; } });
}

async function fetchListTweets(
  listId: string,
  token: string,
): Promise<{ tweets: ListTweet[]; authors: Map<string, string> }> {
  const params = new URLSearchParams({
    max_results: String(MAX_RESULTS),
    'tweet.fields': 'created_at,entities,author_id',
    expansions: 'author_id',
  });
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

/** Injectable seams so runXLists' branches (baseline, dry-run, budget-block, rate-limit abort) are unit-testable without network or DB. */
export interface XListsDeps {
  fetchListTweets?: typeof fetchListTweets;
  checkBudget?: typeof checkBudget;
  recordTwitterReads?: typeof recordTwitterReads;
  getState?: typeof getAppState;
  setState?: typeof setAppState;
  submit?: typeof processIntakeMessage;
}

export async function runXLists(pool: Pool, opts: { dryRun?: boolean } = {}, deps: XListsDeps = {}): Promise<XListsResult> {
  const fetchImpl = deps.fetchListTweets ?? fetchListTweets;
  const checkBudgetImpl = deps.checkBudget ?? checkBudget;
  const recordTwitterReadsImpl = deps.recordTwitterReads ?? recordTwitterReads;
  const getStateImpl = deps.getState ?? getAppState;
  const setStateImpl = deps.setState ?? setAppState;
  const submitImpl = deps.submit ?? processIntakeMessage;

  const token = process.env.X_BEARER_TOKEN;
  const lists = parseXListConfig(config.watchtower.xListIds);
  const dryRun = opts.dryRun ?? config.watchtower.xListsDryRun;
  if (!token) return { ran: false, reason: 'X_BEARER_TOKEN not set', perList: [] };
  if (!lists.length) return { ran: false, reason: 'X_LIST_IDS not configured', perList: [] };

  const budget = await checkBudgetImpl(pool);
  if (!budget.allowed) {
    console.warn(`[XLists] SKIPPED — monthly budget reached ($${budget.spentUsd} of $${budget.capUsd})`);
    return { ran: false, reason: `budget reached ($${budget.spentUsd}/$${budget.capUsd})`, perList: [] };
  }

  const perList: XListsResult['perList'] = [];
  for (const { wire, listId } of lists) {
    const stateKey = `xlist:since:${listId}`;
    const sinceId = await getStateImpl<string>(stateKey);
    const start = Date.now();
    try {
      const { tweets, authors } = await fetchImpl(listId, token);
      logApiUsage({ provider: 'twitter', model: 'list-timeline', purpose: 'watchtower-x-list', wire, duration_ms: Date.now() - start, success: true });
      await recordTwitterReadsImpl(tweets.length);

      const baseline = !sinceId;
      const fresh = filterNewTweets(tweets, sinceId || null);
      let submitted = 0;
      if (!baseline && !dryRun) {
        for (const tweet of fresh) {
          const author = (tweet.author_id && authors.get(tweet.author_id)) || 'unknown';
          const result = await submitImpl(tweetToIntakeMessage(tweet, wire, author), 'x-list');
          if (result.status === 'inserted') submitted++;
        }
      }
      if (tweets.length > 0) {
        await setStateImpl(stateKey, tweets[0].id); // API returns newest first
      }
      perList.push({ wire, listId, fetched: tweets.length, fresh: fresh.length, submitted, baseline });
      console.log(`[XLists] ${wire} (${listId}): ${tweets.length} fetched, ${fresh.length} fresh, ${submitted} submitted${baseline ? ' (baseline run, watermark set)' : ''}${dryRun ? ' [DRY RUN]' : ''}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logApiUsage({ provider: 'twitter', model: 'list-timeline', purpose: 'watchtower-x-list', wire, duration_ms: Date.now() - start, success: false, error_message: msg });
      perList.push({ wire, listId, fetched: 0, fresh: 0, submitted: 0, baseline: false, error: msg });
      console.warn(`[XLists] ${wire} (${listId}) failed: ${msg}`);
      if (msg === 'RATE_LIMITED') break; // stop the whole run; retry next cycle
    }
  }
  return { ran: true, perList };
}
