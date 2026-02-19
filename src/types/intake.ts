/**
 * Types for the scan intake, deduplication, and quality scoring pipeline.
 * These extend the existing grant-wire-summarizer type system.
 */

// Wire values are dynamic (driven by feeds table), so we use string

// Which prompt variant produced this result
export type PromptVariant = 'A' | 'B' | 'C';

// Prompt strategy labels (for human readability)
export type PromptStrategy = 'Action' | 'Landscape' | 'Open Sweep';

// Where the result came from
export type ScanSource = 'x-scan' | 'web-search';

// Processing state for scan results as they move through the pipeline
export type ScanStatus =
  | 'raw'           // Just ingested, no processing yet
  | 'deduped'       // Passed dedup check (unique)
  | 'duplicate'     // Flagged as duplicate
  | 'scored'        // Quality score assigned
  | 'queued'        // Ready for AI enrichment (passed quality threshold)
  | 'enriched'      // AI summary generated
  | 'published'     // Included in a newsletter output
  | 'archived';     // Below quality threshold, kept for reference

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
