/**
 * Dashboard Routes
 *
 * GET /stats — aggregated overview stats for React dashboard
 */

import { Router, Request, Response } from 'express';
import { getPool } from '../db';

const router = Router();

// API: Dashboard overview stats (aggregated for React dashboard)
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const pool = getPool();
    const runs = await pool.query(`
      SELECT wire,
        COUNT(*) as scans_run,
        COALESCE(SUM(new_unique),0) as items_this_week,
        COALESCE(SUM(duplicates_found),0) as duplicates_found,
        COALESCE(ROUND(AVG(avg_quality_score)),0) as avg_quality_score,
        COALESCE(SUM(high_quality_count),0) as high_quality_count,
        MAX(created_at) as last_scan
      FROM intake_runs
      WHERE created_at >= NOW() - INTERVAL '7 days' AND wire IS NOT NULL
      GROUP BY wire
    `);
    const pending = await pool.query(
      "SELECT wire, COUNT(*) as cnt FROM scan_entries WHERE status='queued' GROUP BY wire"
    );
    res.json({ intake: runs.rows, pending: pending.rows });
  } catch (error) {
    console.error('Failed to get dashboard stats:', error);
    res.status(500).json({ error: 'Failed to get dashboard stats' });
  }
});

export { router as dashboardRouter };
