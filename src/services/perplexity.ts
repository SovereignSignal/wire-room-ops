/**
 * Perplexity API service — deep web research scans.
 *
 * Uses sonar-pro for high-quality research queries. Perplexity natively searches
 * the web and returns cited results — no tool configuration needed.
 *
 * Env var: PERPLEXITY_API_KEY
 */

import { config } from '../config';

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
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    throw new Error('PERPLEXITY_API_KEY not set in environment');
  }

  const model = options?.model || DEFAULT_PERPLEXITY_MODEL;

  const response = await fetch(`${PERPLEXITY_BASE_URL}/chat/completions`, {
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
          content: 'You are a research assistant scanning the web for grant funding opportunities. Return only factual, sourced results. For each result include the organization, description, amount if known, deadline if known, and URL.',
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
    throw new Error(`Perplexity API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as PerplexityResponse;

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Perplexity API returned empty response');
  }

  const tokensUsed = data.usage?.total_tokens;

  return {
    content: content.trim(),
    model,
    tokensUsed,
  };
}
