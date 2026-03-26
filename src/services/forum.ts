/**
 * Forum Service — discuss.watch API client
 *
 * Dual-strategy scanning of 160+ Discourse forums via discuss.watch:
 *   1. /discussions — date-filtered recent activity (high volume, fresh)
 *   2. /search — keyword-targeted matches (precision, deeper reach)
 *
 * Results are mapped to RawScanResult[] for the intake pipeline.
 * Rate limit: ~14 req/min (4.2s delay between requests)
 */

import { config } from '../config';
import type { RawScanResult } from '../types/intake';
import { sleep } from '../utils/async';

// --- Wire-to-category mapping (discuss.watch categories match wire keys) ---
// Wire keys map 1:1 to discuss.watch categories today; keeping the map
// explicit so the mapping is easy to change if they diverge.
const WIRE_CATEGORY_MAP: Record<string, string> = {
  crypto: 'crypto',
  ai: 'ai',
  oss: 'oss',
};

// Default search keywords (used when FORUM_SEARCH_TERMS env var is not set)
const DEFAULT_SEARCH_TERMS = [
  'grant program',
  'funding round',
  'ecosystem fund',
  'bounty program',
  'hackathon',
  'fellowship',
  'RFP',
  'grants council',
  'developer grants',
  'retroactive funding',
];

function getSearchTerms(): string[] {
  const envVal = process.env.FORUM_SEARCH_TERMS;
  if (envVal) {
    return envVal.split(',').map(t => t.trim()).filter(Boolean);
  }
  return DEFAULT_SEARCH_TERMS;
}

// Rate limit: ~14 req/min = 4.2s between requests
const REQUEST_DELAY_MS = 4300;
const MAX_RESULTS_PER_RUN = 300;
const RESULTS_PER_SEARCH = 25;
const MAX_DISCUSSIONS_PER_CATEGORY = 50;

// --- Interfaces ---

export interface ForumSearchOptions {
  wire?: string;
  keywords?: string[];
  maxResults?: number;
  excludeUrls?: Set<string>;
  onProgress?: (message: string, pct: number) => void;
}

export interface ForumDiscussionsOptions {
  wire?: string;
  since?: string;
  maxResults?: number;
  onProgress?: (message: string, pct: number) => void;
}

export interface DualForumScanOptions {
  wire?: string;
  since?: string;
  keywords?: string[];
  maxResults?: number;
  onProgress?: (message: string, pct: number) => void;
}

export interface WireResults {
  wire: string;
  results: RawScanResult[];
}

export interface DualForumScanResult {
  byWire: WireResults[];
  discussionsCount: number;
  searchCount: number;
}

interface DiscussWatchResult {
  id?: string | number;
  title?: string;
  blurb?: string;
  url?: string;
  forum?: { name?: string; url?: string; token?: string };
  category?: string;
  createdAt?: string;
  replies?: number;
  views?: number;
  likes?: number;
}

interface DiscussWatchSearchResponse {
  data?: DiscussWatchResult[];
  meta?: { total?: number; query?: string; forums?: number };
  error?: string;
}

interface DiscussWatchDiscussion {
  id?: string | number;
  title?: string;
  url?: string;
  forum?: { name?: string; url?: string; token?: string };
  createdAt?: string;
  lastActivityAt?: string;
  replies?: number;
  views?: number;
  likes?: number;
  isHot?: boolean;
}

interface DiscussWatchDiscussionsResponse {
  data?: DiscussWatchDiscussion[];
  meta?: { total?: number; category?: string; forums?: number };
  error?: string;
}

/**
 * Extract dollar amount from text using simple regex patterns.
 * Handles: $100K, $1.5M, $50,000, $1 million, etc.
 */
function extractAmount(text: string): string | null {
  if (!text) return null;

  const patterns = [
    /\$[\d,.]+\s*[Mm](?:illion)?/,
    /\$[\d,.]+\s*[Bb](?:illion)?/,
    /\$[\d,.]+\s*[Kk]/,
    /\$[\d,]+(?:\.\d+)?/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }

  return null;
}

function normalizeUrl(url: string): string {
  return url.toLowerCase().replace(/\/+$/, '');
}

/**
 * Pre-filter discussion titles for grants-ecosystem relevance.
 * Phase 1 (discussions) returns ALL recent activity from a category,
 * so we filter client-side to avoid ingesting random code PRs,
 * version releases, and unrelated forum chatter.
 */
const RELEVANCE_KEYWORDS = [
  'grant', 'grants', 'funding', 'fund', 'funds', 'funded',
  'bounty', 'bounties', 'hackathon', 'prize', 'fellowship',
  'rfp', 'proposal', 'treasury', 'budget', 'allocation',
  'subsidy', 'sponsorship', 'sponsor', 'donation', 'endowment',
  'incentive', 'incentives', 'reward', 'rewards',
  'retro funding', 'retroactive', 'public goods',
  'ecosystem', 'council', 'committee', 'governance',
  'milestone', 'deliverable', 'grantee',
  'open call', 'call for', 'applications open', 'apply',
  'stipend', 'scholarship', 'residency', 'accelerator',
];

function isRelevantDiscussion(title: string): boolean {
  const lower = title.toLowerCase();
  return RELEVANCE_KEYWORDS.some(kw => lower.includes(kw));
}

// --- Phase 1: Recent Discussions ---

/**
 * Fetch recent discussions from discuss.watch /discussions endpoint.
 * Date-filtered, category-aware, high-volume source.
 */
export async function fetchRecentDiscussions(
  options: ForumDiscussionsOptions = {}
): Promise<{ byWire: WireResults[]; totalCount: number }> {
  const baseUrl = config.forum.discussWatchBaseUrl;
  const maxPerCategory = options.maxResults || MAX_DISCUSSIONS_PER_CATEGORY;
  const progress = options.onProgress || (() => {});

  // Determine which categories to scan
  const categories: { category: string; wire: string }[] = [];
  if (options.wire && WIRE_CATEGORY_MAP[options.wire]) {
    categories.push({ category: WIRE_CATEGORY_MAP[options.wire], wire: options.wire });
  } else {
    for (const [wire, cat] of Object.entries(WIRE_CATEGORY_MAP)) {
      categories.push({ category: cat, wire });
    }
  }

  // Default since: 2 days ago
  const since = options.since || new Date(Date.now() - config.forum.defaultLookbackDays * 86400000).toISOString().split('T')[0];

  const byWire: WireResults[] = [];
  let totalCount = 0;

  for (let i = 0; i < categories.length; i++) {
    const { category, wire } = categories[i];
    const pct = Math.round((i / categories.length) * 100);
    progress(`Fetching recent ${category} discussions (since ${since})`, pct);

    let retried = false;
    const attemptFetch = async (): Promise<DiscussWatchDiscussionsResponse | null> => {
      const params = new URLSearchParams({
        category,
        since,
        sort: 'activity',
        limit: String(maxPerCategory),
      });

      const response = await fetch(`${baseUrl}/discussions?${params}`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        if (response.status === 429 && !retried) {
          retried = true;
          console.warn(`[Forum] Rate limited on discussions/${category}, waiting 10s and retrying...`);
          await sleep(10000);
          return attemptFetch();
        }
        console.warn(`[Forum] Discussions ${category} returned ${response.status}`);
        return null;
      }
      return await response.json() as DiscussWatchDiscussionsResponse;
    };

    try {
      const data = await attemptFetch();
      if (!data) continue;

      if (data.error) {
        console.warn(`[Forum] Discussions API error for ${category}: ${data.error}`);
        continue;
      }

      const items = data.data || [];
      const results: RawScanResult[] = [];
      const seenUrls = new Set<string>();

      let skippedIrrelevant = 0;
      for (const item of items) {
        if (!item.url || !item.title) continue;

        // Pre-filter: only ingest discussions with grants-ecosystem relevance
        if (!isRelevantDiscussion(item.title)) {
          skippedIrrelevant++;
          continue;
        }

        const normalized = normalizeUrl(item.url);
        if (seenUrls.has(normalized)) continue;
        seenUrls.add(normalized);

        results.push({
          name: item.title,
          description: '',
          sourceUrl: item.url,
          amount: extractAmount(item.title),
          deadline: null,
          sourcePublishedAt: item.lastActivityAt || item.createdAt || null,
        });
      }

      if (results.length > 0) {
        byWire.push({ wire, results });
        totalCount += results.length;
      }

      console.log(`[Forum] Discussions ${category}: ${items.length} items, ${results.length} relevant, ${skippedIrrelevant} filtered`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[Forum] Discussions ${category} failed: ${msg}`);
    }

    // Rate limit delay between categories (skip after last)
    if (i < categories.length - 1) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  return { byWire, totalCount };
}

// --- Phase 2: Keyword Search ---

/**
 * Search discuss.watch for grant-related forum discussions.
 * Keyword-targeted, precision-oriented source.
 */
export async function searchForumDiscussions(
  options: ForumSearchOptions = {}
): Promise<RawScanResult[]> {
  const baseUrl = config.forum.discussWatchBaseUrl;
  const keywords = options.keywords || getSearchTerms();
  const maxResults = options.maxResults || MAX_RESULTS_PER_RUN;
  const progress = options.onProgress || (() => {});
  const excludeUrls = options.excludeUrls || new Set<string>();

  const allResults: RawScanResult[] = [];
  const seenUrls = new Set<string>(excludeUrls);

  for (let i = 0; i < keywords.length; i++) {
    if (allResults.length >= maxResults) break;

    const keyword = keywords[i];
    const pct = Math.round((i / keywords.length) * 80);
    progress(`Searching: "${keyword}" (${i + 1}/${keywords.length})`, pct);

    try {
      const params = new URLSearchParams({
        q: keyword,
        limit: String(RESULTS_PER_SEARCH),
      });
      if (options.wire) {
        params.set('category', WIRE_CATEGORY_MAP[options.wire] || options.wire);
      }

      const response = await fetch(`${baseUrl}/search?${params}`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        if (response.status === 429) {
          console.warn(`[Forum] Rate limited on "${keyword}", waiting 10s...`);
          await sleep(10000);
          continue;
        }
        console.warn(`[Forum] Search "${keyword}" returned ${response.status}`);
        continue;
      }

      const data = await response.json() as DiscussWatchSearchResponse;

      if (data.error) {
        console.warn(`[Forum] API error for "${keyword}": ${data.error}`);
        continue;
      }

      const results = data.data || [];
      for (const item of results) {
        if (allResults.length >= maxResults) break;
        if (!item.url || !item.title) continue;

        const normalizedUrl = normalizeUrl(item.url);
        if (seenUrls.has(normalizedUrl)) continue;
        seenUrls.add(normalizedUrl);

        const description = item.blurb || '';
        const combinedText = `${item.title} ${description}`;

        allResults.push({
          name: item.title,
          description: description,
          sourceUrl: item.url,
          amount: extractAmount(combinedText),
          deadline: null,
          sourcePublishedAt: item.createdAt || null,
        });
      }

      console.log(`[Forum] "${keyword}": ${results.length} results, ${allResults.length} total unique`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[Forum] Search "${keyword}" failed: ${msg}`);
    }

    // Rate limit delay between searches (skip after last)
    if (i < keywords.length - 1 && allResults.length < maxResults) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  progress(`Found ${allResults.length} unique search results`, 85);
  return allResults;
}

// --- Dual Strategy Orchestrator ---

/**
 * Run dual-strategy forum scan: discussions (fresh) + search (precision).
 * Returns results grouped by wire for per-wire intake submissions.
 */
export async function runDualForumScan(
  options: DualForumScanOptions = {}
): Promise<DualForumScanResult> {
  const progress = options.onProgress || (() => {});
  const maxResults = options.maxResults || MAX_RESULTS_PER_RUN;

  // Phase 1: Recent discussions (0-40%)
  let discussionsResult: { byWire: WireResults[]; totalCount: number } = { byWire: [], totalCount: 0 };
  try {
    discussionsResult = await fetchRecentDiscussions({
      wire: options.wire,
      since: options.since,
      onProgress: (msg, pct) => progress(msg, Math.round(pct * 0.4)),
    });
    progress(`Discussions: ${discussionsResult.totalCount} results across ${discussionsResult.byWire.length} wires`, 40);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[Forum] Discussions phase failed, falling back to search-only: ${msg}`);
    progress('Discussions unavailable, using search only', 40);
  }

  // Seed wire map with discussions results and collect URLs for cross-dedup
  const wireMap = new Map<string, RawScanResult[]>();
  const discussionUrls = new Set<string>();
  for (const wr of discussionsResult.byWire) {
    wireMap.set(wr.wire, [...wr.results]);
    for (const r of wr.results) {
      discussionUrls.add(normalizeUrl(r.sourceUrl));
    }
  }

  // Rate limit pause between phases
  if (discussionsResult.totalCount > 0) {
    await sleep(REQUEST_DELAY_MS);
  }

  // Phase 2: Keyword search (40-85%)
  // When wire is specified, search only that category. Otherwise, search per-category
  // so results are correctly assigned to the right wire.
  const searchWires = options.wire
    ? [options.wire]
    : Object.keys(WIRE_CATEGORY_MAP);

  let totalSearchCount = 0;
  const searchBudget = Math.max(maxResults - discussionsResult.totalCount, 50);
  const perWireBudget = Math.ceil(searchBudget / searchWires.length);

  for (let wi = 0; wi < searchWires.length; wi++) {
    const wire = searchWires[wi];
    const searchPct = (pct: number) => {
      const wireOffset = wi / searchWires.length;
      const wireSpan = 1 / searchWires.length;
      progress(`Search (${wire})`, 40 + Math.round((wireOffset + wireSpan * pct / 100) * 45));
    };

    const wireSearchResults = await searchForumDiscussions({
      wire,
      keywords: options.keywords,
      maxResults: perWireBudget,
      excludeUrls: discussionUrls,
      onProgress: (msg, pct) => searchPct(pct),
    });

    if (wireSearchResults.length > 0) {
      // Add search results to the wire's existing discussions (or create new entry)
      const existing = wireMap.get(wire) || [];
      existing.push(...wireSearchResults);
      wireMap.set(wire, existing);
      totalSearchCount += wireSearchResults.length;

      // Add these URLs to excludeUrls to avoid cross-wire duplication in search
      for (const r of wireSearchResults) {
        discussionUrls.add(normalizeUrl(r.sourceUrl));
      }
    }
  }

  progress(`Search: ${totalSearchCount} additional results`, 88);

  // Build final grouped results
  const byWire: WireResults[] = [];
  for (const [wire, results] of wireMap) {
    if (results.length > 0) {
      byWire.push({ wire, results });
    }
  }

  const totalDiscussions = discussionsResult.totalCount;
  const totalSearch = totalSearchCount;
  const totalAll = totalDiscussions + totalSearch;

  progress(`Forum scan complete: ${totalAll} total (${totalDiscussions} discussions + ${totalSearch} search)`, 100);
  console.log(`[Forum] Dual scan complete: ${totalDiscussions} from discussions, ${totalSearch} from search, ${byWire.length} wires`);

  return {
    byWire,
    discussionsCount: totalDiscussions,
    searchCount: totalSearch,
  };
}
