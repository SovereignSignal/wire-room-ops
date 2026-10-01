/**
 * Daily Intake Job
 *
 * The main orchestrator that ties together intake, dedup, and scoring.
 * Processes raw scan submissions through the full pipeline:
 *
 * 1. Parse structured text into RawScanResult[]
 * 2. Insert as scan_entries with status='raw'
 * 3. Run dedup against seen_urls and seen_names
 * 4. Score unique entries for quality
 * 5. Update status based on score (queued vs archived)
 * 6. Register new entries in seen tables
 * 7. Generate summary report
 *
 * Can be triggered manually from the dashboard or run on schedule.
 */

import type { Pool } from 'pg';
import {
  DEFAULT_DEDUPE_WINDOW_DAYS,
  type PromptVariant,
  type RawScanResult,
  type ScanSource,
  type ScanSubmission,
  type ScanEntry,
  type IntakeRunSummary,
  type IntakeJobConfig,
} from '../types/intake';
import {
  parseStructuredOutput,
  parseAmount,
  parseDeadline,

  normalizeName,
  extractNameTokens,
  isUsefulUrl,
} from '../services/intake';
import { findRelatedOpportunity, finalizeExistingEntryDedup, annotateAlternateSource } from '../services/dedup';
// quality-scorer.ts replaced by LLM scoring in classifier.ts
import { seedSeenUrlsFromMessages } from '../db';
import { finalizeProgramForEntry } from '../services/program-identity';
import type { ProgramResolutionStamp } from '../services/program-identity';
import { applyKnownProgramCycleGuard, type Classification } from '../services/classifier';

// ============================================================
// Default Configuration
// ============================================================

const DEFAULT_CONFIG: IntakeJobConfig = {
  qualityThreshold: 40,
  dedupeWindow: DEFAULT_DEDUPE_WINDOW_DAYS,
  sendBriefing: false,
  briefingMinScore: 60,
};

const STALE_GRANTS_GOV_SOURCE_DAYS = 30;
const URGENT_DEADLINE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

type EntryStatusAfterFreshnessGate = 'queued' | 'archived';

export interface SourceFreshnessGateInput {
  sourceUrl?: string | null;
  sourcePublishedAt?: string | Date | null;
  deadlineParsed?: string | Date | null;
  classification: Classification;
}

export interface SourceFreshnessGateDecision {
  status: EntryStatusAfterFreshnessGate;
  metadata: Record<string, unknown>;
}

function parseOptionalDate(value?: string | Date | null): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isGrantsGovOpportunityUrl(sourceUrl?: string | null): boolean {
  if (!sourceUrl) return false;
  try {
    const url = new URL(sourceUrl);
    const host = url.hostname.replace(/^www\./, '');
    return host === 'grants.gov' || host.endsWith('.grants.gov');
  } catch {
    return false;
  }
}

/**
 * Keep old Grants.gov listings out of the active queue unless they are urgent.
 * These are still real opportunities, but a 30+ day old federal listing should
 * not appear as a fresh publish candidate months before its close date.
 */
export function applySourceFreshnessGate(
  input: SourceFreshnessGateInput,
  now = new Date(),
): SourceFreshnessGateDecision {
  const baseStatus: EntryStatusAfterFreshnessGate = input.classification === 'NOISE' ? 'archived' : 'queued';
  const metadata: Record<string, unknown> = {};

  const sourcePublishedAt = parseOptionalDate(input.sourcePublishedAt);
  if (!isGrantsGovOpportunityUrl(input.sourceUrl) || !sourcePublishedAt) {
    return { status: baseStatus, metadata };
  }

  const ageDays = Math.floor((now.getTime() - sourcePublishedAt.getTime()) / DAY_MS);
  if (ageDays <= STALE_GRANTS_GOV_SOURCE_DAYS) {
    return { status: baseStatus, metadata };
  }

  const deadline = parseOptionalDate(input.deadlineParsed);
  const daysToDeadline = deadline ? Math.ceil((deadline.getTime() - now.getTime()) / DAY_MS) : null;
  const freshnessGate = {
    source: 'grants.gov',
    source_published_at: sourcePublishedAt.toISOString(),
    age_days: ageDays,
    days_to_deadline: daysToDeadline,
  };

  if (daysToDeadline !== null && daysToDeadline >= 0 && daysToDeadline <= URGENT_DEADLINE_DAYS) {
    return {
      status: baseStatus,
      metadata: {
        freshness_label: 'current_open_listing',
        freshness_gate: {
          ...freshnessGate,
          action: 'kept_due_to_near_deadline',
          reason: 'Older Grants.gov listing kept visible because the deadline is near.',
        },
      },
    };
  }

  return {
    status: 'archived',
    metadata: {
      operator_route: 'park',
      archived_reason: 'stale_grants_gov_current_listing',
      freshness_label: 'current_open_listing_old_source',
      freshness_gate: {
        ...freshnessGate,
        action: 'archived_from_active_queue',
        reason: 'Grants.gov listing is older than 30 days and not deadline-urgent; keep it out of the fresh review queue.',
      },
    },
  };
}

// ============================================================
// Main Job Function
// ============================================================

export interface IntakeJobOptions {
  config?: Partial<IntakeJobConfig>;
  onProgress?: (message: string, pct: number) => void;
  /** Insert raw entries and return immediately. The background raw processor
   *  (process-raw, every 5 min) handles dedup/classify/queue. Used for agent
   *  API submissions so the HTTP request returns fast instead of holding the
   *  connection through synchronous LLM classification. */
  insertOnly?: boolean;
}

/**
 * Process a batch of scan submissions through the full pipeline.
 *
 * @param pool - Postgres connection pool
 * @param submissions - Array of parsed scan submissions
 * @param options - Job configuration and callbacks
 * @returns IntakeRunSummary with full statistics
 */
export async function runDailyIntake(
  pool: Pool,
  submissions: ScanSubmission[],
  options: IntakeJobOptions = {}
): Promise<IntakeRunSummary> {
  if (submissions.some(submission => submission.source === 'x-monitor')) {
    throw new Error('x-monitor submissions must use the Account Monitor canonical-URL intake path');
  }
  const config = { ...DEFAULT_CONFIG, ...options.config };
  const progress = options.onProgress || (() => {});

  const runDate = submissions[0]?.scanDate || new Date().toISOString().split('T')[0];
  // Determine wire: if all submissions share the same wire, use it; otherwise 'all'
  const uniqueWires = new Set(submissions.map(s => s.wire));
  const wire = uniqueWires.size === 1 ? submissions[0].wire : 'all';

  // Seed seen_urls with URLs already in the wire (non-fatal)
  try {
    const seeded = await seedSeenUrlsFromMessages();
    if (seeded > 0) {
      console.log(`[Intake] Seeded ${seeded} URLs from existing wire content`);
    }
  } catch (err) {
    console.error('[Intake] Failed to seed seen_urls from messages (non-fatal):', err);
  }

  progress('Starting intake pipeline...', 0);

  // Flatten all results from all submissions
  const allResults: Array<{
    result: RawScanResult;
    wire: string;
    promptVariant: PromptVariant;
    scanSource: ScanSource;
    scanDate: string;
    promptId?: string;
    submittedBy?: string;
    rawOutput?: string;
    parseStrategy?: string;
  }> = [];

  for (const sub of submissions) {
    // Only store raw output on the first entry per submission to save space
    let isFirstEntry = true;
    for (const r of sub.results) {
      allResults.push({
        result: r,
        wire: sub.wire,
        promptVariant: sub.promptVariant,
        scanSource: sub.source,
        scanDate: sub.scanDate,
        promptId: sub.promptId,
        submittedBy: sub.submittedBy,
        rawOutput: isFirstEntry ? sub.rawOutput : undefined,
        parseStrategy: sub.parseStrategy,
      });
      isFirstEntry = false;
    }
  }

  progress(`Parsed ${allResults.length} total results from ${submissions.length} scans`, 5);

  // ---- Phase 1: Insert raw entries (batched) ----
  progress('Inserting raw entries...', 10);
  const insertedIds: number[] = [];

  // Build batched multi-row INSERT (chunks of 50 to stay within param limits)
  const BATCH_SIZE = 50;
  const COLS_PER_ROW = 18;

  for (let batchStart = 0; batchStart < allResults.length; batchStart += BATCH_SIZE) {
    const batch = allResults.slice(batchStart, batchStart + BATCH_SIZE);
    const values: (string | number | Date | null)[] = [];
    const valueClauses: string[] = [];

    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      const parsed = parseAmount(item.result.amount);
      const deadlineParsed = parseDeadline(item.result.deadline);
      const offset = i * COLS_PER_ROW;

      valueClauses.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, 'raw', $${offset + 13}, $${offset + 14}, $${offset + 15}, $${offset + 16}, $${offset + 17}, $${offset + 18})`
      );
      values.push(
        item.result.name,
        item.result.description,
        item.result.sourceUrl,
        item.result.amount,
        parsed?.numeric || null,
        parsed?.currency || null,
        item.result.deadline,
        deadlineParsed,
        item.wire,
        item.promptVariant,
        item.scanSource,
        item.scanDate,
        item.promptId || null,
        item.submittedBy || null,
        item.result.sourcePublishedAt || null,
        item.rawOutput || null,
        item.parseStrategy || null,
        item.result.metadata ? JSON.stringify(item.result.metadata) : null,
      );
    }

    const res = await pool.query(
      `INSERT INTO scan_entries
       (name, description, source_url, amount, amount_numeric, amount_currency,
        deadline, deadline_parsed, wire, prompt_variant, scan_source, scan_date, status, prompt_id, submitted_by, source_published_at, raw_output, parse_strategy, metadata)
       VALUES ${valueClauses.join(', ')}
       RETURNING id`,
      values
    );

    for (const row of res.rows) {
      insertedIds.push(row.id);
    }
  }

  progress(`Inserted ${insertedIds.length} raw entries`, 25);

  // ---- Phase 1.5: Gate 1 — Archive entries without usable source URLs ----
  // Must run BEFORE dedup so URL-less entries never pollute seen_urls/seen_names
  let archivedNoUrl = 0;
  const validIndices: number[] = [];

  for (let i = 0; i < allResults.length; i++) {
    const item = allResults[i];
    const entryId = insertedIds[i];
    const url = item.result.sourceUrl;

    if (!url || url.trim() === '' || !isUsefulUrl(url)) {
      await pool.query(
        `UPDATE scan_entries
         SET status = 'archived',
             metadata = COALESCE(metadata, '{}'::jsonb) || '{"archived_reason": "no_source_url"}'::jsonb
         WHERE id = $1`,
        [entryId]
      );
      archivedNoUrl++;
    } else {
      validIndices.push(i);
    }
  }

  if (archivedNoUrl > 0) {
    console.log(`[DailyIntake] Archived ${archivedNoUrl} entries with no source URL`);
  }

  progress(`Gate 1: ${archivedNoUrl} archived (no URL), ${validIndices.length} continue`, 28);

  // ---- Insert-only mode: leave entries raw for the background processor ----
  if (options.insertOnly) {
    progress(`Insert-only: ${validIndices.length} entries left raw for background processing`, 100);
    return {
      runDate: new Date().toISOString().slice(0, 10),
      wire: submissions.length === 1 ? submissions[0].wire : 'all',
      totalIngested: allResults.length,
      duplicatesFound: 0,
      newUnique: validIndices.length,
      averageQualityScore: 0,
      highQualityCount: 0,
      byPrompt: {},
      topFinds: [],
    };
  }

  // ---- Phase 2: Dedup (only entries with valid URLs) ----
  progress('Running deduplication...', 30);
  let duplicatesFound = 0;
  const uniqueEntryIds: number[] = [];
  const programResolutions = new Map<number, ProgramResolutionStamp | null>();
  const priorCycles = new Map<number, { entryId: number; name: string } | null>();

  for (const idx of validIndices) {
    const item = allResults[idx];
    const entryId = insertedIds[idx];

    const dedupOutcome = await finalizeExistingEntryDedup(pool, {
      id: entryId,
      sourceUrl: item.result.sourceUrl,
      name: item.result.name,
      wire: item.wire,
      scanDate: item.scanDate,
      expectedStatus: 'raw',
      deadline: item.result.deadline ?? null,
    }, config.dedupeWindow, { programGate: true });

    if (dedupOutcome.outcome === 'duplicate' || dedupOutcome.outcome === 'seed-conflict') {
      duplicatesFound++;
      continue;
    }
    if (dedupOutcome.outcome === 'stale') {
      console.log(`[DailyIntake] Entry ${entryId} changed during dedup; preserving operator state`);
      continue;
    }

    // The transaction above already set status=deduped. A soft related-source
    // annotation may enrich that state, but its compare-and-set cannot revive
    // a row changed by an operator while this lookup was running.
    const relatedResult = await findRelatedOpportunity(
      pool,
      {
        sourceUrl: item.result.sourceUrl,
        name: item.result.name,
        wire: item.wire,
      },
      config.dedupeWindow
    );
    if (relatedResult.isRelated) {
      await annotateAlternateSource(pool, entryId, item.result.sourceUrl, relatedResult);
    }
    uniqueEntryIds.push(entryId);
    // Finalize program identity only after classification establishes domain,
    // scope, and a validated deadline.
    programResolutions.set(entryId, dedupOutcome.programResolution ?? null);
    priorCycles.set(entryId, dedupOutcome.priorCycle ?? null);

    // Progress update every 10 entries
    if (duplicatesFound % 10 === 0 && duplicatesFound > 0) {
      const pct = 30 + Math.round((validIndices.indexOf(idx) / validIndices.length) * 30);
      progress(`Dedup: ${validIndices.indexOf(idx) + 1}/${validIndices.length} (${duplicatesFound} dupes so far)`, pct);
    }
  }

  progress(
    `Dedup complete: ${duplicatesFound} duplicates, ${uniqueEntryIds.length} unique`,
    60
  );

  // ---- Phase 3: Quality Scoring ----
  progress('Scoring entries...', 65);
  let totalScore = 0;
  let highQualityCount = 0;
  let scoredCount = 0;

  const { classifyEntry } = await import('../services/classifier');
  const classificationFailures: number[] = [];

  for (const entryId of uniqueEntryIds) {
    // Fetch the entry for classification + scoring (join prompt intent)
    const entryRes = await pool.query(
      `SELECT se.name, se.description, se.amount, se.deadline, se.deadline_parsed, se.scan_date,
              se.source_url, se.source_published_at, se.wire, se.operator_notes,
              sp.intent AS prompt_intent
       FROM scan_entries se
       LEFT JOIN scan_prompts sp ON se.prompt_id = sp.id
       WHERE se.id = $1 AND se.status = 'deduped'`,
      [entryId]
    );
    const entry = entryRes.rows[0];
    if (!entry) continue;

    // Gate 2: LLM classification + quality scoring (single call)
    try {
      const rawClassResult = await classifyEntry({
        name: entry.name,
        description: entry.description || '',
        source_url: entry.source_url || '',
        wire: entry.wire,
        intent: entry.prompt_intent || undefined,
        amount: entry.amount,
        deadlineParsed: entry.deadline_parsed,
        sourcePublishedAt: entry.source_published_at,
      });
      const classResult = applyKnownProgramCycleGuard(rawClassResult, {
        name: entry.name,
        sourceUrl: entry.source_url || '',
        intakeWire: entry.wire,
        priorCycle: priorCycles.get(entryId),
        operatorNotes: entry.operator_notes,
      });
      const cycleGuarded = classResult !== rawClassResult;
      const freshnessDecision = applySourceFreshnessGate({
        sourceUrl: entry.source_url,
        sourcePublishedAt: entry.source_published_at,
        deadlineParsed: entry.deadline_parsed,
        classification: classResult.classification,
      });
      const classStatus = freshnessDecision.status;
      const mergedMetadata = {
        ...classResult.extracted,
        operator_route: classResult.operatorRoute,
        ...freshnessDecision.metadata,
      };

      const classified = await pool.query(
        `UPDATE scan_entries
         SET quality_score = $1, quality_breakdown = $2, status = $8,
             classification = $3, classification_reason = $4,
             metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
             tags = $6
         WHERE id = $7
           AND status = 'deduped'
           AND name IS NOT DISTINCT FROM $9
           AND description IS NOT DISTINCT FROM $10
           AND source_url IS NOT DISTINCT FROM $11
           AND wire IS NOT DISTINCT FROM $12
           AND deadline_parsed IS NOT DISTINCT FROM $13
           AND source_published_at IS NOT DISTINCT FROM $14
           AND amount IS NOT DISTINCT FROM $15
         RETURNING id`,
        [
          classResult.qualityScore,
          JSON.stringify({
            scoreReason: classResult.scoreReason,
            in_scope: classResult.inScope,
            detected_wire: classResult.detectedWire,
            ...(cycleGuarded ? { cycle_guard: 'known_program_new_cycle' } : {}),
          }),
          classResult.classification,
          classResult.reason,
          JSON.stringify(mergedMetadata),
          classResult.tags,
          entryId,
          classStatus,
          entry.name,
          entry.description,
          entry.source_url,
          entry.wire,
          entry.deadline_parsed,
          entry.source_published_at,
          entry.amount,
        ]
      );
      if (classified.rowCount !== 1) continue;

      totalScore += classResult.qualityScore;
      scoredCount++;
      if (classResult.qualityScore >= 60) highQualityCount++;

      if (classResult.inScope && (classResult.classification === 'GRANT' || classResult.classification === 'EXPIRED')) {
        await finalizeProgramForEntry(pool, {
          id: entryId,
          name: entry.name,
          sourceUrl: entry.source_url,
          wire: entry.wire,
          deadline: entry.deadline_parsed ?? null,
          description: entry.description ?? null,
        }, programResolutions.get(entryId) ?? null);
      }
    } catch (classError) {
      console.error(`[DailyIntake] Classification failed for entry ${entryId}:`, classError);
      // Preserve the row for retry without turning an unavailable score into a
      // real zero. The UI and analytics treat NULL as unscored.
      const fallback = await pool.query(
        `UPDATE scan_entries SET quality_score = NULL, status = 'queued'
         WHERE id = $1
           AND status = 'deduped'
           AND name IS NOT DISTINCT FROM $2
           AND description IS NOT DISTINCT FROM $3
           AND source_url IS NOT DISTINCT FROM $4
           AND wire IS NOT DISTINCT FROM $5
         RETURNING id`,
        [entryId, entry.name, entry.description, entry.source_url, entry.wire]
      );
      if (fallback.rowCount === 1) classificationFailures.push(entryId);
    }

  }

  // Retry failed classifications once
  if (classificationFailures.length > 0) {
    progress(`Retrying ${classificationFailures.length} failed classifications...`, 82);

    for (const entryId of classificationFailures) {
      try {
        // Brief pause between retries
        await new Promise(resolve => setTimeout(resolve, 2000));

        const entryRes = await pool.query(
          `SELECT se.name, se.description, se.amount, se.source_url, se.source_published_at,
                  se.deadline_parsed, se.wire, se.operator_notes, sp.intent AS prompt_intent
           FROM scan_entries se
           LEFT JOIN scan_prompts sp ON se.prompt_id = sp.id
           WHERE se.id = $1 AND se.status = 'queued'`,
          [entryId]
        );
        const entry = entryRes.rows[0];
        if (!entry) continue;

        const rawClassResult = await classifyEntry({
          name: entry.name,
          description: entry.description || '',
          source_url: entry.source_url || '',
          wire: entry.wire,
          intent: entry.prompt_intent || undefined,
          amount: entry.amount,
          deadlineParsed: entry.deadline_parsed,
          sourcePublishedAt: entry.source_published_at,
        });
        const classResult = applyKnownProgramCycleGuard(rawClassResult, {
          name: entry.name,
          sourceUrl: entry.source_url || '',
          intakeWire: entry.wire,
          priorCycle: priorCycles.get(entryId),
          operatorNotes: entry.operator_notes,
        });
        const cycleGuarded = classResult !== rawClassResult;
        const freshnessDecision = applySourceFreshnessGate({
          sourceUrl: entry.source_url,
          sourcePublishedAt: entry.source_published_at,
          deadlineParsed: entry.deadline_parsed,
          classification: classResult.classification,
        });
        const retryStatus = freshnessDecision.status;
        const mergedMetadata = {
          ...classResult.extracted,
          operator_route: classResult.operatorRoute,
          ...freshnessDecision.metadata,
        };

        const retried = await pool.query(
          `UPDATE scan_entries
           SET quality_score = $1, quality_breakdown = $2, status = $8,
               classification = $3, classification_reason = $4,
               metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
               tags = $6
           WHERE id = $7
             AND status = 'queued'
             AND name IS NOT DISTINCT FROM $9
             AND description IS NOT DISTINCT FROM $10
             AND source_url IS NOT DISTINCT FROM $11
             AND wire IS NOT DISTINCT FROM $12
             AND deadline_parsed IS NOT DISTINCT FROM $13
             AND source_published_at IS NOT DISTINCT FROM $14
             AND amount IS NOT DISTINCT FROM $15
           RETURNING id`,
          [
            classResult.qualityScore,
            JSON.stringify({
              scoreReason: classResult.scoreReason,
              in_scope: classResult.inScope,
              detected_wire: classResult.detectedWire,
              ...(cycleGuarded ? { cycle_guard: 'known_program_new_cycle' } : {}),
            }),
            classResult.classification,
            classResult.reason,
            JSON.stringify(mergedMetadata),
            classResult.tags,
            entryId,
            retryStatus,
            entry.name,
            entry.description,
            entry.source_url,
            entry.wire,
            entry.deadline_parsed,
            entry.source_published_at,
            entry.amount,
          ]
        );
        if (retried.rowCount !== 1) continue;

        if (classResult.inScope && (classResult.classification === 'GRANT' || classResult.classification === 'EXPIRED')) {
          await finalizeProgramForEntry(pool, {
            id: entryId,
            name: entry.name,
            sourceUrl: entry.source_url,
            wire: entry.wire,
            deadline: entry.deadline_parsed ?? null,
            description: entry.description ?? null,
          }, programResolutions.get(entryId) ?? null);
        }

        // Update running totals
        totalScore += classResult.qualityScore;
        scoredCount++;
        if (classResult.qualityScore >= 60) highQualityCount++;

        console.log(`[DailyIntake] Retry succeeded for entry ${entryId}: ${classResult.classification} → ${retryStatus} (${classResult.qualityScore})`);
      } catch (retryError) {
        console.error(`[DailyIntake] Retry also failed for entry ${entryId}:`, retryError);
      }
    }
  }

  const avgScore =
    scoredCount > 0 ? totalScore / scoredCount : 0;

  progress(`Scoring complete: ${highQualityCount} high quality entries`, 85);

  // ---- Phase 4: Build Summary ----
  progress('Building summary...', 90);

  // Get per-prompt breakdown
  const promptStats = await pool.query(
    `SELECT
       wire || ' ' || prompt_variant as prompt_key,
       COUNT(*) as total,
       COUNT(*) FILTER (WHERE status = 'duplicate') as duplicates,
       COUNT(*) FILTER (WHERE status != 'duplicate') as new_unique,
       ROUND(AVG(quality_score) FILTER (WHERE quality_score IS NOT NULL)) as avg_score
     FROM scan_entries
     WHERE scan_date = $1
     GROUP BY wire, prompt_variant
     ORDER BY wire, prompt_variant`,
    [runDate]
  );

  const byPrompt: IntakeRunSummary['byPrompt'] = {};
  for (const row of promptStats.rows) {
    byPrompt[row.prompt_key] = {
      total: parseInt(row.total),
      duplicates: parseInt(row.duplicates),
      newUnique: parseInt(row.new_unique),
      avgScore: parseFloat(row.avg_score) || 0,
    };
  }

  // Get top finds
  const topFindsRes = await pool.query(
    `SELECT * FROM scan_entries
     WHERE scan_date = $1 AND status IN ('queued')
     ORDER BY quality_score DESC NULLS LAST
     LIMIT 10`,
    [runDate]
  );

  const summary: IntakeRunSummary = {
    runDate,
    wire,
    totalIngested: allResults.length,
    duplicatesFound,
    newUnique: uniqueEntryIds.length,
    averageQualityScore: Math.round(avgScore),
    highQualityCount,
    byPrompt,
    topFinds: topFindsRes.rows,
  };

  // Log the run
  await pool.query(
    `INSERT INTO intake_runs (run_date, wire, total_ingested, duplicates_found,
     new_unique, avg_quality_score, high_quality_count, summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      runDate,
      wire === 'all' ? null : wire,
      summary.totalIngested,
      summary.duplicatesFound,
      summary.newUnique,
      summary.averageQualityScore,
      summary.highQualityCount,
      JSON.stringify(summary),
    ]
  );

  progress('Intake complete!', 100);

  return summary;
}

// ============================================================
// Daily Queue: Get today's new high-quality entries
// ============================================================

/**
 * GET /queue score filter.
 * Omitted minScore includes unscored rows (quality_score IS NULL). A passed
 * minScore keeps `quality_score >= n`, which still hides nulls.
 */
export function resolveQueueMinScore(raw: unknown): { ok: true; minScore: number | null } | { ok: false; error: string } {
  if (raw == null || raw === '') return { ok: true, minScore: null };
  const n = parseInt(String(raw), 10);
  if (Number.isNaN(n)) return { ok: false, error: 'minScore must be an integer from 0 to 100' };
  return { ok: true, minScore: Math.max(0, Math.min(100, n)) };
}

/**
 * Get the daily queue of entries ready for review.
 * minScore null means no score predicate, so unscored rows are included.
 */
export async function getDailyQueue(
  pool: Pool,
  wire: string | null = null,
  minScore: number | null = null,
  date: string | null = null
): Promise<ScanEntry[]> {
  const targetDate = date || new Date().toISOString().split('T')[0];

  const params: any[] = [targetDate];
  let scoreClause = '';
  if (minScore != null) {
    params.push(minScore);
    scoreClause = `AND quality_score >= $${params.length}`;
  }
  let wireClause = '';
  if (wire) {
    params.push(wire);
    wireClause = `AND wire = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT * FROM scan_entries
     WHERE scan_date = $1
       AND status IN ('queued')
       ${scoreClause}
       ${wireClause}
     ORDER BY quality_score DESC NULLS LAST, amount_numeric DESC NULLS LAST`,
    params
  );

  return result.rows;
}

/**
 * Get entries that are queued and ready for AI enrichment.
 * These have passed dedup and quality scoring.
 */
export async function getEnrichmentQueue(
  pool: Pool,
  wire: string | null = null,
  limit: number = 50
): Promise<ScanEntry[]> {
  const wireClause = wire ? 'AND wire = $2' : '';
  const params: any[] = [limit];
  if (wire) params.push(wire);

  const result = await pool.query(
    `SELECT * FROM scan_entries
     WHERE status = 'queued'
       ${wireClause}
     ORDER BY quality_score DESC NULLS LAST
     LIMIT $1`,
    params
  );

  return result.rows;
}

// ============================================================
// Dashboard Data Helpers
// ============================================================

/**
 * Get aggregate stats across all intake runs for the dashboard.
 */
export async function getIntakeStats(
  pool: Pool,
  days: number = 7
): Promise<{
  totalEntries: number;
  totalDuplicates: number;
  totalUnique: number;
  avgQuality: number;
  entriesByDay: Array<{ date: string; total: number; unique: number; highQuality: number }>;
  entriesByWire: Record<string, number>;
}> {
  const byDay = await pool.query(
    `SELECT
       scan_date::text as date,
       COUNT(*) as total,
       COUNT(*) FILTER (WHERE status != 'duplicate') as unique_count,
       COUNT(*) FILTER (WHERE quality_score >= 60) as high_quality
     FROM scan_entries
     WHERE scan_date >= CURRENT_DATE - INTERVAL '1 day' * $1
     GROUP BY scan_date
     ORDER BY scan_date`,
    [days]
  );

  const byWire = await pool.query(
    `SELECT wire, COUNT(*) as count
     FROM scan_entries
     WHERE scan_date >= CURRENT_DATE - INTERVAL '1 day' * $1
       AND status != 'duplicate'
     GROUP BY wire`,
    [days]
  );

  const totals = await pool.query(
    `SELECT
       COUNT(*) as total,
       COUNT(*) FILTER (WHERE status = 'duplicate') as dupes,
       COUNT(*) FILTER (WHERE status != 'duplicate') as unique_count,
       ROUND(AVG(quality_score) FILTER (WHERE quality_score IS NOT NULL)) as avg_quality
     FROM scan_entries
     WHERE scan_date >= CURRENT_DATE - INTERVAL '1 day' * $1`,
    [days]
  );

  const wireMap: Record<string, number> = {};
  for (const row of byWire.rows) {
    wireMap[row.wire] = parseInt(row.count);
  }

  return {
    totalEntries: parseInt(totals.rows[0]?.total || '0'),
    totalDuplicates: parseInt(totals.rows[0]?.dupes || '0'),
    totalUnique: parseInt(totals.rows[0]?.unique_count || '0'),
    avgQuality: parseFloat(totals.rows[0]?.avg_quality || '0'),
    entriesByDay: byDay.rows.map((r) => ({
      date: r.date,
      total: parseInt(r.total),
      unique: parseInt(r.unique_count),
      highQuality: parseInt(r.high_quality),
    })),
    entriesByWire: wireMap,
  };
}
