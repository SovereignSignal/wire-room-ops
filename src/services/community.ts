/**
 * Community Pulse Service
 *
 * Searches Reddit and Hacker News for community signal on funding/grants
 * topics. Returns results formatted for the existing parseStructuredOutput()
 * pipeline — zero changes needed downstream.
 *
 * All APIs are free, public, and require no authentication.
 *
 * Sources:
 * - Reddit: public JSON search API (reddit.com/search.json)
 * - Hacker News: Algolia search API (hn.algolia.com)
 *
 * NOTE: Polymarket intentionally excluded. Prediction markets surface
 * political/geopolitical speculation, not funding opportunities.
 * Polymarket is used in the Macro Brief (via last30days), not here.
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
  relevanceScore: number; // 0-1, how relevant to funding/grants
}

// ============================================================
// Relevance keywords — results must match at least one
// ============================================================

const FUNDING_KEYWORDS = [
  'grant', 'grants', 'funding', 'fund', 'funded',
  'bounty', 'bounties', 'reward', 'prize',
  'fellowship', 'scholarship', 'stipend',
  'accelerator', 'incubator',
  'rfp', 'rfa', 'open call',
  'retroactive', 'retropgf', 'rpgf',
  'treasury', 'allocation',
  'sponsorship', 'sponsor',
  'hackathon', 'hack',
  'developer program', 'builder program',
  'ecosystem fund', 'ecosystem grant',
  'foundation', 'endowment',
  'apply', 'application', 'deadline',
  'airdrop', 'incentive', 'incentives',
];

// Wire-specific keywords for additional relevance
const WIRE_KEYWORDS: Record<string, string[]> = {
  crypto: [
    'defi', 'dao', 'protocol', 'blockchain', 'ethereum', 'solana',
    'optimism', 'arbitrum', 'base', 'polygon', 'uniswap', 'aave',
    'compound', 'maker', 'gitcoin', 'public goods', 'web3',
    'onchain', 'on-chain', 'smart contract', 'token',
  ],
  ai: [
    'machine learning', 'deep learning', 'nlp', 'llm', 'neural',
    'artificial intelligence', 'ai safety', 'alignment',
    'nsf', 'darpa', 'nih', 'openai', 'anthropic', 'google deepmind',
    'research lab', 'compute grant', 'gpu', 'training',
  ],
  oss: [
    'open source', 'open-source', 'foss', 'libre',
    'github sponsors', 'linux foundation', 'apache', 'cncf',
    'sovereign tech', 'nlnet', 'mozilla', 'outreachy',
    'maintainer', 'contributor', 'upstream',
    'gsoc', 'google summer', 'lfx mentorship',
  ],
};

/**
 * Score relevance of a result to funding/grants topics.
 * Returns 0-1 score. Results below threshold are filtered out.
 */
function scoreRelevance(text: string, wire: string): number {
  const lower = text.toLowerCase();
  let score = 0;
  let matches = 0;

  // Check funding keywords (high weight)
  for (const kw of FUNDING_KEYWORDS) {
    if (lower.includes(kw)) {
      score += 0.3;
      matches++;
      if (matches >= 3) break; // Cap contribution
    }
  }

  // Check wire-specific keywords (medium weight)
  const wireKws = WIRE_KEYWORDS[wire] || [];
  let wireMatches = 0;
  for (const kw of wireKws) {
    if (lower.includes(kw)) {
      score += 0.15;
      wireMatches++;
      if (wireMatches >= 3) break;
    }
  }

  // Bonus for having both funding + wire keywords
  if (matches > 0 && wireMatches > 0) {
    score += 0.2;
  }

  return Math.min(score, 1.0);
}

// ============================================================
// Reddit Public JSON API
// ============================================================

const REDDIT_USER_AGENT = 'wire-room-ops/1.0 (community-pulse)';

// Targeted subreddits per wire for focused search
const WIRE_SUBREDDITS: Record<string, string[]> = {
  crypto: [
    'ethereum', 'defi', 'ethfinance', 'CryptoCurrency',
    'ethdev', 'solana', 'cosmosnetwork', 'web3',
  ],
  ai: [
    'MachineLearning', 'artificial', 'LocalLLaMA',
    'MLQuestions', 'deeplearning', 'LanguageTechnology',
  ],
  oss: [
    'opensource', 'linux', 'programming', 'selfhosted',
    'github', 'webdev', 'devops',
  ],
};

async function searchReddit(topic: string, wire: string, limit = 25): Promise<RedditThread[]> {
  const allResults: RedditThread[] = [];

  // Strategy: run two searches in parallel
  // 1. Global search with funding-specific terms
  // 2. Targeted subreddit search for wire-specific communities
  const subreddits = WIRE_SUBREDDITS[wire] || [];
  const subredditQuery = subreddits.length > 0
    ? `(${subreddits.slice(0, 4).map(s => `subreddit:${s}`).join(' OR ')}) (grant OR funding OR bounty OR program)`
    : topic;

  const searches = [
    // Global search — funding-focused
    fetchReddit(`${topic} (grant OR funding OR bounty OR hackathon)`, limit),
    // Subreddit-targeted search
    fetchReddit(subredditQuery, Math.min(limit, 15)),
  ];

  const [global, targeted] = await Promise.all(searches);

  // Merge and deduplicate by permalink
  const seen = new Set<string>();
  for (const thread of [...global, ...targeted]) {
    if (!seen.has(thread.permalink)) {
      seen.add(thread.permalink);
      allResults.push(thread);
    }
  }

  return allResults;
}

async function fetchReddit(query: string, limit: number): Promise<RedditThread[]> {
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

async function searchHN(topic: string, wire: string, limit = 15): Promise<HNStory[]> {
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60;

  // Run two HN searches: topic-general and funding-specific
  const searches = [
    fetchHN(`${topic} (grant OR funding OR program)`, limit, thirtyDaysAgo),
    fetchHN(`${topic} (open source OR developer) (fund OR sponsor OR bounty)`, Math.min(limit, 10), thirtyDaysAgo),
  ];

  const [general, funding] = await Promise.all(searches);

  // Merge and deduplicate
  const seen = new Set<string>();
  const results: HNStory[] = [];
  for (const story of [...general, ...funding]) {
    if (!seen.has(story.storyUrl)) {
      seen.add(story.storyUrl);
      results.push(story);
    }
  }

  return results;
}

async function fetchHN(query: string, limit: number, sinceTimestamp: number): Promise<HNStory[]> {
  const params = new URLSearchParams({
    query,
    tags: 'story',
    numericFilters: `created_at_i>${sinceTimestamp}`,
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
// Result building with relevance filtering
// ============================================================

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().split('T')[0];
}

const RELEVANCE_THRESHOLD = 0.2; // Minimum relevance score to include

function buildCommunityResults(
  reddit: RedditThread[],
  hn: HNStory[],
  wire: string,
): CommunityResult[] {
  const results: CommunityResult[] = [];

  // Reddit → CommunityResult with relevance scoring
  for (const thread of reddit) {
    const fullText = `${thread.title} ${thread.selftext} ${thread.subreddit}`;
    const relevance = scoreRelevance(fullText, wire);

    if (relevance < RELEVANCE_THRESHOLD) continue; // Filter irrelevant

    const engagement = thread.score + thread.numComments * 2;
    results.push({
      name: `[Reddit] r/${thread.subreddit}: "${thread.title}"`,
      description:
        `Reddit thread with ${thread.score} upvotes and ${thread.numComments} comments (${formatDate(thread.createdUtc)}). ` +
        (thread.selftext ? thread.selftext.substring(0, 200) + '...' : 'Link post — discussion in comments.'),
      sourceUrl: thread.permalink,
      engagement,
      source: 'reddit',
      relevanceScore: relevance,
    });
  }

  // HN → CommunityResult with relevance scoring
  for (const story of hn) {
    const fullText = `${story.title} ${story.url || ''}`;
    const relevance = scoreRelevance(fullText, wire);

    if (relevance < RELEVANCE_THRESHOLD) continue;

    const engagement = story.points + story.numComments * 3;
    results.push({
      name: `[Hacker News] "${story.title}"`,
      description:
        `Hacker News story with ${story.points} points and ${story.numComments} comments. ` +
        (story.url ? `Links to: ${story.url}` : 'Ask HN / Show HN discussion.'),
      sourceUrl: story.storyUrl,
      engagement,
      source: 'hackernews',
      relevanceScore: relevance,
    });
  }

  // Sort by relevance first, then engagement within same relevance tier
  results.sort((a, b) => {
    const relevanceDiff = b.relevanceScore - a.relevanceScore;
    if (Math.abs(relevanceDiff) > 0.1) return relevanceDiff;
    return b.engagement - a.engagement;
  });

  return results;
}

// ============================================================
// Format for parseStructuredOutput() compatibility
// ============================================================

function formatAsStructuredOutput(results: CommunityResult[], topic: string): string {
  if (results.length === 0) {
    return `No relevant community results found for "${topic}".`;
  }

  // Take top 15 results
  const top = results.slice(0, 15);
  const lines: string[] = [];

  lines.push(`Community Pulse: "${topic}" — ${top.length} relevant results from Reddit and Hacker News\n`);

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
  lines.push(`Sources: ${redditCount} Reddit threads, ${hnCount} HN stories (relevance-filtered)`);

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

  // Build targeted search queries from the prompt
  const queries = buildSearchQueries(promptText, wire);
  console.log(`[Community] Queries: ${JSON.stringify(queries)}`);

  // Fan out to Reddit + HN in parallel (Polymarket excluded — wrong tool for grant discovery)
  const [reddit, hn] = await Promise.all([
    searchReddit(queries.primary, wire),
    searchHN(queries.primary, wire),
  ]);

  const durationMs = Date.now() - start;

  console.log(
    `[Community] Raw results — Reddit: ${reddit.length}, HN: ${hn.length} (${durationMs}ms)`
  );

  // Build unified results with relevance filtering
  const results = buildCommunityResults(reddit, hn, wire);

  console.log(
    `[Community] After relevance filter: ${results.length} results (threshold: ${RELEVANCE_THRESHOLD})`
  );

  const content = formatAsStructuredOutput(results, queries.primary);

  logApiUsage({
    provider: 'community',
    model: 'community-pulse/1.1',
    purpose: 'scan',
    duration_ms: durationMs,
    success: true,
    tokens_in: 0,
    tokens_out: 0,
  });

  return {
    content,
    model: 'community-pulse/1.1',
    tokensUsed: 0,
  };
}

// ============================================================
// Search query building
// ============================================================

/**
 * Build focused search queries from the scan prompt text.
 * Instead of dumping the full prompt as a search query, we extract
 * the key funding-related terms and combine with wire context.
 */
function buildSearchQueries(promptText: string, wire: string): { primary: string; secondary: string } {
  // Wire-specific primary queries — these are what we actually search for
  const wirePrimaries: Record<string, string> = {
    crypto: 'crypto grant funding program DeFi DAO',
    ai: 'AI research grant funding fellowship program',
    oss: 'open source grant funding sponsorship program',
  };

  const wireSecondaries: Record<string, string> = {
    crypto: 'retroPGF public goods Gitcoin ecosystem fund',
    ai: 'NSF DARPA AI safety compute grant',
    oss: 'GitHub Sponsors sovereign tech fund maintainer',
  };

  // Check if the prompt has specific entities/programs mentioned
  const entityMatch = promptText.match(
    /(?:focus on|specifically|including|such as)[:\s]+(.+?)(?:\.|$)/i
  );

  let primary = wirePrimaries[wire] || `${wire} grant funding`;
  let secondary = wireSecondaries[wire] || `${wire} funding program`;

  if (entityMatch) {
    // Append specific entities to narrow the search
    primary += ' ' + entityMatch[1].substring(0, 60).trim();
  }

  return { primary, secondary };
}
