/**
 * Gate 2: Grok LLM Classifier
 *
 * Classifies scan entries as GRANT/EXPIRED/NEWS/NOISE using the xAI
 * chat completions API. Labels are additive — nothing is removed or
 * archived by classification.
 */

import type { Pool } from 'pg';
import { logApiUsage } from './api-usage';
import { getCachedProvider, isProviderExplicitlyDisabled } from './api-provider';
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
const VALID_DETECTED_WIRES = new Set(['crypto', 'ai', 'oss', 'off_domain']);
const DEFAULT_GROK_MODEL = 'grok-4.20-beta-0309-non-reasoning';
const DEFAULT_GROK_BASE_URL = 'https://api.x.ai/v1';

export interface ClassificationEntry {
  name: string;
  description: string;
  source_url: string;
  wire: string;
  intent?: string;
  amount?: string | null;
  deadlineParsed?: string | Date | null;
  sourcePublishedAt?: string | Date | null;
  /** Override only for deterministic tests/replays. Defaults to the call date. */
  currentDate?: string | Date;
}

const LOW_PRECISION_FORMAT_RE = /\b(?:fellowships?|accelerators?|incubators?|competitions?|challenges?|hackathons?|buildathons?|regional|local|credits?|research\s+(?:program|programme|initiative|page))\b/i;
const APPLICANT_PATH_RE = /\b(?:applications?\s+(?:are|is)\s+(?:now\s+)?open|(?:now\s+)?accepting\s+applications?|apply\s+(?:now|by|at|through|via)|submit\s+(?:an?\s+)?application|application\s+(?:form|portal)\s+(?:is\s+)?(?:open|available|live)|(?:open|current|active)\s+(?:call|request)\s+for\s+proposals|(?:call|request)\s+for\s+proposals\s+(?:is|are)\s+open|rfps?\s+(?:is|are)\s+open)\b/i;
const APPLICANT_CLOSED_RE = /\b(?:applications?\s+(?:are|is|remain)\s+(?:now\s+)?closed|not\s+(?:currently\s+)?accepting\s+applications?|no\s+(?:current\s+)?application\s+(?:form|portal)(?:\s+is\s+(?:available|open|live))?|no\s+(?:current\s+)?open\s+(?:call|request)\s+for\s+proposals|application\s+(?:form|portal)\s+(?:is\s+)?unavailable|call\s+(?:is\s+)?closed|deadline\s+(?:has\s+)?passed|closed|expired|archived|no\s+longer\s+open)\b|\?\s*no\b/i;
const STRATEGIC_CAPITAL_RE = /\b(?:allocat(?:e|ed|ion)|commit(?:ment|ted)?|invest(?:ment|ed)?|grant\s+pool|funding\s+pool|treasury\s+funding|governance\s+funding)\b/i;
const MATERIAL_VALUE_RE = /(?:[$€£]\s?\d|\b\d+(?:[.,]\d+)?\s*(?:k|m|b|thousand|million|billion)\b)/i;
const NEGATED_CLAUSE_RE = /\b(?:no|not|without|lacks?|lacking|missing|unavailable|closed|expired|archived|cannot|can't|couldn't|could\s+not|did\s+not|has\s+not|unable\s+to|sought|proposed|requested)\b/i;

function lastMatchEnd(text: string, pattern: RegExp): number {
  const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let last = -1;
  for (const match of text.matchAll(globalPattern)) last = (match.index || 0) + match[0].length;
  return last;
}

function hasCurrentApplicantPath(text: string, sourceUrl: string): boolean {
  const lastPositive = lastMatchEnd(text, APPLICANT_PATH_RE);
  const lastClosed = lastMatchEnd(text, APPLICANT_CLOSED_RE);
  if (lastPositive >= 0) return lastPositive > lastClosed;
  return lastClosed < 0 && /\/(?:apply|application)(?:[/?#]|$)/i.test(sourceUrl);
}

function hasAffirmedStrategicCapital(text: string): boolean {
  const clauses = text.split(/[.!?;\n]+|,\s+(?=but\b|however\b)/i);
  for (const clause of clauses) {
    if (STRATEGIC_CAPITAL_RE.test(clause)
        && MATERIAL_VALUE_RE.test(clause)
        && !NEGATED_CLAUSE_RE.test(clause)) return true;
  }
  return false;
}

/**
 * Deterministic Ready calibration for formats with weak operator agreement.
 * The LLM can still classify the item as a real grant. It cannot recommend
 * publish unless the evidence shows a current applicant path or a material
 * strategic capital signal.
 */
export function applyReadyCalibration(
  entry: ClassificationEntry,
  result: ClassificationResult,
): ClassificationResult {
  if (result.operatorRoute !== 'publish') return result;

  // Only source material can authorize the exception. Model-generated reason,
  // score, and extracted fields may repeat unverified or negated claims.
  const evidence = [
    entry.name,
    entry.description,
    entry.source_url,
    entry.amount || '',
  ].join(' ');
  if (!LOW_PRECISION_FORMAT_RE.test(evidence)) return result;

  const hasApplicantPath = hasCurrentApplicantPath(evidence, entry.source_url);
  const hasStrategicCapital = hasAffirmedStrategicCapital(evidence);
  if (hasApplicantPath || hasStrategicCapital) return result;

  return {
    ...result,
    operatorRoute: 'source_check',
    reason: `${result.reason} Ready calibration: low-precision format lacks a verified applicant path or material strategic capital signal.`,
  };
}

export class ClassifierResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClassifierResponseError';
  }
}

function formatDateContext(value: string | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return 'not provided';
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'invalid/unparseable' : parsed.toISOString();
}

export function buildClassificationPrompt(entry: ClassificationEntry, operatorGuidance?: string): string {
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
URL: ${entry.source_url}
Current date: ${formatDateContext(entry.currentDate || new Date())}
Structured amount: ${entry.amount?.trim() || 'not provided'}
Parsed deadline: ${formatDateContext(entry.deadlineParsed)}
Source publication date: ${formatDateContext(entry.sourcePublishedAt)}${intentGuidance}

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

GRANT vs NEWS boundary: if there is an application path that is open now or opens on a stated date (an apply link, "applications are now open", a future deadline), classify GRANT even when the item reads like a news announcement. Reserve NEWS for items with no application path.

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

Calibration guardrails (apply AFTER picking a band):
- Do NOT stack penalties. Pick the band from the entry's strongest credible reading, then adjust once for its weakest element. Subtracting repeatedly for every imperfection produces artificially cold scores.
- A real, currently-open program with a material amount from a credible organization belongs at 60+ even when some details (eligibility, exact deadline) are missing — missing details are a source_check signal, not a reason to score below 60.
- Organization newness alone is not a hype penalty. Penalize hype LANGUAGE and unverifiable claims, not recency of the org.
${operatorGuidance ? '\n' + operatorGuidance + '\n' : ''}
## Operator Route
Return operator_route separately from classification. Allowed operator_route values: publish | source_check | park | decline | relationship_signal
- publish: strong Wire item Sov is likely to approve for public distribution.
- source_check: promising item that needs canonical URL, deadline, amount, duplicate, or status verification before publishing.
- park: real but low-priority item, weak Wire fit, generic scholarship, local fellowship, academic job, or background signal.
- decline: stale, closed, duplicate, tiny hackathon, hype, spam, or wrong-lane item.
- relationship_signal: useful BD, landscape, funder, or ecosystem signal, but not a direct Wire post.

LOW-PRECISION FORMAT GATE: fellowships, accelerators, incubators, competitions, challenges, hackathons, buildathons, regional or local events, credit-only offers, and research program pages default to source_check. Use publish only when the evidence shows a current concrete applicant path or a material strategic capital/governance signal. Sponsor prestige and verified existence alone are insufficient.

For Telegram/Grok batch intake, be strict: real academic positions, local scholarships, and generic fellowships are often GRANT by content type but park by operator_route unless they are unusually strategic for grants intelligence. Announcements about awarded funding are usually relationship_signal or park, not publish.
Also extract if available: amount, deadline, eligibility, summary.

Also extract entity tags: 1-5 short labels for the organizations, protocols, platforms, or projects specifically named in this entry. Use canonical names (e.g., "Ethereum Foundation" not "EF", "Gitcoin" not "Gitcoin Grants"). Only include entities directly relevant — not generic terms like "blockchain" or "web3". If a specific chain (Ethereum, Solana) is mentioned, include it.

Respond in JSON only, no markdown:
{"classification":"GRANT","in_scope":true,"wire":"oss","quality_score":72,"operator_route":"publish","score_reason":"Linux Foundation mentorship program — credible org, actionable for OSS contributors, clear structure","reason":"Open application for LFX Mentorship 2026","tags":["Linux Foundation","LFX Mentorship"],"extracted":{"amount":"$6,000 stipend","deadline":"April 15 2026","eligibility":"Open source contributors","summary":"One sentence."}}`;
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ClassifierResponseError(`missing or invalid ${field}`);
  }
  return value.trim();
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function toCalendarDate(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    const literal = value.trim().match(/^(\d{4}-\d{2}-\d{2})(?:T|$)/)?.[1];
    if (literal) {
      const parsedLiteral = new Date(`${literal}T00:00:00.000Z`);
      return !Number.isNaN(parsedLiteral.getTime()) && parsedLiteral.toISOString().slice(0, 10) === literal
        ? literal
        : null;
    }
  }
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/** Parse a classifier reply. Invalid core fields throw so callers can retry. */
export function parseClassificationResponse(
  content: string,
  context?: Pick<ClassificationEntry, 'deadlineParsed' | 'currentDate'>,
): ClassificationResult {
  if (!content.trim()) throw new ClassifierResponseError('empty response');

  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new ClassifierResponseError('malformed JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ClassifierResponseError('response must be a JSON object');
  }

  const record = parsed as Record<string, unknown>;
  const classificationRaw = typeof record.classification === 'string'
    ? record.classification.trim().toUpperCase()
    : '';
  if (!VALID_CLASSIFICATIONS.has(classificationRaw as Classification)) {
    throw new ClassifierResponseError('missing or invalid classification');
  }

  if (typeof record.in_scope !== 'boolean') {
    throw new ClassifierResponseError('missing or invalid in_scope');
  }

  const wireRaw = typeof record.wire === 'string' ? record.wire.trim().toLowerCase() : '';
  if (!VALID_DETECTED_WIRES.has(wireRaw)) {
    throw new ClassifierResponseError('missing or invalid wire');
  }

  const qualityRaw = record.quality_score;
  if (typeof qualityRaw !== 'number' || !Number.isFinite(qualityRaw) || qualityRaw < 0 || qualityRaw > 100) {
    throw new ClassifierResponseError('missing or invalid quality_score');
  }

  const operatorRouteRaw = typeof record.operator_route === 'string'
    ? record.operator_route.trim().toLowerCase()
    : '';
  if (!VALID_OPERATOR_ROUTES.has(operatorRouteRaw as OperatorRoute)) {
    throw new ClassifierResponseError('missing or invalid operator_route');
  }

  let classification = classificationRaw as Classification;
  let operatorRoute = operatorRouteRaw as OperatorRoute;
  let detectedWire = wireRaw as NonNullable<ClassificationResult['detectedWire']>;
  let inScope = record.in_scope;
  let reason = readRequiredString(record.reason, 'reason');
  const scoreReason = readRequiredString(record.score_reason, 'score_reason');

  // A model that returns off_domain with in_scope=true is internally
  // inconsistent. Normalize to the fail-closed off-scope state.
  if (detectedWire === 'off_domain' || !inScope) {
    inScope = false;
    detectedWire = 'off_domain';
    classification = 'NOISE';
    operatorRoute = 'decline';
  }

  // Parsed source dates are deterministic evidence. A deadline before today
  // cannot remain an open GRANT, even if the model overlooked it. Comparing
  // YYYY-MM-DD values keeps deadline-today open for the full calendar date.
  const deadlineDate = toCalendarDate(context?.deadlineParsed);
  const currentDate = toCalendarDate(context?.currentDate || new Date());
  if (inScope && classification === 'GRANT' && deadlineDate && currentDate && deadlineDate < currentDate) {
    classification = 'EXPIRED';
    operatorRoute = 'decline';
    reason = `${reason} Deadline ${deadlineDate} predates current date ${currentDate}.`;
  }

  const rawTags = Array.isArray(record.tags) ? record.tags : [];
  const tags = rawTags
    .filter((tag: unknown): tag is string => typeof tag === 'string' && tag.trim().length > 0 && tag.trim().length <= 60)
    .map(tag => tag.trim())
    .slice(0, 5);

  const extractedRecord = record.extracted && typeof record.extracted === 'object' && !Array.isArray(record.extracted)
    ? record.extracted as Record<string, unknown>
    : {};

  return {
    classification,
    reason,
    qualityScore: Math.round(qualityRaw),
    scoreReason,
    operatorRoute,
    tags,
    inScope,
    detectedWire,
    extracted: {
      amount: readOptionalString(extractedRecord.amount),
      deadline: readOptionalString(extractedRecord.deadline),
      eligibility: readOptionalString(extractedRecord.eligibility),
      summary: readOptionalString(extractedRecord.summary),
    },
  };
}

export async function classifyEntry(entry: ClassificationEntry): Promise<ClassificationResult> {
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
  if (!provider?.api_key) {
    throw new Error(isProviderExplicitlyDisabled('grok')
      ? 'Grok provider is disabled'
      : 'Grok API key not configured');
  }
  const classifyModel = provider.default_model || DEFAULT_GROK_MODEL;
  const apiKey = provider.api_key;
  const baseUrl = provider.base_url || DEFAULT_GROK_BASE_URL;
  const start = Date.now();

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
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
  } catch (err) {
    logApiUsage({
      provider: 'grok', model: classifyModel, purpose: 'classify', wire: entry.wire,
      duration_ms: Date.now() - start, success: false,
      error_message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  if (!response.ok) {
    const errorText = await response.text();
    logApiUsage({ provider: 'grok', model: classifyModel, purpose: 'classify', wire: entry.wire, duration_ms: Date.now() - start, success: false, error_message: `${response.status} ${errorText.slice(0, 200)}`.trim() });
    throw new Error(`Grok API error: ${response.status} - ${errorText}`);
  }

  let data: { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  try {
    data = await response.json() as typeof data;
  } catch {
    const error = new ClassifierResponseError('malformed API response JSON');
    logApiUsage({
      provider: 'grok', model: classifyModel, purpose: 'classify', wire: entry.wire,
      duration_ms: Date.now() - start, success: false, error_message: error.message,
    });
    throw error;
  }
  const content = data.choices?.[0]?.message?.content;

  try {
    const result = applyReadyCalibration(entry, parseClassificationResponse(content || '', entry));
    logApiUsage({
      provider: 'grok', model: classifyModel, purpose: 'classify', wire: entry.wire,
      duration_ms: Date.now() - start,
      tokens_in: data.usage?.prompt_tokens, tokens_out: data.usage?.completion_tokens,
    });
    return result;
  } catch (err) {
    logApiUsage({
      provider: 'grok', model: classifyModel, purpose: 'classify', wire: entry.wire,
      duration_ms: Date.now() - start,
      tokens_in: data.usage?.prompt_tokens, tokens_out: data.usage?.completion_tokens,
      success: false,
      error_message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Classify a batch of entries with concurrency control.
 * Updates the DB directly for each entry.
 */
export async function classifyBatch(
  entries: Array<ClassificationEntry & { id: number }>,
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

        const updated = await pool.query(
          `UPDATE scan_entries
           SET classification = $1,
               classification_reason = $2,
               quality_score = $3,
               quality_breakdown = $4,
               metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
               tags = $6
           WHERE id = $7
             AND status = 'queued'
             AND (classification IS NULL OR classification = 'UNCHECKED')
             AND name IS NOT DISTINCT FROM $8
             AND description IS NOT DISTINCT FROM $9
             AND source_url IS NOT DISTINCT FROM $10
             AND wire IS NOT DISTINCT FROM $11
           RETURNING id`,
          [
            result.classification,
            result.reason,
            result.qualityScore,
            JSON.stringify({
              scoreReason: result.scoreReason,
              in_scope: result.inScope,
              detected_wire: result.detectedWire,
            }),
            // Keep operator_route persistence in lockstep with process-raw —
            // this backfill path classifies dumb-pipe (telegram/manual) entries,
            // so without it those lanes never carry the BD/relationship signal.
            JSON.stringify({ ...result.extracted, operator_route: result.operatorRoute || null }),
            result.tags,
            entry.id,
            entry.name,
            entry.description,
            entry.source_url,
            entry.wire,
          ]
        );

        return updated.rowCount === 1;
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        classified++;
      } else if (r.status === 'rejected') {
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
  if (!provider?.api_key) {
    throw new Error(isProviderExplicitlyDisabled('grok')
      ? 'Grok provider is disabled'
      : 'Grok API key not configured');
  }
  const apiKey = provider.api_key;
  const baseUrl = provider.base_url || DEFAULT_GROK_BASE_URL;
  const tagModel = provider.default_model || DEFAULT_GROK_MODEL;

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
        const errorText = await response.text().catch(() => '');
        logApiUsage({ provider: 'grok', model: tagModel, purpose: 'tag-backfill', wire: chunk[0].wire, duration_ms: Date.now() - start, success: false, error_message: `${response.status} ${errorText.slice(0, 200)}`.trim() });
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
