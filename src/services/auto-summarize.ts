/**
 * Auto-summarize service — generates newsletter summaries for approved entries
 *
 * Provider priority (controlled by SUMMARIZE_PROVIDER env var):
 *   'ollama' — Ollama Cloud only (fail if unavailable)
 *   'grok'   — Grok only (fail if unavailable)
 *   'auto'   — Try Ollama first, fall back to Grok (default)
 *
 * Thread-aware: For X.com URLs, fetches full thread context to enrich summaries
 * (only applies when Grok is the provider, since it has native X.com access).
 *
 * Called as a fire-and-forget side effect on entry approval.
 */

import { config } from '../config';
import { getPool } from '../db';
import { getCachedProvider } from './api-provider';
import { fetchThreadContext, type ThreadContext } from './x-thread';
import { isXcomUrl, DEFAULT_GROK_MODEL } from './grok';
import { ollamaAutoSummarize } from './ollama';
import { findSummaryLeak } from './summary-guard';

const DEFAULT_GROK_BASE_URL = 'https://api.x.ai/v1';

export function cleanText(s: string): string {
  return s
    .replace(/\[?\[(\d+)\]\]?\([^)]*\)/g, '') // strip [[N]](url) citation refs
    .replace(/```[\w]*\n?/g, '')               // strip code fences
    .replace(/\s{2,}/g, ' ')
    .trim();
}

interface SummarizeOpts {
  name: string;
  description: string;
  amount: string | null;
  deadline: string | null;
  sourceUrl: string | null;
  wire?: string;
}

async function summarizeViaGrok(
  opts: SummarizeOpts,
  threadContext?: ThreadContext | null,
  entryId?: number
): Promise<string | null> {
  const grok = getCachedProvider('grok');
  if (!grok?.api_key) return null;

  const baseUrl = grok.base_url || DEFAULT_GROK_BASE_URL;
  const model = grok.default_model || DEFAULT_GROK_MODEL;
  const wireLabel = opts.wire === 'ai' ? 'AI funding' : opts.wire === 'oss' ? 'open-source funding' : 'crypto grants';

  let prompt: string;
  if (threadContext?.isThread) {
    prompt = `You are writing an opportunity summary for a ${wireLabel} newsletter.

This entry comes from an AGGREGATOR THREAD by @${threadContext.authorHandle} (${threadContext.authorName}) containing ${threadContext.tweetCount} tweets.

Grant name: ${opts.name}
${opts.amount ? `Amount: ${opts.amount}` : ''}
${opts.deadline ? `Deadline: ${opts.deadline}` : ''}
${opts.sourceUrl ? `Source: ${opts.sourceUrl}` : ''}

FULL THREAD TEXT:
${threadContext.fullThreadText}

Original description: ${opts.description}

IMPORTANT: This thread lists MULTIPLE programs/opportunities. Summarize ALL of them.
Write a 4-8 sentence newsletter summary covering all programs. Lead with the aggregator context. Include all specific numbers. Plain prose, no bullet points, no fluff. Max 250 words.`;

    // Store thread metadata on the entry
    if (entryId) {
      try {
        const pool = getPool();
        await pool.query(
          `UPDATE scan_entries SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
          [JSON.stringify({ thread_context: { authorHandle: threadContext.authorHandle, tweetCount: threadContext.tweetCount } }), entryId]
        );
      } catch (metaErr) {
        console.warn(`[AutoSummarize] Failed to store thread metadata for entry ${entryId}:`, metaErr);
      }
    }
  } else {
    prompt = `You are writing a concise opportunity summary for a ${wireLabel} newsletter.

Grant name: ${opts.name}
${opts.amount ? `Amount: ${opts.amount}` : ''}
${opts.deadline ? `Deadline: ${opts.deadline}` : ''}
${opts.sourceUrl && opts.sourceUrl.startsWith('http') ? `Source: ${opts.sourceUrl}` : ''}
Description: ${opts.description}

Write a 2-4 sentence newsletter summary. Lead with the organization/program name and a strong action verb. Include all specific numbers (amounts, dates, eligibility requirements). Plain prose, no bullet points, no fluff, no hype words. Max 120 words.`;
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${grok.api_key}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: threadContext?.isThread ? 2000 : 1200,
      temperature: 0.3,
    }),
  });

  if (!response.ok) return null;

  const data = await response.json() as {
    choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
  };
  const choice = data.choices?.[0];
  // A length stop means the answer was cut off (or never started after reasoning).
  if (choice?.finish_reason === 'length') return null;
  const summary = choice?.message?.content?.trim();
  return summary && summary.length >= 20 ? summary : null;
}

export type SummaryProvider = 'ollama' | 'grok';

export interface SummaryAttempt {
  provider: SummaryProvider;
  outcome: 'ok' | 'empty' | 'rejected' | 'error';
  detail?: string;
}

export interface SummaryResult {
  summary: string | null;
  provider: SummaryProvider | null;
  attempts: SummaryAttempt[];
}

export interface SummaryInput {
  entryId?: number;
  name: string;
  description: string;
  amount: string | null;
  deadline: string | null;
  sourceUrl: string | null;
  wire?: string;
}

/**
 * Provider order for one summary. Each provider gets a second try when it is
 * the only one available, so a single rejected output is retried once.
 */
export function planSummaryAttempts(
  preference: string,
  available: Record<SummaryProvider, boolean>,
): SummaryProvider[] {
  const order: SummaryProvider[] = preference === 'ollama' ? ['ollama']
    : preference === 'grok' ? ['grok']
      : ['ollama', 'grok'];
  const usable = order.filter(provider => available[provider]);
  return usable.length === 1 ? [usable[0], usable[0]] : usable;
}

/**
 * Generate a summary and accept it only if it reads as a finished summary.
 * Never persists anything; callers decide where the result goes.
 */
export async function generateValidatedSummary(
  input: SummaryInput,
  deps: {
    ollama?: typeof ollamaAutoSummarize;
    grok?: typeof summarizeViaGrok;
    available?: Record<SummaryProvider, boolean>;
    preference?: string;
  } = {},
): Promise<SummaryResult> {
  const opts: SummarizeOpts = {
    name: cleanText(input.name),
    description: cleanText(input.description),
    amount: input.amount,
    deadline: input.deadline,
    sourceUrl: input.sourceUrl,
    wire: input.wire,
  };
  const available = deps.available ?? {
    ollama: !!getCachedProvider('ollama')?.api_key,
    grok: !!getCachedProvider('grok')?.api_key,
  };
  const plan = planSummaryAttempts(deps.preference ?? config.summarize.provider, available);
  const callOllama = deps.ollama ?? ollamaAutoSummarize;
  const callGrok = deps.grok ?? summarizeViaGrok;

  const attempts: SummaryAttempt[] = [];
  let threadContext: ThreadContext | null | undefined;

  for (const provider of plan) {
    let text: string | null;
    try {
      if (provider === 'ollama') {
        text = await callOllama(opts);
      } else {
        if (threadContext === undefined) {
          threadContext = input.sourceUrl && isXcomUrl(input.sourceUrl)
            ? await fetchThreadContext(input.sourceUrl)
            : null;
        }
        text = await callGrok(opts, threadContext, input.entryId);
      }
    } catch (err) {
      attempts.push({ provider, outcome: 'error', detail: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const trimmed = (text || '').trim();
    if (trimmed.length < 20) {
      attempts.push({ provider, outcome: 'empty' });
      continue;
    }
    const leak = findSummaryLeak(trimmed);
    if (leak) {
      attempts.push({ provider, outcome: 'rejected', detail: `${leak.rule}: ${leak.excerpt}` });
      continue;
    }
    attempts.push({ provider, outcome: 'ok' });
    return { summary: trimmed, provider, attempts };
  }

  return { summary: null, provider: null, attempts };
}

function describeAttempts(attempts: SummaryAttempt[]): string {
  return attempts.map(a => `${a.provider}=${a.outcome}${a.detail ? ` (${a.detail.slice(0, 120)})` : ''}`).join(', ');
}

/** Returns true when a validated summary was stored. */
export async function autoSummarizeOnApprove(
  entryId: number,
  summaryId: number | null,
  name: string,
  description: string,
  amount: string | null,
  deadline: string | null,
  sourceUrl: string | null,
  wire?: string
): Promise<boolean> {
  try {
    const result = await generateValidatedSummary({
      entryId, name, description, amount, deadline, sourceUrl, wire,
    });
    const pool = getPool();

    if (!result.summary) {
      if (result.attempts.length === 0) {
        console.warn(`[AutoSummarize] No summarize provider configured for entry ${entryId}`);
        return false;
      }
      console.warn(`[AutoSummarize] No usable summary for entry ${entryId}: ${describeAttempts(result.attempts)}`);
      await pool.query(`UPDATE scan_entries SET auto_summarize_failed = true WHERE id = $1`, [entryId]);
      return false;
    }

    await pool.query(
      `UPDATE scan_entries
       SET enriched_summary = $1, auto_summarize_failed = false, updated_at = NOW()
       WHERE id = $2`,
      [result.summary, entryId]
    );

    if (summaryId) {
      await pool.query(
        `UPDATE summaries SET summary = $1 WHERE id = $2`,
        [result.summary, summaryId]
      ).catch(err => console.warn(`[AutoSummarize] Failed to patch summaries row ${summaryId}:`, err.message));
    }

    console.log(`[AutoSummarize] Generated summary for entry ${entryId} via ${result.provider} (${result.summary.length} chars)`);
    return true;
  } catch (err) {
    console.error(`[AutoSummarize] Failed for entry ${entryId}:`, err);
    try {
      const pool = getPool();
      await pool.query(
        `UPDATE scan_entries SET auto_summarize_failed = true WHERE id = $1`,
        [entryId]
      );
    } catch (markErr) {
      console.error(`[AutoSummarize] Failed to mark entry ${entryId} as failed:`, markErr);
    }
    return false;
  }
}
