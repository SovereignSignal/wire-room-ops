import { config } from '../config';
import { getBrand } from '../config/brand';
import { DatabaseEntry } from '../types';
import type { ToolType } from '../types/intake';
import { logApiUsage } from './api-usage';
import { getCachedProvider } from './api-provider';
import { fetchThreadContext, type ThreadContext } from './x-thread';
import { getPool } from '../db';

function buildGrokPrompt(): string {
  const brand = getBrand();
  return `You have access to X.com posts. Access and summarize this X.com/Twitter post for the ${brand.name} newsletter.

URL: {url}

Reference summary (may be outdated): {existing_summary}

Write a newsletter entry that is INFORMATIVE yet CONCISE. Format:

**[Organization/Project Name]** [action verb] [what happened with key details]. [Additional context, numbers, or requirements]. [Deadline/application info if available].

REQUIREMENTS:
- 3-5 sentences, roughly 75-150 words
- Lead with a strong action verb (announced, launched, opened, unveiled, allocated, distributed, published, released)
- Include ALL specific numbers: funding amounts, token quantities, number of recipients, ROI metrics, dates
- Include deadlines, eligibility requirements, and how to apply when mentioned
- Provide enough context that a reader understands WHY this matters for ${brand.audience}
- No bullet points - write in flowing paragraphs
- No flowery language, but DO include substantive details
- Do not use: crucial, significantly, innovative, exciting, revolutionary, game-changing, foster, comprehensive

GOOD EXAMPLE:
**Optimism Grants Council** published its Season 8 impact analysis, reporting that 1.8M OP distributed to 12 projects generated $3.0M in attribution-adjusted TVL uplift with an ROI of $1.7 per OP token over a 56-day observation period. The full program approved 6.3M OP (~$2.2M) to 23 projects, with recipients mobilizing $1.6M in co-incentives. Top performers include Truemarkets ($4.8/OP ROI), Morpho (+$11.5M TVL), and PancakeSwap (+$6.9M TVL with $1.1M CAKE co-incentives).

BAD EXAMPLE (too vague):
**Optimism** released a grants report showing positive results. Several projects received funding and showed growth. More details available in the post.`;
}

interface GrokResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

// Default model if none specified - grok-4.20 non-reasoning: ~2x faster than grok-4.1, same quality
const DEFAULT_GROK_MODEL = 'grok-4.20-beta-0309-non-reasoning';

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
    const brand = getBrand();
    prompt = `You have access to X.com posts. This is an AGGREGATOR THREAD by @${threadContext.authorHandle} (${threadContext.authorName}) containing ${threadContext.tweetCount} tweets.

Original URL: ${entry.url}
Reference summary (may be outdated): ${entry.quick_summary}

FULL THREAD TEXT:
${threadContext.fullThreadText}

IMPORTANT: This thread lists MULTIPLE programs/opportunities. Summarize ALL of them, not just the first one.

Write a newsletter entry for the ${brand.name} newsletter that covers ALL programs mentioned in the thread.

REQUIREMENTS:
- Lead with the aggregator context: who posted and how many items
- List each program/opportunity with its key details (amounts, deadlines, eligibility)
- 4-8 sentences, roughly 100-250 words (longer than usual because multiple items)
- Plain prose, flowing paragraphs, no bullet points
- Include ALL specific numbers: funding amounts, token quantities, dates
- Do not use: crucial, significantly, innovative, exciting, revolutionary, game-changing, foster, comprehensive`;
  } else {
    prompt = buildGrokPrompt()
      .replace('{existing_summary}', entry.quick_summary)
      .replace('{url}', entry.url);
  }

  const provider = getCachedProvider('grok');
  const apiKey = provider?.api_key || config.apis.grok.apiKey;
  const baseUrl = provider?.base_url || config.apis.grok.baseUrl;
  const useModel = model || provider?.default_model || DEFAULT_GROK_MODEL;
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
      max_tokens: 500,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logApiUsage({ provider: 'grok', model: useModel, purpose: 'summarize', duration_ms: Date.now() - start, success: false, error_message: `${response.status}` });
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

  return data.choices[0].message.content.trim();
}

// Default model for scan prompts — uses Responses API with x_search tool
const DEFAULT_SCAN_MODEL = 'grok-4.20-beta-0309-non-reasoning';

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

export async function executeScanPrompt(
  promptText: string,
  options?: { model?: string; responseFormat?: string | null; toolType?: ToolType }
): Promise<{ content: string; model: string; tokensUsed?: number }> {
  const provider = getCachedProvider('grok');
  const model = options?.model || provider?.default_model || DEFAULT_SCAN_MODEL;

  // Inject today's date so the model has temporal context for recency filtering
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  let fullPrompt = `Today's date is ${today}.\n\n${promptText}`;
  if (options?.responseFormat) {
    fullPrompt += `\n\nRespond using this format:\n${options.responseFormat}`;
  }

  const apiKey = provider?.api_key || config.apis.grok.apiKey;
  const baseUrl = (provider?.base_url || config.apis.grok.baseUrl).replace(/\/v1$/, '');
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
    logApiUsage({ provider: 'grok', model, purpose: 'scan', duration_ms: Date.now() - start, success: false, error_message: `${response.status}` });
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
    throw new Error('Grok Responses API returned empty text content');
  }

  const totalTokens = data.usage
    ? (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0)
    : undefined;

  logApiUsage({
    provider: 'grok', model, purpose: 'scan', duration_ms: Date.now() - start,
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
