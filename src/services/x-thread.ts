/**
 * X/Twitter thread-fetching service
 *
 * Given a tweet URL, fetches the full conversation thread using Twitter API v2.
 * Used to enrich summarization when a tweet is part of a multi-tweet thread
 * (e.g., aggregator accounts listing multiple grant programs).
 */

export interface ThreadTweet {
  id: string;
  text: string;
  position: number;
}

export interface ThreadContext {
  isThread: boolean;
  tweetCount: number;
  authorHandle: string;
  authorName: string;
  tweets: ThreadTweet[];
  fullThreadText: string;
}

const EMPTY_CONTEXT: ThreadContext = {
  isThread: false,
  tweetCount: 1,
  authorHandle: '',
  authorName: '',
  tweets: [],
  fullThreadText: '',
};

// Simple LRU cache with TTL
interface CacheEntry {
  value: ThreadContext;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_MAX_SIZE = 100;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function cacheGet(key: string): ThreadContext | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  // Move to end (LRU refresh)
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function cacheSet(key: string, value: ThreadContext): void {
  // Evict oldest if at capacity
  if (cache.size >= CACHE_MAX_SIZE) {
    const firstKey = cache.keys().next().value as string;
    cache.delete(firstKey);
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Extract tweet ID from an X.com or twitter.com URL.
 */
export function extractTweetId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host !== 'x.com' && host !== 'twitter.com' && !host.endsWith('.x.com') && !host.endsWith('.twitter.com')) {
      return null;
    }
    // Pattern: /{handle}/status/{id}
    const match = u.pathname.match(/\/[^/]+\/status\/(\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

interface TwitterV2Tweet {
  id: string;
  text: string;
  author_id?: string;
  conversation_id?: string;
  created_at?: string;
  referenced_tweets?: Array<{ type: string; id: string }>;
}

interface TwitterV2User {
  id: string;
  username: string;
  name: string;
}

interface TwitterV2SingleResponse {
  data?: TwitterV2Tweet;
  includes?: { users?: TwitterV2User[] };
}

interface TwitterV2SearchResponse {
  data?: TwitterV2Tweet[];
  meta?: { result_count?: number; next_token?: string };
}

async function twitterGet<T>(endpoint: string, bearerToken: string): Promise<T> {
  const res = await fetch(`https://api.x.com/2${endpoint}`, {
    headers: { Authorization: `Bearer ${bearerToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twitter API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Fetch thread context for a tweet URL.
 * Returns EMPTY_CONTEXT gracefully if bearer token is missing or tweet isn't part of a thread.
 */
export async function fetchThreadContext(tweetUrl: string): Promise<ThreadContext> {
  const bearerToken = process.env.X_BEARER_TOKEN;
  if (!bearerToken) {
    console.log('[ThreadFetch] X_BEARER_TOKEN not set, skipping thread fetch');
    return { ...EMPTY_CONTEXT };
  }

  const tweetId = extractTweetId(tweetUrl);
  if (!tweetId) {
    return { ...EMPTY_CONTEXT };
  }

  try {
    // Step 1: Fetch the tweet to get conversation_id and author
    const single = await twitterGet<TwitterV2SingleResponse>(
      `/tweets/${tweetId}?tweet.fields=conversation_id,referenced_tweets,author_id,created_at&expansions=author_id&user.fields=username,name`,
      bearerToken
    );

    if (!single.data) {
      console.log(`[ThreadFetch] Tweet ${tweetId} not found`);
      return { ...EMPTY_CONTEXT };
    }

    const tweet = single.data;
    const conversationId = tweet.conversation_id || tweetId;
    const authorId = tweet.author_id || '';
    const author = single.includes?.users?.[0];
    const authorHandle = author?.username || '';
    const authorName = author?.name || '';

    // Check cache by conversation_id
    const cached = cacheGet(conversationId);
    if (cached) {
      console.log(`[ThreadFetch] Cache hit for conversation ${conversationId}`);
      return cached;
    }

    // If this tweet IS the conversation root and has no referenced tweets,
    // we still check for replies in the thread
    // Step 2: Search for all tweets in this conversation by the same author
    const searchQuery = encodeURIComponent(`conversation_id:${conversationId} from:${authorId}`);
    const search = await twitterGet<TwitterV2SearchResponse>(
      `/tweets/search/recent?query=${searchQuery}&tweet.fields=created_at&max_results=100&sort_order=recency`,
      bearerToken
    );

    const threadTweets = search.data || [];

    // If only 1 tweet in the conversation (the original), it's not a thread
    if (threadTweets.length <= 1) {
      const ctx: ThreadContext = {
        isThread: false,
        tweetCount: 1,
        authorHandle,
        authorName,
        tweets: [{ id: tweetId, text: tweet.text, position: 1 }],
        fullThreadText: tweet.text,
      };
      cacheSet(conversationId, ctx);
      console.log(`[ThreadFetch] Tweet ${tweetId} is a standalone tweet by @${authorHandle}`);
      return ctx;
    }

    // Sort by created_at ascending (chronological order)
    threadTweets.sort((a, b) => {
      if (a.created_at && b.created_at) return a.created_at.localeCompare(b.created_at);
      return 0;
    });

    const tweets: ThreadTweet[] = threadTweets.map((t, i) => ({
      id: t.id,
      text: t.text,
      position: i + 1,
    }));

    const fullThreadText = tweets.map(t => `[${t.position}/${tweets.length}] ${t.text}`).join('\n\n');

    const ctx: ThreadContext = {
      isThread: true,
      tweetCount: tweets.length,
      authorHandle,
      authorName,
      tweets,
      fullThreadText,
    };

    cacheSet(conversationId, ctx);
    console.log(`[ThreadFetch] Tweet ${tweetId} is part of ${tweets.length}-tweet thread by @${authorHandle}`);
    return ctx;
  } catch (err) {
    console.error(`[ThreadFetch] Error fetching thread for ${tweetUrl}:`, err);
    return { ...EMPTY_CONTEXT };
  }
}
