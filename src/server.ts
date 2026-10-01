import path from 'path';
import express, { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { stopAuthCleanup } from './services/auth';
import { requireAuth } from './middleware/auth';
import { requireAuthOrInternalKey } from './middleware/internal-auth';
import { closePool, getPool } from './db';
import { jobQueue } from './services/job-queue';
import { getSchedules, addSchedule, initScheduler, stopScheduler, getSchedulerStatus } from './services/scheduler';
import { computeDerivedFields } from './services/org-enricher';
import { startSummarySync, stopSummarySync } from './jobs/summary-sync';
import { registerIntakeWebhook } from './services/telegram-adapter';
import { processRawEntries } from './jobs/process-raw';
import { runDecidedRecheck } from './jobs/decided-recheck';
import { publishPublicSnapshot } from './jobs/public-snapshot';
import { refreshProviderCache, getCachedProvider } from './services/api-provider';
import { refreshPricingCache } from './services/api-usage';
import { getStartupMigrationHealth, verifyDatabaseSchema } from './db/startup-migrations';
import { csrfGuard } from './middleware/csrf';

// Route modules
import { authRouter } from './routes/auth';
import { scanExecutionRouter } from './routes/scan-execution';
import { jobRouter } from './routes/jobs';
import { accountsRouter } from './routes/accounts';
import { modelRouter } from './routes/models';
import { dashboardRouter } from './routes/dashboard';
import { databaseRouter } from './routes/database';
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

import { drainPublicationQueue } from './services/publication-queue';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// CSRF origin check for cookie-authenticated state-changing requests
app.use(csrfGuard);

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Readiness check (DB connectivity + startup migrations)
app.get('/ready', async (_req: Request, res: Response) => {
  const migrations = getStartupMigrationHealth();
  const checks = {
    db: false,
    schedulerInitialized: false,
    startupMigrations: migrations.ran && migrations.failed === 0,
  };

  try {
    await getPool().query('SELECT 1');
    checks.db = true;
  } catch (error) {
    console.error('[Ready] DB connectivity check failed:', error);
  }

  const schedulerStatus = getSchedulerStatus();
  checks.schedulerInitialized = schedulerStatus.totalSchedules > 0;

  const ready = checks.db && checks.startupMigrations;
  const payload = {
    status: ready ? 'ready' : 'not_ready',
    timestamp: new Date().toISOString(),
    checks,
    ...(migrations.failed > 0 ? { migrationErrors: migrations.errors } : {}),
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

// Background job triggers + SSE progress + Telegram webhook
// NOTE: Must be FIRST among /api routes — jobRouter contains the Telegram intake webhook
// which has NO auth (validated by secret header). If mounted after generic /api+requireAuth
// routes, Express intercepts the webhook with a 401 before it reaches the handler.
app.use('/api', jobRouter);

// Scan prompts CRUD + test/review/run (internal key allowed for agent-driven scans)
app.use('/api/scan/prompts', requireAuthOrInternalKey, scanPromptRouter);

// Scan entries query, submit, queue, stats, actions, distribution per-entry
// NOTE: must be before generic /api routes to prevent requireAuth intercepting /api/scan/*
app.use('/api/scan', requireAuthOrInternalKey, scanEntryRouter);

// Scan execution + forum + feeds triggers (dashboard auth OR internal agent key).
// MUST come before the session-only /api/feeds and scheduleRouter mounts below: those
// prefix-shadow POST /api/feeds/run and /api/forum/run and would 401 the internal key.
app.use('/api', requireAuthOrInternalKey, scanExecutionRouter);

// Feed CRUD API (session only) — mounted AFTER scanExecutionRouter so /api/feeds/run
// resolves to the trigger above, not this CRUD router.
app.use('/api/feeds', requireAuth, feedRouter);

// Schedule, digest & scheduler status API
app.use('/api', requireAuth, scheduleRouter);

// Dashboard overview stats
app.use('/api/dashboard', requireAuth, dashboardRouter);

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
app.use('/api/grants-intel', requireAuthOrInternalKey, grantsIntelRouter);

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
  // Fail before starting any background work if the separately applied schema
  // does not match this release. The runtime connection needs no DDL privileges.
  await verifyDatabaseSchema();

  // Fire-and-forget: recompute org derived fields (avg_quality_score, tier)
  computeDerivedFields().catch(err =>
    console.error('[Startup] computeDerivedFields failed (non-fatal):', err)
  );

  // Warm the API provider cache (DB-backed keys with env fallback)
  try {
    await refreshProviderCache();
    console.log('[Startup] API provider cache ready');
  } catch (error) {
    console.error('API provider cache init failed (non-fatal):', error);
  }

  // Load model pricing so logApiUsage can stamp estimated_cost_usd. Until
  // 2026-09-25 this happened as a side effect of ensureApiUsageTables(), which
  // boot no longer runs (migrations are a release step), so every call since
  // was logged with a NULL cost. Read-only, safe for the runtime role.
  try {
    await refreshPricingCache();
    console.log('[Startup] Pricing cache ready');
  } catch (error) {
    console.error('Pricing cache init failed (non-fatal):', error);
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

  // Optional queue-only repair. This is off by default because deploys must not
  // silently spend on LLM calls or mutate approved history.
  if (config.startup.llmRescoreEnabled) {
    setTimeout(async () => {
      try {
        const pool = getPool();
        const toRescore = await pool.query(
          `SELECT id, name, description, source_url, wire, amount,
                  deadline_parsed AS "deadlineParsed",
                  source_published_at AS "sourcePublishedAt"
           FROM scan_entries
           WHERE status = 'queued'
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
          console.log(`[Startup] Re-scoring ${toRescore.rows.length} queued entries with LLM scorer...`);
          const { classifyBatch } = await import('./services/classifier');
          const stats = await classifyBatch(toRescore.rows, pool);
          console.log(`[Startup] LLM re-score complete: ${stats.classified} scored, ${stats.errors} errors`);
        } else {
          console.log('[Startup] No queued entries require LLM re-score');
        }
      } catch (err) {
        console.error('[Startup] LLM re-score backfill failed (non-fatal):', err);
      }
    }, 10000); // 10s delay: let the server fully start first
  } else {
    console.log('[Startup] Automatic LLM re-score disabled');
  }

  // Start the summary sync bridge (tele-sum summaries → approved scan_entries)
  try {
    startSummarySync(getPool(), 15);
  } catch (error) {
    console.error('Summary sync startup failed (non-fatal):', error);
  }

  // Register Telegram intake webhook if configured
  const intakeToken = getCachedProvider('telegram-intake')?.api_key;
  if (intakeToken) {
    try {
      await registerIntakeWebhook();
    } catch (error) {
      console.error('Telegram intake webhook registration failed (non-fatal):', error);
    }
  }

  // Process raw entries + decided-recheck every 5 minutes. Recheck runs right
  // after process-raw so a scan's freshly queued entries are deduped against
  // the decided corpus in the SAME cycle. Tying it to the 5-min loop (which
  // also fires ~10s after every boot) means it survives frequent redeploys —
  // a standalone 15-min timer kept getting reset before it could fire.
  const runPipelineCycle = async () => {
    try {
      await processRawEntries(getPool());
    } catch (error) {
      console.error('[ProcessRaw] Scheduled run failed:', error);
    }
    try {
      await runDecidedRecheck(getPool());
    } catch (error) {
      console.error('[DecidedRecheck] Scheduled run failed:', error);
    }
    // Public snapshot for the Wire Room Live page. Runs last so it always sees
    // the state this cycle produced, and is isolated so a push failure can never
    // stop process-raw or decided-recheck. No new cron — folded into this one.
    try {
      await publishPublicSnapshot(getPool());
    } catch (error) {
      console.error('[PublicSnapshot] Scheduled run failed:', error);
    }
  };

  const processRawTimer = setInterval(runPipelineCycle, 5 * 60 * 1000);
  processRawTimer.unref();

  // Run once at startup (after a short delay to let DB settle)
  setTimeout(runPipelineCycle, 10_000);

  // Contacts sync every 30 min: Notion Contacts DB → people-monitor control surface
  const contactsSync = async () => {
    try {
      const { runContactsSync } = await import('./jobs/contacts-sync');
      await runContactsSync(getPool());
    } catch (error) {
      console.error('[ContactsSync] Scheduled run failed:', error);
    }
  };
  const contactsSyncTimer = setInterval(contactsSync, 30 * 60 * 1000);
  contactsSyncTimer.unref();
  setTimeout(contactsSync, 25_000); // once shortly after startup

  // CRM work (org enrichment, contact discovery, Notion CRM sync) is folded
  // into the daily-digest cycle (scheduler.ts) — no standalone timers. The
  // digest-orgs lane was retired 2026-07-03.

  const publishTick = () => {
    const migrations = getStartupMigrationHealth();
    if (!migrations.ran || migrations.failed) return;
    return drainPublicationQueue().catch(error => console.error('[PublicationQueue]', error));
  };
  const publicationTimer = setInterval(publishTick, 30_000);
  publicationTimer.unref();
  void publishTick();

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
    clearInterval(contactsSyncTimer);
    clearInterval(publicationTimer);
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
