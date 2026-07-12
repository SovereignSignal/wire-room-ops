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
import { isXcomUrl } from './grok';
import { ollamaAutoSummarize } from './ollama';

const DEFAULT_GROK_MODEL = 'grok-4.20-beta-0309-non-reasoning';
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

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const summary = data.choices?.[0]?.message?.content?.trim();
  return summary && summary.length >= 20 ? summary : null;
}

export async function autoSummarizeOnApprove(
  entryId: number,
  summaryId: number | null,
  name: string,
  description: string,
  amount: string | null,
  deadline: string | null,
  sourceUrl: string | null,
  wire?: string
): Promise<void> {
  try {
    const cleanDesc = cleanText(description);
    const cleanName = cleanText(name);
    const preference = config.summarize.provider; // 'auto' | 'ollama' | 'grok'

    const opts: SummarizeOpts = { name: cleanName, description: cleanDesc, amount, deadline, sourceUrl, wire };
    let summary: string | null = null;
    let usedProvider = 'unknown';

    // Fetch thread context for X.com URLs (used by Grok path)
    let threadContext: ThreadContext | null = null;
    if (sourceUrl && isXcomUrl(sourceUrl)) {
      threadContext = await fetchThreadContext(sourceUrl);
    }

    if (preference === 'ollama') {
      summary = await ollamaAutoSummarize(opts);
      usedProvider = 'ollama';
      if (!summary) {
        console.warn(`[AutoSummarize] Ollama failed for entry ${entryId}, no fallback (SUMMARIZE_PROVIDER=ollama)`);
        return;
      }
    } else if (preference === 'grok') {
      summary = await summarizeViaGrok(opts, threadContext, entryId);
      usedProvider = 'grok';
      if (!summary) {
        console.warn(`[AutoSummarize] Grok failed for entry ${entryId}, no fallback (SUMMARIZE_PROVIDER=grok)`);
        return;
      }
    } else {
      // auto: try Ollama first, fall back to Grok
      summary = await ollamaAutoSummarize(opts);
      usedProvider = 'ollama';
      if (!summary) {
        console.log(`[AutoSummarize] Ollama unavailable for entry ${entryId}, falling back to Grok`);
        summary = await summarizeViaGrok(opts, threadContext, entryId);
        usedProvider = 'grok';
      }
      if (!summary) {
        console.warn(`[AutoSummarize] No provider available for entry ${entryId}`);
        return;
      }
    }

    const pool = getPool();

    // Update scan_entries
    await pool.query(
      `UPDATE scan_entries SET enriched_summary = $1, updated_at = NOW() WHERE id = $2`,
      [summary, entryId]
    );

    // Patch the summaries row if we have its ID
    if (summaryId) {
      await pool.query(
        `UPDATE summaries SET summary = $1 WHERE id = $2`,
        [summary, summaryId]
      ).catch(err => console.warn(`[AutoSummarize] Failed to patch summaries row ${summaryId}:`, err.message));
    }

    console.log(`[AutoSummarize] Generated summary for entry ${entryId} via ${usedProvider} (${summary.length} chars)`);
  } catch (err) {
    console.error(`[AutoSummarize] Failed for entry ${entryId}:`, err);
    // Mark entry so it can be retried
    try {
      const pool = getPool();
      await pool.query(
        `UPDATE scan_entries SET auto_summarize_failed = true WHERE id = $1`,
        [entryId]
      );
    } catch (markErr) {
      console.error(`[AutoSummarize] Failed to mark entry ${entryId} as failed:`, markErr);
    }
  }
}
