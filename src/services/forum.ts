/**
 * Forum Service — discuss.watch API client
 *
 * Searches discuss.watch (150+ Discourse forums) for grant-related discussions.
 * Results are mapped to RawScanResult[] for the intake pipeline.
 *
 * API: GET /api/v1/search?q={keyword}&category={wire}&limit=25
 * Rate limit: ~14 req/min (4.2s delay between searches)
 */

import { config } from '../config';
import type { RawScanResult } from '../types/intake';
import { sleep } from '../utils/async';

// Grant-focused search keywords
const GRANT_KEYWORDS = [
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

// Rate limit: ~14 req/min = 4.2s between requests
const REQUEST_DELAY_MS = 4300;
const MAX_RESULTS_PER_RUN = 100;
const RESULTS_PER_SEARCH = 25;

export interface ForumSearchOptions {
  wire?: string;
  keywords?: string[];
  maxResults?: number;
  onProgress?: (message: string, pct: number) => void;
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

/**
 * Extract dollar amount from text using simple regex patterns.
 * Handles: $100K, $1.5M, $50,000, $1 million, etc.
 */
function extractAmount(text: string): string | null {
  if (!text) return null;

  // $N.NK or $NM or $N,NNN
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

/**
 * Search discuss.watch for grant-related forum discussions.
 */
export async function searchForumDiscussions(
  options: ForumSearchOptions = {}
): Promise<RawScanResult[]> {
  const baseUrl = config.forum.discussWatchBaseUrl;
  const keywords = options.keywords || GRANT_KEYWORDS;
  const maxResults = options.maxResults || MAX_RESULTS_PER_RUN;
  const progress = options.onProgress || (() => {});

  const allResults: RawScanResult[] = [];
  const seenUrls = new Set<string>();

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
        params.set('category', options.wire);
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

        // Deduplicate within batch by URL
        const normalizedUrl = item.url.toLowerCase().replace(/\/+$/, '');
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

  progress(`Found ${allResults.length} unique forum discussions`, 85);
  return allResults;
}
