import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { getEffectiveDbUrl, getDbConfigMeta, saveDbConfig } from '../config/db-config';

const router = Router();

// Lazy pool — created on first use, reads from effective DB URL
let lazyPool: Pool | null = null;

function getLazyPool(): Pool {
  const url = getEffectiveDbUrl();
  if (!url) throw new Error('No database URL configured');

  if (!lazyPool) {
    lazyPool = new Pool({
      connectionString: url,
      ssl: url.includes('localhost') || url.includes('127.0.0.1')
        ? false
        : { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' },
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    lazyPool.on('error', (err) => {
      console.error('[DB-Introspect] Pool error:', err.message);
    });
  }
  return lazyPool;
}

function resetPool(): void {
  if (lazyPool) {
    lazyPool.end().catch(() => {});
    lazyPool = null;
  }
}

// Allowed sort columns per table (whitelist to prevent SQL injection)
const SORT_COLUMNS: Record<string, string[]> = {
  'scan-entries': ['id', 'name', 'wire', 'status', 'quality_score', 'scan_source', 'created_at', 'amount', 'deadline'],
  'intake-runs': ['id', 'wire', 'new_unique', 'duplicates_found', 'avg_quality_score', 'scans_run', 'created_at'],
  'distribution-log': ['id', 'channel', 'wire', 'status', 'created_at'],
  'summaries': ['id', 'title', 'wire', 'processing_status', 'data_quality', 'confidence', 'created_at'],
};

const TABLE_MAP: Record<string, string> = {
  'scan-entries': 'scan_entries',
  'intake-runs': 'intake_runs',
  'distribution-log': 'distribution_logs',
  'summaries': 'summaries',
};

// GET /config — returns config meta (never password)
router.get('/config', (_req: Request, res: Response) => {
  res.json(getDbConfigMeta());
});

// POST /config/test — test a connection URL
router.post('/config/test', async (req: Request, res: Response) => {
  const { databaseUrl } = req.body;
  if (!databaseUrl || typeof databaseUrl !== 'string') {
    res.status(400).json({ success: false, error: 'databaseUrl is required' });
    return;
  }

  const testPool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1')
      ? false
      : { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' },
    max: 1,
    connectionTimeoutMillis: 10_000,
  });

  const start = Date.now();
  try {
    const result = await testPool.query('SELECT version()');
    const latencyMs = Date.now() - start;
    res.json({
      success: true,
      latencyMs,
      version: result.rows[0]?.version || null,
    });
  } catch (error) {
    const latencyMs = Date.now() - start;
    res.json({
      success: false,
      latencyMs,
      error: error instanceof Error ? error.message : 'Connection failed',
    });
  } finally {
    await testPool.end().catch(() => {});
  }
});

// POST /config — save new DB URL (tests first)
router.post('/config', async (req: Request, res: Response) => {
  const { databaseUrl } = req.body;
  if (!databaseUrl || typeof databaseUrl !== 'string') {
    res.status(400).json({ error: 'databaseUrl is required' });
    return;
  }

  // Test connection first
  const testPool = new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1')
      ? false
      : { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' },
    max: 1,
    connectionTimeoutMillis: 10_000,
  });

  try {
    await testPool.query('SELECT 1');
  } catch (error) {
    res.status(400).json({ error: `Connection test failed: ${error instanceof Error ? error.message : 'Unknown error'}` });
    return;
  } finally {
    await testPool.end().catch(() => {});
  }

  try {
    const result = saveDbConfig(databaseUrl);
    resetPool(); // Force pool recreation with new URL
    res.json({ ...result, ...getDbConfigMeta() });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save config' });
  }
});

// GET /scan-entries — paginated with filters
router.get('/scan-entries', async (req: Request, res: Response) => {
  try {
    const pool = getLazyPool();
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 50, 1), 200);
    const offset = (page - 1) * limit;

    const sortCol = SORT_COLUMNS['scan-entries'].includes(req.query.sort as string)
      ? req.query.sort as string : 'created_at';
    const order = (req.query.order as string)?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (req.query.wire) {
      conditions.push(`wire = $${paramIdx++}`);
      params.push(req.query.wire);
    }
    if (req.query.status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(req.query.status);
    }
    if (req.query.search) {
      conditions.push(`(name ILIKE $${paramIdx} OR description ILIKE $${paramIdx})`);
      params.push(`%${req.query.search}%`);
      paramIdx++;
    }
    if (req.query.from) {
      conditions.push(`created_at >= $${paramIdx++}`);
      params.push(req.query.from);
    }
    if (req.query.to) {
      conditions.push(`created_at <= $${paramIdx++}`);
      params.push(req.query.to + 'T23:59:59.999Z');
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await pool.query(`SELECT COUNT(*) FROM scan_entries ${where}`, params);
    const total = parseInt(countResult.rows[0].count, 10);

    const dataResult = await pool.query(
      `SELECT id, name, description, source_url, wire, status, quality_score, scan_source, prompt_variant, created_at, amount, deadline
       FROM scan_entries ${where}
       ORDER BY ${sortCol} ${order}
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    );

    res.json({
      data: dataResult.rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('[DB] scan-entries query failed:', error);
    res.status(500).json({ error: 'Failed to query scan_entries' });
  }
});

// GET /intake-runs — paginated with wire filter
router.get('/intake-runs', async (req: Request, res: Response) => {
  try {
    const pool = getLazyPool();
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 50, 1), 200);
    const offset = (page - 1) * limit;

    const sortCol = SORT_COLUMNS['intake-runs'].includes(req.query.sort as string)
      ? req.query.sort as string : 'created_at';
    const order = (req.query.order as string)?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (req.query.wire) {
      conditions.push(`wire = $${paramIdx++}`);
      params.push(req.query.wire);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await pool.query(`SELECT COUNT(*) FROM intake_runs ${where}`, params);
    const total = parseInt(countResult.rows[0].count, 10);

    const dataResult = await pool.query(
      `SELECT id, wire, new_unique, duplicates_found, avg_quality_score, scans_run, created_at
       FROM intake_runs ${where}
       ORDER BY ${sortCol} ${order}
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    );

    res.json({
      data: dataResult.rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('[DB] intake-runs query failed:', error);
    res.status(500).json({ error: 'Failed to query intake_runs' });
  }
});

// GET /distribution-log — paginated with filters
router.get('/distribution-log', async (req: Request, res: Response) => {
  try {
    const pool = getLazyPool();
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 50, 1), 200);
    const offset = (page - 1) * limit;

    const sortCol = SORT_COLUMNS['distribution-log'].includes(req.query.sort as string)
      ? req.query.sort as string : 'created_at';
    const order = (req.query.order as string)?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (req.query.wire) {
      conditions.push(`wire = $${paramIdx++}`);
      params.push(req.query.wire);
    }
    if (req.query.channel) {
      conditions.push(`channel = $${paramIdx++}`);
      params.push(req.query.channel);
    }
    if (req.query.status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(req.query.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await pool.query(`SELECT COUNT(*) FROM distribution_logs ${where}`, params);
    const total = parseInt(countResult.rows[0].count, 10);

    const dataResult = await pool.query(
      `SELECT id, channel, wire, status, post_text, created_at
       FROM distribution_logs ${where}
       ORDER BY ${sortCol} ${order}
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    );

    res.json({
      data: dataResult.rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('[DB] distribution-log query failed:', error);
    res.status(500).json({ error: 'Failed to query distribution_logs' });
  }
});

// GET /summaries — paginated with filters
router.get('/summaries', async (req: Request, res: Response) => {
  try {
    const pool = getLazyPool();
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50));
    const offset = (page - 1) * limit;
    const sortCol = SORT_COLUMNS['summaries'].includes(req.query.sort as string)
      ? req.query.sort as string
      : 'created_at';
    const sortDir = req.query.dir === 'asc' ? 'ASC' : 'DESC';

    const conditions: string[] = [];
    const params: any[] = [];

    if (req.query.status) {
      params.push(req.query.status);
      conditions.push(`processing_status = $${params.length}`);
    }
    if (req.query.wire) {
      params.push(req.query.wire);
      conditions.push(`wire = $${params.length}`);
    }
    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      conditions.push(`(title ILIKE $${params.length} OR summary ILIKE $${params.length})`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await pool.query(`SELECT COUNT(*) FROM summaries ${where}`, params);
    const total = parseInt(countResult.rows[0].count, 10);

    params.push(limit, offset);
    const rows = await pool.query(
      `SELECT id, title, wire, processing_status, data_quality, confidence, summary, entities, created_at
       FROM summaries ${where}
       ORDER BY ${sortCol} ${sortDir}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      data: rows.rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('[DB] summaries query failed:', error);
    res.status(500).json({ error: 'Failed to query summaries' });
  }
});

// GET /stats — aggregate counts
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const pool = getLazyPool();

    const [scanR, intakeR, distR] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status = 'queued') AS queued,
          COUNT(*) FILTER (WHERE status = 'approved') AS approved,
          COUNT(*) FILTER (WHERE status IN ('archived', 'declined')) AS archived,
          COUNT(*) FILTER (WHERE status = 'raw') AS raw
        FROM scan_entries
      `),
      pool.query(`
        SELECT COUNT(*) AS total, MAX(created_at) AS last_run
        FROM intake_runs
      `),
      pool.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status = 'success' AND created_at > NOW() - INTERVAL '24 hours') AS sent_24h
        FROM distribution_logs
      `),
    ]);

    const scan = scanR.rows[0];
    const intake = intakeR.rows[0];
    const dist = distR.rows[0];

    res.json({
      scan_entries: {
        total: parseInt(scan.total, 10),
        queued: parseInt(scan.queued, 10),
        approved: parseInt(scan.approved, 10),
        archived: parseInt(scan.archived, 10),
        raw: parseInt(scan.raw, 10),
      },
      intake_runs: {
        total: parseInt(intake.total, 10),
        last_run: intake.last_run,
      },
      distribution_log: {
        total: parseInt(dist.total, 10),
        sent_24h: parseInt(dist.sent_24h, 10),
      },
    });
  } catch (error) {
    console.error('[DB] stats query failed:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// GET /export/scan-entries — CSV download
router.get('/export/scan-entries', async (req: Request, res: Response) => {
  try {
    const pool = getLazyPool();
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 10000, 1), 10000);

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (req.query.wire) {
      conditions.push(`wire = $${paramIdx++}`);
      params.push(req.query.wire);
    }
    if (req.query.status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(req.query.status);
    }
    if (req.query.search) {
      conditions.push(`(name ILIKE $${paramIdx} OR description ILIKE $${paramIdx})`);
      params.push(`%${req.query.search}%`);
      paramIdx++;
    }
    if (req.query.from) {
      conditions.push(`created_at >= $${paramIdx++}`);
      params.push(req.query.from);
    }
    if (req.query.to) {
      conditions.push(`created_at <= $${paramIdx++}`);
      params.push(req.query.to + 'T23:59:59.999Z');
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT id, name, description, source_url, wire, status, quality_score, scan_source, prompt_variant, created_at, amount, deadline
       FROM scan_entries ${where}
       ORDER BY created_at DESC
       LIMIT $${paramIdx}`,
      [...params, limit]
    );

    const columns = ['id', 'name', 'description', 'source_url', 'wire', 'status', 'quality_score', 'scan_source', 'prompt_variant', 'created_at', 'amount', 'deadline'];
    const csvRows = [columns.join(',')];
    for (const row of result.rows) {
      csvRows.push(columns.map(col => {
        const val = row[col];
        if (val == null) return '';
        const str = String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      }).join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=scan-entries.csv');
    res.send(csvRows.join('\n'));
  } catch (error) {
    console.error('[DB] export failed:', error);
    res.status(500).json({ error: 'Failed to export scan entries' });
  }
});

export { router as databaseRouter };
