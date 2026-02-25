/**
 * Quality Scoring Service
 *
 * Assigns a 0-100 quality score to each scan entry based on:
 * - Whether it has a dollar amount (+25)
 * - Whether the amount is above a meaningful threshold (+15)
 * - Whether it has a deadline (+15)
 * - Whether the deadline is upcoming/actionable (+10)
 * - Whether it's a real funding opportunity vs governance/news (+20)
 * - Whether someone can actually apply to it (+15)
 *
 * Scores are used to:
 * - Filter the daily briefing (only high quality items)
 * - Prioritize entries for AI enrichment
 * - Determine what goes in the weekly newsletter
 */

import type { QualityBreakdown, ScanEntry } from '../types/intake';
import { parseAmount, parseDeadline } from './intake';

// ============================================================
// Entry Type Classification
// ============================================================

/**
 * Types that represent real, actionable funding opportunities.
 * These get the full "is funding opportunity" bonus.
 */
const FUNDING_TYPES = new Set([
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

/**
 * Types that are actionable (someone can participate) but aren't
 * pure funding. They get a partial bonus.
 */
const ACTIONABLE_TYPES = new Set([
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
 */
export function scoreEntry(entry: {
  name: string;
  description: string | null;
  amount: string | null;
  deadline: string | null;
  scanDate?: string;
}): QualityBreakdown {
  let totalScore = 0;
  const penalties: string[] = [];
  const desc = (entry.description || '').toLowerCase();
  const name = entry.name.toLowerCase();

  // ---- Has Amount: +25 ----
  const hasAmount = !!entry.amount && entry.amount.trim() !== '';
  if (hasAmount) totalScore += 25;

  // ---- Amount Above Threshold: +15 ----
  let amountAboveThreshold = false;
  if (hasAmount) {
    const parsed = parseAmount(entry.amount);
    if (parsed && parsed.numeric >= 5000) {
      amountAboveThreshold = true;
      totalScore += 15;
    } else if (parsed && parsed.numeric < 1000) {
      // Tiny amounts get a small penalty
      penalties.push(`Small amount: ${entry.amount}`);
      totalScore -= 5;
    }
  }

  // ---- Has Deadline: +15 ----
  const hasDeadline =
    !!entry.deadline &&
    entry.deadline !== 'Rolling' &&
    entry.deadline !== 'None listed' &&
    entry.deadline.trim() !== '';
  if (hasDeadline) totalScore += 15;

  // Rolling deadlines get a partial bonus
  if (entry.deadline === 'Rolling') totalScore += 5;

  // ---- Deadline Upcoming: +10 ----
  let deadlineUpcoming = false;
  if (hasDeadline) {
    const parsed = parseDeadline(entry.deadline);
    if (parsed) {
      const now = entry.scanDate ? new Date(entry.scanDate) : new Date();
      const daysUntil =
        (parsed.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

      if (daysUntil >= 0 && daysUntil <= 60) {
        deadlineUpcoming = true;
        totalScore += 10;
      } else if (daysUntil < 0) {
        // Expired deadline is a penalty
        penalties.push('Deadline has passed');
        totalScore -= 10;
      }
    }
  }

  // ---- Is Funding Opportunity: +20 ----
  const isFundingOpportunity = classifyAsFunding(name, desc);
  if (isFundingOpportunity) {
    totalScore += 20;
  }

  // ---- Is Actionable: +15 ----
  const isActionable = classifyAsActionable(name, desc);
  if (isActionable) {
    totalScore += 15;
  }

  // ---- Penalties ----

  // Governance/DAO proposals that aren't actually grants
  if (isGovernanceNoise(name, desc)) {
    totalScore -= 15;
    penalties.push('Governance/DAO noise');
  }

  // "Awarded" entries (already happened, not actionable)
  if (desc.includes('awarded to') || desc.includes('received') || desc.includes('was granted')) {
    if (!isActionable && !isFundingOpportunity) {
      totalScore -= 10;
      penalties.push('Already awarded (not open)');
    }
  }

  // Very short/vague descriptions
  if (!entry.description || entry.description.length < 30) {
    totalScore -= 5;
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
function containsWord(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

function classifyAsFunding(name: string, desc: string): boolean {
  const combined = `${name} ${desc}`;

  for (const type of FUNDING_TYPES) {
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

  // If it's a funding type, it's automatically actionable
  for (const type of FUNDING_TYPES) {
    if (containsWord(combined, type)) return true;
  }

  // Check actionable types
  for (const type of ACTIONABLE_TYPES) {
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
