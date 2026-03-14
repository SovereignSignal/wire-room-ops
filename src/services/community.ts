/**
 * Community Pulse Service
 *
 * Searches Reddit and Hacker News for community signal based on
 * whatever the scan prompt defines. Prompt-driven, not hardcoded —
 * works for any Wire Room deployment (crypto grants, AI consulting,
 * local government RFPs, whatever the operator configures).
 *
 * All APIs are free, public, and require no authentication.
 *
 * Sources:
 * - Reddit: public JSON search API (reddit.com/search.json)
 * - Hacker News: Algolia search API (hn.algolia.com)
 *
 * NOTE: Polymarket intentionally excluded. Prediction markets surface
 * speculation, not actionable opportunities. Use last30days skill
 * for Polymarket integration in macro/research contexts.
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

interface CommunityResult {
  name: string;
  description: string;
  sourceUrl: string;
  engagement: number;
  source: 'reddit' | 'hackernews';
}

// ============================================================
// Query extraction from prompt
// ============================================================

/**
 * Extract search queries from the scan prompt text.
 *
 * The scan prompt is the single source of truth for what to search.
 * This function extracts actionable search terms from natural language
 * prompts — no hardcoded keywords, subreddits, or wire-specific logic.
 *
 * Strategies (in priority order):
 * 1. Quoted phrases in the prompt → use as exact search terms
 * 2. "Focus on:" / "Search for:" sections → extract the listed items
 * 3. Fallback → use the first sentence as the query (trimmed to 120 chars)
 */
function extractSearchQueries(promptText: string): string[] {
  const queries: string[] = [];

  // Strategy 1: Extract quoted phrases
  const quoted = promptText.match(/"([^"]{3,80})"/g);
  if (quoted && quoted.length > 0) {
    for (const q of quoted.slice(0, 3)) {
      queries.push(q.replace(/"/g, ''));
    }
  }

  // Strategy 2: Extract from "Focus on:" or "Search for:" lists
  const focusMatch = promptText.match(
    /(?:focus on|search for|look for|surface|find)[:\s]+([^.]+)/i
  );
  if (focusMatch) {
    // Split comma-separated items into individual queries
    const items = focusMatch[1]
      .split(/,|(?:\band\b)/)
      .map((s) => s.trim())
      .filter((s) => s.length > 5 && s.length < 100);

    // Take up to 3 most specific items as queries
    for (const item of items.slice(0, 3)) {
      if (!queries.some((q) => q.toLowerCase() === item.toLowerCase())) {
        queries.push(item);
      }
    }
  }

  // Strategy 3: Fallback — use the first meaningful sentence
  if (queries.length === 0) {
    const firstSentence = promptText.split(/[.!?\n]/).find((s) => s.trim().length > 10);
    if (firstSentence) {
      queries.push(firstSentence.trim().substring(0, 120));
    }
  }

  // Final fallback
  if (queries.length === 0) {
    queries.push(promptText.substring(0, 120).trim());
  }

  return queries;
}

// ============================================================
// Reddit Public JSON API
// ============================================================

const REDDIT_USER_AGENT = 'wire-room-ops/1.0 (community-pulse)';

async function searchReddit(query: string, limit = 20): Promise<RedditThread[]> {
  const params = new URLSearchParams({
    q: query,
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
      selftext: (child.data.selftext || '').substring(0, 300),
    }));
  } catch (error) {
    console.warn(`[Community] Reddit search failed: ${error}`);
    return [];
  }
}

// ============================================================
// Hacker News Algolia API
// ============================================================

async function searchHN(query: string, limit = 15): Promise<HNStory[]> {
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;

  const params = new URLSearchParams({
    query,
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
// Result building
// ============================================================

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().split('T')[0];
}

function buildCommunityResults(
  reddit: RedditThread[],
  hn: HNStory[],
): CommunityResult[] {
  const results: CommunityResult[] = [];

  for (const thread of reddit) {
    const engagement = thread.score + thread.numComments * 2;
    results.push({
      name: `[Reddit] r/${thread.subreddit}: "${thread.title}"`,
      description:
        `Reddit thread with ${thread.score} upvotes and ${thread.numComments} comments (${formatDate(thread.createdUtc)}). ` +
        (thread.selftext ? thread.selftext.substring(0, 200) + '...' : 'Link post — discussion in comments.'),
      sourceUrl: thread.permalink,
      engagement,
      source: 'reddit',
    });
  }

  for (const story of hn) {
    const engagement = story.points + story.numComments * 3;
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

  // Sort by engagement (highest first)
  results.sort((a, b) => b.engagement - a.engagement);

  return results;
}

// ============================================================
// Format for parseStructuredOutput() compatibility
// ============================================================

function formatAsStructuredOutput(results: CommunityResult[], queries: string[]): string {
  if (results.length === 0) {
    return `No community results found for queries: ${queries.join(', ')}`;
  }

  const top = results.slice(0, 15);
  const lines: string[] = [];

  lines.push(`Community Pulse — ${top.length} results from Reddit and Hacker News\n`);

  for (let i = 0; i < top.length; i++) {
    const r = top[i];
    lines.push(`${i + 1}. **${r.name}** — ${r.description}`);
    lines.push(`Deadline: None listed`);
    lines.push(`Program URL: ${r.sourceUrl}`);
    lines.push('');
  }

  const redditCount = top.filter((r) => r.source === 'reddit').length;
  const hnCount = top.filter((r) => r.source === 'hackernews').length;
  lines.push(`---`);
  lines.push(`Sources: ${redditCount} Reddit threads, ${hnCount} HN stories`);
  lines.push(`Queries: ${queries.join(' | ')}`);

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

  // Extract search queries from the prompt — prompt is the single source of truth
  const queries = extractSearchQueries(promptText);
  console.log(`[Community] Extracted queries: ${JSON.stringify(queries)}`);

  // Run all queries against Reddit + HN in parallel
  const searchPromises: Promise<[RedditThread[], HNStory[]]>[] = queries.map(async (query) => {
    const [reddit, hn] = await Promise.all([
      searchReddit(query, Math.ceil(20 / queries.length)),
      searchHN(query, Math.ceil(15 / queries.length)),
    ]);
    return [reddit, hn] as [RedditThread[], HNStory[]];
  });

  const searchResults = await Promise.all(searchPromises);

  // Merge all results, deduplicating by URL
  const allReddit: RedditThread[] = [];
  const allHN: HNStory[] = [];
  const seenUrls = new Set<string>();

  for (const [reddit, hn] of searchResults) {
    for (const thread of reddit) {
      if (!seenUrls.has(thread.permalink)) {
        seenUrls.add(thread.permalink);
        allReddit.push(thread);
      }
    }
    for (const story of hn) {
      if (!seenUrls.has(story.storyUrl)) {
        seenUrls.add(story.storyUrl);
        allHN.push(story);
      }
    }
  }

  const durationMs = Date.now() - start;

  console.log(
    `[Community] Results — Reddit: ${allReddit.length}, HN: ${allHN.length} (${durationMs}ms)`
  );

  const results = buildCommunityResults(allReddit, allHN);
  const content = formatAsStructuredOutput(results, queries);

  logApiUsage({
    provider: 'community',
    model: 'community-pulse/2.0',
    purpose: 'scan',
    duration_ms: durationMs,
    success: true,
    tokens_in: 0,
    tokens_out: 0,
  });

  return {
    content,
    model: 'community-pulse/2.0',
    tokensUsed: 0,
  };
}
