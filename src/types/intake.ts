/**
 * Types for the scan intake, deduplication, and quality scoring pipeline.
 * These extend the existing wire-room-ops type system.
 */

import type { ProgramResolutionStamp } from '../services/program-identity';

// Wire values are dynamic (driven by feeds table), so we use string

// Which prompt variant produced this result. This list also drives the route
// validators and database CHECK constraints.
export const PROMPT_VARIANTS = ['A', 'B', 'C', 'W', 'P', 'N', 'S'] as const;
export type PromptVariant = typeof PROMPT_VARIANTS[number];

// Prompt strategy labels (for human readability)
export type PromptStrategy = 'Action' | 'Landscape' | 'Open Sweep';

// ─── Canonical enum lists ───────────────────────────────────────────────────
// These consts are THE single source of truth for every DB CHECK constraint,
// TypeScript union, and route validator that touches these columns. The DDL in
// src/db/index.ts interpolates them via sqlEnumList(), so a value added here
// automatically lands in every constraint writer — the June-2026 drift class
// (multiple hand-maintained lists falling out of sync) is impossible by
// construction. tests/enum-lockstep.test.js pins this wiring.

/** Render an enum list for SQL: ['a','b'] -> "'a', 'b'" */
export function sqlEnumList(values: readonly string[]): string {
  return values.map(v => `'${v}'`).join(', ');
}

// Which provider/tool a scan prompt can use. TOOL_TYPES is what the API
// accepts for new prompts; TOOL_TYPES_DB additionally allows legacy
// 'community' rows that still exist in the database.
export const TOOL_TYPES = ['x_search', 'web_search', 'perplexity', 'parallel'] as const;
export type ToolType = typeof TOOL_TYPES[number];
export const TOOL_TYPES_DB = [...TOOL_TYPES, 'community'] as const;

// Production scan calls feed the daily run ledger. Prompt Lab calls use a
// separate purpose so experiments cannot create false production incidents.
export type ScanUsagePurpose = 'scan' | 'scan-test';

// Where a result came from.
export const SCAN_SOURCES = ['x-scan', 'grok-scout', 'web-search', 'perplexity', 'community', 'telegram', 'telegram-intake', 'manual-intake', 'email', 'forum', 'x-monitor', 'x-list', 'feed', 'claude-code', 'claude-cohort-notion', 'known-org-watch', 'stringer'] as const;
export type ScanSource = typeof SCAN_SOURCES[number];

// Processing state for scan results as they move through the pipeline:
// raw (just ingested) -> deduped -> queued (operator review) -> approved/declined;
// side states: duplicate, incomplete (failed Gate 1), archived (off-scope/NOISE),
// skipped (review-later), enriched (AI summary generated), published (newsletter).
export const SCAN_STATUSES = ['raw', 'deduped', 'duplicate', 'queued', 'enriched', 'published', 'archived', 'skipped', 'approved', 'declined', 'incomplete'] as const;
export type ScanStatus = typeof SCAN_STATUSES[number];

// Watch-surface kinds for the Watchtower registry (watch_surfaces table).
// Same single-source-of-truth pattern as SCAN_SOURCES: the DDL CHECK derives
// from this const via sqlEnumList().
export const SURFACE_TYPES = ['grants_page', 'blog', 'forum', 'rss', 'application', 'website', 'x_account', 'github', 'career_page', 'telegram', 'news_rss', 'api'] as const;
export type SurfaceType = typeof SURFACE_TYPES[number];

// node-cron schedule types the scheduler dispatches (see scheduler.ts).
// deadline-digest retired 2026-07-09 — closing-soon now folds into the daily digest.
export const SCHEDULE_TYPES = ['scan-execution', 'forum-scan', 'daily-digest', 'account-monitor', 'source-feeds'] as const;
export type ScheduleType = typeof SCHEDULE_TYPES[number];

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
  metadata?: Record<string, unknown>; // Producer audit fields persisted as JSONB
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
  matchType: 'url_exact' | 'name_exact' | 'name_fuzzy' | 'program' | null;
  matchedEntryId: number | null;
  matchedEntryName: string | null;
  confidence: number;               // 0-1 confidence in the match
  reason: string;
  /** Program-identity resolution (Layer 1.75) — present when the gate ran and matched, even on non-duplicate outcomes. */
  programResolution?: ProgramResolutionStamp | null;
  /** Prior cycle on the same official URL. Set when URL-exact matches a known page but the incoming name/deadline is a new numbered or seasonal cutoff. The entry is NOT a duplicate. */
  priorCycle?: { entryId: number; name: string } | null;
  /**
   * Same round as a declined prior that no longer holds the URL (premature or
   * unverified decline, or a later official source). The entry is NOT a
   * duplicate. Distinct from priorCycle so Gate 2's new-cycle guard stays off.
   */
  resurfacedDecline?: { entryId: number; name: string } | null;
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
  /** Forum rows not inserted because the topic URL already exists on scan_entries. */
  skippedAlreadySeen?: number;
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
/** Exact-name dedup lookback used by process-raw, scan intake, and summary-sync. */
export const DEFAULT_DEDUPE_WINDOW_DAYS = 180;

export interface IntakeJobConfig {
  wire?: string;                     // Filter to specific wire, or all
  qualityThreshold: number;         // Minimum score to enter the queue (default: 40)
  dedupeWindow: number;             // Days to look back for duplicates (default: 180)
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

// --- Distribution types ---

export type DistributionChannel = 'telegram' | 'discord' | 'slack' | 'x' | 'newsletter';
export type DistributionStatus = 'pending' | 'success' | 'failed' | 'skipped' | 'acknowledged';

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
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  acknowledgedReason: string | null;
}

export interface GeneratedPosts {
  tweet: string;
  telegram: string;
}
