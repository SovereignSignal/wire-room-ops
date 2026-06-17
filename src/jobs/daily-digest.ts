/**
 * Daily Digest Job
 *
 * Runs once per day (default: 6 PM PT). Aggregates all scan activity across
 * every wire from the past 24 hours and sends a single summary email.
 *
 * This replaces per-scan email notifications in the scheduler.
 */

import type { Pool } from 'pg';

export interface WireDigestStats {
  wire: string;
  scansRun: number;
  totalIngested: number;
  newUnique: number;
  duplicatesFound: number;
  avgQualityScore: number;
  highQualityCount: number;
  pendingReview: number;
  recentlyApproved: number;
}

export interface DailyDigestResult {
  date: string;
  wires: WireDigestStats[];
  totalPendingReview: number;
  totalNewUnique: number;
  hasActivity: boolean;
}

export async function runDailyDigest(pool: Pool): Promise<DailyDigestResult> {
  const client = await pool.connect();
  const dateStr = new Date().toISOString().slice(0, 10);

  try {
    // Intake runs from the past 24 hours, grouped by wire
    const intakeRows = await client.query<{
      wire: string;
      scans_run: string;
      total_ingested: string;
      new_unique: string;
      duplicates_found: string;
      avg_quality: string;
      high_quality: string;
    }>(`
      SELECT
        wire,
        COUNT(*)                      AS scans_run,
        COALESCE(SUM(total_ingested), 0) AS total_ingested,
        COALESCE(SUM(new_unique), 0)     AS new_unique,
        COALESCE(SUM(duplicates_found), 0) AS duplicates_found,
        COALESCE(ROUND(AVG(avg_quality_score)), 0) AS avg_quality,
        COALESCE(SUM(high_quality_count), 0) AS high_quality
      FROM intake_runs
      WHERE created_at >= NOW() - INTERVAL '24 hours'
        AND wire IS NOT NULL
      GROUP BY wire
      ORDER BY wire
    `);

    // Pending review counts per wire (all-time queue, not just today)
    const pendingRows = await client.query<{ wire: string; cnt: string }>(`
      SELECT wire, COUNT(*) AS cnt
      FROM scan_entries
      WHERE status = 'queued'
      GROUP BY wire
    `);
    const pendingByWire = Object.fromEntries(
      pendingRows.rows.map(r => [r.wire, parseInt(r.cnt, 10)])
    );

    // Recently approved in the past 24h
    const approvedRows = await client.query<{ wire: string; cnt: string }>(`
      SELECT wire, COUNT(*) AS cnt
      FROM scan_entries
      WHERE status = 'approved'
        AND updated_at >= NOW() - INTERVAL '24 hours'
      GROUP BY wire
    `);
    const approvedByWire = Object.fromEntries(
      approvedRows.rows.map(r => [r.wire, parseInt(r.cnt, 10)])
    );

    // If no intake runs today, still report pending queue state
    const wiresFromRuns = new Set(intakeRows.rows.map(r => r.wire));
    const wiresFromPending = new Set(Object.keys(pendingByWire));
    const allWires = new Set([...wiresFromRuns, ...wiresFromPending]);

    const wires: WireDigestStats[] = Array.from(allWires).sort().map(wire => {
      const run = intakeRows.rows.find(r => r.wire === wire);
      return {
        wire,
        scansRun: run ? parseInt(run.scans_run, 10) : 0,
        totalIngested: run ? parseInt(run.total_ingested, 10) : 0,
        newUnique: run ? parseInt(run.new_unique, 10) : 0,
        duplicatesFound: run ? parseInt(run.duplicates_found, 10) : 0,
        avgQualityScore: run ? parseInt(run.avg_quality, 10) : 0,
        highQualityCount: run ? parseInt(run.high_quality, 10) : 0,
        pendingReview: pendingByWire[wire] ?? 0,
        recentlyApproved: approvedByWire[wire] ?? 0,
      };
    });

    const totalPendingReview = wires.reduce((sum, w) => sum + w.pendingReview, 0);
    const totalNewUnique = wires.reduce((sum, w) => sum + w.newUnique, 0);

    return {
      date: dateStr,
      wires,
      totalPendingReview,
      totalNewUnique,
      hasActivity: totalNewUnique > 0 || totalPendingReview > 0,
    };
  } finally {
    client.release();
  }
}

import type { TopFindEntry } from '../services/email';

export interface SourceBreakdownRow {
  wire: string;
  source: string;
  total: number;
  queued: number;
  approved: number;
  archived: number;
  duplicates: number;
  parked: number;
  signals: number;
}

export interface CostRow {
  provider: string;
  calls: number;
  cost_usd: number;
}

/**
 * Per-provider API cost for the last 24 hours, from api_usage_log. Covers all
 * per-cost tools: grok/anthropic/perplexity/ollama (LLM tokens), parallel
 * (search fee), twitter (X reads), firecrawl (scrapes), resend (email).
 * Providers without pricing rows show $0 — see model_pricing.
 */
export async function getCostRecap(pool: Pool): Promise<{ rows: CostRow[]; total: number }> {
  const { rows } = await pool.query<CostRow>(`
    SELECT provider,
           COUNT(*)::int AS calls,
           ROUND(COALESCE(SUM(estimated_cost_usd), 0)::numeric, 4)::float AS cost_usd
    FROM api_usage_log
    WHERE created_at >= NOW() - INTERVAL '24 hours'
    GROUP BY provider
    HAVING COUNT(*) > 0
    ORDER BY cost_usd DESC NULLS LAST
  `);
  const total = rows.reduce((sum, r) => sum + (r.cost_usd || 0), 0);
  return { rows, total: Math.round(total * 10000) / 10000 };
}

/**
 * Per-wire, per-source intake breakdown for the last 24 hours, including how
 * many entries the operator routing parked (kept in DB, not published).
 */
export async function getSourceBreakdown(pool: Pool): Promise<SourceBreakdownRow[]> {
  const { rows } = await pool.query<SourceBreakdownRow>(`
    SELECT
      wire,
      COALESCE(scan_source, 'unknown') AS source,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
      COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
      COUNT(*) FILTER (WHERE status = 'archived')::int AS archived,
      COUNT(*) FILTER (WHERE status = 'duplicate')::int AS duplicates,
      COUNT(*) FILTER (WHERE metadata->>'operator_route' = 'park')::int AS parked,
      COUNT(*) FILTER (WHERE metadata->>'operator_route' = 'relationship_signal')::int AS signals
    FROM scan_entries
    WHERE created_at >= NOW() - INTERVAL '24 hours'
    GROUP BY wire, COALESCE(scan_source, 'unknown')
    ORDER BY wire, total DESC
  `);
  return rows;
}

/**
 * Fetch the top N pending entries by quality score for inclusion in the digest email.
 */
export async function getTopPendingFinds(pool: Pool, limit = 5): Promise<TopFindEntry[]> {
  const client = await pool.connect();
  try {
    const result = await client.query<{
      name: string; wire: string; quality_score: number;
      amount: string | null; deadline: string | null; source_url: string | null;
    }>(`
      SELECT name, wire, quality_score, amount, deadline, source_url
      FROM scan_entries
      WHERE status = 'queued'
        AND (deadline_parsed IS NULL OR deadline_parsed >= CURRENT_DATE)
      ORDER BY quality_score DESC, created_at DESC
      LIMIT $1
    `, [limit]);
    return result.rows;
  } finally {
    client.release();
  }
}
