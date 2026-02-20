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
} from '../services/intake';
import { checkDuplicate, registerSeen } from '../services/dedup';
import { scoreEntry } from '../services/quality-scorer';

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
  const wire = submissions.length === 1 ? submissions[0].wire : 'all';

  progress('Starting intake pipeline...', 0);

  // Flatten all results from all submissions
  const allResults: Array<{
    result: { name: string; description: string; deadline: string | null; sourceUrl: string; amount: string | null };
    wire: string;
    promptVariant: PromptVariant;
    scanSource: ScanSource;
    scanDate: string;
    promptId?: string;
    submittedBy?: string;
  }> = [];

  for (const sub of submissions) {
    for (const r of sub.results) {
      allResults.push({
        result: r,
        wire: sub.wire,
        promptVariant: sub.promptVariant,
        scanSource: sub.source,
        scanDate: sub.scanDate,
        promptId: sub.promptId,
        submittedBy: sub.submittedBy,
      });
    }
  }

  progress(`Parsed ${allResults.length} total results from ${submissions.length} scans`, 5);

  // ---- Phase 1: Insert raw entries (batched) ----
  progress('Inserting raw entries...', 10);
  const insertedIds: number[] = [];

  // Build batched multi-row INSERT (chunks of 50 to stay within param limits)
  const BATCH_SIZE = 50;
  const COLS_PER_ROW = 14;

  for (let batchStart = 0; batchStart < allResults.length; batchStart += BATCH_SIZE) {
    const batch = allResults.slice(batchStart, batchStart + BATCH_SIZE);
    const values: (string | number | null)[] = [];
    const valueClauses: string[] = [];

    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      const parsed = parseAmount(item.result.amount);
      const deadlineParsed = parseDeadline(item.result.deadline);
      const offset = i * COLS_PER_ROW;

      valueClauses.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, 'raw', $${offset + 13}, $${offset + 14})`
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
      );
    }

    const res = await pool.query(
      `INSERT INTO scan_entries
       (name, description, source_url, amount, amount_numeric, amount_currency,
        deadline, deadline_parsed, wire, prompt_variant, scan_source, scan_date, status, prompt_id, submitted_by)
       VALUES ${valueClauses.join(', ')}
       RETURNING id`,
      values
    );

    for (const row of res.rows) {
      insertedIds.push(row.id);
    }
  }

  progress(`Inserted ${insertedIds.length} raw entries`, 25);

  // ---- Phase 2: Dedup ----
  progress('Running deduplication...', 30);
  let duplicatesFound = 0;
  const uniqueEntryIds: number[] = [];

  for (let i = 0; i < allResults.length; i++) {
    const item = allResults[i];
    const entryId = insertedIds[i];

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
    if (i % 10 === 0) {
      const pct = 30 + Math.round((i / allResults.length) * 30);
      progress(`Dedup: ${i + 1}/${allResults.length} (${duplicatesFound} dupes so far)`, pct);
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

  for (const entryId of uniqueEntryIds) {
    // Fetch the entry for scoring
    const entryRes = await pool.query(
      `SELECT name, description, amount, deadline, scan_date FROM scan_entries WHERE id = $1`,
      [entryId]
    );
    const entry = entryRes.rows[0];

    const breakdown = scoreEntry({
      name: entry.name,
      description: entry.description,
      amount: entry.amount,
      deadline: entry.deadline,
      scanDate: entry.scan_date,
    });

    const newStatus =
      breakdown.totalScore >= config.qualityThreshold ? 'queued' : 'archived';

    await pool.query(
      `UPDATE scan_entries
       SET quality_score = $1, quality_breakdown = $2, status = $3
       WHERE id = $4`,
      [breakdown.totalScore, JSON.stringify(breakdown), newStatus, entryId]
    );

    totalScore += breakdown.totalScore;
    if (breakdown.totalScore >= 60) highQualityCount++;
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
     WHERE scan_date = $1 AND status IN ('scored', 'queued')
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
       AND status IN ('queued', 'scored')
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
