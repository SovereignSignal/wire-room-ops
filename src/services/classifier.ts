/**
 * Gate 2: Grok LLM Classifier
 *
 * Classifies scan entries as GRANT/EXPIRED/NEWS/NOISE using the xAI
 * chat completions API. Labels are additive — nothing is removed or
 * archived by classification.
 */

import { config } from '../config';
import type { Pool } from 'pg';

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
  return `You are an intelligence analyst for a ${entry.wire} grants and funding feed. Classify AND score this entry.

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
- Source credibility matters most. An update from Linux Foundation, Mozilla, Ethereum Foundation, Uniswap, Gitcoin, or a major DAO is inherently valuable — even without a dollar amount.
- High-quality news from credible orgs can score HIGHER than low-quality grants from unknown sources.
- A $500 hackathon from an unknown project with hype language = low score (15-25).
- A Linux Foundation program update with real substance = high score (60-75) even if no direct application.
- A well-documented $50K+ grant from an established org with clear eligibility and deadline = highest score (75-95).
- Hype language, promotional tone, influencer shilling = score penalty.
- Vague tweets with just hashtags and no real content = very low (5-15).

Score ranges:
- 80-100: High-value grant with full details from credible org
- 60-79: Strong signal — credible org update, solid grant with some details missing, or major program announcement
- 40-59: Moderate — decent source or content but missing key details, or mid-tier org with good info
- 20-39: Low — unknown source, thin content, small/questionable opportunity
- 0-19: Noise — hype, spam, irrelevant, or completely empty content

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

  const response = await fetch(`${config.apis.grok.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apis.grok.apiKey}`,
    },
    body: JSON.stringify({
      model: 'grok-3',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Grok API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;

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
