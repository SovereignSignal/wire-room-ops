import path from 'path';
import express, { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { validateMagicLink, createMagicLink, createDownloadToken, createSessionToken, validateSession, invalidateSession, stopAuthCleanup, ensureSessionsTable } from './services/auth';
import { requireAuth, verifyPrivyToken, isDevMode } from './middleware/auth';
import { rateLimit } from './middleware/rate-limit';
import { isValidUuid, isValidFeedKey } from './utils/validation';
import { maskConfig, maskCredentials } from './utils/masking';
import { getFile, listFiles } from './services/storage';
import { getAvailableWires, closePool, getAllFeeds, ensureFeedsTable, ensureClassificationColumns, getFeedByKey, getAllScanPrompts, getScanPromptById, createScanPrompt, updateScanPrompt, deleteScanPrompt, getStatusCounts, getEntriesByStatus, getSeenUrlStats, getSeenUrlsList } from './db';
import { sendScanDigestEmail, sendResendLinkEmail } from './services/email';
import { StoredFile } from './types';
import { jobQueue } from './services/job-queue';
import { getAllModels } from './services/models';
import { getSchedules, addSchedule, initScheduler, stopScheduler, getSchedulerStatus } from './services/scheduler';
import { buildSubmission, buildBatchSubmission } from './services/intake';
import { runDailyIntake, getDailyQueue, getIntakeStats } from './jobs/daily-intake';
import { getPool, getDistributionConfigs, upsertDistributionConfig, getDistributionLogs, getDistributionStatusBulk, getDistributionStatusForEntries, getDistributionChannels, getDistributionChannelById, createDistributionChannel, updateDistributionChannel, deleteDistributionChannel } from './db';
import { executeScanPrompt } from './services/grok';
import { executePerplexityScan } from './services/perplexity';
import { ensureOrgProfilesTable } from './services/org-extractor';
import { computeDerivedFields } from './services/org-enricher';
import { ensureIntegrationConfigTable } from './services/notion-sync';
import { withRetry } from './services/processor';
import { runScanExecution } from './jobs/scan-execution';
import { runForumScan } from './jobs/forum-scan';
import { syncSummariesToScanEntries, startSummarySync, stopSummarySync } from './jobs/summary-sync';
import { getPromptEffectivenessStats } from './services/scan-stats';
import { distributeEntries, retryDistribution, generateNewsletterMarkdown, confirmNewsletterDistribution, sendTestMessage } from './services/distribution';
import { parseStructuredOutput } from './services/intake';
import { reviewScanPrompt } from './services/anthropic';
import type { RawScanResult, ToolType } from './types/intake';
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
import { runEnrichment } from './jobs/enrichment';
import { validateForApproval } from './services/approval-guard';
import { singleEntryAction, bulkEntryAction, ApprovalBlockedError, BulkApprovalBlockedError } from './services/entry-actions';
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
const distributionRunning = new Set<string>();

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

// API: Submit a single scan prompt result
app.post('/api/scan/submit', requireAuth, async (req: Request, res: Response) => {
  const { wire, promptVariant, scanDate, rawText, source } = req.body;

  try {
    // Validate wire against feeds table
    const feeds = await getAllFeeds();
    const validKeys = feeds.map(f => f.key);
    if (!wire || !validKeys.includes(wire)) {
      res.status(400).json({ error: `Invalid wire "${wire}". Valid: ${validKeys.join(', ')}` });
      return;
    }
    if (!promptVariant || !['A', 'B', 'C'].includes(promptVariant)) {
      res.status(400).json({ error: 'promptVariant must be A, B, or C' });
      return;
    }
    if (!scanDate || !/^\d{4}-\d{2}-\d{2}$/.test(scanDate) || isNaN(Date.parse(scanDate))) {
      res.status(400).json({ error: 'scanDate must be a valid date string (YYYY-MM-DD)' });
      return;
    }
    if (!rawText || typeof rawText !== 'string' || rawText.trim().length === 0) {
      res.status(400).json({ error: 'rawText is required and must be non-empty' });
      return;
    }

    const submission = buildSubmission(
      rawText,
      wire,
      promptVariant,
      scanDate,
      source || 'x-scan'
    );

    const pool = getPool();
    const summary = await runDailyIntake(pool, [submission]);

    res.json({ success: true, summary });
  } catch (error) {
    console.error('Scan submit failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// API: Submit batch scan (all prompts for a wire)
app.post('/api/scan/submit-batch', requireAuth, async (req: Request, res: Response) => {
  const { wire, scanDate, rawText, source } = req.body;

  try {
    const feeds = await getAllFeeds();
    const validKeys = feeds.map(f => f.key);
    if (!wire || !validKeys.includes(wire)) {
      res.status(400).json({ error: `Invalid wire "${wire}". Valid: ${validKeys.join(', ')}` });
      return;
    }
    if (!scanDate || !/^\d{4}-\d{2}-\d{2}$/.test(scanDate) || isNaN(Date.parse(scanDate))) {
      res.status(400).json({ error: 'scanDate must be a valid date string (YYYY-MM-DD)' });
      return;
    }
    if (!rawText || typeof rawText !== 'string' || rawText.trim().length === 0) {
      res.status(400).json({ error: 'rawText is required and must be non-empty' });
      return;
    }

    const submissions = buildBatchSubmission(
      rawText,
      wire,
      scanDate,
      source || 'x-scan'
    );

    if (submissions.length === 0) {
      res.status(400).json({ error: 'Could not parse any prompt sections from rawText. Expected headers like "Prompt A", "Prompt B", etc.' });
      return;
    }

    const pool = getPool();
    const summary = await runDailyIntake(pool, submissions);

    res.json({ success: true, summary });
  } catch (error) {
    console.error('Scan batch submit failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// API: Get daily scan queue
app.get('/api/scan/queue', requireAuth, async (req: Request, res: Response) => {
  const wire = (req.query.wire as string) || null;
  const rawScore = parseInt(req.query.minScore as string);
  const minScore = isNaN(rawScore) ? 40 : Math.max(0, Math.min(100, rawScore));
  const date = (req.query.date as string) || null;

  // Validate date format if provided
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    return;
  }

  try {
    const pool = getPool();
    const entries = await getDailyQueue(pool, wire, minScore, date);
    res.json({ entries, count: entries.length });
  } catch (error) {
    console.error('Failed to get scan queue:', error);
    res.status(500).json({ error: 'Failed to get scan queue' });
  }
});

// API: Get intake stats
app.get('/api/scan/stats', requireAuth, async (req: Request, res: Response) => {
  const days = parseInt(req.query.days as string) || 7;

  try {
    const pool = getPool();
    const stats = await getIntakeStats(pool, days);
    res.json(stats);
  } catch (error) {
    console.error('Failed to get intake stats:', error);
    res.status(500).json({ error: 'Failed to get intake stats' });
  }
});

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

// API: List scan prompts
app.get('/api/scan/prompts', requireAuth, async (req: Request, res: Response) => {
  const wire = req.query.wire as string | undefined;
  const active = req.query.active as string | undefined;
  const activeOnly = active === 'true' ? true : active === 'false' ? false : undefined;

  try {
    const prompts = await getAllScanPrompts(wire || undefined, activeOnly ?? undefined);

    // Enrich with last run timestamps from scan_entries
    const pool = getPool();
    const lastRunResult = await pool.query(
      `SELECT prompt_id, MAX(created_at) as last_run_at
       FROM scan_entries WHERE prompt_id IS NOT NULL
       GROUP BY prompt_id`
    );
    const lastRunMap = new Map<string, string>();
    for (const row of lastRunResult.rows) {
      lastRunMap.set(String(row.prompt_id), row.last_run_at);
    }

    const enriched = prompts.map((p: any) => ({
      ...p,
      lastRunAt: lastRunMap.get(p.id) || null,
    }));

    res.json(enriched);
  } catch (error) {
    console.error('Failed to fetch scan prompts:', error);
    res.status(500).json({ error: 'Failed to fetch scan prompts' });
  }
});

// API: Create scan prompt
app.post('/api/scan/prompts', requireAuth, async (req: Request, res: Response) => {
  const { wire, label, promptText, responseFormat, isActive, sortOrder, toolType, variant, model, outputFormat, intent } = req.body;

  if (!wire || typeof wire !== 'string') {
    res.status(400).json({ error: 'wire is required' });
    return;
  }
  if (!label || typeof label !== 'string') {
    res.status(400).json({ error: 'label is required' });
    return;
  }
  if (!promptText || typeof promptText !== 'string' || promptText.trim().length === 0) {
    res.status(400).json({ error: 'promptText is required and must be non-empty' });
    return;
  }
  if (toolType && !['x_search', 'web_search', 'perplexity'].includes(toolType)) {
    res.status(400).json({ error: 'toolType must be "x_search", "web_search", or "perplexity"' });
    return;
  }
  if (outputFormat && !['text', 'json'].includes(outputFormat)) {
    res.status(400).json({ error: 'outputFormat must be "text" or "json"' });
    return;
  }
  if (intent && !['discovery', 'canonical', 'signal'].includes(intent)) {
    res.status(400).json({ error: 'intent must be "discovery", "canonical", or "signal"' });
    return;
  }

  // Validate wire against feeds
  try {
    const feeds = await getAllFeeds();
    const validKeys = feeds.map(f => f.key);
    if (!validKeys.includes(wire)) {
      res.status(400).json({ error: `Invalid wire "${wire}". Valid: ${validKeys.join(', ')}` });
      return;
    }

    const prompt = await createScanPrompt({
      wire,
      label,
      promptText,
      responseFormat: responseFormat || undefined,
      isActive: isActive ?? true,
      sortOrder: typeof sortOrder === 'number' ? sortOrder : undefined,
      toolType: toolType || 'x_search',
      variant: variant || undefined,
      model: model || undefined,
      outputFormat: outputFormat || undefined,
      intent: intent || undefined,
    });

    res.json(prompt);
  } catch (error) {
    console.error('Failed to create scan prompt:', error);
    res.status(500).json({ error: 'Failed to create scan prompt' });
  }
});

// API: Update scan prompt
app.put('/api/scan/prompts/:id', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id || !isValidUuid(id)) {
    res.status(400).json({ error: 'Invalid prompt ID' });
    return;
  }

  const { wire, label, promptText, responseFormat, isActive, sortOrder, toolType, variant, model, outputFormat, intent } = req.body;
  const updates: Record<string, any> = {};

  if (wire !== undefined) {
    // Validate wire against feeds
    const feeds = await getAllFeeds();
    const validKeys = feeds.map(f => f.key);
    if (!validKeys.includes(wire)) {
      res.status(400).json({ error: `Invalid wire "${wire}". Valid: ${validKeys.join(', ')}` });
      return;
    }
    updates.wire = wire;
  }
  if (label !== undefined) updates.label = label;
  if (promptText !== undefined) updates.promptText = promptText;
  if (responseFormat !== undefined) updates.responseFormat = responseFormat || null;
  if (isActive !== undefined) updates.isActive = isActive;
  if (sortOrder !== undefined) updates.sortOrder = sortOrder;
  if (variant !== undefined) updates.variant = variant;
  if (toolType !== undefined) {
    if (!['x_search', 'web_search', 'perplexity'].includes(toolType)) {
      res.status(400).json({ error: 'toolType must be "x_search", "web_search", or "perplexity"' });
      return;
    }
    updates.toolType = toolType;
  }
  if (model !== undefined) updates.model = model || null;
  if (outputFormat !== undefined) {
    if (!['text', 'json'].includes(outputFormat)) {
      res.status(400).json({ error: 'outputFormat must be "text" or "json"' });
      return;
    }
    updates.outputFormat = outputFormat;
  }
  if (intent !== undefined) {
    if (!['discovery', 'canonical', 'signal'].includes(intent)) {
      res.status(400).json({ error: 'intent must be "discovery", "canonical", or "signal"' });
      return;
    }
    updates.intent = intent;
  }

  try {
    const updated = await updateScanPrompt(id, updates);
    if (!updated) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }
    res.json(updated);
  } catch (error) {
    console.error('Failed to update scan prompt:', error);
    res.status(500).json({ error: 'Failed to update scan prompt' });
  }
});

// API: Delete scan prompt
app.delete('/api/scan/prompts/:id', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id || !isValidUuid(id)) {
    res.status(400).json({ error: 'Invalid prompt ID' });
    return;
  }

  try {
    const deleted = await deleteScanPrompt(id);
    if (!deleted) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete scan prompt:', error);
    res.status(500).json({ error: 'Failed to delete scan prompt' });
  }
});

function normalizePromptLabPayload(body: Record<string, unknown>): {
  wire?: string;
  label?: string;
  promptText: string;
  responseFormat?: string | null;
  toolType: ToolType;
  model?: string;
  outputFormat?: 'text' | 'json';
  parsedResults?: RawScanResult[];
  testOutput?: string | null;
} {
  return {
    wire: typeof body.wire === 'string' ? body.wire : undefined,
    label: typeof body.label === 'string' ? body.label : undefined,
    promptText: typeof body.promptText === 'string' ? body.promptText.trim() : '',
    responseFormat: typeof body.responseFormat === 'string' ? body.responseFormat : undefined,
    toolType: body.toolType === 'web_search' ? 'web_search' : body.toolType === 'perplexity' ? 'perplexity' : 'x_search',
    model: typeof body.model === 'string' && body.model ? body.model : undefined,
    outputFormat: body.outputFormat === 'json' ? 'json' : 'text',
    parsedResults: Array.isArray(body.parsedResults) ? body.parsedResults as RawScanResult[] : undefined,
    testOutput: typeof body.testOutput === 'string' ? body.testOutput : undefined,
  };
}

async function executePromptLabTest(input: {
  promptText: string;
  responseFormat?: string | null;
  toolType: ToolType;
  model?: string;
  outputFormat?: 'text' | 'json';
  wire?: string;
}) {
  const result = await withRetry(() => {
    if (input.toolType === 'perplexity') {
      return executePerplexityScan(input.promptText, {
        model: input.model,
        responseFormat: input.responseFormat,
        outputFormat: input.outputFormat,
      });
    }
    return executeScanPrompt(input.promptText, {
      model: input.model,
      responseFormat: input.responseFormat,
      toolType: input.toolType,
    });
  });
  const parseHint = input.outputFormat === 'json' ? 'json' as const : undefined;
  const { results: parsedResults, strategy } = parseStructuredOutput(result.content, parseHint);
  return {
    success: true,
    content: result.content,
    parsedResults,
    parsedCount: parsedResults.length,
    parseStrategy: strategy,
    model: result.model,
    tokensUsed: result.tokensUsed,
  };
}

// API: Test-run an unsaved or saved scan prompt against Grok
app.post('/api/scan/prompts/test', requireAuth, async (req: Request, res: Response) => {
  if (!rateLimit('scan-prompt-test', 5, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Too many test requests. Max 5 per 5 minutes.' });
    return;
  }

  try {
    const payload = normalizePromptLabPayload(req.body || {});
    if (!payload.promptText) {
      res.status(400).json({ error: 'promptText is required' });
      return;
    }

    res.json(await executePromptLabTest(payload));
  } catch (error) {
    console.error('Scan prompt test failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Test run failed' });
  }
});

// API: Review a scan prompt with Claude for tuning guidance
app.post('/api/scan/prompts/review', requireAuth, async (req: Request, res: Response) => {
  if (!rateLimit('scan-prompt-review', 3, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Too many review requests. Max 3 per 5 minutes.' });
    return;
  }

  try {
    const payload = normalizePromptLabPayload(req.body || {});
    if (!payload.promptText) {
      res.status(400).json({ error: 'promptText is required' });
      return;
    }

    const review = await reviewScanPrompt(payload);
    res.json(review);
  } catch (error) {
    console.error('Prompt review failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Prompt review failed' });
  }
});

// API: Test-run a saved scan prompt against Grok
app.post('/api/scan/prompts/:id/test', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id || !isValidUuid(id)) {
    res.status(400).json({ error: 'Invalid prompt ID' });
    return;
  }

  if (!rateLimit('scan-prompt-test', 5, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Too many test requests. Max 5 per 5 minutes.' });
    return;
  }

  try {
    const prompt = await getScanPromptById(id);
    if (!prompt) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }

    res.json(await executePromptLabTest({
      promptText: prompt.promptText,
      responseFormat: prompt.responseFormat,
      toolType: prompt.toolType,
      model: prompt.model || undefined,
      outputFormat: prompt.outputFormat,
      wire: prompt.wire,
    }));
  } catch (error) {
    console.error('Scan prompt test failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Test run failed' });
  }
});

// API: Run a single scan prompt through full pipeline (execute → parse → intake → queue)
app.post('/api/scan/prompts/:id/run', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id || !isValidUuid(id)) {
    res.status(400).json({ error: 'Invalid prompt ID' });
    return;
  }

  if (!rateLimit(`scan-prompt-run-${id}`, 2, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'This prompt was recently run. Max 2 per 5 minutes.' });
    return;
  }

  try {
    const prompt = await getScanPromptById(id);
    if (!prompt) {
      res.status(404).json({ error: 'Prompt not found' });
      return;
    }

    // Execute the prompt
    const scanResult = await withRetry(
      () => {
        if (prompt.toolType === 'perplexity') {
          return executePerplexityScan(prompt.promptText, {
            model: prompt.model || undefined,
            responseFormat: prompt.responseFormat,
            outputFormat: prompt.outputFormat,
          });
        }
        return executeScanPrompt(prompt.promptText, {
          model: prompt.model || undefined,
          responseFormat: prompt.responseFormat,
          toolType: prompt.toolType,
        });
      },
      2
    );

    const parseHint = prompt.outputFormat === 'json' ? 'json' as const : undefined;
    const { results: parsed, strategy: parseStrategy } = parseStructuredOutput(scanResult.content, parseHint);
    const today = new Date().toISOString().split('T')[0];

    // Determine variant
    const VALID_VARIANTS = ['A', 'B', 'C', 'W', 'P', 'N', 'S'];
    const variant = (prompt.variant && VALID_VARIANTS.includes(prompt.variant)) ? prompt.variant : 'A';

    // Determine source
    const source =
      prompt.toolType === 'perplexity' ? 'perplexity' as const :
      prompt.toolType === 'web_search' ? 'web-search' as const
        : 'x-scan' as const;

    // Run through intake pipeline
    const pool = getPool();
    const submission = {
      wire: prompt.wire,
      promptVariant: variant as any,
      scanDate: today,
      source,
      results: parsed,
      promptId: prompt.id,
      rawOutput: scanResult.content,
      parseStrategy,
    };

    const intakeSummary = await runDailyIntake(pool, [submission]);

    console.log(`[PromptRun] "${prompt.label}" → ${parsed.length} parsed (${parseStrategy}), ${intakeSummary.newUnique} new, ${intakeSummary.highQualityCount} high quality`);

    res.json({
      success: true,
      parsedCount: parsed.length,
      parseStrategy,
      newUnique: intakeSummary.newUnique,
      duplicatesFound: intakeSummary.duplicatesFound,
      highQualityCount: intakeSummary.highQualityCount,
      model: scanResult.model || 'unknown',
    });
  } catch (error) {
    console.error('Scan prompt run failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Run failed' });
  }
});

// ============================================================
// Phase 2: Automated Scan Execution + Queue Actions + Stats
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

/**
 * Auto-summarize an approved entry using Grok if enriched_summary is missing/thin.
 * Fire-and-forget — updates scan_entries.enriched_summary and patches the summaries row.
 */

// API: Bulk action on multiple entries (approve/decline/reviewlater/restore)
app.post('/api/scan/entries/bulk-action', requireAuth, async (req: Request, res: Response) => {
  const { ids, action, quiet } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: 'ids must be a non-empty array' });
    return;
  }
  if (ids.length > 200) {
    res.status(400).json({ error: 'Maximum 200 entries per bulk action' });
    return;
  }

  const entryIds = ids.map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id));
  if (entryIds.length === 0) {
    res.status(400).json({ error: 'No valid entry IDs provided' });
    return;
  }

  try {
    const result = await bulkEntryAction(entryIds, action, {
      quiet: !!quiet,
      force: req.query.force === 'true',
    });
    res.json(result);
  } catch (error) {
    if (error instanceof BulkApprovalBlockedError) {
      res.status(422).json({
        error: 'Some entries blocked',
        blocked: error.blocked,
        passCount: error.passCount,
        blockCount: error.blockCount,
      });
      return;
    }
    if (error instanceof Error && error.message.startsWith('Invalid action')) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error('Failed to bulk update entry status:', error);
    res.status(500).json({ error: 'Failed to bulk update entries' });
  }
});

// API: Queue action on single entry (approve/decline/reviewlater/restore)
app.post('/api/scan/entries/:id/action', requireAuth, async (req: Request, res: Response) => {
  const entryId = parseInt(req.params.id, 10);
  if (isNaN(entryId)) {
    res.status(400).json({ error: 'Invalid entry ID' });
    return;
  }

  const { action, quiet } = req.body;

  try {
    const result = await singleEntryAction(entryId, action, {
      quiet: !!quiet,
      force: req.query.force === 'true',
    });
    res.json(result);
  } catch (error) {
    if (error instanceof ApprovalBlockedError) {
      res.status(422).json({
        error: 'Approval blocked',
        issues: error.errors,
        warnings: error.warnings,
      });
      return;
    }
    if (error instanceof Error && error.message === 'Entry not found') {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }
    if (error instanceof Error && error.message.startsWith('Invalid action')) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error('Failed to update entry status:', error);
    res.status(500).json({ error: 'Failed to update entry' });
  }
});

// API: Update entry wire/vertical
app.patch('/api/scan/entries/:id/wire', requireAuth, async (req: Request, res: Response) => {
  const entryId = parseInt(req.params.id, 10);
  if (isNaN(entryId)) {
    res.status(400).json({ error: 'Invalid entry ID' });
    return;
  }

  // Accept either { wire: 'crypto' } (legacy) or { wires: ['crypto', 'ai'] } (multi-pick)
  const { wire, wires } = req.body;
  const wireArray: string[] = Array.isArray(wires) ? wires.filter((w: unknown) => typeof w === 'string') : (wire ? [wire] : []);

  if (wireArray.length === 0) {
    res.status(400).json({ error: 'At least one wire is required' });
    return;
  }

  try {
    // Validate all wires against active feeds
    const activeWires = await getAvailableWires();
    const validWireKeys = activeWires.map((w: any) => w.key || w.wire);
    const invalid = wireArray.filter(w => !validWireKeys.includes(w));
    if (invalid.length > 0) {
      res.status(400).json({ error: `Invalid wire(s): ${invalid.join(', ')}. Must be one of: ${validWireKeys.join(', ')}` });
      return;
    }

    const primaryWire = wireArray[0];
    const pool = getPool();
    const result = await pool.query(
      `UPDATE scan_entries SET wire = $1, wires = $2, updated_at = NOW() WHERE id = $3 RETURNING id, wire, wires`,
      [primaryWire, wireArray, entryId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }

    res.json({ success: true, wire: result.rows[0].wire, wires: result.rows[0].wires });
  } catch (error) {
    console.error('Failed to update entry wire:', error);
    res.status(500).json({ error: 'Failed to update wire' });
  }
});

// API: Scan entries by status (for queue tabs)
app.get('/api/scan/entries', requireAuth, async (req: Request, res: Response) => {
  try {
    const statusParam = (req.query.status as string) || 'queued';
    const statuses = statusParam.split(',').map(s => s.trim()).filter(Boolean);
    const wire = req.query.wire as string | undefined;
    const date = req.query.date as string | undefined;
    const promptId = req.query.promptId as string | undefined;
    const includeDistributionStatus = req.query.includeDistributionStatus === '1' || req.query.includeDistributionStatus === 'true';
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
      return;
    }
    if (promptId && !isValidUuid(promptId)) {
      res.status(400).json({ error: 'Invalid promptId format.' });
      return;
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);
    const rawMinScore = parseInt(req.query.minScore as string, 10);
    const minScore = isNaN(rawMinScore) ? undefined : Math.max(0, Math.min(100, rawMinScore));
    const excludeSources = req.query.excludeSources ? (req.query.excludeSources as string).split(',').map(s => s.trim()).filter(Boolean) : undefined;

    let { entries, total } = await getEntriesByStatus(statuses, { wire, date, promptId, limit, offset, minScore, excludeSources });

    if (includeDistributionStatus && entries.length > 0) {
      const distributionStatus = await getDistributionStatusForEntries(entries.map(entry => entry.id));
      entries = entries.map(entry => ({
        ...entry,
        distributionStatus: distributionStatus[entry.id] || {},
      }));
    }

    res.json({ entries, total, count: entries.length });
  } catch (error) {
    console.error('Failed to fetch scan entries:', error);
    res.status(500).json({ error: 'Failed to fetch scan entries' });
  }
});

// API: Seen URLs (seeded from existing wire content)
app.get('/api/scan/seen-urls', requireAuth, async (req: Request, res: Response) => {
  try {
    const wire = req.query.wire as string | undefined;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 50, 1), 500);
    const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

    const { urls, total } = await getSeenUrlsList({ wire, limit, offset });
    res.json({ urls, total, seededTotal: total });
  } catch (error) {
    console.error('Failed to fetch seen URLs:', error);
    res.status(500).json({ error: 'Failed to fetch seen URLs' });
  }
});

// API: Status counts for stat tiles
app.get('/api/scan/status-counts', requireAuth, async (req: Request, res: Response) => {
  try {
    const wire = req.query.wire as string | undefined;
    const date = req.query.date as string | undefined;
    const promptId = req.query.promptId as string | undefined;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
      return;
    }
    if (promptId && !isValidUuid(promptId)) {
      res.status(400).json({ error: 'Invalid promptId format.' });
      return;
    }

    const [counts, urlStats] = await Promise.all([
      getStatusCounts(wire, date, promptId),
      getSeenUrlStats(wire),
    ]);

    res.json({ counts, seededUrls: urlStats.seededCount, totalUrls: urlStats.totalCount });
  } catch (error) {
    console.error('Failed to fetch status counts:', error);
    res.status(500).json({ error: 'Failed to fetch status counts' });
  }
});

// API: Prompt effectiveness stats
app.get('/api/scan/prompt-stats', requireAuth, async (req: Request, res: Response) => {
  const days = Math.min(Math.max(parseInt(req.query.days as string, 10) || 7, 1), 365);
  const wire = req.query.wire as string | undefined;

  try {
    const pool = getPool();
    const stats = await getPromptEffectivenessStats(pool, days, wire);
    res.json(stats);
  } catch (error) {
    console.error('Failed to fetch prompt stats:', error);
    res.status(500).json({ error: 'Failed to fetch prompt stats' });
  }
});

// --- Distribution API ---

// GET /api/distribution/config — list all configs (creds masked)
app.get('/api/distribution/config', requireAuth, async (req: Request, res: Response) => {
  try {
    const wire = req.query.wire as string | undefined;
    const configs = await getDistributionConfigs(wire);

    // Mask sensitive credential values
    const masked = configs.map(c => ({
      wire: c.wire,
      channel: c.channel,
      enabled: c.enabled,
      config: maskConfig(c.channel, c.config),
    }));

    res.json(masked);
  } catch (error) {
    console.error('Failed to fetch distribution configs:', error);
    res.status(500).json({ error: 'Failed to fetch distribution configs' });
  }
});


// PUT /api/distribution/config/:wire/:channel — update channel config
app.put('/api/distribution/config/:wire/:channel', requireAuth, async (req: Request, res: Response) => {
  const { wire, channel } = req.params;
  if (!wire || !isValidFeedKey(wire)) {
    res.status(400).json({ error: 'Invalid wire' });
    return;
  }
  if (!['telegram', 'x', 'newsletter'].includes(channel)) {
    res.status(400).json({ error: 'Invalid channel. Must be telegram, x, or newsletter.' });
    return;
  }

  const { enabled, config: configData } = req.body;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be a boolean' });
    return;
  }
  if (configData && typeof configData !== 'object') {
    res.status(400).json({ error: 'config must be an object' });
    return;
  }

  try {
    // Merge incoming config with existing to avoid overwriting secrets on partial updates
    const existing = await getDistributionConfigs(wire);
    const current = existing.find(c => c.channel === channel);
    // Filter out masked values (e.g. "****...") so they don't overwrite real secrets
    const cleanedData: Record<string, any> = {};
    if (configData) {
      for (const [k, v] of Object.entries(configData)) {
        if (typeof v === 'string' && v.startsWith('****')) continue;
        cleanedData[k] = v;
      }
    }
    const mergedConfig = { ...(current?.config || {}), ...cleanedData };

    const result = await upsertDistributionConfig(
      wire,
      channel as any,
      enabled,
      mergedConfig
    );
    res.json({
      wire: result.wire,
      channel: result.channel,
      enabled: result.enabled,
      config: maskConfig(result.channel, result.config),
    });
  } catch (error) {
    console.error('Failed to update distribution config:', error);
    res.status(500).json({ error: 'Failed to update distribution config' });
  }
});

// POST /api/distribution/run/:wire — trigger distribution (fire-and-forget)
app.post('/api/distribution/run/:wire', requireAuth, async (req: Request, res: Response) => {
  const { wire } = req.params;
  if (!wire || !isValidFeedKey(wire)) {
    res.status(400).json({ error: 'Invalid wire' });
    return;
  }

  if (!rateLimit(`distribution-run:${wire}`, 3, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Distribution recently run. Please wait a few minutes.' });
    return;
  }

  if (distributionRunning.has(wire)) {
    res.status(409).json({ error: 'Distribution already running for this wire' });
    return;
  }

  distributionRunning.add(wire);
  try {
    const result = await distributeEntries(wire);
    res.json({ success: true, ...result });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Distribution] Run failed:', error);
    res.status(500).json({ error: errorMsg });
  } finally {
    distributionRunning.delete(wire);
  }
});

// GET /api/distribution/newsletter/:wire — generate newsletter markdown
app.get('/api/distribution/newsletter/:wire', requireAuth, async (req: Request, res: Response) => {
  const { wire } = req.params;
  if (!wire || !isValidFeedKey(wire)) {
    res.status(400).json({ error: 'Invalid wire' });
    return;
  }

  if (!rateLimit('distribution-newsletter', 5, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Newsletter recently generated. Please wait a few minutes.' });
    return;
  }

  try {
    const feed = await getFeedByKey(wire);
    const displayName = feed?.displayName || wire;
    const { markdown, entryIds } = await generateNewsletterMarkdown(wire, displayName);
    res.json({ success: true, markdown, entryIds });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Distribution] Newsletter generation failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// POST /api/distribution/newsletter/:wire/confirm — mark newsletter entries as distributed
app.post('/api/distribution/newsletter/:wire/confirm', requireAuth, async (req: Request, res: Response) => {
  const { wire } = req.params;
  if (!wire || !isValidFeedKey(wire)) {
    res.status(400).json({ error: 'Invalid wire' });
    return;
  }

  const { entryIds } = req.body;
  if (!Array.isArray(entryIds) || entryIds.length === 0) {
    res.status(400).json({ error: 'entryIds must be a non-empty array' });
    return;
  }

  try {
    await confirmNewsletterDistribution(entryIds, wire);
    res.json({ success: true, confirmed: entryIds.length });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Distribution] Newsletter confirmation failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// GET /api/distribution/status/:wire — bulk distribution status for approved entries
app.get('/api/distribution/status/:wire', requireAuth, async (req: Request, res: Response) => {
  const { wire } = req.params;
  if (!wire || !isValidFeedKey(wire)) {
    res.status(400).json({ error: 'Invalid wire' });
    return;
  }

  try {
    const statusMap = await getDistributionStatusBulk(wire);
    res.json(statusMap);
  } catch (error) {
    console.error('Failed to fetch distribution status:', error);
    res.status(500).json({ error: 'Failed to fetch distribution status' });
  }
});

// GET /api/scan/entries/:id/distribution — logs for single entry
app.get('/api/scan/entries/:id/distribution', requireAuth, async (req: Request, res: Response) => {
  const entryId = parseInt(req.params.id, 10);
  if (isNaN(entryId)) {
    res.status(400).json({ error: 'Invalid entry ID' });
    return;
  }

  try {
    const logs = await getDistributionLogs(entryId);
    res.json(logs);
  } catch (error) {
    console.error('Failed to fetch distribution logs:', error);
    res.status(500).json({ error: 'Failed to fetch distribution logs' });
  }
});

// POST /api/scan/entries/:id/redistribute — retry failed distribution
app.post('/api/scan/entries/:id/redistribute', requireAuth, async (req: Request, res: Response) => {
  const entryId = parseInt(req.params.id, 10);
  if (isNaN(entryId)) {
    res.status(400).json({ error: 'Invalid entry ID' });
    return;
  }

  if (!rateLimit('redistribute', 5, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Too many retry attempts. Please wait a few minutes.' });
    return;
  }

  try {
    // Look up the entry's wire
    const pool = getPool();
    const entryResult = await pool.query('SELECT wire FROM scan_entries WHERE id = $1', [entryId]);
    if (entryResult.rows.length === 0) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }
    const wire = entryResult.rows[0].wire;

    const result = await retryDistribution(entryId, wire);
    res.json({ success: true, ...result });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Distribution] Redistribute failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// --- Distribution Channels CRUD API (managed via dashboard UI) ---

// GET /api/distribution/channels — list all managed channels
app.get('/api/distribution/channels', requireAuth, async (req: Request, res: Response) => {
  try {
    const wire = req.query.wire as string | undefined;
    const channels = await getDistributionChannels(wire);

    // Mask credentials in response
    const masked = channels.map(c => ({
      id: c.id,
      wire: c.wire,
      channel: c.channel,
      name: c.name,
      enabled: c.enabled,
      target_id: c.targetId,
      credentials: maskCredentials(c.credentials),
      created_at: c.createdAt,
      updated_at: c.updatedAt,
    }));

    res.json(masked);
  } catch (error) {
    console.error('Failed to fetch distribution channels:', error);
    res.status(500).json({ error: 'Failed to fetch distribution channels' });
  }
});


// POST /api/distribution/channels — create new managed channel
app.post('/api/distribution/channels', requireAuth, async (req: Request, res: Response) => {
  const { wire, channel, name, enabled, target_id, credentials } = req.body;

  if (!wire || typeof wire !== 'string') {
    res.status(400).json({ error: 'wire is required' });
    return;
  }
  if (!channel || !['telegram', 'discord', 'slack'].includes(channel)) {
    res.status(400).json({ error: 'channel must be telegram, discord, or slack' });
    return;
  }
  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  if (!target_id && channel !== 'slack') {
    res.status(400).json({ error: 'target_id is required for this channel type' });
    return;
  }
  if (!credentials || typeof credentials !== 'object') {
    res.status(400).json({ error: 'credentials is required' });
    return;
  }

  try {
    const result = await createDistributionChannel({
      wire,
      channel,
      name,
      enabled: enabled ?? true,
      targetId: target_id || '',
      credentials,
    });

    res.json({
      id: result.id,
      wire: result.wire,
      channel: result.channel,
      name: result.name,
      enabled: result.enabled,
      target_id: result.targetId,
      credentials: maskCredentials(result.credentials),
      created_at: result.createdAt,
      updated_at: result.updatedAt,
    });
  } catch (error) {
    console.error('Failed to create distribution channel:', error);
    res.status(500).json({ error: 'Failed to create distribution channel' });
  }
});

// PUT /api/distribution/channels/:id — update managed channel
app.put('/api/distribution/channels/:id', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id || !isValidUuid(id)) {
    res.status(400).json({ error: 'Invalid channel ID' });
    return;
  }

  const { wire, channel, name, enabled, target_id, credentials } = req.body;

  // If credentials provided, merge with existing (so partial updates don't wipe secrets)
  let mergedCredentials = credentials;
  if (credentials && typeof credentials === 'object') {
    const existing = await getDistributionChannelById(id);
    if (existing) {
      // Only merge if the incoming creds have masked values (****) — skip those
      const cleanCreds: Record<string, string> = {};
      for (const [k, v] of Object.entries(credentials as Record<string, string>)) {
        if (v && !v.startsWith('****')) {
          cleanCreds[k] = v;
        }
      }
      mergedCredentials = { ...existing.credentials, ...cleanCreds };
    }
  }

  const updates: any = {};
  if (wire !== undefined) updates.wire = wire;
  if (channel !== undefined) updates.channel = channel;
  if (name !== undefined) updates.name = name;
  if (enabled !== undefined) updates.enabled = enabled;
  if (target_id !== undefined) updates.targetId = target_id;
  if (mergedCredentials !== undefined) updates.credentials = mergedCredentials;

  try {
    const result = await updateDistributionChannel(id, updates);
    if (!result) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    res.json({
      id: result.id,
      wire: result.wire,
      channel: result.channel,
      name: result.name,
      enabled: result.enabled,
      target_id: result.targetId,
      credentials: maskCredentials(result.credentials),
      created_at: result.createdAt,
      updated_at: result.updatedAt,
    });
  } catch (error) {
    console.error('Failed to update distribution channel:', error);
    res.status(500).json({ error: 'Failed to update distribution channel' });
  }
});

// DELETE /api/distribution/channels/:id — delete managed channel
app.delete('/api/distribution/channels/:id', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id || !isValidUuid(id)) {
    res.status(400).json({ error: 'Invalid channel ID' });
    return;
  }

  try {
    const deleted = await deleteDistributionChannel(id);
    if (!deleted) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete distribution channel:', error);
    res.status(500).json({ error: 'Failed to delete distribution channel' });
  }
});

// POST /api/distribution/channels/:id/test — send test message
app.post('/api/distribution/channels/:id/test', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id || !isValidUuid(id)) {
    res.status(400).json({ error: 'Invalid channel ID' });
    return;
  }

  if (!rateLimit('dist-channel-test', 5, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Too many test requests. Max 5 per 5 minutes.' });
    return;
  }

  try {
    const channel = await getDistributionChannelById(id);
    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    const result = await sendTestMessage(channel);
    if (result.success) {
      res.json({ success: true, message: 'Test message sent successfully' });
    } else {
      res.status(400).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('Failed to send test message:', error);
    res.status(500).json({ error: 'Failed to send test message' });
  }
});

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
