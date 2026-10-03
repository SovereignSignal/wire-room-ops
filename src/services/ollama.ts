/**
 * Ollama Cloud API — summarization via the native /api/chat endpoint
 * (https://ollama.com/api/chat). Not the OpenAI-compatible /v1 route:
 * glm-5.3-flash's reasoning_effort mapping there does not match the native
 * `think` field (ollama/ollama#18121).
 *
 * Summary model order is the env pair, never api_providers.default_model:
 *   OLLAMA_DEFAULT_MODEL, then OLLAMA_FALLBACK_MODEL.
 * A stale dashboard model cannot put summaries back on an old model.
 */

import { config } from '../config';
import { getBrand } from '../config/brand';
import { DatabaseEntry } from '../types';
import { logApiUsage } from './api-usage';
import { getCachedProvider } from './api-provider';
import { findSummaryLeak } from './summary-guard';
import { isScrapableUrl, scrapeUrl, truncateContent, type ScrapeResult } from './scraper';
import {
  finalAnswerText,
  SUMMARY_TOKEN_BUDGET,
  thinkControl,
  type OllamaChatMessage,
} from './ollama-think';

export { finalAnswerText, SUMMARY_TOKEN_BUDGET, thinkControl } from './ollama-think';

const DEFAULT_OLLAMA_BASE_URL = 'https://ollama.com/api';

interface OllamaChatResponse {
  model: string;
  message: OllamaChatMessage;
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}

/** Explicit model, otherwise the env primary. Never the provider row's default_model. */
export function modelForSummary(explicit?: string | null): string {
  const pinned = explicit?.trim();
  if (pinned) return pinned;
  return config.apis.ollama.defaultModel.trim();
}

/**
 * Models to try, in order. An explicit model replaces the chain.
 * Primary then fallback when they differ; otherwise the one configured model.
 */
export function summaryModelChain(explicit?: string | null): string[] {
  const pinned = explicit?.trim();
  if (pinned) return [pinned];
  const primary = config.apis.ollama.defaultModel.trim();
  const fallback = config.apis.ollama.fallbackModel.trim();
  if (primary && fallback && fallback !== primary) return [primary, fallback];
  const only = primary || fallback;
  return only ? [only] : [];
}

export function buildOllamaChatBody(
  model: string,
  prompt: string,
  numPredict = SUMMARY_TOKEN_BUDGET,
  temperature = 0.3,
) {
  return {
    model,
    messages: [{ role: 'user' as const, content: prompt }],
    stream: false as const,
    ...thinkControl(model),
    options: {
      temperature,
      num_predict: numPredict,
    },
  };
}

function ollamaEndpoint(): { apiKey: string; baseUrl: string } {
  const provider = getCachedProvider('ollama');
  const apiKey = provider?.api_key || '';
  const baseUrl = provider?.base_url || DEFAULT_OLLAMA_BASE_URL;
  return { apiKey, baseUrl };
}

async function chat(
  model: string,
  prompt: string,
  purpose: string,
  wire?: string,
  numPredict = SUMMARY_TOKEN_BUDGET,
): Promise<string> {
  const { apiKey, baseUrl } = ollamaEndpoint();
  if (!apiKey) throw new Error('Ollama API key not configured');

  const start = Date.now();
  const response = await fetch(`${baseUrl}/chat`, {
    method: 'POST',
    signal: AbortSignal.timeout(180_000),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(buildOllamaChatBody(model, prompt, numPredict)),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    logApiUsage({
      provider: 'ollama', model, purpose, wire,
      duration_ms: Date.now() - start, success: false,
      error_message: `${response.status} ${errorText.slice(0, 200)}`.trim(),
    });
    throw new Error(`Ollama API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as OllamaChatResponse;
  const text = finalAnswerText(data);
  logApiUsage({
    provider: 'ollama', model, purpose, wire,
    duration_ms: Date.now() - start,
    tokens_in: data.prompt_eval_count,
    tokens_out: data.eval_count,
    ...(text ? {} : { success: false, error_message: `no final answer (done_reason=${data.done_reason ?? 'unknown'})` }),
  });
  if (!text) {
    throw new Error(`Ollama API returned no final answer (done_reason=${data.done_reason ?? 'unknown'})`);
  }
  return text;
}

function buildScrapedContentPrompt(): string {
  const brand = getBrand();
  return `Summarize this web page for the ${brand.name} newsletter.

URL: {url}

Page Content:
{scraped_content}

Reference summary (may be outdated): {existing_summary}

Write a newsletter entry that is INFORMATIVE yet CONCISE. Format:

**[Organization/Project Name]** [action verb] [what happened with key details]. [Additional context, numbers, or requirements]. [Deadline/application info if available].

REQUIREMENTS:
- 3-5 sentences, roughly 75-150 words
- Lead with a strong action verb (announced, launched, opened, unveiled, allocated, distributed, published, released)
- Include ALL specific numbers from the content: funding amounts, token quantities, number of recipients/applicants, ROI metrics, percentages, dates
- Include deadlines, eligibility requirements, and how to apply when mentioned
- Provide enough context that a reader understands the significance for ${brand.audience}
- No bullet points - write in flowing paragraphs
- Exclude: committee member names, lengthy historical background, detailed mechanism explanations
- Do not use: crucial, significantly, innovative, exciting, revolutionary, game-changing, foster, comprehensive

Write ONLY the finished newsletter entry. No thinking, no explanation of the instructions.`;
}

function buildFallbackPrompt(): string {
  const brand = getBrand();
  return `You are writing a newsletter entry for ${brand.name}, covering ${brand.audience}.

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
- Work with the information provided - do not say "unable to access"

Write ONLY the finished newsletter entry. No thinking, no explanation of the instructions.`;
}

export const UNSCRAPED_SUMMARY_NOTE = '*[Summary based on cached data - original source could not be accessed]*';

export interface PreparedNewsletterPrompt {
  prompt: string;
  /** False when Firecrawl did not return page text. The summary is marked missing. */
  scraped: boolean;
}

export function applySummaryScrapeNote(text: string, scraped: boolean): string {
  if (scraped) return text;
  return `${text}\n\n${UNSCRAPED_SUMMARY_NOTE}`;
}

/**
 * One Firecrawl attempt. A failure keeps the entry and marks the summary as
 * coming from cached text — it does not retry the scrape.
 */
export async function prepareNewsletterPrompt(
  entry: DatabaseEntry,
  scrape: (url: string, opts: { attempts?: number; job?: string }) => Promise<ScrapeResult> = scrapeUrl,
): Promise<PreparedNewsletterPrompt> {
  const fallback = {
    scraped: false,
    prompt: buildFallbackPrompt()
      .replace('{url}', entry.url)
      .replace('{existing_summary}', entry.quick_summary),
  };
  if (!isScrapableUrl(entry.url)) {
    console.log(`    Skipping scrape for non-scrapable URL: ${entry.url}`);
    return fallback;
  }
  console.log(`    Scraping ${entry.url}...`);
  try {
    const scrapeResult = await scrape(entry.url, { attempts: 1, job: 'summary' });
    if (scrapeResult.success && scrapeResult.content.trim()) {
      console.log(`    Scraped ${scrapeResult.content.length} chars via firecrawl`);
      return {
        scraped: true,
        prompt: buildScrapedContentPrompt()
          .replace('{url}', entry.url)
          .replace('{scraped_content}', truncateContent(scrapeResult.content))
          .replace('{existing_summary}', entry.quick_summary),
      };
    }
    console.log(`    Scrape failed (${scrapeResult.error || 'empty'}); summary missing, using cached text`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`    Scrape failed (${message}); summary missing, using cached text`);
  }
  return fallback;
}

/**
 * Model chain only. The scrape already happened in prepareNewsletterPrompt,
 * so a model failure must not fetch the page again.
 */
export async function completeNewsletterSummary(
  entry: DatabaseEntry,
  prepared: PreparedNewsletterPrompt,
  model?: string,
): Promise<string> {
  const models = summaryModelChain(model);
  if (models.length === 0) throw new Error('Ollama summary model is not configured');

  let lastError: Error | null = null;
  for (const useModel of models) {
    try {
      const text = await chat(useModel, prepared.prompt, 'summarize', entry.wire);
      const leak = findSummaryLeak(text);
      if (leak) throw new Error(`Ollama API returned reasoning instead of a summary (${leak.rule})`);
      return applySummaryScrapeNote(text, prepared.scraped);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[Ollama] summarize ${useModel} failed:`, lastError.message);
    }
  }
  throw lastError ?? new Error('Ollama summary failed');
}

/**
 * Newsletter summary for one entry. One Firecrawl attempt, then the env
 * primary model, then the fallback model. An explicit `model` replaces that chain.
 */
export async function summarizeWithOllama(entry: DatabaseEntry, model?: string): Promise<string> {
  const prepared = await prepareNewsletterPrompt(entry);
  return completeNewsletterSummary(entry, prepared, model);
}

/**
 * One auto-summarize attempt on a specific model. Returns null when the call
 * fails or the answer is too short. The caller runs the summary guard and
 * decides whether to try the fallback model.
 */
export async function ollamaAutoSummarize(opts: {
  name: string;
  description: string;
  amount: string | null;
  deadline: string | null;
  sourceUrl: string | null;
  wire?: string;
}, model?: string): Promise<string | null> {
  const useModel = modelForSummary(model);
  const brand = getBrand();
  const wireLabel = opts.wire === 'ai' ? 'AI funding' : opts.wire === 'oss' ? 'open-source funding' : 'crypto grants';

  const prompt = `You are writing a concise opportunity summary for a ${wireLabel} newsletter (${brand.name}).

Grant name: ${opts.name}
${opts.amount ? `Amount: ${opts.amount}` : ''}
${opts.deadline ? `Deadline: ${opts.deadline}` : ''}
${opts.sourceUrl && opts.sourceUrl.startsWith('http') ? `Source: ${opts.sourceUrl}` : ''}
Description: ${opts.description}

Write ONLY the final newsletter summary below. No thinking, no explanation, no markdown formatting. 2-4 sentences. Lead with the organization/program name and a strong action verb. Include all specific numbers (amounts, dates, eligibility requirements). Plain prose, no bullet points, no fluff, no hype words. Max 120 words.`;

  try {
    const summary = (await chat(useModel, prompt, 'auto-summarize', opts.wire))
      .replace(/^["']|["']$/g, '')
      .trim();
    return summary.length >= 20 ? summary : null;
  } catch (err) {
    console.warn(`[Ollama] auto-summarize ${useModel} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** One non-summary completion. An explicit model is used alone; otherwise primary then fallback. */
export async function ollamaComplete(params: {
  prompt: string;
  purpose: string;
  model?: string;
  wire?: string;
  numPredict?: number;
}): Promise<{ model: string; text: string }> {
  const models = summaryModelChain(params.model);
  if (models.length === 0) throw new Error('Ollama summary model is not configured');
  let lastError: Error | null = null;
  for (const model of models) {
    try {
      const text = await chat(model, params.prompt, params.purpose, params.wire, params.numPredict);
      return { model, text };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[Ollama] ${params.purpose} ${model} failed:`, lastError.message);
    }
  }
  throw lastError ?? new Error('Ollama request failed');
}
