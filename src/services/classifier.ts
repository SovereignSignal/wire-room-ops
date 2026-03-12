/**
 * Gate 2: Grok LLM Classifier
 *
 * Classifies scan entries as GRANT/EXPIRED/NEWS/NOISE using the xAI
 * chat completions API. Labels are additive — nothing is removed or
 * archived by classification.
 */

import { config } from '../config';
import type { Pool } from 'pg';
import { logApiUsage } from './api-usage';
import { getCachedProvider } from './api-provider';

export type Classification = 'GRANT' | 'EXPIRED' | 'NEWS' | 'NOISE' | 'UNCHECKED';

export interface ClassificationResult {
  classification: Classification;
  reason: string;
  qualityScore: number;
  scoreReason: string;
  extracted: {
    amount?: string;
    deadline?: string;
    eligibility?: string;
    summary?: string;
  };
}

const VALID_CLASSIFICATIONS = new Set<Classification>(['GRANT', 'EXPIRED', 'NEWS', 'NOISE']);

function buildClassificationPrompt(entry: {
  name: string;
  description: string;
  source_url: string;
  wire: string;
}): string {
  return `You are an intelligence analyst for a grants and funding intelligence feed. Classify AND score this entry. The entry is currently tagged for the "${entry.wire}" wire but you should verify this is correct — if the content is clearly about a different domain (e.g., an AI grant tagged as crypto), note it in your reason.

Name: ${entry.name}
Description: ${entry.description}
URL: ${entry.source_url}

## Classification
Classify as exactly one of:
- GRANT: Real, currently open funding opportunity someone can apply to right now
- EXPIRED: Was real but deadline has passed or program is closed
- NEWS: Article/announcement about funding, org update, or industry signal — not a direct application
- NOISE: Not relevant (spam, hype/shill content, unrelated, error)

## Quality Score (0-100)
Score based on INFORMATION VALUE to a professional tracking grants, funding, and industry signals.

Scoring philosophy:
- Evaluate the PROGRAM/CONTENT, not the posting account. Many grants are posted by aggregator accounts (@opportunitiesfy, grant newsletters, etc.) — a Google.org $3M grant posted by @opportunitiesfy is still a Google.org $3M grant. Score it on the program's credibility.
- Programs from major orgs (Google, Mozilla, Linux Foundation, Ethereum Foundation, Uniswap, Gitcoin, major universities, government bodies, established DAOs) = inherently high credibility.
- High-quality news from credible orgs can score HIGHER than low-quality grants from unknown projects.
- A $500 hackathon from an unknown project with hype language = low score (15-25).
- A Linux Foundation or Mozilla program update with real substance = high score (60-75) even without a direct application link.
- A well-documented $50K+ grant from an established org with clear eligibility and deadline = highest score (75-95).
- Hype language, promotional shilling, unknown microcap project = score penalty.
- Pure aggregator repost with zero original content (just a link, no details) = low (10-20).
- Vague tweets with just hashtags and no real content = very low (5-15).

Score ranges:
- 80-100: High-value grant/fellowship with full details from credible org (Google, Mozilla, EF, major DAO, university, government)
- 60-79: Strong signal — credible org update or solid grant with some details missing, major program announcement
- 40-59: Moderate — decent source or content but missing key details, or mid-tier org with good info
- 20-39: Low — unknown source, thin content, small or questionable opportunity
- 0-19: Noise — hype/shill, spam, irrelevant, or completely empty content

Also extract if available: amount, deadline, eligibility, summary.

Respond in JSON only, no markdown:
{"classification":"GRANT","quality_score":72,"score_reason":"Linux Foundation mentorship program — credible org, actionable for OSS contributors, clear structure","reason":"Open application for LFX Mentorship 2026","extracted":{"amount":"$6,000 stipend","deadline":"April 15 2026","eligibility":"Open source contributors","summary":"One sentence."}}`;
}

export async function classifyEntry(entry: {
  name: string;
  description: string;
  source_url: string;
  wire: string;
}): Promise<ClassificationResult> {
  const prompt = buildClassificationPrompt(entry);
  const classifyModel = 'grok-4.20-beta-0309-non-reasoning';

  const provider = getCachedProvider('grok');
  const apiKey = provider?.api_key || config.apis.grok.apiKey;
  const baseUrl = provider?.base_url || config.apis.grok.baseUrl;
  const start = Date.now();

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: classifyModel,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logApiUsage({ provider: 'grok', model: classifyModel, purpose: 'classify', wire: entry.wire, duration_ms: Date.now() - start, success: false, error_message: `${response.status}` });
    throw new Error(`Grok API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const content = data.choices?.[0]?.message?.content;

  logApiUsage({
    provider: 'grok', model: classifyModel, purpose: 'classify', wire: entry.wire,
    duration_ms: Date.now() - start,
    tokens_in: data.usage?.prompt_tokens, tokens_out: data.usage?.completion_tokens,
  });

  if (!content) {
    return { classification: 'UNCHECKED', reason: 'empty_response', qualityScore: 0, scoreReason: '', extracted: {} };
  }

  try {
    // Strip markdown fences if Grok wraps the JSON
    const cleaned = content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned);

    const classification = VALID_CLASSIFICATIONS.has(parsed.classification)
      ? (parsed.classification as Classification)
      : 'UNCHECKED';

    const qualityScore = typeof parsed.quality_score === 'number'
      ? Math.max(0, Math.min(100, Math.round(parsed.quality_score)))
      : 0;

    return {
      classification,
      reason: String(parsed.reason || ''),
      qualityScore,
      scoreReason: String(parsed.score_reason || ''),
      extracted: {
        amount: parsed.extracted?.amount || undefined,
        deadline: parsed.extracted?.deadline || undefined,
        eligibility: parsed.extracted?.eligibility || undefined,
        summary: parsed.extracted?.summary || undefined,
      },
    };
  } catch {
    return { classification: 'UNCHECKED', reason: 'parse_error', qualityScore: 0, scoreReason: '', extracted: {} };
  }
}

/**
 * Classify a batch of entries with concurrency control.
 * Updates the DB directly for each entry.
 */
export async function classifyBatch(
  entries: Array<{ id: number; name: string; description: string; source_url: string; wire: string }>,
  pool: Pool,
  options?: { concurrency?: number; delayMs?: number }
): Promise<{ classified: number; errors: number }> {
  const concurrency = options?.concurrency || 3;
  const delayMs = options?.delayMs || 500;
  let classified = 0;
  let errors = 0;

  // Process in chunks of `concurrency`
  for (let i = 0; i < entries.length; i += concurrency) {
    const chunk = entries.slice(i, i + concurrency);

    const results = await Promise.allSettled(
      chunk.map(async (entry) => {
        const result = await classifyEntry(entry);

        await pool.query(
          `UPDATE scan_entries
           SET classification = $1,
               classification_reason = $2,
               quality_score = $3,
               quality_breakdown = $4,
               metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb
           WHERE id = $6`,
          [
            result.classification,
            result.reason,
            result.qualityScore,
            JSON.stringify({ scoreReason: result.scoreReason }),
            JSON.stringify(result.extracted),
            entry.id,
          ]
        );

        return result;
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled') {
        classified++;
      } else {
        errors++;
        console.error('[Classifier] Entry classification failed:', r.reason);
      }
    }

    // Delay between chunks to avoid rate limits
    if (i + concurrency < entries.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  console.log(`[Classifier] Batch complete: ${classified} classified, ${errors} errors`);
  return { classified, errors };
}
