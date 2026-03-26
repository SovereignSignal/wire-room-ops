import path from 'path';
import express, { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { validateMagicLink, createMagicLink, createDownloadToken, createSessionToken, validateSession, invalidateSession, stopAuthCleanup, ensureSessionsTable } from './services/auth';
import { requireAuth, verifyPrivyToken, isDevMode } from './middleware/auth';
import { rateLimit } from './middleware/rate-limit';
import { getFile, listFiles } from './services/storage';
import { getAvailableWires, closePool, ensureFeedsTable, ensureClassificationColumns, getPool } from './db';
import { sendScanDigestEmail, sendResendLinkEmail } from './services/email';
import { StoredFile } from './types';
import { jobQueue } from './services/job-queue';
import { getAllModels } from './services/models';
import { getSchedules, addSchedule, initScheduler, stopScheduler, getSchedulerStatus } from './services/scheduler';
import { ensureOrgProfilesTable } from './services/org-extractor';
import { computeDerivedFields } from './services/org-enricher';
import { ensureIntegrationConfigTable } from './services/notion-sync';
import { runScanExecution } from './jobs/scan-execution';
import { runForumScan } from './jobs/forum-scan';
import { syncSummariesToScanEntries, startSummarySync, stopSummarySync } from './jobs/summary-sync';
import { renderLoginPage } from './views/login';
import { renderErrorPage, renderLegacyDownloadPage, renderExpiredLinkPage, renderResendSuccessPage } from './views/error';
import { handleTelegramUpdate, registerIntakeWebhook, cleanupPendingEntries } from './services/telegram-adapter';
import { processRawEntries } from './jobs/process-raw';
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
import { runEnrichment } from './jobs/enrichment';
import { ensureApiProviderTables, refreshProviderCache, getCachedProvider } from './services/api-provider';
import { ensureApiUsageTables } from './services/api-usage';

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

// Landing page - login check then serve React SPA or login page
app.get('/', async (req: Request, res: Response) => {
  const session = req.cookies?.session as string;
  if (isDevMode || (session && await validateSession(session))) {
    // Authenticated — serve React SPA
    const indexPath = path.join(__dirname, '../dist/client/index.html');
    res.sendFile(indexPath, (err) => {
      if (err) {
        // Fallback if client not built yet
        res.redirect('/queue');
      }
    });
    return;
  }
  res.send(renderLoginPage());
});

app.get('/logout', async (req: Request, res: Response) => {
  const sessionToken = req.cookies?.session as string;
  if (sessionToken) {
    await invalidateSession(sessionToken);
  }
  res.clearCookie('session', { httpOnly: true, sameSite: 'lax' });
  res.redirect('/');
});

// Privy auth callback - verifies token and creates session
app.post('/api/auth/callback', async (req: Request, res: Response) => {
  const { token } = req.body;
  if (!token) {
    res.status(400).json({ error: 'Missing token' });
    return;
  }

  try {
    const claims = await verifyPrivyToken(token);
    const privyUserId = claims.sub;

    if (!privyUserId) {
      res.status(401).json({ error: 'Invalid token: no user ID' });
      return;
    }

    // Fetch user details from Privy to get their email
    const privyUserRes = await fetch(`https://auth.privy.io/api/v1/users/${privyUserId}`, {
      headers: {
        'Authorization': `Basic ${Buffer.from(`${config.privy.appId}:${config.privy.appSecret}`).toString('base64')}`,
        'privy-app-id': config.privy.appId,
      },
    });

    if (!privyUserRes.ok) {
      console.error(`[Auth] Failed to fetch Privy user ${privyUserId}: ${privyUserRes.status}`);
      res.status(401).json({ error: 'Could not verify user identity' });
      return;
    }

    const privyUser = await privyUserRes.json() as { linked_accounts?: Array<{ type: string; address?: string }> };

    // Extract email from linked accounts
    const linkedEmail = privyUser.linked_accounts?.find(
      (a) => a.type === 'email'
    )?.address?.toLowerCase();

    // Check against allowed emails (NOTIFICATION_EMAIL + optional ALLOWED_EMAILS)
    const allowedEmails = new Set<string>();
    if (config.email.notificationEmail) {
      allowedEmails.add(config.email.notificationEmail.toLowerCase());
    }
    const extraEmails = process.env.ALLOWED_EMAILS;
    if (extraEmails) {
      extraEmails.split(',').map(e => e.trim().toLowerCase()).filter(Boolean).forEach(e => allowedEmails.add(e));
    }

    if (!linkedEmail || !allowedEmails.has(linkedEmail)) {
      console.warn(`[Auth] Access denied for ${linkedEmail || 'unknown email'} (Privy user ${privyUserId})`);
      res.status(403).json({ error: 'Access denied. This dashboard is restricted.' });
      return;
    }

    console.log(`[Auth] Login granted for ${linkedEmail}`);
    const sessionToken = await createSessionToken(linkedEmail);
    res.cookie('session', sessionToken, {
      httpOnly: true,
      secure: config.app.url.startsWith('https'),
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days to match DB session expiry
    });
    res.json({ ok: true });
  } catch (error) {
    console.error('Privy token verification failed:', error);
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Legacy view routes removed — React SPA handles these paths via the * fallback below

// Legacy view redirect routes removed — React SPA handles all UI paths

// API: Get available models
app.get('/api/models', requireAuth, async (req: Request, res: Response) => {
  try {
    const models = await getAllModels();
    res.json(models);
  } catch (error) {
    console.error('Failed to fetch models:', error);
    res.status(500).json({ error: 'Failed to fetch models' });
  }
});

// API: Get available wires (feeds) from database
app.get('/api/wires', requireAuth, async (req: Request, res: Response) => {
  try {
    const wires = await getAvailableWires();
    res.json(wires);
  } catch (error) {
    console.error('Failed to fetch wires:', error);
    res.status(500).json({ error: 'Failed to fetch wires' });
  }
});

// Feed CRUD API
app.use('/api/feeds', requireAuth, feedRouter);

// Running job trackers to prevent concurrent execution
let runningScanJobId: string | null = null;
let runningForumJobId: string | null = null;

// SSE endpoint for job progress
app.get('/api/job/:jobId/progress', requireAuth, (req: Request, res: Response) => {
  const { jobId } = req.params;
  const job = jobQueue.getJob(jobId);

  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send keepalive comment every 30s to prevent proxy timeouts
  const keepalive = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      clearInterval(keepalive);
    }
  }, 30_000);

  // Subscribe to job updates
  const unsubscribe = jobQueue.subscribe(jobId, (status) => {
    res.write(`data: ${JSON.stringify(status)}\n\n`);

    // Close connection when job is complete or failed
    if (status.status === 'completed' || status.status === 'failed') {
      clearInterval(keepalive);
      setTimeout(() => {
        res.end();
      }, 100);
    }
  });

  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(keepalive);
    unsubscribe();
  });
});

// Download file
app.get('/file/:fileId', async (req: Request, res: Response) => {
  const session = req.cookies?.session as string;
  const fileId = req.params.fileId;

  if (!session || !(await validateSession(session))) {
    res.redirect('/');
    return;
  }
  
  const file = await getFile(fileId);

  if (!file) {
    res.status(404).send(renderErrorPage('File not found'));
    return;
  }

  const ext = file.filename.split('.').pop()?.toLowerCase();
  const contentType = ext === 'csv' ? 'text/csv; charset=utf-8' : 'text/markdown; charset=utf-8';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.filename)}"`);
  res.send(file.content);
});

// Resend download link for the most recent file
// Resend download link - requires auth or strict rate limiting
app.post('/resend-link', async (req: Request, res: Response) => {
  // Check auth first; fall back to IP rate limiting for expired-session users
  const session = req.cookies?.session as string;
  const isAuthed = session && await validateSession(session);

  if (!isAuthed) {
    const clientIp = req.ip || 'unknown';
    if (!rateLimit(`resend:${clientIp}`, 2, 30 * 60 * 1000)) {
      res.status(429).send(renderErrorPage('Too many requests. Please try again later.'));
      return;
    }
  }

  try {
    const files = await listFiles();

    if (files.length === 0) {
      res.send(renderErrorPage('No files available. Please run the job first.'));
      return;
    }

    // Get the most recent file
    const latestFile = files[0];

    const downloadUrl = createMagicLink(config.email.notificationEmail, latestFile.id);
    await sendResendLinkEmail(config.email.notificationEmail, downloadUrl, latestFile.filename);
    
    res.send(renderResendSuccessPage());
  } catch (error) {
    console.error('Failed to resend link:', error);
    res.send(renderErrorPage('Failed to resend link. Please try again.'));
  }
});

// Legacy download endpoint for email links
app.get('/download', async (req: Request, res: Response) => {
  const token = req.query.token as string;
  
  if (!token) {
    res.redirect('/');
    return;
  }
  
  const validation = validateMagicLink(token);
  
  if (!validation.valid || !validation.fileId) {
    res.send(renderExpiredLinkPage(validation.error || 'Invalid link'));
    return;
  }
  
  const file = await getFile(validation.fileId);
  
  if (!file) {
    res.status(404).send(renderErrorPage('File not found'));
    return;
  }
  
  const downloadToken = createDownloadToken(validation.fileId);
  res.send(renderLegacyDownloadPage(file.filename, downloadToken));
});

// Legacy file download
app.get('/download/:token', async (req: Request, res: Response) => {
  const token = req.params.token;
  const validation = validateMagicLink(token);
  
  if (!validation.valid || !validation.fileId) {
    res.status(401).send(renderErrorPage(validation.error || 'Invalid or expired download link'));
    return;
  }
  
  const file = await getFile(validation.fileId);

  if (!file) {
    res.status(404).send(renderErrorPage('File not found'));
    return;
  }

  const ext = file.filename.split('.').pop()?.toLowerCase();
  const contentType = ext === 'csv' ? 'text/csv; charset=utf-8' : 'text/markdown; charset=utf-8';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.filename)}"`);
  res.send(file.content);
});

// API: List files
app.get('/api/files', requireAuth, async (req: Request, res: Response) => {

  const files = await listFiles();
  res.json(files.map((f: StoredFile) => ({
    id: f.id,
    filename: f.filename,
    createdAt: f.createdAt,
    dateRange: f.dateRange,
  })));
});

// Schedule, digest & scheduler status API
app.use('/api', requireAuth, scheduleRouter);

// Scan prompts CRUD + test/review/run
app.use('/api/scan/prompts', requireAuth, scanPromptRouter);

// Scan entries query, submit, queue, stats, actions, distribution per-entry
app.use('/api/scan', requireAuth, scanEntryRouter);

// API: Dashboard overview stats (aggregated for React dashboard)
app.get('/api/dashboard/stats', requireAuth, async (req: Request, res: Response) => {
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

// ============================================================
// Phase 2: Automated Scan Execution + Jobs + Pipeline Triggers
// ============================================================

// API: Trigger automated scan execution (async with SSE progress)
app.post('/api/scan/run', requireAuth, async (req: Request, res: Response) => {
  if (!rateLimit('scan-run', 1, 15 * 60 * 1000)) {
    res.status(429).json({ error: 'Scan already running or recently completed. Please wait 15 minutes between scans.' });
    return;
  }

  // Prevent concurrent scan jobs
  if (runningScanJobId) {
    const existingJob = jobQueue.getJob(runningScanJobId);
    if (existingJob && existingJob.status === 'running') {
      res.status(409).json({ error: 'A scan job is already running', jobId: runningScanJobId });
      return;
    }
    runningScanJobId = null;
  }

  const { wire } = req.body;
  const pool = getPool();

  const jobId = jobQueue.createJob();
  runningScanJobId = jobId;
  res.json({ jobId });

  (async () => {
    jobQueue.updateJob(jobId, { status: 'running' });

    try {
      const result = await runScanExecution(pool, {
        wire: wire || undefined,
        onProgress: (message, pct) => {
          jobQueue.updateProgress(jobId, {
            current: pct,
            total: 100,
            step: message,
          });
        },
      });

      jobQueue.completeJob(jobId, result);

      // Send digest email for manual scans too
      if (result.totalResults > 0) {
        try {
          await sendScanDigestEmail(result, config.app.url);
          console.log(`[ScanRun] Digest email sent`);
        } catch (emailErr) {
          console.error(`[ScanRun] Failed to send digest email:`, emailErr);
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      jobQueue.failJob(jobId, errorMsg);
    } finally {
      runningScanJobId = null;
      jobQueue.cleanup();
    }
  })().catch(error => {
    console.error('Unexpected error in scan runner:', error);
    runningScanJobId = null;
  });
});

// API: Trigger forum scan via discuss.watch (async with SSE progress)
app.post('/api/forum/run', requireAuth, async (req: Request, res: Response) => {
  if (!config.forum.enabled) {
    res.status(400).json({ error: 'Forum scanning is not enabled. Set FORUM_SCAN_ENABLED=true to enable.' });
    return;
  }

  // Check concurrent first (does not consume rate limit token)
  if (runningForumJobId) {
    const existingJob = jobQueue.getJob(runningForumJobId);
    if (existingJob && existingJob.status === 'running') {
      res.status(409).json({ error: 'A forum scan job is already running', jobId: runningForumJobId });
      return;
    }
    runningForumJobId = null;
  }

  if (!rateLimit('forum-run', 1, 15 * 60 * 1000)) {
    res.status(429).json({ error: 'Forum scan recently completed. Please wait 15 minutes.' });
    return;
  }

  const { wire } = req.body;
  const pool = getPool();

  const jobId = jobQueue.createJob();
  runningForumJobId = jobId;
  res.json({ jobId });

  (async () => {
    jobQueue.updateJob(jobId, { status: 'running' });

    try {
      const result = await runForumScan(pool, {
        wire: wire || undefined,
        onProgress: (message, pct) => {
          jobQueue.updateProgress(jobId, {
            current: pct,
            total: 100,
            step: message,
          });
        },
      });

      jobQueue.completeJob(jobId, result);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      jobQueue.failJob(jobId, errorMsg);
    } finally {
      runningForumJobId = null;
      jobQueue.cleanup();
    }
  })().catch(error => {
    console.error('Unexpected error in forum scan runner:', error);
    runningForumJobId = null;
  });
});

// API: Manual trigger for summary sync (tele-sum summaries → scan_entries)
app.post('/api/summary-sync', requireAuth, async (_req: Request, res: Response) => {
  if (!rateLimit('summary-sync', 3, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Summary sync recently run. Please wait 5 minutes.' });
    return;
  }

  try {
    const pool = getPool();
    const result = await syncSummariesToScanEntries(pool);
    res.json({ success: true, ...result });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[SummarySync] Manual trigger failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// API: Manual trigger for process-raw (dedup+score raw entries)
app.post('/api/process-raw', requireAuth, async (_req: Request, res: Response) => {
  if (!rateLimit('process-raw', 3, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Process-raw recently run. Please wait 5 minutes.' });
    return;
  }

  try {
    const pool = getPool();
    const result = await processRawEntries(pool);
    res.json({ success: true, ...result });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[ProcessRaw] Manual trigger failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// API: Enrich queued entries with thin descriptions
app.post('/api/enrich', requireAuth, async (req: Request, res: Response) => {
  if (!rateLimit('enrich', 3, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Enrichment recently run. Please wait 5 minutes.' });
    return;
  }

  try {
    const wire = req.body?.wire as string | undefined;
    const result = await runEnrichment(wire);
    res.json({ success: true, ...result });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Enrichment] Manual trigger failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// API: Batch-classify queued entries with Grok LLM (Gate 2)
app.post('/api/scan/classify-queue', requireAuth, async (req: Request, res: Response) => {
  if (!rateLimit('classify-queue', 3, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Classification recently run. Please wait a few minutes.' });
    return;
  }

  try {
    const pool = getPool();
    const wire = req.body?.wire as string | undefined;

    const conditions = [`status IN ('queued', 'approved')`, `(classification IS NULL OR classification = 'UNCHECKED')`];
    const values: any[] = [];
    let paramIndex = 1;

    if (wire) {
      conditions.push(`wire = $${paramIndex++}`);
      values.push(wire);
    }

    const result = await pool.query(
      `SELECT id, name, description, source_url, wire FROM scan_entries
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT 200`,
      values
    );

    if (result.rows.length === 0) {
      res.json({ classified: 0, errors: 0, durationMs: 0 });
      return;
    }

    const { classifyBatch } = await import('./services/classifier');
    const start = Date.now();
    const stats = await classifyBatch(result.rows, pool);
    const durationMs = Date.now() - start;

    res.json({ ...stats, durationMs });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[ClassifyQueue] Failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// API: Telegram intake webhook (no auth — validated by secret header)
app.post('/api/telegram/intake-webhook', async (req: Request, res: Response) => {
  // Always return 200 so Telegram doesn't retry
  const secret = config.telegramIntake.webhookSecret;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    console.warn('[TelegramIntake] Webhook called with invalid secret');
    res.sendStatus(200);
    return;
  }

  // Fire and forget — respond immediately
  handleTelegramUpdate(req.body).catch(err => {
    console.error('[TelegramIntake] Handler error:', err);
  });

  res.sendStatus(200);
});

// Distribution API (config, channels CRUD, run, newsletter, status, redistribute)
app.use('/api', requireAuth, distributionRouter);

// CSV export API
app.use('/api/export', requireAuth, exportRouter);

// API providers, usage tracking & pricing
app.use('/api', requireAuth, providerRouter);

// Database introspection API
app.use('/api/database', requireAuth, databaseRouter);

// Scoring experiments API
app.use('/api/experiments', requireAuth, experimentsRouter);

// Org profiles API
app.use('/api/orgs', requireAuth, orgRouter);

// Integrations API (Notion CRM Sync)
app.use('/api/integrations', requireAuth, integrationRouter);

// Admin operations (migrations, backfills, purges)
app.use('/api/admin', requireAuth, adminRouter);

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
