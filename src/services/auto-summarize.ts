/**
 * Auto-summarize service — generates newsletter summaries for approved entries
 *
 * Uses Grok LLM to write concise 2-4 sentence summaries.
 * Called as a fire-and-forget side effect on entry approval.
 */

import { getPool } from '../db';
import { getCachedProvider } from './api-provider';

const DEFAULT_GROK_MODEL = 'grok-4.20-beta-0309-non-reasoning';
const DEFAULT_GROK_BASE_URL = 'https://api.x.ai/v1';

export function cleanText(s: string): string {
  return s
    .replace(/\[?\[(\d+)\]\]?\([^)]*\)/g, '') // strip [[N]](url) citation refs
    .replace(/```[\w]*\n?/g, '')               // strip code fences
    .replace(/\s{2,}/g, ' ')
    .trim();
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
    const grok = getCachedProvider('grok');
    if (!grok?.api_key) {
      console.warn(`[AutoSummarize] No Grok provider configured, skipping entry ${entryId}`);
      return;
    }

    const baseUrl = grok.base_url || DEFAULT_GROK_BASE_URL;
    const apiKey = grok.api_key;
    const model = grok.default_model || DEFAULT_GROK_MODEL;

    const pool = getPool();
    const wireLabel = wire === 'ai' ? 'AI funding' : wire === 'oss' ? 'open-source funding' : 'crypto grants';
    const cleanDesc = cleanText(description);
    const cleanName = cleanText(name);

    const prompt = `You are writing a concise opportunity summary for a ${wireLabel} newsletter.

Grant name: ${cleanName}
${amount ? `Amount: ${amount}` : ''}
${deadline ? `Deadline: ${deadline}` : ''}
${sourceUrl && sourceUrl.startsWith('http') ? `Source: ${sourceUrl}` : ''}
Description: ${cleanDesc}

Write a 2-4 sentence newsletter summary. Lead with the organization/program name and a strong action verb. Include all specific numbers (amounts, dates, eligibility requirements). Plain prose, no bullet points, no fluff, no hype words. Max 120 words.`;

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      console.warn(`[AutoSummarize] Grok returned ${response.status} for entry ${entryId}`);
      return;
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const summary = data.choices?.[0]?.message?.content?.trim();
    if (!summary || summary.length < 20) return;

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

    console.log(`[AutoSummarize] Generated summary for entry ${entryId} (${summary.length} chars)`);
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
