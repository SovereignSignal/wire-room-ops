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
import type {
  PromptVariant,
  ScanSource,
  ScanSubmission,
  ScanEntry,
  IntakeRunSummary,
  IntakeJobConfig,
} from '../types/intake';
import {
  parseStructuredOutput,
  parseAmount,
  parseDeadline,
  normalizeUrl,
  normalizeName,
  extractNameTokens,
  isUsefulUrl,
} from '../services/intake';
import { checkDuplicate, registerSeen } from '../services/dedup';
// quality-scorer.ts replaced by LLM scoring in classifier.ts
import { seedSeenUrlsFromMessages } from '../db';

// ============================================================
// Default Configuration
// ============================================================

const DEFAULT_CONFIG: IntakeJobConfig = {
  qualityThreshold: 40,
  dedupeWindow: 14,
  sendBriefing: false,
  briefingMinScore: 60,
};

// ============================================================
// Main Job Function
// ============================================================

export interface IntakeJobOptions {
  config?: Partial<IntakeJobConfig>;
  onProgress?: (message: string, pct: number) => void;
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
    result: { name: string; description: string; deadline: string | null; sourceUrl: string; amount: string | null; sourcePublishedAt?: string | null };
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
  const COLS_PER_ROW = 17;

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
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, 'raw', $${offset + 13}, $${offset + 14}, $${offset + 15}, $${offset + 16}, $${offset + 17})`
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
      );
    }

    const res = await pool.query(
      `INSERT INTO scan_entries
       (name, description, source_url, amount, amount_numeric, amount_currency,
        deadline, deadline_parsed, wire, prompt_variant, scan_source, scan_date, status, prompt_id, submitted_by, source_published_at, raw_output, parse_strategy)
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

  // ---- Phase 2: Dedup (only entries with valid URLs) ----
  progress('Running deduplication...', 30);
  let duplicatesFound = 0;
  const uniqueEntryIds: number[] = [];

  for (const idx of validIndices) {
    const item = allResults[idx];
    const entryId = insertedIds[idx];

    const dedupResult = await checkDuplicate(
      pool,
      {
        sourceUrl: item.result.sourceUrl,
        name: item.result.name,
        wire: item.wire,
      },
      config.dedupeWindow
    );

    if (dedupResult.isDuplicate) {
      // Mark as duplicate
      await pool.query(
        `UPDATE scan_entries
         SET status = 'duplicate',
             duplicate_of_id = $1,
             duplicate_reason = $2
         WHERE id = $3`,
        [dedupResult.matchedEntryId, dedupResult.reason, entryId]
      );
      duplicatesFound++;
    } else {
      // Mark as deduped (passed)
      await pool.query(
        `UPDATE scan_entries SET status = 'deduped' WHERE id = $1`,
        [entryId]
      );
      uniqueEntryIds.push(entryId);

      // Register in seen tables so future entries can match against this one
      await registerSeen(pool, {
        id: entryId,
        sourceUrl: item.result.sourceUrl,
        name: item.result.name,
        wire: item.wire,
        scanDate: item.scanDate,
      });
    }

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

  const { classifyEntry } = await import('../services/classifier');
  const classificationFailures: number[] = [];

  for (const entryId of uniqueEntryIds) {
    // Fetch the entry for classification + scoring (join prompt intent)
    const entryRes = await pool.query(
      `SELECT se.name, se.description, se.amount, se.deadline, se.scan_date, se.source_url, se.wire,
              sp.intent AS prompt_intent
       FROM scan_entries se
       LEFT JOIN scan_prompts sp ON se.prompt_id = sp.id
       WHERE se.id = $1`,
      [entryId]
    );
    const entry = entryRes.rows[0];

    // Gate 2: LLM classification + quality scoring (single call)
    let qualityScore = 0;
    try {
      const classResult = await classifyEntry({
        name: entry.name,
        description: entry.description || '',
        source_url: entry.source_url || '',
        wire: entry.wire,
        intent: entry.prompt_intent || undefined,
      });
      qualityScore = classResult.qualityScore;
      const classStatus = classResult.classification === 'NOISE' ? 'archived' : 'queued';

      await pool.query(
        `UPDATE scan_entries
         SET quality_score = $1, quality_breakdown = $2, status = $8,
             classification = $3, classification_reason = $4,
             metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
             tags = $6
         WHERE id = $7`,
        [
          qualityScore,
          JSON.stringify({ scoreReason: classResult.scoreReason }),
          classResult.classification,
          classResult.reason,
          JSON.stringify(classResult.extracted),
          classResult.tags,
          entryId,
          classStatus,
        ]
      );
    } catch (classError) {
      console.error(`[DailyIntake] Classification failed for entry ${entryId}:`, classError);
      classificationFailures.push(entryId);
      // Fallback: queue with score 0
      await pool.query(
        `UPDATE scan_entries SET quality_score = 0, status = 'queued' WHERE id = $1`,
        [entryId]
      );
    }

    totalScore += qualityScore;
    if (qualityScore >= 60) highQualityCount++;
  }

  // Retry failed classifications once
  if (classificationFailures.length > 0) {
    progress(`Retrying ${classificationFailures.length} failed classifications...`, 82);

    for (const entryId of classificationFailures) {
      try {
        // Brief pause between retries
        await new Promise(resolve => setTimeout(resolve, 2000));

        const entryRes = await pool.query(
          `SELECT se.name, se.description, se.source_url, se.wire, sp.intent AS prompt_intent
           FROM scan_entries se
           LEFT JOIN scan_prompts sp ON se.prompt_id = sp.id
           WHERE se.id = $1`,
          [entryId]
        );
        const entry = entryRes.rows[0];
        if (!entry) continue;

        const classResult = await classifyEntry({
          name: entry.name,
          description: entry.description || '',
          source_url: entry.source_url || '',
          wire: entry.wire,
          intent: entry.prompt_intent || undefined,
        });
        const retryStatus = classResult.classification === 'NOISE' ? 'archived' : 'queued';

        await pool.query(
          `UPDATE scan_entries
           SET quality_score = $1, quality_breakdown = $2, status = $8,
               classification = $3, classification_reason = $4,
               metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
               tags = $6
           WHERE id = $7`,
          [
            classResult.qualityScore,
            JSON.stringify({ scoreReason: classResult.scoreReason }),
            classResult.classification,
            classResult.reason,
            JSON.stringify(classResult.extracted),
            classResult.tags,
            entryId,
            retryStatus,
          ]
        );

        // Update running totals
        totalScore += classResult.qualityScore;
        if (classResult.qualityScore >= 60) highQualityCount++;

        console.log(`[DailyIntake] Retry succeeded for entry ${entryId}: ${classResult.classification} → ${retryStatus} (${classResult.qualityScore})`);
      } catch (retryError) {
        console.error(`[DailyIntake] Retry also failed for entry ${entryId}:`, retryError);
      }
    }
  }

  const avgScore =
    uniqueEntryIds.length > 0 ? totalScore / uniqueEntryIds.length : 0;

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
 * Get the daily queue of new, quality entries ready for review.
 * This powers the "daily briefing" view on the dashboard.
 */
export async function getDailyQueue(
  pool: Pool,
  wire: string | null = null,
  minScore: number = 40,
  date: string | null = null
): Promise<ScanEntry[]> {
  const targetDate = date || new Date().toISOString().split('T')[0];

  const wireClause = wire ? 'AND wire = $3' : '';
  const params: any[] = [targetDate, minScore];
  if (wire) params.push(wire);

  const result = await pool.query(
    `SELECT * FROM scan_entries
     WHERE scan_date = $1
       AND status IN ('queued')
       AND quality_score >= $2
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
