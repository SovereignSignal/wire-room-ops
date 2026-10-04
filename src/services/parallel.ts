/**
 * Parallel.ai Search API service — high-quality web retrieval for scans.
 *
 * Parallel's Search API (https://api.parallel.ai/v1/search) returns ranked web
 * results with excerpts — raw retrieval, not a synthesized answer. We pair it
 * with Grok: Grok plans the keyword queries, Parallel retrieves, Grok extracts
 * the structured grant entries from the excerpts. Each tool to its strength.
 *
 * Cost per scan ≈ $0.005 (Parallel search) + ~$0.01 (two small Grok calls).
 *
 * Env var: PARALLEL_API_KEY (or via Settings > API Providers, provider 'parallel')
 */

import { getBrand } from '../config/brand';
import { logApiUsage } from './api-usage';
import { getCachedProvider, isProviderExplicitlyDisabled } from './api-provider';
import { blockedDomains } from './source-filter';
import type { ScanUsagePurpose } from '../types/intake';
import { DEFAULT_GROK_MODEL, chatCompletionExtras } from './grok';
import { WIRE_AREA_LIST, WIRE_OUT_LIST } from '../types/wire-area';

const PARALLEL_BASE_URL = 'https://api.parallel.ai';

interface ParallelSearchResult {
  url: string;
  title: string | null;
  publish_date: string | null;
  excerpts: string[];
}

interface ParallelSearchResponse {
  search_id: string;
  results: ParallelSearchResult[];
  session_id: string;
  warnings?: unknown[] | null;
}

// --- Grok helper (query planning + extraction) ---

async function grokChat(prompt: string, maxTokens: number, purpose: string, wire?: string): Promise<string | null> {
  const provider = getCachedProvider('grok');
  const apiKey = provider?.api_key;
  const baseUrl = provider?.base_url || 'https://api.x.ai/v1';
  const model = provider?.default_model || DEFAULT_GROK_MODEL;
  if (!apiKey) return null;

  const start = Date.now();
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(120_000),
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature: 0.1, ...chatCompletionExtras(baseUrl) }),
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      logApiUsage({ provider: 'grok', model, purpose, wire, duration_ms: Date.now() - start, success: false, error_message: `${response.status} ${errorText.slice(0, 200)}`.trim() });
      return null;
    }
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    logApiUsage({ provider: 'grok', model, purpose, wire, duration_ms: Date.now() - start, tokens_in: data.usage?.prompt_tokens, tokens_out: data.usage?.completion_tokens });
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Extract operator-supplied queries from the prompt. Parallel's value is
 * precise search, and Grok-planned queries are non-deterministic (one run
 * surfaces primary sources, the next surfaces directories). A prompt line of
 * the form `Search queries: a | b | c` pins the queries deterministically.
 * Returns null when no explicit queries are present (→ fall back to Grok).
 */
function extractExplicitQueries(promptText: string): string[] | null {
  const m = promptText.match(/search[_ ]?queries:\s*(.+?)(?:\n\n|$)/is);
  if (!m) return null;
  const queries = m[1].split(/\s*\|\s*|\s*;\s*|\n/).map(q => q.trim()).filter(q => q.length >= 3).slice(0, 5);
  return queries.length > 0 ? queries : null;
}

export function parallelAreaGuide(): string {
  return `Wire areas: ${WIRE_AREA_LIST}. OUT (skip): ${WIRE_OUT_LIST}.`;
}

/** Plan 2-3 short keyword queries (3-6 words each) for the Parallel search. */
async function planQueries(objective: string, wire?: string, usagePurpose: ScanUsagePurpose = 'scan'): Promise<string[]> {
  const wireHint = wire ? `The vertical is "${wire}". ` : '';
  const content = await grokChat(
    `${wireHint}${parallelAreaGuide()} Turn this research objective into 2-3 concise web search queries (3-6 keywords each) that will surface items in areas 1-6: open calls, award and round results, governance or treasury decisions that move capital, incentives, funding-mechanism analysis, and grant tools. Return ONLY a JSON array of strings, nothing else.\n\nObjective: ${objective.slice(0, 1200)}`,
    2000, usagePurpose === 'scan-test' ? 'parallel-test-queries' : 'parallel-queries', wire
  );
  if (content) {
    try {
      const cleaned = content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
      const arr = JSON.parse(cleaned);
      if (Array.isArray(arr)) {
        const queries = arr.filter((q): q is string => typeof q === 'string' && q.trim().length > 0).slice(0, 3);
        if (queries.length > 0) return queries;
      }
    } catch { /* fall through to heuristic */ }
  }
  // Heuristic fallback — keeps the scan working if query planning fails
  const base = wire ? `${wire} ` : '';
  return [`${base}grant programs open applications 2026`, `${base}grant award recipients round results`];
}

export async function executeParallelScan(
  promptText: string,
  options?: { model?: string; responseFormat?: string | null; outputFormat?: 'text' | 'json'; wire?: string; afterDate?: string; usagePurpose?: ScanUsagePurpose; filterSeenUrls?: (urls: string[]) => Promise<Set<string>> }
): Promise<{ content: string; model: string; tokensUsed?: number }> {
  const provider = getCachedProvider('parallel');
  const apiKey = provider?.api_key;
  if (!apiKey) {
    throw new Error(isProviderExplicitlyDisabled('parallel')
      ? 'Parallel provider is disabled'
      : 'Parallel API key not configured — add it via Settings > API Providers or set PARALLEL_API_KEY');
  }
  if (!getCachedProvider('grok')?.api_key) {
    throw new Error(isProviderExplicitlyDisabled('grok')
      ? 'Grok provider is disabled; Parallel extraction cannot run'
      : 'Grok API key not configured; Parallel extraction cannot run');
  }
  const baseUrl = provider?.base_url || PARALLEL_BASE_URL;
  const wire = options?.wire;
  const usagePurpose = options?.usagePurpose || 'scan';

  // 1. Queries — operator-supplied (deterministic) or Grok-planned (fallback)
  const searchQueries = extractExplicitQueries(promptText) || await planQueries(promptText, wire, usagePurpose);

  // 2. Retrieve (Parallel)
  const today = new Date().toISOString().split('T')[0];
  const searchStart = Date.now();
  const searchResp = await fetch(`${baseUrl}/v1/search`, {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      objective: `Today is ${today}. ${promptText.slice(0, 1200)}`,
      search_queries: searchQueries,
      mode: 'advanced',
      // Tune excerpts for the Grok extractor + cap total tokens for cost.
      client_model: 'grok-4',
      max_chars_total: 30000,
      advanced_settings: {
        max_results: 15,
        excerpt_settings: { max_chars_per_result: 1500 },
        // Block known aggregators at the API; on discovery prompts, the caller passes
        // afterDate so stale/expired pages are filtered server-side before Grok sees them.
        source_policy: {
          exclude_domains: blockedDomains(),
          ...(options?.afterDate ? { after_date: options.afterDate } : {}),
        },
      },
    }),
  });

  if (!searchResp.ok) {
    const errorText = await searchResp.text();
    logApiUsage({ provider: 'parallel', model: 'search', purpose: usagePurpose, wire, duration_ms: Date.now() - searchStart, success: false, error_message: `${searchResp.status} ${errorText.slice(0, 200)}`.trim() });
    throw new Error(`Parallel Search API error: ${searchResp.status} - ${errorText}`);
  }

  const searchData = await searchResp.json() as ParallelSearchResponse;
  logApiUsage({ provider: 'parallel', model: 'search', purpose: usagePurpose, wire, duration_ms: Date.now() - searchStart, success: true });

  let results = searchData.results || [];

  // Early dedup: the lane re-searches a rolling window daily, so most results are
  // already ingested. Dropping them here saves the Grok extraction AND the
  // downstream classify — downstream dedup remains the backstop for the rest.
  if (options?.filterSeenUrls && results.length > 0) {
    try {
      const seen = await options.filterSeenUrls(results.map(r => r.url));
      const before = results.length;
      results = results.filter(r => !seen.has(r.url));
      if (before !== results.length) {
        console.log(`[Parallel] early-dedup: ${before - results.length} of ${before} results already seen; ${results.length} to extraction`);
      }
    } catch (err) {
      // Never let the dedup lookup break a scan — fall through with the full set.
      console.warn('[Parallel] early-dedup lookup failed, proceeding unfiltered:', err instanceof Error ? err.message : err);
    }
  }

  if (results.length === 0) {
    return { content: '', model: 'parallel-search' };
  }

  // 3. Extract structured entries (Grok)
  const resultsBlock = results.map((r, i) =>
    `[${i + 1}] ${r.title || r.url}\nURL: ${r.url}\nPublished: ${r.publish_date || 'unknown'}\n${(r.excerpts || []).join('\n').slice(0, 1500)}`
  ).join('\n\n');

  const format = options?.responseFormat ||
    `1. **Program Name** — Description including funding amount and who runs it\nDeadline: [date, "Rolling", or "None listed"]\nPublished: [date]\nSource URL: [direct canonical link from the results above]`;

  const extractPrompt = `You are extracting wire items from web search results. ${parallelAreaGuide()} From the results below, list every distinct item in areas 1-6. Use ONLY the canonical Source URL shown for each result — never invent URLs. Skip duplicates, the OUT list, and pure marketing. Closed programs stay skipped when they would be area 3, but their result announcements are area 2 and should be included. If nothing qualifies, return "No results."\n\nFormat each entry exactly:\n${format}\n\nSEARCH RESULTS:\n${resultsBlock}`;

  const extracted = await grokChat(
    extractPrompt,
    6000,
    usagePurpose === 'scan-test' ? 'parallel-test-extract' : 'parallel-extract',
    wire,
  );
  if (!extracted) {
    throw new Error('Parallel scan: Grok extraction returned empty');
  }

  return { content: extracted, model: 'parallel-search+grok' };
}
