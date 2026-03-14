/**
 * Community Pulse Service
 *
 * Searches Reddit, Hacker News, and Polymarket for community signal
 * on a given topic. Returns results formatted for the existing
 * parseStructuredOutput() pipeline — zero changes needed downstream.
 *
 * All APIs are free, public, and require no authentication.
 *
 * Sources:
 * - Reddit: public JSON search API (reddit.com/search.json)
 * - Hacker News: Algolia search API (hn.algolia.com)
 * - Polymarket: Gamma events API (gamma-api.polymarket.com)
 */

import { logApiUsage } from './api-usage';

// ============================================================
// Types
// ============================================================

interface RedditThread {
  title: string;
  subreddit: string;
  score: number;
  numComments: number;
  url: string;
  permalink: string;
  createdUtc: number;
  selftext: string;
}

interface HNStory {
  title: string;
  url: string | null;
  points: number;
  numComments: number;
  storyUrl: string;
  createdAt: string;
}

interface PolymarketEvent {
  title: string;
  slug: string;
  volume: number;
  liquidity: number;
  outcomes: string[];
  outcomePrices: string[];
  endDate: string | null;
  url: string;
}

interface CommunityResult {
  name: string;
  description: string;
  sourceUrl: string;
  engagement: number; // normalized engagement score for sorting
  source: 'reddit' | 'hackernews' | 'polymarket';
}

// ============================================================
// Reddit Public JSON API
// ============================================================

const REDDIT_USER_AGENT = 'wire-room-ops/1.0 (community-pulse)';

async function searchReddit(topic: string, limit = 20): Promise<RedditThread[]> {
  const params = new URLSearchParams({
    q: topic,
    sort: 'relevance',
    t: 'month',
    limit: String(limit),
    type: 'link',
  });

  const url = `https://www.reddit.com/search.json?${params}`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': REDDIT_USER_AGENT },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      console.warn(`[Community] Reddit returned ${response.status}`);
      return [];
    }

    const data = await response.json() as {
      data: {
        children: Array<{
          data: {
            title: string;
            subreddit: string;
            score: number;
            num_comments: number;
            url: string;
            permalink: string;
            created_utc: number;
            selftext: string;
          };
        }>;
      };
    };

    return data.data.children.map((child) => ({
      title: child.data.title,
      subreddit: child.data.subreddit,
      score: child.data.score,
      numComments: child.data.num_comments,
      url: child.data.url,
      permalink: `https://www.reddit.com${child.data.permalink}`,
      createdUtc: child.data.created_utc,
      selftext: (child.data.selftext || '').substring(0, 200),
    }));
  } catch (error) {
    console.warn(`[Community] Reddit search failed: ${error}`);
    return [];
  }
}

// ============================================================
// Hacker News Algolia API
// ============================================================

async function searchHN(topic: string, limit = 10): Promise<HNStory[]> {
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;
  const params = new URLSearchParams({
    query: topic,
    tags: 'story',
    numericFilters: `created_at_i>${thirtyDaysAgo}`,
    hitsPerPage: String(limit),
  });

  const url = `https://hn.algolia.com/api/v1/search?${params}`;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      console.warn(`[Community] HN returned ${response.status}`);
      return [];
    }

    const data = await response.json() as {
      hits: Array<{
        title: string;
        url: string | null;
        points: number;
        num_comments: number;
        objectID: string;
        created_at: string;
      }>;
    };

    return data.hits.map((hit) => ({
      title: hit.title,
      url: hit.url,
      points: hit.points || 0,
      numComments: hit.num_comments || 0,
      storyUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
      createdAt: hit.created_at,
    }));
  } catch (error) {
    console.warn(`[Community] HN search failed: ${error}`);
    return [];
  }
}

// ============================================================
// Polymarket Gamma API
// ============================================================

async function searchPolymarket(topic: string, limit = 8): Promise<PolymarketEvent[]> {
  // Gamma API for event search — public, no auth
  const url = `https://gamma-api.polymarket.com/events?closed=false&limit=${limit}&q=${encodeURIComponent(topic)}`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'wire-room-ops/1.0' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      console.warn(`[Community] Polymarket returned ${response.status}`);
      return [];
    }

    const events = await response.json() as Array<{
      title: string;
      slug: string;
      volume: number;
      liquidity: number;
      markets: Array<{
        outcomePrices: string;
        outcomes: string;
      }>;
      endDate: string | null;
    }>;

    return events.map((event) => {
      let outcomes: string[] = [];
      let outcomePrices: string[] = [];

      // Markets contain the outcome data
      if (event.markets && event.markets.length > 0) {
        const market = event.markets[0];
        try {
          outcomes = typeof market.outcomes === 'string'
            ? JSON.parse(market.outcomes) : (market.outcomes || []);
          outcomePrices = typeof market.outcomePrices === 'string'
            ? JSON.parse(market.outcomePrices) : (market.outcomePrices || []);
        } catch {
          // Ignore parse errors
        }
      }

      return {
        title: event.title,
        slug: event.slug,
        volume: event.volume || 0,
        liquidity: event.liquidity || 0,
        outcomes,
        outcomePrices,
        endDate: event.endDate,
        url: `https://polymarket.com/event/${event.slug}`,
      };
    });
  } catch (error) {
    console.warn(`[Community] Polymarket search failed: ${error}`);
    return [];
  }
}

// ============================================================
// Result formatting
// ============================================================

function formatVolume(volume: number): string {
  if (volume >= 1_000_000) return `$${(volume / 1_000_000).toFixed(1)}M`;
  if (volume >= 1_000) return `$${(volume / 1_000).toFixed(0)}K`;
  return `$${volume.toFixed(0)}`;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().split('T')[0];
}

function buildCommunityResults(
  reddit: RedditThread[],
  hn: HNStory[],
  polymarket: PolymarketEvent[],
): CommunityResult[] {
  const results: CommunityResult[] = [];

  // Reddit → CommunityResult
  for (const thread of reddit) {
    const engagement = thread.score + thread.numComments * 2;
    results.push({
      name: `[Reddit] r/${thread.subreddit}: "${thread.title}"`,
      description:
        `Reddit thread with ${thread.score} upvotes and ${thread.numComments} comments (${formatDate(thread.createdUtc)}). ` +
        (thread.selftext ? thread.selftext.substring(0, 150) + '...' : 'Link post — discussion in comments.'),
      sourceUrl: thread.permalink,
      engagement,
      source: 'reddit',
    });
  }

  // HN → CommunityResult
  for (const story of hn) {
    const engagement = story.points + story.numComments * 3; // HN comments are higher signal
    results.push({
      name: `[Hacker News] "${story.title}"`,
      description:
        `Hacker News story with ${story.points} points and ${story.numComments} comments. ` +
        (story.url ? `Links to: ${story.url}` : 'Ask HN / Show HN discussion.'),
      sourceUrl: story.storyUrl,
      engagement,
      source: 'hackernews',
    });
  }

  // Polymarket → CommunityResult
  for (const event of polymarket) {
    // Build odds string
    let oddsStr = '';
    if (event.outcomes.length > 0 && event.outcomePrices.length > 0) {
      const pairs = event.outcomes.map((o, i) => {
        const price = parseFloat(event.outcomePrices[i] || '0');
        return `${o}: ${Math.round(price * 100)}%`;
      });
      oddsStr = pairs.join(', ');
    }

    results.push({
      name: `[Polymarket] "${event.title}"`,
      description:
        `Prediction market with ${formatVolume(event.volume)} volume, ${formatVolume(event.liquidity)} liquidity. ` +
        (oddsStr ? `Current odds: ${oddsStr}. ` : '') +
        (event.endDate ? `Resolves: ${event.endDate.split('T')[0]}` : ''),
      sourceUrl: event.url,
      engagement: event.volume / 100, // normalize volume to comparable range
      source: 'polymarket',
    });
  }

  // Sort by engagement (highest first)
  results.sort((a, b) => b.engagement - a.engagement);

  return results;
}

// ============================================================
// Format for parseStructuredOutput() compatibility
// ============================================================

/**
 * Format results into the same structured text format that
 * parseStructuredOutput() in intake.ts already parses.
 *
 * Format per entry:
 *   N. **Name** — Description
 *   Deadline: None listed
 *   Program URL: https://...
 */
function formatAsStructuredOutput(results: CommunityResult[], topic: string): string {
  if (results.length === 0) {
    return `No community results found for "${topic}".`;
  }

  // Take top 15 results across all sources
  const top = results.slice(0, 15);
  const lines: string[] = [];

  lines.push(`Community Pulse: "${topic}" — ${top.length} results from Reddit, Hacker News, and Polymarket\n`);

  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    lines.push(`${i + 1}. **${r.name}** — ${r.description}`);
    lines.push(`Deadline: None listed`);
    lines.push(`Program URL: ${r.sourceUrl}`);
    lines.push('');
  }

  // Append stats
  const redditCount = top.filter((r) => r.source === 'reddit').length;
  const hnCount = top.filter((r) => r.source === 'hackernews').length;
  const pmCount = top.filter((r) => r.source === 'polymarket').length;
  lines.push(`---`);
  lines.push(`Sources: ${redditCount} Reddit threads, ${hnCount} HN stories, ${pmCount} Polymarket events`);

  return lines.join('\n');
}

// ============================================================
// Main execution (called by scan-execution.ts)
// ============================================================

export async function executeCommunityScan(
  promptText: string,
  options?: { wire?: string }
): Promise<{ content: string; model: string; tokensUsed?: number }> {
  const start = Date.now();
  const wire = options?.wire || 'unknown';

  console.log(`[Community] Starting community pulse scan for wire: ${wire}`);

  // Extract topic from prompt text
  // The prompt text contains the full scan prompt — extract the core topic
  const topic = extractTopic(promptText, wire);
  console.log(`[Community] Topic: "${topic}"`);

  // Fan out to all three sources in parallel
  const [reddit, hn, polymarket] = await Promise.all([
    searchReddit(topic),
    searchHN(topic),
    searchPolymarket(topic),
  ]);

  const durationMs = Date.now() - start;

  console.log(
    `[Community] Results — Reddit: ${reddit.length}, HN: ${hn.length}, Polymarket: ${polymarket.length} (${durationMs}ms)`
  );

  // Build unified results
  const results = buildCommunityResults(reddit, hn, polymarket);

  // Format as structured output for parseStructuredOutput()
  const content = formatAsStructuredOutput(results, topic);

  // Log API usage (all free, but track for monitoring)
  logApiUsage({
    provider: 'community',
    model: 'community-pulse/1.0',
    purpose: 'scan',
    duration_ms: durationMs,
    success: true,
    tokens_in: 0,
    tokens_out: 0,
  });

  return {
    content,
    model: 'community-pulse/1.0',
    tokensUsed: 0,
  };
}

// ============================================================
// Topic extraction
// ============================================================

/**
 * Extract the core search topic from the scan prompt text.
 * The prompt contains instructions + topic context.
 * We extract key phrases relevant to the wire.
 */
function extractTopic(promptText: string, wire: string): string {
  // Strategy: use wire-specific default topics, enhanced by prompt keywords

  const wireDefaults: Record<string, string> = {
    crypto: 'cryptocurrency grants funding DeFi DAO treasury public goods',
    ai: 'AI grants research funding machine learning fellowship',
    oss: 'open source funding grants sustainability sponsorship',
  };

  // Start with the wire default
  let topic = wireDefaults[wire] || wire;

  // Extract any quoted phrases from the prompt for specificity
  const quotedPhrases = promptText.match(/"([^"]+)"/g);
  if (quotedPhrases && quotedPhrases.length > 0) {
    topic = quotedPhrases.map((p) => p.replace(/"/g, '')).join(' ');
  }

  // Check for explicit topic markers in the prompt
  const topicMatch = promptText.match(
    /(?:focus on|search for|topic:|about)\s*[:\-]?\s*(.+?)(?:\.|$)/i
  );
  if (topicMatch) {
    // Use the first 100 chars of the matched topic as the search query
    topic = topicMatch[1].substring(0, 100).trim();
  }

  return topic;
}
