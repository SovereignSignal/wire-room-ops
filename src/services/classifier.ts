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
  return `Classify this grant/funding opportunity for the ${entry.wire} grants intelligence feed.

Name: ${entry.name}
Description: ${entry.description}
URL: ${entry.source_url}

Classify as exactly one of:
- GRANT: Real, currently open funding opportunity someone can apply to right now
- EXPIRED: Was real but deadline has passed or program is closed
- NEWS: Article/announcement about funding but not an application you can submit
- NOISE: Not a funding opportunity (spam, unrelated content, error)

Also extract if available: amount (funding size), deadline (application deadline), eligibility (who can apply), summary (one clean sentence describing the opportunity).

Respond in JSON only, no markdown:
{"classification":"GRANT","reason":"brief reason","extracted":{"amount":"$50k","deadline":"March 31 2026","eligibility":"Web3 builders","summary":"One sentence."}}`;
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
    return { classification: 'UNCHECKED', reason: 'empty_response', extracted: {} };
  }

  try {
    // Strip markdown fences if Grok wraps the JSON
    const cleaned = content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned);

    const classification = VALID_CLASSIFICATIONS.has(parsed.classification)
      ? (parsed.classification as Classification)
      : 'UNCHECKED';

    return {
      classification,
      reason: String(parsed.reason || ''),
      extracted: {
        amount: parsed.extracted?.amount || undefined,
        deadline: parsed.extracted?.deadline || undefined,
        eligibility: parsed.extracted?.eligibility || undefined,
        summary: parsed.extracted?.summary || undefined,
      },
    };
  } catch {
    return { classification: 'UNCHECKED', reason: 'parse_error', extracted: {} };
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
               metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
           WHERE id = $4`,
          [
            result.classification,
            result.reason,
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
