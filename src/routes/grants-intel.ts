import { Router, Request, Response } from 'express';
import { getPool } from '../db';

const router = Router();

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS source_runs (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL,
  track TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_domain TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running',
  records_fetched INTEGER NOT NULL DEFAULT 0,
  records_normalized INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  raw_artifact_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(run_id, source_name)
);

CREATE TABLE IF NOT EXISTS opportunity_observations (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL,
  track TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_domain TEXT,
  wire TEXT,
  source_record_id TEXT,
  title TEXT NOT NULL,
  organization TEXT,
  opportunity_type TEXT,
  description TEXT,
  url TEXT,
  apply_url TEXT,
  deadline TEXT,
  amount TEXT,
  currency TEXT,
  ecosystem TEXT,
  status TEXT,
  confidence NUMERIC,
  routing TEXT,
  dedupe_key TEXT NOT NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  matched_scan_entry_id INTEGER,
  matched_grant_entry_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(run_id, source_name, dedupe_key)
);
`;

function normalizeUrlSql(alias: string): string {
  return `lower(regexp_replace(regexp_replace(coalesce(${alias}, ''), '^https?://(www\\.)?', ''), '/$', ''))`;
}

async function ensureGrantsIntelTables(): Promise<void> {
  await getPool().query(CREATE_TABLES_SQL);
}

router.get('/summary', async (_req: Request, res: Response) => {
  try {
    await ensureGrantsIntelTables();
    const pool = getPool();
    const [runs, routing, pillars, recentWire] = await Promise.all([
      pool.query(`
        SELECT track, source_name, status, COUNT(*)::int AS runs,
               COALESCE(SUM(records_normalized), 0)::int AS records_normalized,
               MAX(finished_at) AS last_finished
        FROM source_runs
        WHERE finished_at >= NOW() - INTERVAL '24 hours'
        GROUP BY track, source_name, status
        ORDER BY track, source_name
      `),
      pool.query(`
        SELECT track, routing, COUNT(*)::int AS count
        FROM opportunity_observations
        WHERE observed_at >= NOW() - INTERVAL '24 hours'
        GROUP BY track, routing
        ORDER BY track, routing
      `),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE observed_at >= NOW() - INTERVAL '24 hours')::int AS landscape_observations,
          COUNT(*) FILTER (WHERE observed_at >= NOW() - INTERVAL '24 hours' AND routing IN ('wire_queue_candidate','daily_brief','opportunity_signal'))::int AS opportunity_candidates,
          COUNT(*) FILTER (WHERE observed_at >= NOW() - INTERVAL '24 hours' AND routing = 'wire_queue_candidate')::int AS wire_candidates,
          COUNT(*) FILTER (WHERE observed_at >= NOW() - INTERVAL '24 hours' AND routing IN ('daily_brief','opportunity_signal'))::int AS writing_inputs
        FROM opportunity_observations
      `),
      pool.query(`
        SELECT wire, status, COUNT(*)::int AS count
        FROM scan_entries
        WHERE created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY wire, status
        ORDER BY wire, status
      `),
    ]);

    res.json({
      sourceRuns: runs.rows,
      routingCounts: routing.rows,
      pillars: pillars.rows[0] || {},
      recentWire: recentWire.rows,
    });
  } catch (error) {
    console.error('Failed to get grants intel summary:', error);
    res.status(500).json({ error: 'Failed to get grants intel summary' });
  }
});

router.get('/observations', async (req: Request, res: Response) => {
  try {
    await ensureGrantsIntelTables();
    const pool = getPool();
    const wire = typeof req.query.wire === 'string' ? req.query.wire : '';
    const routing = typeof req.query.routing === 'string' ? req.query.routing : '';
    const track = typeof req.query.track === 'string' ? req.query.track : '';
    const limit = Math.min(parseInt(String(req.query.limit || '100'), 10) || 100, 250);

    const filters: string[] = [`o.observed_at >= NOW() - INTERVAL '7 days'`];
    const params: (string | number)[] = [];
    if (wire) {
      params.push(wire.toLowerCase());
      filters.push(`lower(o.wire) LIKE '%' || $${params.length} || '%'`);
    }
    if (routing) {
      params.push(routing);
      filters.push(`o.routing = $${params.length}`);
    }
    if (track) {
      params.push(track.toUpperCase());
      filters.push(`o.track = $${params.length}`);
    }
    params.push(limit);

    const urlExpr = normalizeUrlSql('l.url');
    const applyUrlExpr = normalizeUrlSql('l.apply_url');
    const sourceUrlExpr = normalizeUrlSql('s.source_url');

    const result = await pool.query(
      `
      WITH latest AS (
        SELECT DISTINCT ON (dedupe_key)
          id, run_id, track, source_name, source_domain, wire, title, organization,
          opportunity_type, description, url, apply_url, deadline, amount, currency,
          ecosystem, status, confidence, routing, dedupe_key, observed_at
        FROM opportunity_observations o
        WHERE ${filters.join(' AND ')}
        ORDER BY dedupe_key, observed_at DESC
      )
      SELECT l.*,
             s.id AS matched_scan_entry_id,
             s.name AS matched_scan_entry_name,
             s.status AS matched_scan_entry_status,
             s.created_at AS matched_scan_entry_created_at,
             CASE
               WHEN s.id IS NOT NULL THEN 'already_in_wire_room'
               WHEN EXISTS (
                 SELECT 1 FROM grant_entries g
                 WHERE lower(coalesce(g.title, '')) = lower(coalesce(l.title, ''))
                    OR lower(regexp_replace(regexp_replace(coalesce(g."sourceUrl", ''), '^https?://(www\\.)?', ''), '/$', '')) IN (${normalizeUrlSql('l.url')}, ${normalizeUrlSql('l.apply_url')})
               ) THEN 'known_grant_archive'
               ELSE 'new_to_wire_room'
             END AS match_status
      FROM latest l
      LEFT JOIN LATERAL (
        SELECT s.id, s.name, s.status, s.created_at, s.source_url
        FROM scan_entries s
        WHERE ${sourceUrlExpr} IN (${urlExpr}, ${applyUrlExpr})
           OR lower(s.name) = lower(l.title)
        ORDER BY s.created_at DESC
        LIMIT 1
      ) s ON true
      ORDER BY
        CASE l.routing WHEN 'wire_queue_candidate' THEN 0 WHEN 'daily_brief' THEN 1 WHEN 'opportunity_signal' THEN 2 ELSE 3 END,
        l.confidence DESC NULLS LAST,
        l.observed_at DESC
      LIMIT $${params.length}
      `,
      params,
    );

    res.json({ observations: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Failed to get grants intel observations:', error);
    res.status(500).json({ error: 'Failed to get grants intel observations' });
  }
});

export { router as grantsIntelRouter };
