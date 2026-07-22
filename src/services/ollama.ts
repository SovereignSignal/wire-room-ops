/**
 * Ollama Cloud API — summarization via /api/chat endpoint.
 *
 * Uses Ollama Cloud's native chat API (not OpenAI-compatible).
 * Default model: kimi-k2.5:cloud (cost-effective alternative to Grok for summaries).
 */

import { getBrand } from '../config/brand';
import { DatabaseEntry } from '../types';
import { logApiUsage } from './api-usage';
import { getCachedProvider } from './api-provider';

const DEFAULT_OLLAMA_MODEL = 'gpt-oss:120b';
const DEFAULT_OLLAMA_BASE_URL = 'https://ollama.com/api';

interface OllamaChatResponse {
  model: string;
  message: {
    role: string;
    content: string;
    thinking?: string;
  };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}

function buildSummarizePrompt(): string {
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
- Do not use: crucial, significantly, innovative, exciting, revolutionary, game-changing, foster, comprehensive`;
}

export async function summarizeWithOllama(entry: DatabaseEntry, model?: string): Promise<string> {
  const prompt = buildSummarizePrompt()
    .replace('{existing_summary}', entry.quick_summary)
    .replace('{url}', entry.url);

  const provider = getCachedProvider('ollama');
  const apiKey = provider?.api_key;
  const baseUrl = provider?.base_url || DEFAULT_OLLAMA_BASE_URL;
  const useModel = model || provider?.default_model || DEFAULT_OLLAMA_MODEL;
  const start = Date.now();

  if (!apiKey) {
    throw new Error('Ollama API key not configured');
  }

  const response = await fetch(`${baseUrl}/chat`, {
    method: 'POST',
    signal: AbortSignal.timeout(180_000),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: useModel,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      options: {
        temperature: 0.3,
        num_predict: 500,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logApiUsage({
      provider: 'ollama', model: useModel, purpose: 'summarize',
      duration_ms: Date.now() - start, success: false, error_message: `${response.status} ${errorText.slice(0, 200)}`.trim(),
    });
    throw new Error(`Ollama API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as OllamaChatResponse;

  // Kimi K2.5 puts response in 'thinking' field, not 'content'
  const rawText = data.message?.content || data.message?.thinking || '';
  const summary = rawText.trim();

  if (!summary) {
    throw new Error('Ollama API returned empty response');
  }

  logApiUsage({
    provider: 'ollama', model: useModel, purpose: 'summarize',
    duration_ms: Date.now() - start,
    tokens_in: data.prompt_eval_count,
    tokens_out: data.eval_count,
  });

  return summary;
}

/**
 * Lightweight summarization for auto-summarize-on-approve.
 * Uses the same Ollama chat API but with a shorter prompt focused on newsletter blurbs.
 */
export async function ollamaAutoSummarize(opts: {
  name: string;
  description: string;
  amount: string | null;
  deadline: string | null;
  sourceUrl: string | null;
  wire?: string;
}): Promise<string | null> {
  const provider = getCachedProvider('ollama');
  const apiKey = provider?.api_key;
  const baseUrl = provider?.base_url || DEFAULT_OLLAMA_BASE_URL;
  const useModel = provider?.default_model || DEFAULT_OLLAMA_MODEL;

  if (!apiKey) return null;

  const brand = getBrand();
  const wireLabel = opts.wire === 'ai' ? 'AI funding' : opts.wire === 'oss' ? 'open-source funding' : 'crypto grants';

  const prompt = `You are writing a concise opportunity summary for a ${wireLabel} newsletter (${brand.name}).

Grant name: ${opts.name}
${opts.amount ? `Amount: ${opts.amount}` : ''}
${opts.deadline ? `Deadline: ${opts.deadline}` : ''}
${opts.sourceUrl && opts.sourceUrl.startsWith('http') ? `Source: ${opts.sourceUrl}` : ''}
Description: ${opts.description}

Write ONLY the final newsletter summary below. No thinking, no explanation, no markdown formatting. 2-4 sentences. Lead with the organization/program name and a strong action verb. Include all specific numbers (amounts, dates, eligibility requirements). Plain prose, no bullet points, no fluff, no hype words. Max 120 words.`;

  const start = Date.now();

  const response = await fetch(`${baseUrl}/chat`, {
    method: 'POST',
    signal: AbortSignal.timeout(180_000),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: useModel,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      options: {
        temperature: 0.3,
        num_predict: 200,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    logApiUsage({
      provider: 'ollama', model: useModel, purpose: 'auto-summarize',
      duration_ms: Date.now() - start, success: false, error_message: `${response.status} ${errorText.slice(0, 200)}`.trim(),
    });
    return null;
  }

  const data = await response.json() as OllamaChatResponse;

  // GPT-OSS models output to 'content' but may have 'thinking' too. Use content preferentially.
  const rawText = data.message?.content || data.message?.thinking || '';
  
  // Extract just the summary — look for actual output after thinking
  let summary = rawText.trim();
  
  // If there's a clear separator like "Probably:" or "Make sure it's only", extract after the last such marker
  const markers = ['Probably:', 'Probably', 'Make sure it', 'Provide exactly that'];
  for (const marker of markers) {
    const idx = summary.lastIndexOf(marker);
    if (idx !== -1) {
      const after = summary.slice(idx + marker.length).trim();
      if (after.length > 50) {
        summary = after;
        break;
      }
    }
  }
  
  // Clean up any quotes or extra whitespace
  summary = summary.replace(/^["']|["']$/g, '').trim();

  logApiUsage({
    provider: 'ollama', model: useModel, purpose: 'auto-summarize',
    duration_ms: Date.now() - start,
    tokens_in: data.prompt_eval_count,
    tokens_out: data.eval_count,
  });

  return summary && summary.length >= 20 ? summary : null;
}
