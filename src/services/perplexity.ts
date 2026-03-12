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
  options?: { model?: string }
): Promise<{ content: string; model: string; tokensUsed?: number }> {
  const provider = getCachedProvider('perplexity');
  const apiKey = provider?.api_key || process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    throw new Error('PERPLEXITY_API_KEY not set in environment');
  }

  const model = options?.model || DEFAULT_PERPLEXITY_MODEL;
  const baseUrl = provider?.base_url || PERPLEXITY_BASE_URL;
  const start = Date.now();

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: `You are a research assistant scanning the web for ${getBrand().contentType}. Return only factual, sourced results. For each result include the organization, description, amount if known, deadline if known, and URL.`,
        },
        {
          role: 'user',
          content: promptText,
        },
      ],
      max_tokens: 2000,
      temperature: 0.1,
      return_citations: true,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logApiUsage({ provider: 'perplexity', model, purpose: 'scan', duration_ms: Date.now() - start, success: false, error_message: `${response.status}` });
    throw new Error(`Perplexity API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as PerplexityResponse;

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Perplexity API returned empty response');
  }

  logApiUsage({
    provider: 'perplexity', model, purpose: 'scan', duration_ms: Date.now() - start,
    tokens_in: data.usage?.prompt_tokens, tokens_out: data.usage?.completion_tokens,
  });

  const tokensUsed = data.usage?.total_tokens;

  return {
    content: content.trim(),
    model,
    tokensUsed,
  };
}
