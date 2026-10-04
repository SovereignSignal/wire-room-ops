import { getBrand } from '../config/brand';
import { FACTS_ONLY_SUMMARY_RULES, isSummarySkip } from '../types/wire-area';
import { DatabaseEntry } from '../types';
import type { ScanUsagePurpose, ToolType } from '../types/intake';
import { logApiUsage } from './api-usage';
import { getCachedProvider, isProviderExplicitlyDisabled } from './api-provider';
import { fetchThreadContext, type ThreadContext } from './x-thread';
import { getPool } from '../db';

export function buildGrokPrompt(): string {
  const brand = getBrand();
  return `You have access to X.com posts. Access and summarize this X.com/Twitter post for the ${brand.name} newsletter.

URL: {url}

Reference summary (may be outdated): {existing_summary}

Write a newsletter entry that is INFORMATIVE yet CONCISE. Format:

**[Organization/Project Name]** [the funder's own verb] [who, what, amount, and dates exactly as written].

REQUIREMENTS:
- 3-5 sentences, roughly 75-150 words
- ${FACTS_ONLY_SUMMARY_RULES}
- No bullet points - write in flowing paragraphs
- No flowery language, but DO include substantive details
- Do not use: crucial, significantly, innovative, exciting, revolutionary, game-changing, foster, comprehensive

GOOD EXAMPLE:
**Example Foundation** awarded $50,000 to Northwind on March 4, 2026. The foundation's post states the amount as $50,000 and the date as March 4, 2026.

BAD EXAMPLE (too vague, and it invents a total):
**Optimism** released a grants report showing positive results. Several projects received funding and the round totaled far more than any single award. More details available in the post.`;
}

export function buildAggregatorThreadPrompt(input: {
  authorHandle: string;
  authorName: string;
  tweetCount: number;
  url: string;
  existingSummary: string;
  fullThreadText: string;
}): string {
  const brand = getBrand();
  return `You have access to X.com posts. This is an AGGREGATOR THREAD by @${input.authorHandle} (${input.authorName}) containing ${input.tweetCount} tweets.

Original URL: ${input.url}
Reference summary (may be outdated): ${input.existingSummary}

FULL THREAD TEXT:
${input.fullThreadText}

IMPORTANT: This thread lists MULTIPLE programs/opportunities. Summarize ALL of them, not just the first one.

Write a newsletter entry for the ${brand.name} newsletter that covers ALL programs mentioned in the thread.

REQUIREMENTS:
- Lead with who posted and how many items, only if the thread states that count
- List each program with the facts the thread states (who, what, amount, dates, link)
- 4-8 sentences, roughly 100-250 words (longer than usual because multiple items)
- Plain prose, flowing paragraphs, no bullet points
- ${FACTS_ONLY_SUMMARY_RULES}
- Do not use: crucial, significantly, innovative, exciting, revolutionary, game-changing, foster, comprehensive

Write ONLY the finished newsletter entry, or the single word SKIP.`;
}

interface GrokResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

// Last-resort chat model when the grok provider row has no default_model.
// The DB row is authoritative (it has pointed the slot at glm-5.2 on
// ollama.com since 2026-07-11); this literal exists so a blank row fails on a
// named model instead of an empty string. One definition — the six callers
// that used to carry their own copy import this.
export const DEFAULT_GROK_MODEL = 'grok-4.20-beta-0309-non-reasoning';
const DEFAULT_GROK_BASE_URL = 'https://api.x.ai/v1';

function requireGrokProvider() {
  const provider = getCachedProvider('grok');
  if (!provider?.api_key) {
    throw new Error(isProviderExplicitlyDisabled('grok')
      ? 'Grok provider is disabled'
      : 'Grok API key not configured');
  }
  return provider;
}

/**
 * Extra chat-completion parameters for JSON-only callers, keyed by the provider
 * slot's base URL. Ollama Cloud serves reasoning models (glm-5.2) that otherwise
 * spend the whole max_tokens budget thinking and return truncated or empty
 * content; reasoning_effort:"none" is honoured there and cuts output tokens
 * roughly 8x. xAI rejects the parameter on non-reasoning models, so it is only
 * sent to ollama.com.
 */
export function chatCompletionExtras(baseUrl: string | undefined): Record<string, unknown> {
  try {
    const host = new URL(baseUrl ?? '').hostname.toLowerCase();
    if (host === 'ollama.com' || host.endsWith('.ollama.com')) return { reasoning_effort: 'none' };
  } catch { /* not a URL: send nothing extra */ }
  return {};
}

export async function summarizeWithGrok(entry: DatabaseEntry, model?: string): Promise<string> {
  // Fetch thread context for X.com URLs
  let threadContext: ThreadContext | null = null;
  if (isXcomUrl(entry.url)) {
    threadContext = await fetchThreadContext(entry.url);
  }

  // Store thread metadata on the entry if thread detected
  if (threadContext?.isThread) {
    try {
      const pool = getPool();
      await pool.query(
        `UPDATE scan_entries SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE source_url = $2`,
        [JSON.stringify({ thread_context: { authorHandle: threadContext.authorHandle, tweetCount: threadContext.tweetCount } }), entry.url]
      );
    } catch (metaErr) {
      console.warn(`[Grok] Failed to store thread metadata for ${entry.url}:`, metaErr);
    }
  }

  let prompt: string;
  if (threadContext?.isThread) {
    prompt = buildAggregatorThreadPrompt({
      authorHandle: threadContext.authorHandle,
      authorName: threadContext.authorName,
      tweetCount: threadContext.tweetCount,
      url: entry.url,
      existingSummary: entry.quick_summary,
      fullThreadText: threadContext.fullThreadText,
    });
  } else {
    prompt = buildGrokPrompt()
      .replace('{existing_summary}', entry.quick_summary)
      .replace('{url}', entry.url);
  }

  const provider = requireGrokProvider();
  const apiKey = provider.api_key;
  const baseUrl = provider.base_url || DEFAULT_GROK_BASE_URL;
  const useModel = model || provider.default_model || DEFAULT_GROK_MODEL;
  const start = Date.now();

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: useModel,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      max_tokens: 2000,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logApiUsage({ provider: 'grok', model: useModel, purpose: 'summarize', duration_ms: Date.now() - start, success: false, error_message: `${response.status} ${errorText.slice(0, 200)}`.trim() });
    throw new Error(`Grok API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as GrokResponse & { usage?: { prompt_tokens?: number; completion_tokens?: number } };

  if (!data.choices?.[0]?.message?.content) {
    throw new Error('Grok API returned empty response');
  }

  logApiUsage({
    provider: 'grok', model: useModel, purpose: 'summarize', duration_ms: Date.now() - start,
    tokens_in: data.usage?.prompt_tokens, tokens_out: data.usage?.completion_tokens,
  });

  const text = data.choices[0].message.content.trim();
  return isSummarySkip(text) ? 'SKIP' : text;
}

// Default model for scan prompts — uses Responses API with x_search/web_search.
// Chat defaults (the grok provider row) stay separate; search lanes must pin a
// Grok model or xAI rejects the tool. GROK_SEARCH_MODEL overrides this default.
// grok-4.7 is the current flagship id on https://docs.x.ai/developers/models
// and is accepted with x_search / web_search.
export const DEFAULT_GROK_SEARCH_MODEL = 'grok-4.7';

export function grokSearchModel(): string {
  const override = (process.env.GROK_SEARCH_MODEL || '').trim();
  if (override && supportsGrokSearchTools(override)) return override;
  return DEFAULT_GROK_SEARCH_MODEL;
}

/** Code default. grokSearchModel() applies GROK_SEARCH_MODEL when set. */
export const GROK_SEARCH_MODEL = DEFAULT_GROK_SEARCH_MODEL;

// Response format for the /v1/responses endpoint
interface ResponsesAPIOutput {
  type: string;
  id?: string;
  role?: string;
  content?: Array<{ type: string; text?: string }>;
}

interface ResponsesAPIResponse {
  id: string;
  output: ResponsesAPIOutput[];
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}

export function supportsGrokSearchTools(model: string): boolean {
  return /^grok(?:[-_.]|$)/i.test(model.trim());
}

/**
 * Use the provider default only when it can call x_search/web_search.
 * Otherwise fall back so CRM enrichment does not inherit a cheap chat model.
 */
export function resolveGrokSearchModel(
  providerDefault?: string | null,
  fallback: string = grokSearchModel(),
): string {
  const candidate = (providerDefault || '').trim();
  if (candidate && supportsGrokSearchTools(candidate)) return candidate;
  return fallback;
}

export async function executeScanPrompt(
  promptText: string,
  options?: { model?: string; responseFormat?: string | null; toolType?: ToolType; usagePurpose?: ScanUsagePurpose }
): Promise<{ content: string; model: string; tokensUsed?: number }> {
  const provider = requireGrokProvider();
  const model = options?.model || provider.default_model || grokSearchModel();
  const usagePurpose = options?.usagePurpose || 'scan';

  if (!supportsGrokSearchTools(model)) {
    throw new Error(
      `x_search/web_search requires an xAI Grok model; the configured model is "${model}". Use Parallel or Perplexity.`
    );
  }

  // Inject today's date so the model has temporal context for recency filtering
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  let fullPrompt = `Today's date is ${today}.\n\n${promptText}`;
  if (options?.responseFormat) {
    fullPrompt += `\n\nRespond using this format:\n${options.responseFormat}`;
  }

  const apiKey = provider.api_key;
  const baseUrl = (provider.base_url || DEFAULT_GROK_BASE_URL).replace(/\/v1$/, '');
  const start = Date.now();

  // Use the Responses API with x_search tool for real-time X.com scanning
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    signal: AbortSignal.timeout(300_000),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: [{ role: 'user', content: fullPrompt }],
      tools: [{ type: options?.toolType || 'x_search' }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logApiUsage({ provider: 'grok', model, purpose: usagePurpose, duration_ms: Date.now() - start, success: false, error_message: `${response.status} ${errorText.slice(0, 200)}`.trim() });
    throw new Error(`Grok API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as ResponsesAPIResponse;

  // Extract text from the Responses API output
  let textContent = '';
  for (const item of data.output || []) {
    if (item.type === 'message' && item.content) {
      for (const block of item.content) {
        if (block.type === 'output_text' && block.text) {
          textContent += block.text;
        }
      }
    }
  }

  if (!textContent) {
    logApiUsage({
      provider: 'grok', model, purpose: usagePurpose, duration_ms: Date.now() - start,
      tokens_in: data.usage?.input_tokens, tokens_out: data.usage?.output_tokens,
      success: false, error_message: 'Grok Responses API returned empty text content',
    });
    throw new Error('Grok Responses API returned empty text content');
  }

  const totalTokens = data.usage
    ? (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0)
    : undefined;

  logApiUsage({
    provider: 'grok', model, purpose: usagePurpose, duration_ms: Date.now() - start,
    tokens_in: data.usage?.input_tokens, tokens_out: data.usage?.output_tokens,
  });

  return {
    content: textContent.trim(),
    model,
    tokensUsed: totalTokens,
  };
}

export function isXcomUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === 'x.com' || hostname === 'twitter.com'
      || hostname.endsWith('.x.com') || hostname.endsWith('.twitter.com');
  } catch {
    return false;
  }
}
