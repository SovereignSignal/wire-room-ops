/**
 * Perplexity API service — deep web research scans.
 *
 * Uses sonar-pro for high-quality research queries. Perplexity natively searches
 * the web and returns cited results — no tool configuration needed.
 *
 * Env var: PERPLEXITY_API_KEY
 */

import { config } from '../config';
import { getBrand } from '../config/brand';
import { logApiUsage } from './api-usage';
import { getCachedProvider } from './api-provider';
import type { ScanUsagePurpose } from '../types/intake';

const PERPLEXITY_BASE_URL = 'https://api.perplexity.ai';

interface PerplexityResponse {
  id: string;
  model: string;
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

const DEFAULT_PERPLEXITY_MODEL = 'sonar-pro';

export async function executePerplexityScan(
  promptText: string,
  options?: { model?: string; responseFormat?: string | null; outputFormat?: 'text' | 'json'; usagePurpose?: ScanUsagePurpose }
): Promise<{ content: string; model: string; tokensUsed?: number }> {
  const provider = getCachedProvider('perplexity');
  const apiKey = provider?.api_key || process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    throw new Error('Perplexity API key not configured — add it via Settings > API Providers');
  }

  const model = options?.model || provider?.default_model || DEFAULT_PERPLEXITY_MODEL;
  const usagePurpose = options?.usagePurpose || 'scan';
  const baseUrl = provider?.base_url || PERPLEXITY_BASE_URL;
  const start = Date.now();
  const useJson = options?.outputFormat === 'json';

  // Inject today's date for temporal context, append response format
  const today = new Date().toISOString().split('T')[0];
  let fullPrompt = `Today's date is ${today}.\n\n${promptText}`;
  if (!useJson && options?.responseFormat) {
    fullPrompt += `\n\nRespond using this format:\n${options.responseFormat}`;
  }
  if (useJson) {
    fullPrompt += `\n\nReturn results as a JSON object with a "results" array. Each item must have: name (string), description (string), source_url (string), and optionally: deadline (string), published (string), amount (string).`;
  }

  const systemPrompt = useJson
    ? `You are a research assistant scanning the web for ${getBrand().contentType}. Return only factual, sourced results as structured JSON.`
    : `You are a research assistant scanning the web for ${getBrand().contentType}. Return only factual, sourced results.\n\nFor each result, use this format:\n1. **Program Name** — Description including funding amount\nDeadline: [date, "Rolling", or "None listed"]\nSource URL: [URL where you found this]\n\nBold names with **, number results, include URLs. Include both new and currently active programs.`;

  const requestBody: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: fullPrompt },
    ],
    max_tokens: 2000,
    temperature: 0.1,
    return_citations: true,
  };

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(180_000),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logApiUsage({ provider: 'perplexity', model, purpose: usagePurpose, duration_ms: Date.now() - start, success: false, error_message: `${response.status} ${errorText.slice(0, 200)}`.trim() });
    throw new Error(`Perplexity API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as PerplexityResponse;

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    logApiUsage({
      provider: 'perplexity', model, purpose: usagePurpose, duration_ms: Date.now() - start,
      tokens_in: data.usage?.prompt_tokens, tokens_out: data.usage?.completion_tokens,
      success: false, error_message: 'Perplexity API returned empty response',
    });
    throw new Error('Perplexity API returned empty response');
  }

  logApiUsage({
    provider: 'perplexity', model, purpose: usagePurpose, duration_ms: Date.now() - start,
    tokens_in: data.usage?.prompt_tokens, tokens_out: data.usage?.completion_tokens,
  });

  const tokensUsed = data.usage?.total_tokens;

  return {
    content: content.trim(),
    model,
    tokensUsed,
  };
}
