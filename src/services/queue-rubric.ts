/**
 * Queue Decision Rubric
 * 
 * Determines confidence level for autonomous approve/decline decisions.
 * SURE_APPROVE and SURE_DECLINE can be executed autonomously.
 * UNSURE surfaces to Sov for manual review.
 */

export type DecisionConfidence = 'SURE_APPROVE' | 'SURE_DECLINE' | 'UNSURE';

export interface QueueEntry {
  id: number;
  name: string;
  description: string | null;
  sourceUrl: string | null;
  wire: string;
  scanSource: string;
  qualityScore: number | null;
  classification: string | null;
  tags: string[] | null;
  deadline: string | null;
  amount: string | null;
  created_at: Date;
}

export interface RubricDecision {
  confidence: DecisionConfidence;
  action: 'approve' | 'decline' | 'review';
  reason: string;
  factors: string[];
}

// Programs that are always worth approving (major ecosystems, credible orgs)
const TIER_1_ORGS = [
  // Major crypto foundations
  'Ethereum Foundation', 'Solana Foundation', 'Arbitrum Foundation', 'Optimism', 
  'Optimism Foundation', 'Polygon', 'Avalanche Foundation', 'Sui Foundation',
  'Starknet Foundation', 'Interledger', 'Filecoin Foundation', 'Zcash Foundation',
  'Bitcoin', 'Ethereum', 'Optimism', 'Arbitrum', 'Solana', 'Sui', 'Starknet',
  // Major AI/tech funders
  'DARPA', 'Google.org', 'Google DeepMind', 'OpenAI', 'Anthropic', 'Microsoft',
  'Linux Foundation', 'Foresight Institute', 'Human Rights Foundation', 'HRF',
  // Major OSS funders
  'Mozilla', 'Apache', 'Open Source Initiative', 'Software Freedom Conservancy',
];

// Programs that are too niche/regional for the wire
const REGIONAL_NICHE_PATTERNS = [
  // Regional hackathons
  /hackathon.*(india|africa|nigeria|kenya|lagos|mumbai|delhi|bangalore)/i,
  /regional hackathon/i,
  /university hackathon/i,
  /college hackathon/i,
  // Regional programs
  /fellowship.*(india|africa|nigeria|kenya)/i,
  /program.*(india|africa|nigeria|kenya)/i,
  // Too niche
  /bug bounty/i,
  /bug of the year/i,
  /ctf\b/i,
  /capture the flag/i,
  // Competitions/awards (not grants)
  /competition$/i,
  /award$/i,
  /challenge$/i,
];

// Programs that are already over or expired
const EXPIRED_PATTERNS = [
  /2024\b/,
  /2025\b(?!-\d{2})/,  // 2025 alone, not 2025-2026
  /results announced/i,
  /winners announced/i,
  /closed$/i,
  /completed$/i,
];

// Aggregator/listicle patterns
const AGGREGATOR_PATTERNS = [
  /^\d+\s+(grants|programs|fellowships|opportunities)/i,
  /top \d+ /i,
  /best \d+ /i,
  /complete (guide|list)/i,
  /ultimate (guide|list)/i,
  /comprehensive (guide|list)/i,
];

// Low-value indicators
const LOW_VALUE_PATTERNS = [
  /\$[\d,]{1,4}[\s]/,  // Under $10k prize pool
  /\$[\d,]{1,3}\s*(prize|pool|award)/i,
  /micro.?grant/i,
  /small grant/i,
];

/**
 * Evaluate an entry against the rubric
 */
export function evaluateRubric(entry: QueueEntry): RubricDecision {
  const factors: string[] = [];
  let approveScore = 0;
  let declineScore = 0;

  // === QUALITY SCORE ===
  if (entry.qualityScore !== null) {
    if (entry.qualityScore >= 70) {
      factors.push(`quality_score=${entry.qualityScore} (high)`);
      approveScore += 2;
    } else if (entry.qualityScore >= 60) {
      factors.push(`quality_score=${entry.qualityScore} (good)`);
      approveScore += 1;
    } else if (entry.qualityScore < 30) {
      factors.push(`quality_score=${entry.qualityScore} (low)`);
      declineScore += 2;
    } else if (entry.qualityScore < 50) {
      factors.push(`quality_score=${entry.qualityScore} (marginal)`);
      declineScore += 1;
    }
  }

  // === CLASSIFICATION ===
  if (entry.classification === 'GRANT' || entry.classification === 'FELLOWSHIP') {
    factors.push(`classification=${entry.classification}`);
    approveScore += 1;
  } else if (entry.classification === 'NEWS') {
    // NEWS can be approved if it's about a program launch/funding announcement
    factors.push(`classification=NEWS (context-dependent)`);
    // Don't add to approveScore, need manual check
  } else if (entry.classification === 'EXPIRED') {
    factors.push(`classification=EXPIRED`);
    declineScore += 3;
  }

  // === TIER 1 ORGANIZATION CHECK ===
  const nameAndTags = `${entry.name} ${(entry.tags || []).join(' ')}`;
  const isTier1 = TIER_1_ORGS.some(org => 
    nameAndTags.toLowerCase().includes(org.toLowerCase())
  );
  if (isTier1) {
    factors.push(`tier1_org detected`);
    approveScore += 2;
  }

  // === REGIONAL/NICHE CHECK ===
  for (const pattern of REGIONAL_NICHE_PATTERNS) {
    if (pattern.test(entry.name) || (entry.description && pattern.test(entry.description))) {
      factors.push(`regional_niche match: ${pattern}`);
      declineScore += 2;
    }
  }

  // === EXPIRED CHECK ===
  for (const pattern of EXPIRED_PATTERNS) {
    if (pattern.test(entry.name)) {
      factors.push(`expired_pattern match: ${pattern}`);
      declineScore += 2;
    }
  }

  // === AGGREGATOR CHECK ===
  for (const pattern of AGGREGATOR_PATTERNS) {
    if (pattern.test(entry.name)) {
      factors.push(`aggregator_pattern match: ${pattern}`);
      declineScore += 2;
    }
  }

  // === LOW VALUE CHECK ===
  for (const pattern of LOW_VALUE_PATTERNS) {
    if (pattern.test(entry.name) || (entry.description && pattern.test(entry.description))) {
      factors.push(`low_value match: ${pattern}`);
      declineScore += 1;
    }
  }

  // === HACKATHON SCOPING ===
  const isHackathon = /hackathon/i.test(entry.name);
  if (isHackathon) {
    // Only approve global hackathons from credible organizers
    const isGlobal = /global|worldwide|international/i.test(entry.name);
    const hasCredibleOrg = TIER_1_ORGS.some(org => 
      nameAndTags.toLowerCase().includes(org.toLowerCase())
    );
    
    if (!isGlobal && !hasCredibleOrg) {
      factors.push(`hackathon_regional_or_small`);
      declineScore += 1;
    } else if (isGlobal || hasCredibleOrg) {
      factors.push(`hackathon_credible`);
      approveScore += 1;
    }
  }

  // === SOURCE QUALITY ===
  const sourceQuality: Record<string, number> = {
    'x-scan': 1.0,      // 52% approval rate
    'forum': 0.7,       // Medium quality
    'web-search': 0.5,  // Mixed
    'telegram': 0.35,   // 28% approval rate, very noisy
    'perplexity': 0.3,  // 31% approval rate, recency issues
  };
  const sourceWeight = sourceQuality[entry.scanSource] || 0.5;
  if (sourceWeight < 0.4) {
    factors.push(`noisy_source: ${entry.scanSource}`);
    declineScore += 0.5;
  }

  // === DEADLINE CHECK ===
  if (entry.deadline) {
    const deadline = new Date(entry.deadline);
    const now = new Date();
    const daysUntil = (deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    
    if (daysUntil < 0) {
      factors.push(`deadline_passed`);
      declineScore += 2;
    } else if (daysUntil < 7) {
      factors.push(`deadline_soon: ${Math.floor(daysUntil)} days`);
      // Urgent but not auto-decline
    } else {
      factors.push(`deadline_valid: ${Math.floor(daysUntil)} days`);
    }
  } else {
    // No deadline is OK for rolling programs, but needs scrutiny
    if (entry.classification === 'GRANT') {
      factors.push(`no_deadline (rolling program OK)`);
    } else {
      factors.push(`no_deadline (needs context)`);
    }
  }

  // === FINAL DECISION ===
  let confidence: DecisionConfidence;
  let action: 'approve' | 'decline' | 'review';
  let reason: string;

  if (declineScore >= 3) {
    confidence = 'SURE_DECLINE';
    action = 'decline';
    reason = `Decline factors outweigh (decline=${declineScore}, approve=${approveScore})`;
  } else if (approveScore >= 3 && declineScore < 2) {
    confidence = 'SURE_APPROVE';
    action = 'approve';
    reason = `Strong approval signals (approve=${approveScore}, decline=${declineScore})`;
  } else {
    confidence = 'UNSURE';
    action = 'review';
    reason = `Mixed signals (approve=${approveScore}, decline=${declineScore})`;
  }

  return {
    confidence,
    action,
    reason,
    factors,
  };
}

/**
 * Batch evaluate entries
 */
export function batchEvaluate(entries: QueueEntry[]): Map<number, RubricDecision> {
  const results = new Map<number, RubricDecision>();
  for (const entry of entries) {
    results.set(entry.id, evaluateRubric(entry));
  }
  return results;
}