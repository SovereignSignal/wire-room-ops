import path from 'path';
import express, { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { stopAuthCleanup, ensureSessionsTable } from './services/auth';
import { requireAuth } from './middleware/auth';
import { requireAuthOrInternalKey } from './middleware/internal-auth';
import { closePool, ensureFeedsTable, ensureClassificationColumns, ensureEngagementMetricsTable, ensureDistributeAfterColumn, ensureAutoSummarizeFailedColumn, ensureMonitoredAccountsTable, getPool } from './db';
import { jobQueue } from './services/job-queue';
import { getSchedules, addSchedule, initScheduler, stopScheduler, getSchedulerStatus } from './services/scheduler';
import { ensureOrgProfilesTable } from './services/org-extractor';
import { ensureEntryActionColumns } from './services/entry-actions';
import { computeDerivedFields } from './services/org-enricher';
import { ensureIntegrationConfigTable } from './services/notion-sync';
import { startSummarySync, stopSummarySync } from './jobs/summary-sync';
import { registerIntakeWebhook, cleanupPendingEntries } from './services/telegram-adapter';
import { processRawEntries } from './jobs/process-raw';
import { ensureApiProviderTables, refreshProviderCache, getCachedProvider } from './services/api-provider';
import { ensureApiUsageTables } from './services/api-usage';

// Route modules
import { authRouter } from './routes/auth';
import { scanExecutionRouter } from './routes/scan-execution';
import { jobRouter } from './routes/jobs';
import { accountsRouter } from './routes/accounts';
import { modelRouter } from './routes/models';
import { dashboardRouter } from './routes/dashboard';
import { databaseRouter } from './routes/database';
import { experimentsRouter } from './routes/experiments';
import { exportRouter } from './routes/export';
import { providerRouter } from './routes/providers';
import { orgRouter } from './routes/orgs';
import { integrationRouter } from './routes/integrations';
import { feedRouter } from './routes/feeds';
import { scheduleRouter } from './routes/schedules';
import { adminRouter } from './routes/admin';
import { distributionRouter } from './routes/distribution';
import { scanPromptRouter } from './routes/scan-prompts';
import { scanEntryRouter } from './routes/scan-entries';
import { grantsIntelRouter } from './routes/grants-intel';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// CSRF origin check for state-changing requests
app.use((req: Request, res: Response, next: Function): void => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }

  // Skip if APP_URL is not configured (can't validate origin without it)
  let appHost: string;
  try {
    appHost = new URL(config.app.url).host;
  } catch {
    return next();
  }

  const origin = req.headers.origin;
  const referer = req.headers.referer;

  // Accept if Origin header matches our app
  if (origin) {
    try {
      if (new URL(origin).host === appHost) return next();
    } catch {}
    res.status(403).json({ error: 'Forbidden: origin mismatch' });
    return;
  }

  // Fall back to Referer if no Origin header
  if (referer) {
    try {
      if (new URL(referer).host === appHost) return next();
    } catch {}
    res.status(403).json({ error: 'Forbidden: referer mismatch' });
    return;
  }

  // No Origin or Referer: allow for same-origin API clients (curl, etc.)
  // This is safe because browsers always send Origin on cross-origin POSTs
  next();
});

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Readiness check (includes DB connectivity)
app.get('/ready', async (_req: Request, res: Response) => {
  const checks = {
    db: false,
    schedulerInitialized: false,
  };

  try {
    await getPool().query('SELECT 1');
    checks.db = true;
  } catch (error) {
    console.error('[Ready] DB connectivity check failed:', error);
  }

  const schedulerStatus = getSchedulerStatus();
  checks.schedulerInitialized = schedulerStatus.totalSchedules > 0;

  const ready = checks.db;
  const payload = {
    status: ready ? 'ready' : 'not_ready',
    timestamp: new Date().toISOString(),
    checks,
  };

  if (!ready) {
    res.status(503).json(payload);
    return;
  }

  res.json(payload);
});

// ── Route mounts ────────────────────────────────────────────

// Auth, login, logout, file download (mounted at / — keeps full paths)
app.use('/', authRouter);

// Feed CRUD API
app.use('/api/feeds', requireAuth, feedRouter);

// Background job triggers + SSE progress + Telegram webhook
// NOTE: Must be FIRST among /api routes — jobRouter contains the Telegram intake webhook
// which has NO auth (validated by secret header). If mounted after generic /api+requireAuth
// routes, Express intercepts the webhook with a 401 before it reaches the handler.
app.use('/api', jobRouter);

// Scan prompts CRUD + test/review/run
app.use('/api/scan/prompts', requireAuth, scanPromptRouter);

// Scan entries query, submit, queue, stats, actions, distribution per-entry
// NOTE: must be before generic /api routes to prevent requireAuth intercepting /api/scan/*
app.use('/api/scan', requireAuthOrInternalKey, scanEntryRouter);

// Schedule, digest & scheduler status API
app.use('/api', requireAuth, scheduleRouter);

// Dashboard overview stats
app.use('/api/dashboard', requireAuth, dashboardRouter);

// Scan execution + forum scan triggers (auth applied inside router)
app.use('/api', requireAuth, scanExecutionRouter);

// Background job triggers + SSE progress + Telegram webhook
// NOTE: jobRouter contains the Telegram webhook which does NOT use requireAuth.
// Models & wires lookup
app.use('/api', requireAuth, modelRouter);

// Distribution API (config, channels CRUD, run, newsletter, status, redistribute)
app.use('/api', requireAuth, distributionRouter);

// CSV export API
app.use('/api/export', requireAuth, exportRouter);

// API providers, usage tracking & pricing
app.use('/api', requireAuth, providerRouter);

// Database introspection API
app.use('/api/database', requireAuth, databaseRouter);

// Grants intelligence intake / four-pillar review view
app.use('/api/grants-intel', requireAuth, grantsIntelRouter);

// Scoring experiments API
app.use('/api/experiments', requireAuth, experimentsRouter);

// Org profiles API
app.use('/api/orgs', requireAuth, orgRouter);

// Integrations API (Notion CRM Sync)
app.use('/api/integrations', requireAuth, integrationRouter);

// Admin operations (migrations, backfills, purges)
app.use('/api/admin', requireAuth, adminRouter);
app.use('/api/accounts', requireAuthOrInternalKey, accountsRouter);

// ── Static serving & SPA fallback ───────────────────────────

// Serve React dashboard (built client)
const clientDist = path.join(__dirname, '../dist/client');
app.use(express.static(clientDist, {
  // Hashed assets (e.g. index-abc123.js) can be cached forever
  setHeaders: (res, filePath) => {
    if (filePath.match(/\.(js|css)$/) && filePath.match(/[-\.][a-f0-9]{8}\./)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      // index.html and other non-hashed files: no cache
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// SPA fallback — serve index.html for non-API, non-auth routes
app.get('*', (req: Request, res: Response, next: Function) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path === '/health') {
    return next();
  }
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) next();
  });
});

// Global error handler — catches unhandled errors from async route handlers
app.use((err: Error, _req: Request, res: Response, _next: express.NextFunction) => {
  console.error('[Server] Unhandled error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export async function startServer(): Promise<void> {
  // Ensure sessions table exists (DB-backed sessions survive deploys)
  try {
    await ensureSessionsTable();
  } catch (error) {
    console.error('Sessions table initialization failed (non-fatal):', error);
  }

  // Ensure feeds table exists and is seeded with known wires
  try {
    await ensureFeedsTable();
  } catch (error) {
    console.error('Feeds table initialization failed (non-fatal):', error);
  }

  // Add classification columns to scan_entries (Gate 1 + Gate 2 support)
  try {
    await ensureClassificationColumns();
  } catch (error) {
    console.error('Classification columns migration failed (non-fatal):', error);
  }

  // Ensure org_profiles table exists (Gate 2.5)
  try {
    await ensureOrgProfilesTable();
    // Fire-and-forget: recompute derived fields (avg_quality_score, tier) on startup
    computeDerivedFields().catch(err =>
      console.error('[Startup] computeDerivedFields failed (non-fatal):', err)
    );
  } catch (error) {
    console.error('Org profiles table migration failed (non-fatal):', error);
  }

  // Ensure integration_config table exists (Notion CRM Sync)
  try {
    await ensureIntegrationConfigTable();
  } catch (error) {
    console.error('Integration config table migration failed (non-fatal):', error);
  }

  // Ensure entry action audit columns exist (actioned_by, action_reason)
  try {
    await ensureEntryActionColumns();
  } catch (error) {
    console.error('Entry action columns migration failed (non-fatal):', error);
  }

  // Ensure engagement_metrics table exists
  try {
    await ensureEngagementMetricsTable();
  } catch (error) {
    console.error('Engagement metrics table migration failed (non-fatal):', error);
  }

  // Ensure distribute_after column exists
  try {
    await ensureDistributeAfterColumn();
  } catch (error) {
    console.error('distribute_after column migration failed (non-fatal):', error);
  }

  // Ensure auto_summarize_failed column exists
  try {
    await ensureAutoSummarizeFailedColumn();
  } catch (error) {
    console.error('auto_summarize_failed column migration failed (non-fatal):', error);
  }

  // Ensure monitored_accounts table exists
  try {
    await ensureMonitoredAccountsTable();
  } catch (error) {
    console.error('monitored_accounts table migration failed (non-fatal):', error);
  }

  // Ensure API provider + usage tables exist
  try {
    await ensureApiProviderTables();
    await ensureApiUsageTables();
    await refreshProviderCache();
    console.log('[Startup] API provider & usage tables ready');
  } catch (error) {
    console.error('API provider/usage table initialization failed (non-fatal):', error);
  }

  // Initialize the scheduler (loads config from database)
  // Wrapped in try-catch so scheduler issues don't prevent server from starting
  try {
    await initScheduler();
    console.log('Scheduler initialized');

    // Ensure a daily-digest schedule exists (disabled by default — operator opts in)
    const allSchedules = getSchedules();
    const hasDigest = allSchedules.some(s => s.scheduleType === 'daily-digest');
    if (!hasDigest) {
      try {
        await addSchedule({
          name: 'Daily Digest',
          scheduleType: 'daily-digest',
          hour: 6,
          minute: 0,
          timezone: 'America/Los_Angeles',
          enabled: false,
          dayOfWeek: 0,
          lookbackDays: 1,
        });
        console.log('Created default daily-digest schedule (disabled)');
      } catch (digestErr) {
        console.error('Failed to create default daily-digest schedule (non-fatal):', digestErr);
      }
    }
  } catch (error) {
    console.error('Scheduler initialization failed (non-fatal):', error);
  }

  // Backfill: re-classify + re-score entries using LLM scorer
  // Runs once on startup, non-blocking. Covers: unclassified entries AND entries
  // with old keyword-based scores (quality_breakdown not containing scoreReason).
  setTimeout(async () => {
    try {
      const pool = getPool();
      const toRescore = await pool.query(
        `SELECT id, name, description, source_url, wire FROM scan_entries
         WHERE status IN ('queued', 'approved')
           AND (
             classification IS NULL
             OR classification = 'UNCHECKED'
             OR quality_breakdown IS NULL
             OR quality_breakdown::text NOT LIKE '%scoreReason%'
           )
         ORDER BY created_at DESC
         LIMIT 500`
      );
      if (toRescore.rows.length > 0) {
        console.log(`[Startup] Re-scoring ${toRescore.rows.length} entries with LLM scorer...`);
        const { classifyBatch } = await import('./services/classifier');
        const stats = await classifyBatch(toRescore.rows, pool);
        console.log(`[Startup] LLM re-score complete: ${stats.classified} scored, ${stats.errors} errors`);
      } else {
        console.log('[Startup] All entries already scored with LLM scorer');
      }
    } catch (err) {
      console.error('[Startup] LLM re-score backfill failed (non-fatal):', err);
    }
  }, 10000); // 10s delay — let the server fully start first

  // Start the summary sync bridge (tele-sum summaries → approved scan_entries)
  try {
    startSummarySync(getPool(), 15);
  } catch (error) {
    console.error('Summary sync startup failed (non-fatal):', error);
  }

  // Register Telegram intake webhook if configured
  const intakeToken = getCachedProvider('telegram-intake')?.api_key || config.telegramIntake.botToken;
  if (intakeToken) {
    try {
      await registerIntakeWebhook();
    } catch (error) {
      console.error('Telegram intake webhook registration failed (non-fatal):', error);
    }
  }

  // Process raw entries every 5 minutes (dedup + scoring pipeline)
  const processRawTimer = setInterval(async () => {
    try {
      await processRawEntries(getPool());
    } catch (error) {
      console.error('[ProcessRaw] Scheduled run failed:', error);
    }
  }, 5 * 60 * 1000);
  processRawTimer.unref();

  // Run once at startup (after a short delay to let DB settle)
  setTimeout(async () => {
    try {
      await processRawEntries(getPool());
    } catch (error) {
      console.error('[ProcessRaw] Initial run failed:', error);
    }
  }, 10_000);

  // Cleanup expired pending intake entries every 15 minutes
  const intakeCleanupTimer = setInterval(cleanupPendingEntries, 15 * 60 * 1000);
  intakeCleanupTimer.unref();

  const server = app.listen(config.app.port, () => {
    console.log(`Server running on port ${config.app.port}`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[Server] ${signal} received, shutting down gracefully...`);
    stopScheduler();
    stopSummarySync();
    stopAuthCleanup();
    jobQueue.stopPeriodicCleanup();
    clearInterval(processRawTimer);
    clearInterval(intakeCleanupTimer);
    server.close(async () => {
      await closePool();
      console.log('[Server] Shutdown complete');
      process.exit(0);
    });
    // Force exit after 10s if graceful shutdown stalls
    setTimeout(() => {
      console.error('[Server] Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export { app };
