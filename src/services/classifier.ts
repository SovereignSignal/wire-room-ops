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
import { computeOperatorSignals, formatSignalsForPrompt } from './operator-signals';

export type Classification = 'GRANT' | 'EXPIRED' | 'NEWS' | 'NOISE' | 'UNCHECKED';
export type OperatorRoute = 'publish' | 'source_check' | 'park' | 'decline' | 'relationship_signal';

export interface ClassificationResult {
  classification: Classification;
  reason: string;
  qualityScore: number;
  scoreReason: string;
  operatorRoute?: OperatorRoute;
  tags: string[];
  /** Domain-scope gate: false = a real opportunity but OUTSIDE our three
   *  domains (general scholarship, bio/health fellowship, etc.). Off-scope
   *  is routed to NOISE regardless of how credible the program is. */
  inScope: boolean;
  /** The wire the classifier judges correct from the content ('crypto'|'ai'|
   *  'oss'), or 'off_domain'. Used to correct a wrong intake wire-guess. */
  detectedWire?: 'crypto' | 'ai' | 'oss' | 'off_domain';
  extracted: {
    amount?: string;
    deadline?: string;
    eligibility?: string;
    summary?: string;
  };
}

const VALID_CLASSIFICATIONS = new Set<Classification>(['GRANT', 'EXPIRED', 'NEWS', 'NOISE']);
const VALID_OPERATOR_ROUTES = new Set<OperatorRoute>(['publish', 'source_check', 'park', 'decline', 'relationship_signal']);

export function buildClassificationPrompt(entry: {
  name: string;
  description: string;
  source_url: string;
  wire: string;
  intent?: string;
}, operatorGuidance?: string): string {
  const intentGuidance = entry.intent === 'signal'
    ? '\n## Prompt Intent: Signal\nThis entry came from a signal-detection prompt. Classify as NEWS unless it is clearly a direct grant application opportunity.'
    : entry.intent === 'canonical'
    ? '\n## Prompt Intent: Canonical\nThis entry came from a canonical-program prompt. Penalize if the program is closed/expired. Reward complete information (amount, deadline, eligibility).'
    : entry.intent === 'discovery'
    ? '\n## Prompt Intent: Discovery\nThis entry came from a discovery prompt. Penalize if there is no evidence of recent activity (announcement, post, update within last 30 days).'
    : '';

  return `You are an intelligence analyst for a grants and funding intelligence feed. Classify AND score this entry. The entry is currently tagged for the "${entry.wire}" wire but you must VERIFY and CORRECT this.

Name: ${entry.name}
Description: ${entry.description}
URL: ${entry.source_url}${intentGuidance}

## Domain Scope (CRITICAL — check this first)
This feed covers ONLY these three domains:
- crypto: blockchain / web3 / crypto grants, ecosystem funds, protocol & DAO funding, public-goods rounds.
- ai: AI safety, AI alignment, AI research funding, AI compute-credit programs, and AI-focused government/foundation calls.
- oss: open-source software funding — maintainer grants, foundation programs (NLnet, Sovereign Tech, OpenSSF, Linux Foundation, etc.), OSS security funding.

Set "in_scope": false when the content is a REAL funding opportunity but OUTSIDE all three domains — e.g. general academic scholarships (Rhodes, Knight-Hennessy), biology/medical/health fellowships (EMBO), humanities, neuroscience, unrelated government recognitions, business-plan competitions, study-abroad programs. Off-scope items are NOISE no matter how prestigious or well-funded — a real Rhodes Scholarship is still off-scope. When in_scope is false, set classification to NOISE.
Set "wire" to the correct domain ("crypto" | "ai" | "oss") when in scope, or "off_domain" when in_scope is false. Do not keep a wrong wire just because the entry arrived tagged that way.

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
- Small random hackathons, local student events, or hiring-funnel competitions are noise unless they are sizable, materially funded, and backed by prominent organizations. Penalize hard when prize/funding amount, credible organizer, or serious ecosystem relevance is missing.
- Hackathon scoring ceiling: unknown/local/student hackathons with vague prizes should be NOISE or NEWS at 0-30. Corporate hackathons without a material cash/grant pool should usually be NEWS at 25-45 even when hosted by a recognizable company. Only prominent, materially funded ecosystem hackathons with serious builder pipeline signal should reach 50+.
- Sizable hackathons from prominent organizations with material prize pools can be useful, but they should score below comparable direct grants/fellowships unless they create meaningful funding or builder pipeline signal.
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
${operatorGuidance ? '\n' + operatorGuidance + '\n' : ''}
## Operator Route
Return operator_route separately from classification. Allowed operator_route values: publish | source_check | park | decline | relationship_signal
- publish: strong Wire item Sov is likely to approve for public distribution.
- source_check: promising item that needs canonical URL, deadline, amount, duplicate, or status verification before publishing.
- park: real but low-priority item, weak Wire fit, generic scholarship, local fellowship, academic job, or background signal.
- decline: stale, closed, duplicate, tiny hackathon, hype, spam, or wrong-lane item.
- relationship_signal: useful BD, landscape, funder, or ecosystem signal, but not a direct Wire post.

For Telegram/Grok batch intake, be strict: real academic positions, local scholarships, and generic fellowships are often GRANT by content type but park by operator_route unless they are unusually strategic for grants intelligence. Announcements about awarded funding are usually relationship_signal or park, not publish.
Also extract if available: amount, deadline, eligibility, summary.

Also extract entity tags: 1-5 short labels for the organizations, protocols, platforms, or projects specifically named in this entry. Use canonical names (e.g., "Ethereum Foundation" not "EF", "Gitcoin" not "Gitcoin Grants"). Only include entities directly relevant — not generic terms like "blockchain" or "web3". If a specific chain (Ethereum, Solana) is mentioned, include it.

Respond in JSON only, no markdown:
{"classification":"GRANT","in_scope":true,"wire":"oss","quality_score":72,"operator_route":"publish","score_reason":"Linux Foundation mentorship program — credible org, actionable for OSS contributors, clear structure","reason":"Open application for LFX Mentorship 2026","tags":["Linux Foundation","LFX Mentorship"],"extracted":{"amount":"$6,000 stipend","deadline":"April 15 2026","eligibility":"Open source contributors","summary":"One sentence."}}`;
}

export async function classifyEntry(entry: {
  name: string;
  description: string;
  source_url: string;
  wire: string;
  intent?: string;
}): Promise<ClassificationResult> {
  // Fetch operator signals (cached, non-blocking on failure)
  let operatorGuidance = '';
  try {
    const signals = await computeOperatorSignals(entry.wire);
    operatorGuidance = formatSignalsForPrompt(signals);
  } catch (err) {
    console.error('[Classifier] Failed to fetch operator signals:', err);
  }
  const prompt = buildClassificationPrompt(entry, operatorGuidance);

  const provider = getCachedProvider('grok');
  const classifyModel = provider?.default_model || 'grok-4.20-beta-0309-non-reasoning';
  const apiKey = provider?.api_key || config.apis.grok.apiKey;
  const baseUrl = provider?.base_url || config.apis.grok.baseUrl;
  const start = Date.now();

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: classifyModel,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4000,
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
    return { classification: 'UNCHECKED', reason: 'empty_response', qualityScore: 0, scoreReason: '', tags: [], inScope: true, extracted: {} };
  }

  try {
    // Strip markdown fences if Grok wraps the JSON
    const cleaned = content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned);

    // Domain-scope gate: default to in-scope unless the model explicitly says false.
    const inScope = parsed.in_scope !== false;
    const wireRaw = typeof parsed.wire === 'string' ? parsed.wire.toLowerCase() : '';
    const detectedWire = (['crypto', 'ai', 'oss', 'off_domain'].includes(wireRaw)
      ? wireRaw
      : undefined) as ClassificationResult['detectedWire'];

    let classification = VALID_CLASSIFICATIONS.has(parsed.classification)
      ? (parsed.classification as Classification)
      : 'UNCHECKED';
    let operatorRoute = typeof parsed.operator_route === 'string' && VALID_OPERATOR_ROUTES.has(parsed.operator_route)
      ? parsed.operator_route as OperatorRoute
      : undefined;

    // Off-scope content is NOISE → decline, regardless of how the model scored it.
    if (!inScope || detectedWire === 'off_domain') {
      classification = 'NOISE';
      operatorRoute = 'decline';
    }

    const qualityScore = typeof parsed.quality_score === 'number'
      ? Math.max(0, Math.min(100, Math.round(parsed.quality_score)))
      : 0;

    const rawTags = Array.isArray(parsed.tags) ? parsed.tags : [];
    const tags = rawTags.filter((t: unknown): t is string => typeof t === 'string' && t.length > 0 && t.length <= 60).slice(0, 5);

    return {
      classification,
      reason: String(parsed.reason || ''),
      qualityScore,
      scoreReason: String(parsed.score_reason || ''),
      operatorRoute,
      tags,
      inScope,
      detectedWire,
      extracted: {
        amount: parsed.extracted?.amount || undefined,
        deadline: parsed.extracted?.deadline || undefined,
        eligibility: parsed.extracted?.eligibility || undefined,
        summary: parsed.extracted?.summary || undefined,
      },
    };
  } catch {
    return { classification: 'UNCHECKED', reason: 'parse_error', qualityScore: 0, scoreReason: '', tags: [], inScope: true, extracted: {} };
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

  // Pre-warm operator signals per wire so concurrent classifyEntry calls hit the
  // cache instead of stampeding the 30-day history query.
  const wires = [...new Set(entries.map(e => e.wire))];
  for (const wire of wires) {
    try {
      await computeOperatorSignals(wire);
    } catch (err) {
      console.error(`[Classifier] Failed to pre-warm operator signals for ${wire}:`, err);
    }
  }

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
               metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
               tags = $6
           WHERE id = $7`,
          [
            result.classification,
            result.reason,
            result.qualityScore,
            JSON.stringify({ scoreReason: result.scoreReason }),
            // Keep operator_route persistence in lockstep with process-raw —
            // this backfill path classifies dumb-pipe (telegram/manual) entries,
            // so without it those lanes never carry the BD/relationship signal.
            JSON.stringify({ ...result.extracted, operator_route: result.operatorRoute || null }),
            result.tags,
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

/**
 * Lightweight batch tag extraction — processes up to 10 entries per Grok call.
 * Only extracts entity tags, does not re-classify or re-score.
 */
export async function tagBatch(
  entries: Array<{ id: number; name: string; description: string; wire: string }>,
  pool: Pool,
  options?: { batchSize?: number; delayMs?: number }
): Promise<{ tagged: number; errors: number }> {
  const batchSize = options?.batchSize || 10;
  const delayMs = options?.delayMs || 500;
  let tagged = 0;
  let errors = 0;

  const provider = getCachedProvider('grok');
  const apiKey = provider?.api_key || config.apis.grok.apiKey;
  const baseUrl = provider?.base_url || config.apis.grok.baseUrl;
  const tagModel = provider?.default_model || 'grok-4.20-beta-0309-non-reasoning';

  for (let i = 0; i < entries.length; i += batchSize) {
    const chunk = entries.slice(i, i + batchSize);

    const entryLines = chunk.map((e, idx) =>
      `${idx + 1}. [ID:${e.id}] Name: "${e.name}" | Desc: "${(e.description || '').slice(0, 200)}"`
    ).join('\n');

    const prompt = `Extract 1-5 entity tags per entry (org names, protocols, platforms, projects). Use canonical names (e.g., "Ethereum Foundation" not "EF"). Only include specifically named entities — not generic terms like "blockchain" or "web3". Return JSON array only, no markdown:\n[{"id":123,"tags":["Gitcoin","Ethereum"]}, ...]\n\n${entryLines}`;

    try {
      const start = Date.now();
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: AbortSignal.timeout(120_000),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: tagModel,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 4000,
          temperature: 0.1,
        }),
      });

      if (!response.ok) {
        logApiUsage({ provider: 'grok', model: tagModel, purpose: 'tag-backfill', wire: chunk[0].wire, duration_ms: Date.now() - start, success: false, error_message: `${response.status}` });
        errors += chunk.length;
        continue;
      }

      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const content = data.choices?.[0]?.message?.content;

      logApiUsage({
        provider: 'grok', model: tagModel, purpose: 'tag-backfill', wire: chunk[0].wire,
        duration_ms: Date.now() - start,
        tokens_in: data.usage?.prompt_tokens, tokens_out: data.usage?.completion_tokens,
      });

      if (!content) {
        errors += chunk.length;
        continue;
      }

      const cleaned = content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
      const results = JSON.parse(cleaned) as Array<{ id: number; tags: unknown[] }>;

      for (const r of results) {
        const tags = Array.isArray(r.tags)
          ? r.tags.filter((t: unknown): t is string => typeof t === 'string' && t.length > 0 && t.length <= 60).slice(0, 5)
          : [];
        if (tags.length > 0) {
          await pool.query(`UPDATE scan_entries SET tags = $1 WHERE id = $2`, [tags, r.id]);
          tagged++;
        }
      }
    } catch (err) {
      console.error('[Classifier] Tag batch failed:', err);
      errors += chunk.length;
    }

    if (i + batchSize < entries.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  console.log(`[Classifier] Tag backfill complete: ${tagged} tagged, ${errors} errors`);
  return { tagged, errors };
}
