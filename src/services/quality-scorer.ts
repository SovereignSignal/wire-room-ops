/**
 * Quality Scoring Service
 *
 * Assigns a 0-100 quality score to each scan entry based on parameterized weights.
 * Parameters are loaded from the active scoring experiment (DB), falling back to
 * DEFAULT_PARAMS which match the original hardcoded values exactly.
 *
 * Scores are used to:
 * - Filter the daily briefing (only high quality items)
 * - Prioritize entries for AI enrichment
 * - Determine what goes in the weekly newsletter
 */

import type { QualityBreakdown, ScoringParams } from '../types/intake';
import { parseAmount, parseDeadline } from './intake';
import { getPool } from '../db';

// ============================================================
// Default Parameters (match original hardcoded values exactly)
// ============================================================

export const DEFAULT_PARAMS: ScoringParams = {
  // Base weights
  w_has_amount: 25,
  w_amount_threshold: 15,
  w_has_deadline: 15,
  w_deadline_upcoming: 10,
  w_funding_opportunity: 20,
  w_actionable: 15,

  // Penalties
  p_governance_noise: -15,
  p_already_awarded: -10,
  p_vague_description: -5,
  p_small_amount: -5,

  // Thresholds
  t_amount_min: 5000,
  t_amount_tiny: 1000,
  t_deadline_window_days: 60,
  t_rolling_bonus: 5,

  // Queue threshold
  t_queue_min_score: 40,
};

// ============================================================
// Active Params Loader
// ============================================================

/**
 * Load the active experiment's params from DB, or fall back to DEFAULT_PARAMS.
 * Returns the params and optionally the experiment ID.
 */
export async function getActiveParams(): Promise<{ params: ScoringParams; experimentId: string | null }> {
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT id, params FROM scoring_experiments
       WHERE status = 'active'
       ORDER BY started_at DESC LIMIT 1`
    );

    if (result.rows.length > 0) {
      return {
        params: result.rows[0].params as ScoringParams,
        experimentId: result.rows[0].id as string,
      };
    }
  } catch {
    // DB not available or table doesn't exist yet — use defaults
  }

  return { params: DEFAULT_PARAMS, experimentId: null };
}

// ============================================================
// Entry Type Classification
// ============================================================

/**
 * Parse a comma-separated or JSON array string from an env var into a Set.
 * Returns null if the env var is not set.
 */
function parseEnvSet(envKey: string): Set<string> | null {
  const raw = process.env[envKey];
  if (!raw) return null;

  const trimmed = raw.trim();
  // Try JSON array first
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed) as unknown[];
      return new Set(arr.filter((v): v is string => typeof v === 'string').map(s => s.toLowerCase()));
    } catch {
      // Fall through to comma-separated
    }
  }
  return new Set(trimmed.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

// Default sets (used when env var is absent)
const DEFAULT_FUNDING_TYPES = new Set([
  'grant',
  'grants',
  'grant program',
  'fellowship',
  'scholarship',
  'accelerator',
  'open call',
  'rfp',
  'seed grant',
  'seed funding',
  'travel grant',
  'research grant',
  'sponsorship',
  'audit grant',
  'subsidy',
]);

const DEFAULT_ACTIONABLE_TYPES = new Set([
  'hackathon',
  'bounty',
  'bounty program',
  'bug bounty',
  'competition',
  'pitch competition',
  'residency',
  'incubator',
  'airdrop',
  'campaign',
  'retro funding',
  'retroactive funding',
]);

/**
 * Types that represent real, actionable funding opportunities.
 * Override via QUALITY_FUNDING_TYPES env var (JSON array or comma-separated).
 */
function getFundingTypes(): Set<string> {
  return parseEnvSet('QUALITY_FUNDING_TYPES') || DEFAULT_FUNDING_TYPES;
}

/**
 * Types that are actionable (someone can participate) but aren't
 * pure funding. Override via QUALITY_ACTIONABLE_TYPES env var.
 */
function getActionableTypes(): Set<string> {
  return parseEnvSet('QUALITY_ACTIONABLE_TYPES') || DEFAULT_ACTIONABLE_TYPES;
}

/**
 * Types that are informational/not actionable.
 * These get penalized in scoring.
 */
const NON_ACTIONABLE_TYPES = new Set([
  'governance',
  'proposal',
  'awarded',
  'government initiative',
  'policy',
  'report',
  'news',
  'commentary',
  'other',
  'platform',
  'training program',
  'fundraiser',
  'fiscal host',
  'token program',
]);

/**
 * Keywords in descriptions that suggest governance/non-actionable content.
 */
const GOVERNANCE_KEYWORDS = [
  'proposal to',
  'governance vote',
  'treasury allocation',
  'treasury transfer',
  'fee switch',
  'revenue allocation',
  'budget allocation',
  'dao budget',
  'token holder',
  'staked',
  'staking',
  'guidelines update',
  'post-mortem',
  'completion report',
  'rebranding',
];

/**
 * Keywords that suggest a real opportunity someone can apply to.
 */
const OPPORTUNITY_KEYWORDS = [
  'apply',
  'application',
  'applications open',
  'open call',
  'accepting proposals',
  'submit',
  'register',
  'sign up',
  'enroll',
  'deadline',
  'grants for',
  'funding for',
  'fellowship for',
  'open to',
  'targeted at',
  'aimed at',
  'for developers',
  'for researchers',
  'for builders',
  'for teams',
  'for projects',
  'for startups',
];

// ============================================================
// Main Scoring Function
// ============================================================

/**
 * Score a scan entry on quality from 0-100.
 * Returns both the total score and a breakdown of how it was calculated.
 *
 * When called without params, uses DEFAULT_PARAMS (backward compatible).
 */
export function scoreEntry(
  entry: {
    name: string;
    description: string | null;
    amount: string | null;
    deadline: string | null;
    scanDate?: string;
  },
  params: ScoringParams = DEFAULT_PARAMS
): QualityBreakdown {
  let totalScore = 0;
  const penalties: string[] = [];
  const desc = (entry.description || '').toLowerCase();
  const name = entry.name.toLowerCase();

  // ---- Has Amount ----
  const hasAmount = !!entry.amount && entry.amount.trim() !== '';
  if (hasAmount) totalScore += params.w_has_amount;

  // ---- Amount Above Threshold ----
  let amountAboveThreshold = false;
  if (hasAmount) {
    const parsed = parseAmount(entry.amount);
    if (parsed && parsed.numeric >= params.t_amount_min) {
      amountAboveThreshold = true;
      totalScore += params.w_amount_threshold;
    } else if (parsed && parsed.numeric < params.t_amount_tiny) {
      penalties.push(`Small amount: ${entry.amount}`);
      totalScore += params.p_small_amount;
    }
  }

  // ---- Has Deadline ----
  const hasDeadline =
    !!entry.deadline &&
    entry.deadline !== 'Rolling' &&
    entry.deadline !== 'None listed' &&
    entry.deadline.trim() !== '';
  if (hasDeadline) totalScore += params.w_has_deadline;

  // Rolling deadlines get a partial bonus
  if (entry.deadline === 'Rolling') totalScore += params.t_rolling_bonus;

  // ---- Deadline Upcoming ----
  let deadlineUpcoming = false;
  if (hasDeadline) {
    const parsed = parseDeadline(entry.deadline);
    if (parsed) {
      const now = entry.scanDate ? new Date(entry.scanDate) : new Date();
      const daysUntil =
        (parsed.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

      if (daysUntil >= 0 && daysUntil <= params.t_deadline_window_days) {
        deadlineUpcoming = true;
        totalScore += params.w_deadline_upcoming;
      } else if (daysUntil < 0) {
        // Expired deadline — use the same magnitude as the deadline_upcoming weight as penalty
        penalties.push('Deadline has passed');
        totalScore -= params.w_deadline_upcoming;
      }
    }
  }

  // ---- Is Funding Opportunity ----
  const isFundingOpportunity = classifyAsFunding(name, desc);
  if (isFundingOpportunity) {
    totalScore += params.w_funding_opportunity;
  }

  // ---- Is Actionable ----
  const isActionable = classifyAsActionable(name, desc);
  if (isActionable) {
    totalScore += params.w_actionable;
  }

  // ---- Penalties ----

  // Governance/DAO proposals that aren't actually grants
  if (isGovernanceNoise(name, desc)) {
    totalScore += params.p_governance_noise;
    penalties.push('Governance/DAO noise');
  }

  // "Awarded" entries (already happened, not actionable)
  if (desc.includes('awarded to') || desc.includes('received') || desc.includes('was granted')) {
    if (!isActionable && !isFundingOpportunity) {
      totalScore += params.p_already_awarded;
      penalties.push('Already awarded (not open)');
    }
  }

  // Very short/vague descriptions
  if (!entry.description || entry.description.length < 30) {
    totalScore += params.p_vague_description;
    penalties.push('Vague description');
  }

  // Clamp to 0-100
  totalScore = Math.max(0, Math.min(100, totalScore));

  return {
    totalScore,
    hasAmount,
    amountAboveThreshold,
    hasDeadline,
    deadlineUpcoming,
    isFundingOpportunity,
    isActionable,
    penalties,
  };
}

// ============================================================
// Classification Helpers
// ============================================================

/**
 * Check if text contains a phrase as a whole word (not a substring).
 * e.g. "grant" matches "open grant program" but not "immigrant".
 */
const regexpCache = new Map<string, RegExp>();

function containsWord(text: string, phrase: string): boolean {
  let re = regexpCache.get(phrase);
  if (!re) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(`\\b${escaped}\\b`, 'i');
    regexpCache.set(phrase, re);
  }
  return re.test(text);
}

function classifyAsFunding(name: string, desc: string): boolean {
  const combined = `${name} ${desc}`;
  const fundingTypes = getFundingTypes();

  for (const type of fundingTypes) {
    if (containsWord(combined, type)) return true;
  }

  // Check for opportunity keywords
  let opportunitySignals = 0;
  for (const kw of OPPORTUNITY_KEYWORDS) {
    if (containsWord(combined, kw)) opportunitySignals++;
  }

  return opportunitySignals >= 2;
}

function classifyAsActionable(name: string, desc: string): boolean {
  const combined = `${name} ${desc}`;
  const fundingTypes = getFundingTypes();
  const actionableTypes = getActionableTypes();

  // If it's a funding type, it's automatically actionable
  for (const type of fundingTypes) {
    if (containsWord(combined, type)) return true;
  }

  // Check actionable types
  for (const type of actionableTypes) {
    if (containsWord(combined, type)) return true;
  }

  // Check opportunity keywords
  let signals = 0;
  for (const kw of OPPORTUNITY_KEYWORDS) {
    if (containsWord(combined, kw)) signals++;
  }

  return signals >= 1;
}

function isGovernanceNoise(name: string, desc: string): boolean {
  const combined = `${name} ${desc}`;

  for (const kw of GOVERNANCE_KEYWORDS) {
    if (containsWord(combined, kw)) return true;
  }

  return false;
}

// ============================================================
// Batch Scoring
// ============================================================

/**
 * Score an array of entries and return them sorted by quality.
 */
export function scoreAndSort(
  entries: Array<{
    name: string;
    description: string | null;
    amount: string | null;
    deadline: string | null;
    scanDate?: string;
  }>
): Array<{
  entry: (typeof entries)[number];
  score: QualityBreakdown;
}> {
  return entries
    .map((entry) => ({
      entry,
      score: scoreEntry(entry),
    }))
    .sort((a, b) => b.score.totalScore - a.score.totalScore);
}

/**
 * Filter entries by minimum quality score.
 */
export function filterByQuality<T extends { qualityScore: number | null }>(
  entries: T[],
  minScore: number
): T[] {
  return entries.filter(
    (e) => e.qualityScore !== null && e.qualityScore >= minScore
  );
}
