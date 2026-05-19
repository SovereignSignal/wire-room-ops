/**
 * Types for the scan intake, deduplication, and quality scoring pipeline.
 * These extend the existing wire-room-ops type system.
 */

// Wire values are dynamic (driven by feeds table), so we use string

// Which prompt variant produced this result
export type PromptVariant = 'A' | 'B' | 'C' | 'W' | 'P' | 'N' | 'S';

// Prompt strategy labels (for human readability)
export type PromptStrategy = 'Action' | 'Landscape' | 'Open Sweep';

// Which Grok tool to use for scan execution
export type ToolType = 'x_search' | 'web_search' | 'perplexity';

// Where the result came from
export type ScanSource = 'x-scan' | 'web-search' | 'perplexity' | 'telegram' | 'telegram-intake' | 'manual-intake' | 'email' | 'forum';

// Processing state for scan results as they move through the pipeline
export type ScanStatus =
  | 'raw'           // Just ingested, no processing yet
  | 'deduped'       // Passed dedup check (unique)
  | 'duplicate'     // Flagged as duplicate
  | 'queued'        // Ready for operator review
  | 'enriched'      // AI summary generated
  | 'published'     // Included in a newsletter output
  | 'archived'      // Below quality threshold, kept for reference
  | 'skipped'       // Manually skipped by user
  | 'approved'      // Approved for publication + distribution
  | 'declined';     // Rejected by reviewer

// Output format for scan prompts
export type OutputFormat = 'text' | 'json';

// Prompt intent classification
export type PromptIntent = 'discovery' | 'canonical' | 'signal';

/**
 * A single result as parsed from a structured scan output.
 * This is the raw intake format before any processing.
 */
export interface RawScanResult {
  name: string;
  description: string;
  deadline: string | null;    // "Rolling", "None listed", or a date string
  sourceUrl: string;          // The X post URL or web page URL
  amount: string | null;      // Dollar amount if mentioned, raw string
  sourcePublishedAt?: string | null;  // ISO date from source (e.g. forum post date)
}

/**
 * A complete scan submission: all results from one prompt run.
 */
export interface ScanSubmission {
  wire: string;
  promptVariant: PromptVariant;
  scanDate: string;           // ISO date string (YYYY-MM-DD)
  source: ScanSource;
  results: RawScanResult[];
  promptId?: string;          // UUID of the scan_prompt that produced these results
  submittedBy?: string;       // Who submitted (e.g. 'telegram:12345', 'email:user@example.com')
  rawOutput?: string;         // Full raw API response text (before parsing)
  parseStrategy?: string;     // Which parser matched ('structured_text', 'json', 'x_post', 'lenient_list', 'none')
}

/**
 * A scan result after it's been stored in the database.
 * Includes all metadata and processing state.
 */
export interface ScanEntry {
  id: number;
  name: string;
  description: string;
  sourceUrl: string;
  amount: string | null;
  amountNumeric: number | null;     // Parsed dollar amount for sorting/filtering
  amountCurrency: string | null;    // USD, EUR, GBP, INR, etc.
  deadline: string | null;
  deadlineParsed: Date | null;      // Parsed deadline for sorting
  wire: string;
  promptVariant: PromptVariant;
  scanSource: ScanSource;
  scanDate: Date;
  status: ScanStatus;
  qualityScore: number | null;      // 0-100 quality score
  duplicateOfId: number | null;     // Points to the original if this is a dupe
  duplicateReason: string | null;   // Why it was flagged as duplicate
  submittedBy: string | null;       // Who submitted (e.g. 'telegram:12345', 'email:user@example.com')
  sourcePublishedAt: Date | null;   // When the source was originally published
  distributable: boolean;           // Whether this entry should be included in distribution
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Result of a dedup check against a single entry.
 */
export interface DedupResult {
  isDuplicate: boolean;
  matchType: 'url_exact' | 'name_fuzzy' | 'url_and_name' | null;
  matchedEntryId: number | null;
  matchedEntryName: string | null;
  confidence: number;               // 0-1 confidence in the match
  reason: string;
}

/**
 * Review-visible relation to prior material. This is deliberately softer than
 * DedupResult: related entries stay in the queue unless exact URL dedup catches
 * them elsewhere.
 */
export interface RelatedOpportunityResult {
  isRelated: boolean;
  relationType: 'alternate_source' | 'sibling_track' | null;
  matchedEntryId: number | null;
  matchedEntryName: string | null;
  matchedSourceUrl: string | null;
  matchedStatus: ScanStatus | null;
  confidence: number;
  reason: string;
}

/**
 * Quality score breakdown for a single entry.
 */
export interface QualityBreakdown {
  totalScore: number;               // 0-100
  hasAmount: boolean;               // +25 points
  amountAboveThreshold: boolean;    // +15 points (above $5K)
  hasDeadline: boolean;             // +15 points
  deadlineUpcoming: boolean;        // +10 points (within 60 days)
  isFundingOpportunity: boolean;    // +20 points (grant/fellowship/hackathon vs governance/news)
  isActionable: boolean;            // +15 points (something someone can apply to)
  penalties: string[];              // Reasons for score deductions
}

/**
 * Summary of a daily intake run.
 */
export interface IntakeRunSummary {
  runDate: string;
  wire: string | 'all';
  totalIngested: number;
  duplicatesFound: number;
  newUnique: number;
  averageQualityScore: number;
  highQualityCount: number;         // Score >= 60
  byPrompt: Record<string, {
    total: number;
    duplicates: number;
    newUnique: number;
    avgScore: number;
  }>;
  topFinds: ScanEntry[];            // Top 10 by quality score
}

/**
 * Configuration for the daily intake job.
 */
export interface IntakeJobConfig {
  wire?: string;                     // Filter to specific wire, or all
  qualityThreshold: number;         // Minimum score to enter the queue (default: 40)
  dedupeWindow: number;             // Days to look back for duplicates (default: 14)
  sendBriefing: boolean;            // Email daily briefing
  briefingMinScore: number;         // Minimum score for briefing inclusion (default: 60)
}

/**
 * The structured output format our Grok prompts now produce.
 * Used for parsing raw text input.
 */
export interface StructuredPromptOutput {
  entries: Array<{
    name: string;
    description: string;
    deadline: string;
    link: string;
  }>;
  totalCount: number;
}

/**
 * Seen URL record for fast dedup lookups.
 */
export interface SeenUrl {
  url: string;
  normalizedUrl: string;
  firstSeenEntryId: number;
  firstSeenDate: Date;
  wire: string;
}

/**
 * Seen name record for fuzzy matching.
 */
export interface SeenName {
  nameNormalized: string;
  entryId: number;
  wire: string;
  firstSeen: Date;
}

// --- Scoring experiment types ---

/**
 * Tunable parameters for the quality scorer.
 * All values are integers. Weights are points added/subtracted; thresholds are numeric limits.
 */
export interface ScoringParams {
  // Base weights
  w_has_amount: number;
  w_amount_threshold: number;
  w_has_deadline: number;
  w_deadline_upcoming: number;
  w_funding_opportunity: number;
  w_actionable: number;

  // Penalties (negative values)
  p_governance_noise: number;
  p_already_awarded: number;
  p_vague_description: number;
  p_small_amount: number;

  // Thresholds
  t_amount_min: number;
  t_amount_tiny: number;
  t_deadline_window_days: number;
  t_rolling_bonus: number;

  // Queue threshold
  t_queue_min_score: number;
}

export interface ParamRange {
  min: number;
  max: number;
}

export const PARAM_RANGES: Record<keyof ScoringParams, ParamRange> = {
  w_has_amount:          { min: 10, max: 40 },
  w_amount_threshold:    { min: 5,  max: 30 },
  w_has_deadline:        { min: 5,  max: 25 },
  w_deadline_upcoming:   { min: 0,  max: 20 },
  w_funding_opportunity: { min: 10, max: 35 },
  w_actionable:          { min: 5,  max: 25 },

  p_governance_noise:    { min: -30, max: 0 },
  p_already_awarded:     { min: -25, max: 0 },
  p_vague_description:   { min: -15, max: 0 },
  p_small_amount:        { min: -15, max: 0 },

  t_amount_min:          { min: 1000,  max: 25000 },
  t_amount_tiny:         { min: 100,   max: 5000 },
  t_deadline_window_days:{ min: 14,    max: 120 },
  t_rolling_bonus:       { min: 0,     max: 15 },

  t_queue_min_score:     { min: 20, max: 70 },
};

/**
 * Hard constraints that no mutation may violate.
 */
export const PARAM_CONSTRAINTS = {
  /** Sum of positive weights must be >= 60 */
  MIN_POSITIVE_WEIGHT_SUM: 60,
  /** Sum of positive weights must be <= 130 */
  MAX_POSITIVE_WEIGHT_SUM: 130,
  /** Maximum mutations per experiment */
  MAX_MUTATIONS_PER_EXPERIMENT: 3,
  /** Minimum experiment duration in hours */
  MIN_EXPERIMENT_HOURS: 48,
  /** Maximum experiment duration in hours */
  MAX_EXPERIMENT_HOURS: 168,
  /** Auto-rollback if approval rate drops below this */
  MIN_APPROVAL_RATE: 0.15,
} as const;

export interface ExperimentResults {
  approval_rate: number;
  engagement_rate: number;
  editorial_efficiency: number;
  composite_score: number;
}

export interface ScoringExperiment {
  id: string;
  name: string;
  status: 'pending' | 'active' | 'completed' | 'rolled_back' | 'aborted';
  params: ScoringParams;
  parent_experiment_id: string | null;
  mutation_description: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  min_duration_hours: number;
  results: ExperimentResults | null;
  entry_count: number;
  approved_count: number;
  declined_count: number;
  created_at: Date;
  created_by: string;
}

// --- Distribution types ---

export type DistributionChannel = 'telegram' | 'discord' | 'slack' | 'x' | 'newsletter';
export type DistributionStatus = 'pending' | 'success' | 'failed' | 'skipped';

export interface DistributionConfig {
  wire: string;
  channel: DistributionChannel;
  enabled: boolean;
  config: Record<string, string>;
}

export interface DistributionLog {
  id: number;
  entryId: number;
  channel: DistributionChannel;
  channelId: string | null;
  wire: string;
  status: DistributionStatus;
  postText: string | null;
  externalId: string | null;
  errorMessage: string | null;
  createdAt: Date;
}

export interface GeneratedPosts {
  tweet: string;
  telegram: string;
}

