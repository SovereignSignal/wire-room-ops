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
