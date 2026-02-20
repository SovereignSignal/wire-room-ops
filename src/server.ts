import express, { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { validateMagicLink, createMagicLink, createDownloadToken, createSessionToken, validateSession, createLoginMagicLink } from './services/auth';
import { getFile, listFiles } from './services/storage';
import { getAvailableWires, closePool, getAllFeeds, getFeedByKey, createFeed, updateFeed, archiveFeed, getEntryCountsByWire, getAllScanPrompts, getScanPromptById, createScanPrompt, updateScanPrompt, deleteScanPrompt } from './db';
import { sendLoginEmail, sendScanDigestEmail } from './services/email';
import { runWeeklySummaryJob } from './jobs/weekly-summary';
import { StoredFile } from './types';
import { jobQueue } from './services/job-queue';
import { getAllModels } from './services/models';
import { getSchedule, getSchedules, setSchedule, addSchedule, removeSchedule, formatScheduleDescription, getNextRunTime, initScheduler, stopScheduler, ScheduleConfig, sendTestAlert, getSchedulerStatus } from './services/scheduler';
import { runCrmSyncJob, getStagingOrgs, CrmSyncJobResult } from './services/crm-sync';
import { isStagingConfigured } from './services/notion';
import { buildSubmission, buildBatchSubmission } from './services/intake';
import { runDailyIntake, getDailyQueue, getIntakeStats } from './jobs/daily-intake';
import { getPool } from './db';
import { executeScanPrompt } from './services/grok';
import { withRetry } from './services/processor';
import { runScanExecution } from './jobs/scan-execution';
import { getPromptEffectivenessStats } from './services/scan-stats';
import { registerTelegramWebhook, handleTelegramUpdate } from './services/telegram';
import { handleInboundEmail, verifyResendSignature, ResendInboundPayload } from './services/email-inbound';
import { escapeHtml } from './utils/html';

const app = express();

app.use(express.json({
  verify: (req, _res, buf) => {
    // Capture raw body for webhook signature verification
    (req as any).rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Auth middleware - checks session from HttpOnly cookie only
function requireAuth(req: Request, res: Response, next: Function): void {
  const session = req.cookies?.session as string;
  if (!session || !validateSession(session)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// CSRF origin check for state-changing requests
app.use((req: Request, res: Response, next: Function): void => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }

  // Skip for webhook endpoints (authenticated via signatures, not cookies)
  if (req.path.startsWith('/webhook/')) {
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

// Simple in-memory rate limiter
const rateLimitStore = new Map<string, number[]>();

// Cleanup stale rate limit entries every 15 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of rateLimitStore.entries()) {
    const recent = timestamps.filter(t => now - t < 15 * 60 * 1000);
    if (recent.length === 0) {
      rateLimitStore.delete(key);
    }
  }
}, 15 * 60 * 1000);

function rateLimit(key: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  const timestamps = rateLimitStore.get(key) || [];
  const recent = timestamps.filter(t => now - t < windowMs);
  if (recent.length >= maxRequests) {
    rateLimitStore.set(key, recent);
    return false;
  }
  recent.push(now);
  rateLimitStore.set(key, recent);
  return true;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(id: string): boolean {
  return UUID_REGEX.test(id);
}

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================================
// Webhook Routes (unauthenticated, verified by secrets)
// ============================================================

// Telegram Bot Webhook
app.post('/webhook/telegram', (req: Request, res: Response) => {
  // Verify webhook secret
  if (config.telegram.webhookSecret) {
    const secretHeader = req.headers['x-telegram-bot-api-secret-token'] as string;
    if (secretHeader !== config.telegram.webhookSecret) {
      res.status(403).json({ error: 'Invalid secret' });
      return;
    }
  }

  // Rate limit: 10 messages per minute per chat
  const chatId = req.body?.message?.chat?.id;
  if (chatId && !rateLimit(`tg:${chatId}`, 10, 60 * 1000)) {
    res.status(429).json({ error: 'Rate limited' });
    return;
  }

  // Return 200 immediately, process async
  res.json({ ok: true });

  handleTelegramUpdate(req.body).catch(err => {
    console.error('[Webhook/Telegram] Processing error:', err);
  });
});

// Resend Inbound Email Webhook
app.post('/webhook/email', (req: Request, res: Response) => {
  // Verify Resend signature if secret is configured
  if (config.inboundEmail.webhookSigningSecret) {
    const signature = req.headers['resend-signature'] as string || '';
    const rawBody = (req as any).rawBody?.toString() || JSON.stringify(req.body);
    if (!verifyResendSignature(rawBody, signature)) {
      res.status(403).json({ error: 'Invalid signature' });
      return;
    }
  }

  const payload: ResendInboundPayload = req.body;

  // Rate limit: 5 emails per 15 min per sender
  const sender = (payload.data?.from || 'unknown').toLowerCase();
  if (!rateLimit(`email:${sender}`, 5, 15 * 60 * 1000)) {
    res.status(429).json({ error: 'Rate limited' });
    return;
  }

  // Return 200 immediately, process async
  res.json({ ok: true });

  handleInboundEmail(payload).catch(err => {
    console.error('[Webhook/Email] Processing error:', err);
  });
});

// Landing page - login form
app.get('/', (req: Request, res: Response) => {
  const session = req.cookies?.session as string;
  if (session && validateSession(session)) {
    res.redirect('/dashboard');
    return;
  }
  res.send(renderLoginPage());
});

// Handle login request - send magic link
app.post('/login', async (req: Request, res: Response) => {
  const clientIp = req.ip || 'unknown';
  if (!rateLimit(`login:${clientIp}`, 5, 15 * 60 * 1000)) {
    res.status(429).send(renderLoginPage('Too many login attempts. Please try again later.'));
    return;
  }

  const email = req.body.email?.toLowerCase().trim();

  if (!email) {
    res.send(renderLoginPage('Please enter your email address'));
    return;
  }

  if (email !== config.email.notificationEmail.toLowerCase()) {
    res.send(renderLoginPage('Email not authorized'));
    return;
  }

  try {
    const magicLink = createLoginMagicLink(email);
    await sendLoginEmail(email, magicLink);
    res.send(renderLoginSentPage(email));
  } catch (error) {
    console.error('Failed to send login email:', error);
    res.send(renderLoginPage('Failed to send email. Please try again.'));
  }
});

// Magic link auth - creates session cookie and redirects to dashboard
app.get('/auth', (req: Request, res: Response) => {
  const token = req.query.token as string;

  if (!token) {
    res.redirect('/?error=invalid');
    return;
  }

  const validation = validateMagicLink(token);

  if (!validation.valid) {
    res.send(renderErrorPage(validation.error || 'Invalid or expired link'));
    return;
  }

  const sessionToken = createSessionToken(validation.email || config.email.notificationEmail);
  res.cookie('session', sessionToken, {
    httpOnly: true,
    secure: config.app.url.startsWith('https'),
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
  });
  res.redirect('/dashboard');
});

// Dashboard - main interface
app.get('/dashboard', async (req: Request, res: Response) => {
  const session = req.cookies?.session as string;

  if (!session || !validateSession(session)) {
    res.redirect('/');
    return;
  }

  const files = await listFiles();
  const message = req.query.message as string;
  res.send(renderDashboard(files, message));
});

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

// API: List feeds (CRUD)
app.get('/api/feeds', requireAuth, async (req: Request, res: Response) => {
  try {
    const includeArchived = req.query.includeArchived === 'true';
    const feeds = await getAllFeeds(includeArchived);
    const counts = await getEntryCountsByWire();

    res.json(feeds.map(f => ({
      key: f.key,
      displayName: f.displayName,
      titleTemplate: f.titleTemplate,
      sortOrder: f.sortOrder,
      archived: f.archived,
      entryCount: counts[f.key] || 0,
    })));
  } catch (error) {
    console.error('Failed to fetch feeds:', error);
    res.status(500).json({ error: 'Failed to fetch feeds' });
  }
});

// API: Create feed
app.post('/api/feeds', requireAuth, async (req: Request, res: Response) => {
  const { key, displayName, titleTemplate, sortOrder } = req.body;

  if (!key || typeof key !== 'string') {
    res.status(400).json({ error: 'key is required' });
    return;
  }
  if (!displayName || typeof displayName !== 'string') {
    res.status(400).json({ error: 'displayName is required' });
    return;
  }

  const normalizedKey = key.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (normalizedKey !== key) {
    res.status(400).json({ error: 'key must be lowercase alphanumeric (with - or _)' });
    return;
  }
  if (normalizedKey.length === 0 || normalizedKey.length > 50) {
    res.status(400).json({ error: 'key must be between 1 and 50 characters' });
    return;
  }
  if (displayName.length > 100) {
    res.status(400).json({ error: 'displayName must be 100 characters or fewer' });
    return;
  }
  if (titleTemplate && typeof titleTemplate === 'string' && titleTemplate.length > 500) {
    res.status(400).json({ error: 'titleTemplate must be 500 characters or fewer' });
    return;
  }

  try {
    const existing = await getFeedByKey(normalizedKey);
    if (existing) {
      res.status(409).json({ error: 'Feed with this key already exists' });
      return;
    }

    const feed = await createFeed({
      key: normalizedKey,
      displayName,
      titleTemplate: titleTemplate || undefined,
      sortOrder: typeof sortOrder === 'number' ? sortOrder : undefined,
    });

    res.json({
      key: feed.key,
      displayName: feed.displayName,
      titleTemplate: feed.titleTemplate,
      sortOrder: feed.sortOrder,
      archived: feed.archived,
      entryCount: 0,
    });
  } catch (error) {
    console.error('Failed to create feed:', error);
    res.status(500).json({ error: 'Failed to create feed' });
  }
});

// API: Update feed
app.put('/api/feeds/:key', requireAuth, async (req: Request, res: Response) => {
  const { key } = req.params;
  if (!key || !/^[a-z0-9_-]+$/.test(key)) {
    res.status(400).json({ error: 'Invalid feed key' });
    return;
  }
  const { displayName, titleTemplate, sortOrder } = req.body;

  const updates: { displayName?: string; titleTemplate?: string; sortOrder?: number } = {};
  if (displayName !== undefined) updates.displayName = displayName;
  if (titleTemplate !== undefined) updates.titleTemplate = titleTemplate;
  if (typeof sortOrder === 'number') updates.sortOrder = sortOrder;

  try {
    const updated = await updateFeed(key, updates);
    if (!updated) {
      res.status(404).json({ error: 'Feed not found' });
      return;
    }

    res.json({
      key: updated.key,
      displayName: updated.displayName,
      titleTemplate: updated.titleTemplate,
      sortOrder: updated.sortOrder,
      archived: updated.archived,
    });
  } catch (error) {
    console.error('Failed to update feed:', error);
    res.status(500).json({ error: 'Failed to update feed' });
  }
});

// API: Archive (soft-delete) feed
app.delete('/api/feeds/:key', requireAuth, async (req: Request, res: Response) => {
  const { key } = req.params;
  if (!key || !/^[a-z0-9_-]+$/.test(key)) {
    res.status(400).json({ error: 'Invalid feed key' });
    return;
  }

  try {
    const archived = await archiveFeed(key);
    if (!archived) {
      res.status(404).json({ error: 'Feed not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to archive feed:', error);
    res.status(500).json({ error: 'Failed to archive feed' });
  }
});

// Running job trackers to prevent concurrent execution
let runningWeeklyJobId: string | null = null;
let runningScanJobId: string | null = null;

// Trigger job manually (async with job queue)
app.post('/api/run-job', requireAuth, async (req: Request, res: Response) => {
  if (!rateLimit('run-job', 3, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Too many job requests. Please wait before trying again.' });
    return;
  }

  // Prevent concurrent weekly summary jobs
  if (runningWeeklyJobId) {
    const existingJob = jobQueue.getJob(runningWeeklyJobId);
    if (existingJob && existingJob.status === 'running') {
      res.status(409).json({ error: 'A weekly summary job is already running', jobId: runningWeeklyJobId });
      return;
    }
    runningWeeklyJobId = null;
  }

  // Parse date range from request
  const { startDate, endDate, grokModel, anthropicModel, wire } = req.body;
  let dateRange: { start: Date; end: Date } | undefined;

  if (startDate && endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      res.status(400).json({ error: 'Invalid date format' });
      return;
    }
    if (end < start) {
      res.status(400).json({ error: 'End date must be after start date' });
      return;
    }
    const diffDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays > 90) {
      res.status(400).json({ error: 'Date range cannot exceed 90 days' });
      return;
    }

    dateRange = { start, end };
    // Set end date to end of day
    dateRange.end.setHours(23, 59, 59, 999);
  }

  // Parse model options
  const models = (grokModel || anthropicModel) ? {
    grokModel: grokModel || undefined,
    anthropicModel: anthropicModel || undefined,
  } : undefined;

  // Parse wire filter (can be single value or array)
  const wireFilter = wire ? (Array.isArray(wire) ? wire : [wire].filter(Boolean)) : undefined;

  // Create job and return immediately
  const jobId = jobQueue.createJob();
  runningWeeklyJobId = jobId;
  res.json({ jobId });

  // Run job asynchronously
  (async () => {
    jobQueue.updateJob(jobId, { status: 'running' });

    try {
      const result = await runWeeklySummaryJob({
        sendEmail: false,
        dateRange,
        models,
        wire: wireFilter?.length === 1 ? wireFilter[0] : wireFilter,
        onProgress: (current, total, step) => {
          jobQueue.updateProgress(jobId, { current, total, step });
        },
      });

      jobQueue.completeJob(jobId, result);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      jobQueue.failJob(jobId, errorMsg);
    } finally {
      runningWeeklyJobId = null;
      jobQueue.cleanup();
    }
  })().catch(error => {
    console.error('Unexpected error in job runner:', error);
    runningWeeklyJobId = null;
  });
});

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

  if (!session || !validateSession(session)) {
    res.redirect('/');
    return;
  }
  
  const file = await getFile(fileId);
  
  if (!file) {
    res.status(404).send(renderErrorPage('File not found'));
    return;
  }
  
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename.replace(/"/g, '\\"')}"`);
  res.send(file.content);
});

// Resend download link for the most recent file
// Resend download link - requires auth or strict rate limiting
app.post('/resend-link', async (req: Request, res: Response) => {
  // Check auth first; fall back to IP rate limiting for expired-session users
  const session = req.cookies?.session as string;
  const isAuthed = session && validateSession(session);

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
    const { sendResendLinkEmail } = require('./services/email');
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
  
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename.replace(/"/g, '\\"')}"`);
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

// API: List all schedules
app.get('/api/schedules', requireAuth, (req: Request, res: Response) => {
  const schedules = getSchedules().map(schedule => ({
    ...schedule,
    description: formatScheduleDescription(schedule),
    nextRun: getNextRunTime(schedule.id)?.toISOString() || null,
  }));

  res.json({ schedules });
});

// API: Get single schedule (legacy compatibility)
app.get('/api/schedule', requireAuth, (req: Request, res: Response) => {
  const id = req.query.id as string;
  if (!id || !isValidUuid(id)) {
    res.status(400).json({ error: 'Invalid schedule ID' });
    return;
  }

  const schedule = getSchedule(id);
  if (!schedule) {
    res.status(404).json({ error: 'Schedule not found' });
    return;
  }

  const nextRun = getNextRunTime(schedule.id);
  const description = formatScheduleDescription(schedule);

  res.json({
    ...schedule,
    description,
    nextRun: nextRun?.toISOString() || null,
  });
});

// Validate schedule numeric parameters
function validateScheduleParams(body: Record<string, any>): string | null {
  const { dayOfWeek, hour, minute, lookbackDays, scheduleType } = body;
  if (scheduleType && !['weekly-summary', 'scan-execution'].includes(scheduleType)) {
    return 'scheduleType must be "weekly-summary" or "scan-execution"';
  }
  if (typeof dayOfWeek === 'number' && (dayOfWeek < 0 || dayOfWeek > 6)) {
    return 'dayOfWeek must be between 0 (Sunday) and 6 (Saturday)';
  }
  if (typeof hour === 'number' && (hour < 0 || hour > 23)) {
    return 'hour must be between 0 and 23';
  }
  if (typeof minute === 'number' && (minute < 0 || minute > 59)) {
    return 'minute must be between 0 and 59';
  }
  if (typeof lookbackDays === 'number' && (lookbackDays < 1 || lookbackDays > 365)) {
    return 'lookbackDays must be between 1 and 365';
  }
  return null;
}

// API: Create new schedule
app.post('/api/schedules', requireAuth, async (req: Request, res: Response) => {
  const validationError = validateScheduleParams(req.body);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const { name, enabled, dayOfWeek, hour, minute, lookbackDays, grokModel, anthropicModel, timezone, wire, scheduleType } = req.body;

  const scheduleData: Partial<Omit<ScheduleConfig, 'id'>> = {};

  if (name) scheduleData.name = name;
  if (scheduleType) scheduleData.scheduleType = scheduleType;
  if (typeof enabled === 'boolean') scheduleData.enabled = enabled;
  if (typeof dayOfWeek === 'number') scheduleData.dayOfWeek = dayOfWeek;
  if (typeof hour === 'number') scheduleData.hour = hour;
  if (typeof minute === 'number') scheduleData.minute = minute;
  if (typeof lookbackDays === 'number') scheduleData.lookbackDays = lookbackDays;
  if (grokModel) scheduleData.grokModel = grokModel;
  if (anthropicModel) scheduleData.anthropicModel = anthropicModel;
  if (timezone) scheduleData.timezone = timezone;
  if (wire !== undefined) scheduleData.wire = wire || undefined;

  try {
    const newSchedule = await addSchedule(scheduleData);
    const nextRun = getNextRunTime(newSchedule.id);
    const description = formatScheduleDescription(newSchedule);

    res.json({
      ...newSchedule,
      description,
      nextRun: nextRun?.toISOString() || null,
    });
  } catch (error) {
    console.error('Failed to create schedule:', error);
    res.status(500).json({ error: 'Failed to create schedule' });
  }
});

// API: Update schedule
app.put('/api/schedules/:id', requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!isValidUuid(id)) {
    res.status(400).json({ error: 'Invalid schedule ID' });
    return;
  }

  const validationError = validateScheduleParams(req.body);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const { name, enabled, dayOfWeek, hour, minute, lookbackDays, grokModel, anthropicModel, timezone, wire, scheduleType } = req.body;

  const updates: Partial<Omit<ScheduleConfig, 'id'>> = {};

  if (name !== undefined) updates.name = name;
  if (scheduleType !== undefined) updates.scheduleType = scheduleType;
  if (typeof enabled === 'boolean') updates.enabled = enabled;
  if (typeof dayOfWeek === 'number') updates.dayOfWeek = dayOfWeek;
  if (typeof hour === 'number') updates.hour = hour;
  if (typeof minute === 'number') updates.minute = minute;
  if (typeof lookbackDays === 'number') updates.lookbackDays = lookbackDays;
  if (grokModel !== undefined) updates.grokModel = grokModel || undefined;
  if (anthropicModel !== undefined) updates.anthropicModel = anthropicModel || undefined;
  if (timezone) updates.timezone = timezone;
  if (wire !== undefined) updates.wire = wire || undefined;

  try {
    const updatedSchedule = await setSchedule(id, updates);
    if (!updatedSchedule) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }

    const nextRun = getNextRunTime(updatedSchedule.id);
    const description = formatScheduleDescription(updatedSchedule);

    res.json({
      ...updatedSchedule,
      description,
      nextRun: nextRun?.toISOString() || null,
    });
  } catch (error) {
    console.error('Failed to update schedule:', error);
    res.status(500).json({ error: 'Failed to update schedule' });
  }
});

// API: Delete schedule
app.delete('/api/schedules/:id', requireAuth, async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!isValidUuid(id)) {
    res.status(400).json({ error: 'Invalid schedule ID' });
    return;
  }

  try {
    const deleted = await removeSchedule(id);
    if (!deleted) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete schedule:', error);
    res.status(500).json({ error: 'Failed to delete schedule' });
  }
});

// API: Update schedule (legacy POST compatibility)
app.post('/api/schedule', requireAuth, async (req: Request, res: Response) => {
  const id = req.body.id;

  const { name, enabled, dayOfWeek, hour, minute, lookbackDays, grokModel, anthropicModel, timezone, wire, scheduleType } = req.body;

  const updates: Partial<Omit<ScheduleConfig, 'id'>> = {};

  if (name !== undefined) updates.name = name;
  if (scheduleType !== undefined) updates.scheduleType = scheduleType;
  if (typeof enabled === 'boolean') updates.enabled = enabled;
  if (typeof dayOfWeek === 'number') updates.dayOfWeek = dayOfWeek;
  if (typeof hour === 'number') updates.hour = hour;
  if (typeof minute === 'number') updates.minute = minute;
  if (typeof lookbackDays === 'number') updates.lookbackDays = lookbackDays;
  if (grokModel !== undefined) updates.grokModel = grokModel || undefined;
  if (anthropicModel !== undefined) updates.anthropicModel = anthropicModel || undefined;
  if (timezone) updates.timezone = timezone;
  if (wire !== undefined) updates.wire = wire || undefined;

  try {
    // If no ID provided, get the first schedule
    const targetId = id || getSchedule()?.id;
    if (!targetId) {
      res.status(404).json({ error: 'No schedule found' });
      return;
    }

    const updatedSchedule = await setSchedule(targetId, updates);
    if (!updatedSchedule) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }

    const nextRun = getNextRunTime(updatedSchedule.id);
    const description = formatScheduleDescription(updatedSchedule);

    res.json({
      ...updatedSchedule,
      description,
      nextRun: nextRun?.toISOString() || null,
    });
  } catch (error) {
    console.error('Failed to update schedule:', error);
    res.status(500).json({ error: 'Failed to update schedule' });
  }
});

// API: Send test alert to verify email configuration
app.post('/api/test-alert', requireAuth, async (req: Request, res: Response) => {

  try {
    const result = await sendTestAlert();
    if (result.success) {
      res.json({ success: true, message: result.message });
    } else {
      res.status(500).json({ success: false, error: result.message });
    }
  } catch (error) {
    console.error('Failed to send test alert:', error);
    res.status(500).json({ success: false, error: 'Failed to send test alert' });
  }
});

// API: Get scheduler status (for debugging)
app.get('/api/scheduler-status', requireAuth, (req: Request, res: Response) => {
  const status = getSchedulerStatus();
  res.json(status);
});

// API: Run CRM sync job
app.post('/api/crm-sync', requireAuth, async (req: Request, res: Response) => {
  const { lookbackDays, wire } = req.body;

  try {
    const result = await runCrmSyncJob({
      lookbackDays: lookbackDays ? parseInt(lookbackDays, 10) : 1,
      wire: wire || undefined,
      useStaging: true,
    });

    res.json(result);
  } catch (error) {
    console.error('CRM sync failed:', error);
    res.status(500).json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

// API: Get CRM sync status (staging orgs count, config status)
app.get('/api/crm-sync/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const stagingConfigured = isStagingConfigured();
    let pendingOrgs: number = 0;

    if (stagingConfigured) {
      const orgs = await getStagingOrgs('Pending');
      pendingOrgs = orgs.length;
    }

    res.json({
      stagingConfigured,
      pendingOrgs,
    });
  } catch (error) {
    console.error('Failed to get CRM sync status:', error);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// API: Get staging orgs list
app.get('/api/crm-sync/staging-orgs', requireAuth, async (req: Request, res: Response) => {
  const status = req.query.status as 'Pending' | 'Approved' | 'Rejected' | undefined;

  try {
    const orgs = await getStagingOrgs(status);
    res.json({ orgs });
  } catch (error) {
    console.error('Failed to get staging orgs:', error);
    res.status(500).json({ error: 'Failed to get staging orgs' });
  }
});

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

// API: List scan prompts
app.get('/api/scan/prompts', requireAuth, async (req: Request, res: Response) => {
  const wire = req.query.wire as string | undefined;
  const active = req.query.active as string | undefined;
  const activeOnly = active === 'true' ? true : active === 'false' ? false : undefined;

  try {
    const prompts = await getAllScanPrompts(wire || undefined, activeOnly ?? undefined);
    res.json(prompts);
  } catch (error) {
    console.error('Failed to fetch scan prompts:', error);
    res.status(500).json({ error: 'Failed to fetch scan prompts' });
  }
});

// API: Create scan prompt
app.post('/api/scan/prompts', requireAuth, async (req: Request, res: Response) => {
  const { wire, label, promptText, responseFormat, isActive, sortOrder } = req.body;

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
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    res.status(400).json({ error: 'Invalid prompt ID' });
    return;
  }

  const { wire, label, promptText, responseFormat, isActive, sortOrder } = req.body;
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
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
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

// API: Test-run a scan prompt against Grok
app.post('/api/scan/prompts/:id/test', requireAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
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

    const result = await withRetry(() => executeScanPrompt(prompt.promptText, {
      responseFormat: prompt.responseFormat,
    }));

    res.json({
      success: true,
      content: result.content,
      model: result.model,
      tokensUsed: result.tokensUsed,
    });
  } catch (error) {
    console.error('Scan prompt test failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Test run failed' });
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

// API: Queue action on single entry (promote/archive/skip)
app.post('/api/scan/entries/:id/action', requireAuth, async (req: Request, res: Response) => {
  const entryId = parseInt(req.params.id, 10);
  if (isNaN(entryId)) {
    res.status(400).json({ error: 'Invalid entry ID' });
    return;
  }

  const { action } = req.body;
  const actionMap: Record<string, string> = {
    promote: 'queued',
    archive: 'archived',
    skip: 'skipped',
  };

  const newStatus = actionMap[action];
  if (!newStatus) {
    res.status(400).json({ error: 'Invalid action. Must be promote, archive, or skip.' });
    return;
  }

  try {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE scan_entries SET status = $1 WHERE id = $2 RETURNING id, status`,
      [newStatus, entryId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }

    res.json({ success: true, newStatus });
  } catch (error) {
    console.error('Failed to update entry status:', error);
    res.status(500).json({ error: 'Failed to update entry' });
  }
});

// API: Prompt effectiveness stats
app.get('/api/scan/prompt-stats', requireAuth, async (req: Request, res: Response) => {
  const days = Math.min(Math.max(parseInt(req.query.days as string, 10) || 7, 1), 365);

  try {
    const pool = getPool();
    const stats = await getPromptEffectivenessStats(pool, days);
    res.json(stats);
  } catch (error) {
    console.error('Failed to fetch prompt stats:', error);
    res.status(500).json({ error: 'Failed to fetch prompt stats' });
  }
});

function renderLoginPage(error?: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <title>Sign In - Grant Wire Summarizer</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📡</text></svg>">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d0d0d;
      margin: 0;
      padding: 20px;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      max-width: 400px;
      width: 100%;
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      padding: 48px 40px;
      border-radius: 16px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.4);
    }
    .logo { margin: 0 0 8px; font-size: 28px; font-weight: 700; }
    .logo-crypto { color: #ffffff; }
    .logo-grant { color: #f5a623; }
    .logo-wire { color: #ffffff; }
    .subtitle { color: #999999; margin-bottom: 32px; }
    .form-group { margin-bottom: 20px; }
    label { display: block; margin-bottom: 8px; font-weight: 500; color: #ffffff; }
    input[type="email"] {
      width: 100%;
      padding: 14px 16px;
      border: 1px solid #2a2a2a;
      border-radius: 8px;
      font-size: 16px;
      background: #0d0d0d;
      color: #ffffff;
      transition: border-color 0.2s;
    }
    input[type="email"]::placeholder { color: #666666; }
    input[type="email"]:focus {
      outline: none;
      border-color: #f5a623;
    }
    .button {
      width: 100%;
      background: #f5a623;
      color: #0d0d0d;
      padding: 14px 24px;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    .button:hover { background: #e6951a; }
    .error {
      background: rgba(239, 83, 80, 0.15);
      color: #ef5350;
      padding: 12px 16px;
      border-radius: 8px;
      margin-bottom: 20px;
      font-size: 14px;
      border: 1px solid rgba(239, 83, 80, 0.3);
    }
  </style>
</head>
<body>
  <div class="container">
    <h1 class="logo">📡 <span class="logo-grant">Grant</span><span class="logo-wire">Wire</span></h1>
    <p class="subtitle">Sign in to access your dashboard</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="/login">
      <div class="form-group">
        <label for="email">Email address</label>
        <input type="email" id="email" name="email" placeholder="you@example.com" required>
      </div>
      <button type="submit" class="button">Send Magic Link</button>
    </form>
  </div>
</body>
</html>
  `.trim();
}

function renderLoginSentPage(email: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <title>Check Your Email - Grant Wire Summarizer</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📡</text></svg>">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d0d0d;
      margin: 0;
      padding: 20px;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      max-width: 400px;
      width: 100%;
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      padding: 48px 40px;
      border-radius: 16px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.4);
      text-align: center;
    }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { color: #ffffff; margin: 0 0 16px; font-size: 24px; }
    p { color: #999999; line-height: 1.6; }
    .email { font-weight: 600; color: #f5a623; }
    .back {
      display: inline-block;
      margin-top: 24px;
      color: #f5a623;
      text-decoration: none;
    }
    .back:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">✉️</div>
    <h1>Check your email</h1>
    <p>We sent a magic link to<br><span class="email">${escapeHtml(email)}</span></p>
    <p>Click the link in the email to sign in.</p>
    <a href="/" class="back">← Back to login</a>
  </div>
</body>
</html>
  `.trim();
}

function renderDashboard(files: StoredFile[], message?: string): string {
  const fileRows = files.length > 0
    ? files.map(f => `
        <tr>
          <td>${escapeHtml(f.filename)}</td>
          <td>${new Date(f.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
          <td><a href="/file/${encodeURIComponent(f.id)}" class="download-link">Download</a></td>
        </tr>
      `).join('')
    : '<tr><td colspan="3" class="empty">No files yet. Run the job to generate summaries.</td></tr>';

  // Default date range: last 7 days
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 7);
  const formatDate = (d: Date) => d.toISOString().split('T')[0];

  return `
<!DOCTYPE html>
<html>
<head>
  <title>Dashboard - Grant Wire Summarizer</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📡</text></svg>">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d0d0d;
      margin: 0;
      padding: 0;
      min-height: 100vh;
      color: #ffffff;
    }
    .header {
      background: #1a1a1a;
      border-bottom: 1px solid #2a2a2a;
      padding: 24px 32px;
    }
    .header-content { max-width: 900px; margin: 0 auto; }
    .logo { margin: 0; font-size: 24px; font-weight: 700; }
    .logo-crypto { color: #ffffff; }
    .logo-grant { color: #f5a623; }
    .logo-wire { color: #ffffff; }
    .header p { margin: 8px 0 0; color: #999999; }
    .main { padding: 32px; max-width: 900px; margin: 0 auto; }
    .card {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
    }
    .card h2 { margin: 0 0 16px; font-size: 18px; color: #ffffff; }
    .message {
      padding: 12px 16px;
      border-radius: 8px;
      margin-bottom: 24px;
      font-size: 14px;
    }
    .message.success {
      background: rgba(76, 175, 80, 0.15);
      color: #4caf50;
      border: 1px solid rgba(76, 175, 80, 0.3);
    }
    .message.error {
      background: rgba(239, 83, 80, 0.15);
      color: #ef5350;
      border: 1px solid rgba(239, 83, 80, 0.3);
    }
    .button {
      display: inline-block;
      background: #f5a623;
      color: #0d0d0d;
      padding: 12px 24px;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      transition: background 0.2s;
    }
    .button:hover { background: #e6951a; }
    .button:disabled {
      background: #666666;
      cursor: not-allowed;
    }
    .button.secondary {
      background: #2a2a2a;
      color: #ffffff;
    }
    .button.secondary:hover { background: #3a3a3a; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #2a2a2a; }
    th { font-weight: 600; color: #999999; font-size: 12px; text-transform: uppercase; }
    td { color: #ffffff; }
    .download-link { color: #f5a623; text-decoration: none; font-weight: 500; }
    .download-link:hover { text-decoration: underline; }
    .empty { color: #666666; text-align: center; padding: 32px; }
    .run-form { display: flex; flex-direction: column; gap: 16px; }
    .form-row { display: flex; gap: 16px; align-items: flex-end; flex-wrap: wrap; }
    .form-group { display: flex; flex-direction: column; gap: 6px; }
    .form-group label { font-size: 12px; color: #999999; text-transform: uppercase; font-weight: 600; }
    .form-group input[type="date"],
    .form-group select {
      padding: 10px 12px;
      border: 1px solid #2a2a2a;
      border-radius: 6px;
      font-size: 14px;
      background: #0d0d0d;
      color: #ffffff;
      min-width: 180px;
    }
    .form-group input[type="date"]:focus,
    .form-group select:focus {
      outline: none;
      border-color: #f5a623;
    }
    .form-group select option {
      background: #1a1a1a;
      color: #ffffff;
    }
    .model-row { margin-top: 8px; }
    .schedule-status {
      margin-top: 16px;
      padding: 12px 16px;
      background: #0d0d0d;
      border-radius: 8px;
      border: 1px solid #2a2a2a;
    }
    .schedule-status p { margin: 0; }
    .schedule-status .next-run {
      color: #f5a623;
      font-size: 13px;
      margin-top: 8px;
    }
    #schedule-description { color: #999999; font-size: 14px; }
    .form-group input[type="time"],
    .form-group input[type="number"] {
      padding: 10px 12px;
      border: 1px solid #2a2a2a;
      border-radius: 6px;
      font-size: 14px;
      background: #0d0d0d;
      color: #ffffff;
    }
    .form-group input[type="time"]:focus,
    .form-group input[type="number"]:focus {
      outline: none;
      border-color: #f5a623;
    }
    .save-success {
      color: #4caf50 !important;
      font-weight: 500;
    }
    .form-description { color: #666666; font-size: 14px; margin: 0; }
    .progress-container { display: none; }
    .progress-container.active { display: block; }
    .progress-bar-outer {
      background: #2a2a2a;
      border-radius: 8px;
      height: 8px;
      overflow: hidden;
      margin-bottom: 12px;
    }
    .progress-bar-inner {
      background: #f5a623;
      height: 100%;
      width: 0%;
      transition: width 0.3s ease;
    }
    .progress-text { color: #999999; font-size: 14px; margin: 0 0 8px; }
    .progress-step { color: #f5a623; font-size: 14px; margin: 0; }
    .elapsed-time { color: #666666; font-size: 12px; margin-top: 8px; }
    .scheduler-health {
      margin-top: 24px;
      padding-top: 24px;
      border-top: 1px solid #2a2a2a;
    }
    .scheduler-health h3 {
      margin: 0 0 16px;
      font-size: 14px;
      color: #999999;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .status-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 12px;
    }
    .status-item {
      background: #0d0d0d;
      border: 1px solid #2a2a2a;
      border-radius: 8px;
      padding: 12px 16px;
    }
    .status-item .label {
      font-size: 11px;
      color: #666666;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    .status-item .value {
      font-size: 14px;
      color: #ffffff;
    }
    .status-item .value.success { color: #4caf50; }
    .status-item .value.error { color: #ef5350; }
    .status-item .value.warning { color: #f5a623; }
    .status-item .value.muted { color: #666666; }
    .status-item .error-msg {
      font-size: 12px;
      color: #ef5350;
      margin-top: 4px;
      font-family: monospace;
      word-break: break-word;
    }
    .refresh-btn {
      background: transparent;
      border: 1px solid #2a2a2a;
      color: #999999;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
      margin-left: 12px;
    }
    .refresh-btn:hover { border-color: #f5a623; color: #f5a623; }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-content">
      <h1 class="logo">📡 <span class="logo-grant">Grant</span><span class="logo-wire">Wire</span></h1>
      <p>Newsletter Automation Dashboard</p>
    </div>
  </div>
  <div class="main">
    ${message ? `<div class="message ${message.startsWith('Error') ? 'error' : 'success'}">${escapeHtml(decodeURIComponent(message))}</div>` : ''}

    <div class="card">
      <h2>Generate Weekly Summary</h2>
      <form id="job-form" class="run-form">
        <div class="form-row">
          <div class="form-group">
            <label for="startDate">Start Date</label>
            <input type="date" id="startDate" name="startDate" value="${formatDate(startDate)}">
          </div>
          <div class="form-group">
            <label for="endDate">End Date</label>
            <input type="date" id="endDate" name="endDate" value="${formatDate(endDate)}">
          </div>
          <div class="form-group">
            <label for="wireFilter">Feed</label>
            <select id="wireFilter" name="wire">
              <option value="">Loading feeds...</option>
            </select>
          </div>
        </div>
        <div class="form-row model-row">
          <div class="form-group">
            <label for="grokModel">Grok Model (X.com)</label>
            <select id="grokModel" name="grokModel">
              <option value="">Loading models...</option>
            </select>
          </div>
          <div class="form-group">
            <label for="anthropicModel">Claude Model (Other)</label>
            <select id="anthropicModel" name="anthropicModel">
              <option value="">Loading models...</option>
            </select>
          </div>
          <button type="submit" id="run-button" class="button">Run Job Now</button>
        </div>
        <p class="form-description">Fetches entries from the selected date range, processes with selected AI models, generates markdown.</p>
      </form>
      <div id="progress-container" class="progress-container">
        <p class="progress-text">Processing...</p>
        <div class="progress-bar-outer">
          <div id="progress-bar" class="progress-bar-inner"></div>
        </div>
        <p id="progress-step" class="progress-step"></p>
        <p id="elapsed-time" class="elapsed-time"></p>
      </div>
    </div>

    <div class="card">
      <h2>Generated Files</h2>
      <table>
        <thead>
          <tr>
            <th>Filename</th>
            <th>Created</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${fileRows}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>Feed Management <button type="button" id="add-feed" class="button" style="float: right; padding: 8px 16px; font-size: 13px;">+ Add Feed</button></h2>
      <div id="feeds-list"></div>
      <div id="feed-form" class="run-form" style="display: none; margin-top: 16px; padding-top: 16px; border-top: 1px solid #2a2a2a;">
        <input type="hidden" id="feedEditKey" value="">
        <div class="form-row">
          <div class="form-group">
            <label for="feedKey">Key</label>
            <input type="text" id="feedKey" placeholder="e.g. defi" style="background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px 12px; color: #fff; width: 120px;">
          </div>
          <div class="form-group">
            <label for="feedDisplayName">Display Name</label>
            <input type="text" id="feedDisplayName" placeholder="e.g. DeFi" style="background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px 12px; color: #fff; width: 150px;">
          </div>
          <div class="form-group">
            <label for="feedTitleTemplate">Title Template</label>
            <input type="text" id="feedTitleTemplate" placeholder="Sov's DeFi Grant Wire Weekly Update" style="background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px 12px; color: #fff; width: 320px;">
          </div>
          <button type="button" id="save-feed" class="button">Save</button>
          <button type="button" id="cancel-feed" class="button secondary">Cancel</button>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Scheduled Runs <button type="button" id="add-schedule" class="button" style="float: right; padding: 8px 16px; font-size: 13px;">+ Add Schedule</button></h2>
      <div id="schedules-list"></div>
      
      <div id="schedule-form" class="run-form" style="display: none; margin-top: 16px; padding-top: 16px; border-top: 1px solid #2a2a2a;">
        <input type="hidden" id="scheduleId" value="">
        <div class="form-row">
          <div class="form-group">
            <label for="scheduleName">Name</label>
            <input type="text" id="scheduleName" value="New Schedule" style="background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px 12px; color: #fff; width: 150px;">
          </div>
          <div class="form-group">
            <label for="scheduleType">Type</label>
            <select id="scheduleType">
              <option value="weekly-summary">Weekly Summary</option>
              <option value="scan-execution">Scan Execution (Daily)</option>
            </select>
          </div>
          <div class="form-group">
            <label for="scheduleEnabled">Status</label>
            <select id="scheduleEnabled">
              <option value="false">Disabled</option>
              <option value="true">Enabled</option>
            </select>
          </div>
          <div class="form-group" id="scheduleDayOfWeekGroup">
            <label for="scheduleDayOfWeek">Day of Week</label>
            <select id="scheduleDayOfWeek">
              <option value="0">Sunday</option>
              <option value="1">Monday</option>
              <option value="2">Tuesday</option>
              <option value="3">Wednesday</option>
              <option value="4">Thursday</option>
              <option value="5">Friday</option>
              <option value="6">Saturday</option>
            </select>
          </div>
          <div class="form-group">
            <label for="scheduleTime">Time</label>
            <input type="time" id="scheduleTime" value="09:00">
          </div>
          <div class="form-group">
            <label for="scheduleLookback">Lookback Days</label>
            <input type="number" id="scheduleLookback" min="1" max="30" value="7" style="width: 80px;">
          </div>
          <div class="form-group">
            <label for="scheduleTimezone">Timezone</label>
            <select id="scheduleTimezone">
              <option value="America/Los_Angeles">Pacific (LA)</option>
              <option value="America/Denver">Mountain (Denver)</option>
              <option value="America/Chicago">Central (Chicago)</option>
              <option value="America/New_York">Eastern (NY)</option>
              <option value="UTC">UTC</option>
              <option value="Europe/London">London</option>
              <option value="Europe/Paris">Paris</option>
              <option value="Asia/Tokyo">Tokyo</option>
              <option value="Asia/Singapore">Singapore</option>
            </select>
          </div>
        </div>
        <div class="form-row model-row">
          <div class="form-group">
            <label for="scheduleWire">Feed</label>
            <select id="scheduleWire">
              <option value="">Loading feeds...</option>
            </select>
          </div>
          <div class="form-group">
            <label for="scheduleGrokModel">Grok Model</label>
            <select id="scheduleGrokModel">
              <option value="">Loading...</option>
            </select>
          </div>
          <div class="form-group">
            <label for="scheduleAnthropicModel">Claude Model</label>
            <select id="scheduleAnthropicModel">
              <option value="">Loading...</option>
            </select>
          </div>
          <button type="button" id="save-schedule" class="button">Save</button>
          <button type="button" id="cancel-schedule" class="button secondary">Cancel</button>
        </div>
      </div>
      
      <div style="margin-top: 16px;">
        <button type="button" id="test-alert" class="button secondary">Test Alert Email</button>
      </div>

        <div class="scheduler-health">
          <h3>Scheduler Health <button id="refresh-status" class="refresh-btn">Refresh</button></h3>
          <div class="status-grid">
            <div class="status-item">
              <div class="label">Scheduler Status</div>
              <div id="scheduler-running" class="value muted">Loading...</div>
            </div>
            <div class="status-item">
              <div class="label">Server Started</div>
              <div id="scheduler-started" class="value muted">Loading...</div>
            </div>
            <div class="status-item">
              <div class="label">Last Job Run</div>
              <div id="last-job-run" class="value muted">Loading...</div>
            </div>
            <div class="status-item">
              <div class="label">Last Job Result</div>
              <div id="last-job-status" class="value muted">Loading...</div>
              <div id="last-job-error" class="error-msg" style="display: none;"></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>CRM Org Sync</h2>
      <p class="form-description" style="margin-bottom: 16px;">Sync organization names from entries to Notion staging database for review.</p>
      <div id="crm-sync-status" style="margin-bottom: 16px;">
        <div class="status-grid">
          <div class="status-item">
            <div class="label">Staging DB</div>
            <div id="crm-staging-configured" class="value muted">Loading...</div>
          </div>
          <div class="status-item">
            <div class="label">Pending Orgs</div>
            <div id="crm-pending-count" class="value muted">Loading...</div>
          </div>
        </div>
      </div>
      <div class="form-row" style="align-items: flex-end;">
        <div class="form-group">
          <label for="crmLookbackDays">Lookback Days</label>
          <input type="number" id="crmLookbackDays" min="1" max="30" value="1" style="width: 80px;">
        </div>
        <button type="button" id="run-crm-sync" class="button">Run CRM Sync</button>
      </div>
      <div id="crm-sync-result" style="display: none; margin-top: 16px; padding: 12px 16px; background: #0d0d0d; border-radius: 8px; border: 1px solid #2a2a2a;">
        <p style="margin: 0; color: #999;">Sync results will appear here</p>
      </div>
    </div>

    <div class="card">
      <h2>Run Scan</h2>
      <p class="form-description" style="margin-bottom: 16px;">Execute all active prompts against Grok and feed results through the intake pipeline.</p>
      <div class="run-form">
        <div class="form-row" style="align-items: flex-end;">
          <div class="form-group">
            <label for="scanRunWire">Wire Filter</label>
            <select id="scanRunWire">
              <option value="">All Wires</option>
            </select>
          </div>
          <button type="button" id="run-scan-btn" class="button">Run Scan Now</button>
        </div>
        <div id="scan-run-progress" style="display: none; margin-top: 16px;">
          <div style="background: #2a2a2a; border-radius: 4px; overflow: hidden; height: 20px;">
            <div id="scan-run-bar" style="background: #f5a623; height: 100%; width: 0%; transition: width 0.3s;"></div>
          </div>
          <p id="scan-run-step" style="color: #999; font-size: 13px; margin: 8px 0 0;">Initializing...</p>
        </div>
        <div id="scan-run-result" style="display: none; margin-top: 16px; padding: 12px 16px; background: #0d0d0d; border-radius: 8px; border: 1px solid #2a2a2a;">
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Scan Intake</h2>
      <p class="form-description" style="margin-bottom: 16px;">Paste structured Grok scan output to ingest, deduplicate, and score entries.</p>
      <div class="run-form">
        <div class="form-row">
          <div class="form-group">
            <label for="scanWire">Feed</label>
            <select id="scanWire">
              <option value="">Loading feeds...</option>
            </select>
          </div>
          <div class="form-group">
            <label for="scanMode">Mode</label>
            <select id="scanMode">
              <option value="single">Single Prompt</option>
              <option value="batch">Batch (All Prompts)</option>
            </select>
          </div>
          <div class="form-group" id="scanVariantGroup">
            <label for="scanVariant">Prompt Variant</label>
            <select id="scanVariant">
              <option value="A">A - Action</option>
              <option value="B">B - Landscape</option>
              <option value="C">C - Open Sweep</option>
            </select>
          </div>
          <div class="form-group">
            <label for="scanDate">Scan Date</label>
            <input type="date" id="scanDate" value="${formatDate(endDate)}">
          </div>
        </div>
        <div class="form-group" style="margin-top: 12px;">
          <label for="scanRawText">Raw Scan Output</label>
          <textarea id="scanRawText" rows="8" placeholder="Paste structured Grok output here..." style="width: 100%; padding: 10px 12px; border: 1px solid #2a2a2a; border-radius: 6px; font-size: 13px; font-family: monospace; background: #0d0d0d; color: #ffffff; resize: vertical;"></textarea>
        </div>
        <div style="margin-top: 12px;">
          <button type="button" id="process-scan" class="button">Process Scan</button>
        </div>
      </div>
      <div id="scan-result" style="display: none; margin-top: 16px; padding: 12px 16px; background: #0d0d0d; border-radius: 8px; border: 1px solid #2a2a2a;">
        <p style="margin: 0; color: #999;">Results will appear here</p>
      </div>
    </div>

    <div class="card">
      <h2>Daily Queue <span id="queue-count-badge" style="display: none; background: #f5a623; color: #000; font-size: 13px; padding: 2px 10px; border-radius: 12px; margin-left: 8px; font-weight: 600;"></span></h2>
      <p class="form-description" style="margin-bottom: 16px;">Review prioritized scan entries. Promote to keep, skip to defer, archive to dismiss.</p>
      <div class="form-row" style="margin-bottom: 16px;">
        <div class="form-group">
          <label for="queueWire">Feed Filter</label>
          <select id="queueWire">
            <option value="">All Feeds</option>
          </select>
        </div>
        <div class="form-group">
          <label for="queueMinScore">Min Score</label>
          <input type="number" id="queueMinScore" min="0" max="100" value="40" style="width: 80px;">
        </div>
        <div class="form-group">
          <label for="queueDate">Date</label>
          <input type="date" id="queueDate" value="${formatDate(endDate)}">
        </div>
        <button type="button" id="load-queue" class="button secondary">Load Queue</button>
      </div>
      <div id="queue-results">
        <p style="color: #666;">Click "Load Queue" to view entries.</p>
      </div>
    </div>

    <div class="card">
      <h2>Prompt Management <button type="button" id="add-prompt" class="button" style="float: right; padding: 8px 16px; font-size: 13px;">+ Add Prompt</button></h2>
      <p class="form-description" style="margin-bottom: 16px;">Manage scan prompts for automated Grok queries. Test prompts to preview output before scheduling.</p>
      <div id="prompts-list"></div>
      <div id="prompt-form" class="run-form" style="display: none; margin-top: 16px; padding-top: 16px; border-top: 1px solid #2a2a2a;">
        <input type="hidden" id="promptEditId" value="">
        <div class="form-row">
          <div class="form-group">
            <label for="promptWire">Wire</label>
            <select id="promptWire">
              <option value="">Loading feeds...</option>
            </select>
          </div>
          <div class="form-group">
            <label for="promptLabel">Label</label>
            <input type="text" id="promptLabel" placeholder="e.g. Action Scan" style="background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px 12px; color: #fff; width: 180px;">
          </div>
          <div class="form-group">
            <label for="promptSortOrder">Order</label>
            <input type="number" id="promptSortOrder" value="0" min="0" style="width: 70px;">
          </div>
          <div class="form-group">
            <label for="promptIsActive">Status</label>
            <select id="promptIsActive">
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </select>
          </div>
        </div>
        <div class="form-group" style="margin-top: 12px;">
          <label for="promptText">Prompt Text</label>
          <textarea id="promptText" rows="6" placeholder="Enter the scan prompt..." style="width: 100%; padding: 10px 12px; border: 1px solid #2a2a2a; border-radius: 6px; font-size: 13px; font-family: monospace; background: #0d0d0d; color: #ffffff; resize: vertical;"></textarea>
        </div>
        <div class="form-group" style="margin-top: 12px;">
          <label for="promptResponseFormat">Response Format (optional)</label>
          <textarea id="promptResponseFormat" rows="3" placeholder="Optional structured output format..." style="width: 100%; padding: 10px 12px; border: 1px solid #2a2a2a; border-radius: 6px; font-size: 13px; font-family: monospace; background: #0d0d0d; color: #ffffff; resize: vertical;"></textarea>
        </div>
        <div style="margin-top: 12px;">
          <button type="button" id="save-prompt" class="button">Save Prompt</button>
          <button type="button" id="cancel-prompt" class="button secondary" style="margin-left: 8px;">Cancel</button>
        </div>
      </div>
      <div id="prompt-test-result" style="display: none; margin-top: 16px; padding: 12px 16px; background: #0d0d0d; border-radius: 8px; border: 1px solid #2a2a2a;">
        <p style="margin: 0; color: #999;">Test results will appear here</p>
      </div>
    </div>

    <div class="card">
      <h2>Prompt Effectiveness</h2>
      <p class="form-description" style="margin-bottom: 16px;">How well each prompt performs: unique results, duplicate rate, quality scores.</p>
      <div class="form-row" style="margin-bottom: 16px; align-items: flex-end;">
        <div class="form-group">
          <label for="statsDays">Lookback Days</label>
          <input type="number" id="statsDays" min="1" max="90" value="7" style="width: 80px;">
        </div>
        <button type="button" id="load-prompt-stats" class="button secondary">Refresh</button>
      </div>
      <div id="prompt-stats-results">
        <p style="color: #666;">Loading stats...</p>
      </div>
    </div>
  </div>

  <script>
    function escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    const form = document.getElementById('job-form');
    const runButton = document.getElementById('run-button');
    const progressContainer = document.getElementById('progress-container');
    const progressBar = document.getElementById('progress-bar');
    const progressStep = document.getElementById('progress-step');
    const elapsedTimeEl = document.getElementById('elapsed-time');
    const grokModelSelect = document.getElementById('grokModel');
    const anthropicModelSelect = document.getElementById('anthropicModel');
    let startTime;
    let elapsedTimer;

    // Fetch and populate models on page load
    async function loadModels() {
      try {
        const response = await fetch('/api/models');
        if (!response.ok) throw new Error('Failed to fetch models');
        const models = await response.json();

        // Populate Grok models
        grokModelSelect.innerHTML = models.grok.map((m, i) =>
          '<option value="' + escapeHtml(m.id) + '"' + (i === 0 ? ' selected' : '') + '>' + escapeHtml(m.displayName) + '</option>'
        ).join('');

        // Populate Anthropic models
        anthropicModelSelect.innerHTML = models.anthropic.map((m, i) =>
          '<option value="' + escapeHtml(m.id) + '"' + (i === 0 ? ' selected' : '') + '>' + escapeHtml(m.displayName) + '</option>'
        ).join('');
      } catch (error) {
        console.error('Failed to load models:', error);
        grokModelSelect.innerHTML = '<option value="grok-4-1-fast-reasoning">Grok 4.1 Fast (Reasoning)</option>';
        anthropicModelSelect.innerHTML = '<option value="claude-opus-4-5-20251101">Claude Opus 4.5</option>';
      }
    }

    loadModels();

    // Shared feeds fetch to avoid duplicate /api/feeds calls
    let cachedFeedsPromise = null;
    async function fetchFeedsOnce() {
      if (!cachedFeedsPromise) {
        cachedFeedsPromise = fetch('/api/feeds').then(function(r) {
          if (!r.ok) throw new Error('Failed to fetch feeds');
          return r.json();
        });
      }
      return cachedFeedsPromise;
    }
    function invalidateFeedsCache() { cachedFeedsPromise = null; }

    // Fetch and populate wires/feeds on page load
    const wireFilterSelect = document.getElementById('wireFilter');

    async function loadWires() {
      try {
        const feeds = await fetchFeedsOnce();

        // Build options: "All Feeds" first, then each feed
        let options = '<option value="">All Feeds</option>';
        feeds.forEach(function(f) {
          options += '<option value="' + escapeHtml(f.key) + '">' + escapeHtml(f.displayName) + ' (' + f.entryCount + ' entries)</option>';
        });
        wireFilterSelect.innerHTML = options;
      } catch (error) {
        console.error('Failed to load feeds:', error);
        wireFilterSelect.innerHTML = '<option value="">All Feeds</option>';
      }
    }

    loadWires();

    // Feed management
    const feedsListEl = document.getElementById('feeds-list');
    const feedForm = document.getElementById('feed-form');
    const feedEditKeyEl = document.getElementById('feedEditKey');
    const feedKeyInput = document.getElementById('feedKey');
    const feedDisplayNameInput = document.getElementById('feedDisplayName');
    const feedTitleTemplateInput = document.getElementById('feedTitleTemplate');
    const saveFeedBtn = document.getElementById('save-feed');
    const cancelFeedBtn = document.getElementById('cancel-feed');
    const addFeedBtn = document.getElementById('add-feed');

    async function loadFeeds() {
      try {
        const feeds = await fetchFeedsOnce();
        renderFeedsList(feeds);
      } catch (error) {
        console.error('Failed to load feeds:', error);
        feedsListEl.innerHTML = '<p style="color: #ef5350;">Failed to load feeds</p>';
      }
    }

    function renderFeedsList(feeds) {
      if (feeds.length === 0) {
        feedsListEl.innerHTML = '<p style="color: #666;">No feeds configured. Click "+ Add Feed" to create one.</p>';
        return;
      }

      let html = '<table><thead><tr><th>Key</th><th>Display Name</th><th>Entries</th><th>Title Template</th><th>Actions</th></tr></thead><tbody>';

      feeds.forEach(function(f) {
        html += '<tr>';
        html += '<td><code style="background: #0d0d0d; padding: 2px 6px; border-radius: 4px;">' + escapeHtml(f.key) + '</code></td>';
        html += '<td>' + escapeHtml(f.displayName) + '</td>';
        html += '<td>' + f.entryCount + '</td>';
        html += '<td style="font-size: 12px; color: #999;">' + escapeHtml(f.titleTemplate || '-') + '</td>';
        html += '<td>';
        html += '<button class="edit-feed" data-key="' + escapeHtml(f.key) + '" data-display="' + escapeHtml(f.displayName) + '" data-template="' + escapeHtml(f.titleTemplate || '') + '" style="background: #2a2a2a; border: none; color: #f5a623; padding: 6px 12px; border-radius: 4px; cursor: pointer; margin-right: 8px;">Edit</button>';
        html += '<button class="archive-feed" data-key="' + escapeHtml(f.key) + '" data-display="' + escapeHtml(f.displayName) + '" style="background: #2a2a2a; border: none; color: #ef5350; padding: 6px 12px; border-radius: 4px; cursor: pointer;">Archive</button>';
        html += '</td>';
        html += '</tr>';
      });

      html += '</tbody></table>';
      feedsListEl.innerHTML = html;

      document.querySelectorAll('.edit-feed').forEach(function(btn) {
        btn.addEventListener('click', function() {
          feedEditKeyEl.value = btn.dataset.key;
          feedKeyInput.value = btn.dataset.key;
          feedKeyInput.disabled = true;
          feedDisplayNameInput.value = btn.dataset.display;
          feedTitleTemplateInput.value = btn.dataset.template;
          feedForm.style.display = 'block';
        });
      });
      document.querySelectorAll('.archive-feed').forEach(function(btn) {
        btn.addEventListener('click', function() {
          if (!confirm('Archive feed "' + btn.dataset.display + '"? It will be hidden from dropdowns.')) return;
          fetch('/api/feeds/' + encodeURIComponent(btn.dataset.key), { method: 'DELETE' })
            .then(function(r) { if (!r.ok) throw new Error('Failed'); invalidateFeedsCache(); loadFeeds(); loadWires(); loadSchedules(); })
            .catch(function(e) { console.error(e); alert('Failed to archive feed'); });
        });
      });
    }

    addFeedBtn.addEventListener('click', function() {
      feedEditKeyEl.value = '';
      feedKeyInput.value = '';
      feedKeyInput.disabled = false;
      feedDisplayNameInput.value = '';
      feedTitleTemplateInput.value = '';
      feedForm.style.display = 'block';
    });

    cancelFeedBtn.addEventListener('click', function() {
      feedForm.style.display = 'none';
    });

    saveFeedBtn.addEventListener('click', async function() {
      const editKey = feedEditKeyEl.value;
      const key = feedKeyInput.value.trim();
      const displayName = feedDisplayNameInput.value.trim();
      const titleTemplate = feedTitleTemplateInput.value.trim();

      if (!displayName) { alert('Display name is required'); return; }

      saveFeedBtn.disabled = true;
      saveFeedBtn.textContent = 'Saving...';

      try {
        let response;
        if (editKey) {
          response = await fetch('/api/feeds/' + encodeURIComponent(editKey), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ displayName, titleTemplate: titleTemplate || undefined })
          });
        } else {
          if (!key) { alert('Key is required'); saveFeedBtn.disabled = false; saveFeedBtn.textContent = 'Save'; return; }
          response = await fetch('/api/feeds', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, displayName, titleTemplate: titleTemplate || undefined })
          });
        }

        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.error || 'Failed to save');
        }

        feedForm.style.display = 'none';
        invalidateFeedsCache();
        loadFeeds();
        loadWires();
        loadSchedules();
      } catch (error) {
        console.error('Failed to save feed:', error);
        alert('Failed to save feed: ' + error.message);
      } finally {
        saveFeedBtn.disabled = false;
        saveFeedBtn.textContent = 'Save';
      }
    });

    loadFeeds();

    // Schedule management
    const schedulesListEl = document.getElementById('schedules-list');
    const scheduleForm = document.getElementById('schedule-form');
    const scheduleId = document.getElementById('scheduleId');
    const scheduleName = document.getElementById('scheduleName');
    const scheduleTypeSelect = document.getElementById('scheduleType');
    const scheduleEnabled = document.getElementById('scheduleEnabled');
    const scheduleDayOfWeek = document.getElementById('scheduleDayOfWeek');
    const scheduleDayOfWeekGroup = document.getElementById('scheduleDayOfWeekGroup');
    const scheduleTime = document.getElementById('scheduleTime');
    const scheduleLookback = document.getElementById('scheduleLookback');
    const scheduleGrokModel = document.getElementById('scheduleGrokModel');
    const scheduleAnthropicModel = document.getElementById('scheduleAnthropicModel');
    const scheduleWire = document.getElementById('scheduleWire');
    const scheduleTimezone = document.getElementById('scheduleTimezone');
    const saveScheduleBtn = document.getElementById('save-schedule');
    const cancelScheduleBtn = document.getElementById('cancel-schedule');
    const addScheduleBtn = document.getElementById('add-schedule');

    // Show/hide dayOfWeek based on schedule type
    scheduleTypeSelect.addEventListener('change', function() {
      scheduleDayOfWeekGroup.style.display = scheduleTypeSelect.value === 'scan-execution' ? 'none' : '';
    });
    
    let cachedWires = [];
    let cachedModels = { grok: [], anthropic: [] };

    async function loadSchedules() {
      try {
        // Load feeds and models first
        const [feedsRes, modelsRes, schedulesRes] = await Promise.all([
          fetch('/api/feeds'),
          fetch('/api/models'),
          fetch('/api/schedules')
        ]);

        if (feedsRes.ok) cachedWires = await feedsRes.json();
        if (modelsRes.ok) cachedModels = await modelsRes.json();
        
        if (!schedulesRes.ok) throw new Error('Failed to fetch schedules');
        const data = await schedulesRes.json();
        
        renderSchedulesList(data.schedules || []);
      } catch (error) {
        console.error('Failed to load schedules:', error);
        schedulesListEl.innerHTML = '<p style="color: #ef5350;">Failed to load schedules</p>';
      }
    }
    
    function renderSchedulesList(schedules) {
      if (schedules.length === 0) {
        schedulesListEl.innerHTML = '<p style="color: #666;">No schedules configured. Click "+ Add Schedule" to create one.</p>';
        return;
      }
      
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      
      let html = '<table><thead><tr><th>Name</th><th>Type</th><th>Schedule</th><th>Feed</th><th>Status</th><th>Next Run</th><th>Actions</th></tr></thead><tbody>';

      schedules.forEach(s => {
        const day = dayNames[s.dayOfWeek];
        const hour12 = s.hour % 12 || 12;
        const ampm = s.hour >= 12 ? 'PM' : 'AM';
        const time = hour12 + ':' + s.minute.toString().padStart(2, '0') + ' ' + ampm;
        const feedMatch = cachedWires.find(function(f) { return f.key === s.wire; });
        const feed = s.wire ? (feedMatch ? feedMatch.displayName : s.wire) : 'All';
        const status = s.enabled ? '<span style="color: #4caf50;">Enabled</span>' : '<span style="color: #666;">Disabled</span>';
        const tz = s.timezone || 'America/Los_Angeles';
        const tzShort = tz.split('/').pop().replace('_', ' ');
        const isScan = s.scheduleType === 'scan-execution';
        const typeLabel = isScan ? '<span style="color: #9c27b0;">Scan</span>' : 'Summary';
        let nextRun = '-';
        if (s.nextRun) {
          try {
            nextRun = new Date(s.nextRun).toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
          } catch (e) {
            nextRun = new Date(s.nextRun).toLocaleString();
          }
        }
        
        html += '<tr>';
        html += '<td>' + escapeHtml(s.name || 'Untitled') + '</td>';
        html += '<td>' + typeLabel + '</td>';
        html += '<td>' + (isScan ? 'Daily' : day) + ' @ ' + time + ' <span style="color: #666; font-size: 11px;">(' + escapeHtml(tzShort) + ')</span></td>';
        html += '<td>' + escapeHtml(feed) + '</td>';
        html += '<td>' + status + '</td>';
        html += '<td style="font-size: 12px;">' + escapeHtml(nextRun) + (s.nextRun ? ' <span style="color: #666; font-size: 10px;">(' + escapeHtml(tz === 'UTC' ? 'UTC' : tzShort) + ')</span>' : '') + '</td>';
        html += '<td>';
        html += '<button class="edit-schedule" data-id="' + escapeHtml(s.id) + '" style="background: #2a2a2a; border: none; color: #f5a623; padding: 6px 12px; border-radius: 4px; cursor: pointer; margin-right: 8px;">Edit</button>';
        html += '<button class="delete-schedule" data-id="' + escapeHtml(s.id) + '" data-name="' + escapeHtml(s.name || 'Untitled') + '" style="background: #2a2a2a; border: none; color: #ef5350; padding: 6px 12px; border-radius: 4px; cursor: pointer;">Delete</button>';
        html += '</td>';
        html += '</tr>';
      });
      
      html += '</tbody></table>';
      schedulesListEl.innerHTML = html;
      
      // Attach event listeners
      document.querySelectorAll('.edit-schedule').forEach(btn => {
        btn.addEventListener('click', () => editSchedule(btn.dataset.id));
      });
      document.querySelectorAll('.delete-schedule').forEach(btn => {
        btn.addEventListener('click', () => deleteSchedule(btn.dataset.id, btn.dataset.name));
      });
    }
    
    function populateFormDropdowns(schedule) {
      // Feeds
      let wireOptions = '<option value="">All Feeds</option>';
      cachedWires.forEach(function(f) {
        const selected = schedule && f.key === schedule.wire ? ' selected' : '';
        wireOptions += '<option value="' + escapeHtml(f.key) + '"' + selected + '>' + escapeHtml(f.displayName) + '</option>';
      });
      scheduleWire.innerHTML = wireOptions;

      // Models
      scheduleGrokModel.innerHTML = cachedModels.grok.map(m =>
        '<option value="' + escapeHtml(m.id) + '"' + (schedule && m.id === schedule.grokModel ? ' selected' : '') + '>' + escapeHtml(m.displayName) + '</option>'
      ).join('');

      scheduleAnthropicModel.innerHTML = cachedModels.anthropic.map(m =>
        '<option value="' + escapeHtml(m.id) + '"' + (schedule && m.id === schedule.anthropicModel ? ' selected' : '') + '>' + escapeHtml(m.displayName) + '</option>'
      ).join('');
    }
    
    function showScheduleForm(schedule) {
      scheduleForm.style.display = 'block';
      populateFormDropdowns(schedule);

      if (schedule) {
        scheduleId.value = schedule.id;
        scheduleName.value = schedule.name || '';
        scheduleTypeSelect.value = schedule.scheduleType || 'weekly-summary';
        scheduleEnabled.value = schedule.enabled.toString();
        scheduleDayOfWeek.value = schedule.dayOfWeek.toString();
        scheduleTime.value = schedule.hour.toString().padStart(2, '0') + ':' + schedule.minute.toString().padStart(2, '0');
        scheduleLookback.value = schedule.lookbackDays;
        scheduleTimezone.value = schedule.timezone || 'America/Los_Angeles';
      } else {
        scheduleId.value = '';
        scheduleName.value = 'New Schedule';
        scheduleTypeSelect.value = 'weekly-summary';
        scheduleEnabled.value = 'false';
        scheduleDayOfWeek.value = '3';
        scheduleTime.value = '09:00';
        scheduleLookback.value = '7';
        scheduleTimezone.value = 'America/Los_Angeles';
      }
      // Toggle dayOfWeek visibility based on type
      scheduleDayOfWeekGroup.style.display = scheduleTypeSelect.value === 'scan-execution' ? 'none' : '';
    }
    
    function hideScheduleForm() {
      scheduleForm.style.display = 'none';
      scheduleId.value = '';
    }
    
    async function editSchedule(id) {
      try {
        const response = await fetch('/api/schedule?id=' + encodeURIComponent(id));
        if (!response.ok) throw new Error('Failed to fetch schedule');
        const schedule = await response.json();
        showScheduleForm(schedule);
      } catch (error) {
        console.error('Failed to edit schedule:', error);
      }
    }
    
    async function deleteSchedule(id, name) {
      if (!confirm('Delete schedule "' + name + '"?')) return;

      try {
        const response = await fetch('/api/schedules/' + encodeURIComponent(id), { method: 'DELETE' });
        if (!response.ok) throw new Error('Failed to delete');
        loadSchedules();
        loadSchedulerStatus();
      } catch (error) {
        console.error('Failed to delete schedule:', error);
        alert('Failed to delete schedule');
      }
    }
    
    addScheduleBtn.addEventListener('click', () => showScheduleForm(null));
    cancelScheduleBtn.addEventListener('click', hideScheduleForm);
    
    loadSchedules();

    // Scheduler health status
    const schedulerRunningEl = document.getElementById('scheduler-running');
    const schedulerStartedEl = document.getElementById('scheduler-started');
    const lastJobRunEl = document.getElementById('last-job-run');
    const lastJobStatusEl = document.getElementById('last-job-status');
    const lastJobErrorEl = document.getElementById('last-job-error');
    const refreshStatusBtn = document.getElementById('refresh-status');

    function formatRelativeTime(dateStr) {
      if (!dateStr) return null;
      const date = new Date(dateStr);
      const now = new Date();
      const diffMs = now - date;
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return diffMins + ' min ago';
      if (diffHours < 24) return diffHours + ' hour' + (diffHours > 1 ? 's' : '') + ' ago';
      if (diffDays < 7) return diffDays + ' day' + (diffDays > 1 ? 's' : '') + ' ago';
      return date.toLocaleDateString();
    }

    async function loadSchedulerStatus() {
      try {
        const response = await fetch('/api/scheduler-status');
        if (!response.ok) throw new Error('Failed to fetch status');
        const status = await response.json();

        // Find the most recent schedule that has run a job
        const latestSchedule = (status.schedules || [])
          .filter(function(s) { return s.lastJobRun; })
          .sort(function(a, b) { return new Date(b.lastJobRun) - new Date(a.lastJobRun); })[0] || null;

        // Scheduler running status
        if (status.isRunning) {
          schedulerRunningEl.textContent = 'Active (' + status.activeSchedules + ' schedule' + (status.activeSchedules !== 1 ? 's' : '') + ')';
          schedulerRunningEl.className = 'value success';
        } else if (status.totalSchedules > 0) {
          schedulerRunningEl.textContent = 'Not Running (restart needed)';
          schedulerRunningEl.className = 'value error';
        } else {
          schedulerRunningEl.textContent = 'No Schedules';
          schedulerRunningEl.className = 'value muted';
        }

        // Server started time
        if (status.schedulerStartedAt) {
          var startedAt = formatRelativeTime(status.schedulerStartedAt);
          schedulerStartedEl.textContent = startedAt;
          schedulerStartedEl.className = 'value';
        } else {
          schedulerStartedEl.textContent = 'Not started';
          schedulerStartedEl.className = 'value muted';
        }

        // Last job run (from most recent schedule)
        if (latestSchedule && latestSchedule.lastJobRun) {
          var lastRun = formatRelativeTime(latestSchedule.lastJobRun);
          lastJobRunEl.textContent = lastRun + ' (' + latestSchedule.name + ')';
          lastJobRunEl.className = 'value';
        } else {
          lastJobRunEl.textContent = 'Never';
          lastJobRunEl.className = 'value muted';
        }

        // Last job status (from most recent schedule)
        var lastStatus = latestSchedule ? latestSchedule.lastJobStatus : null;
        var lastError = latestSchedule ? latestSchedule.lastJobError : null;
        if (lastStatus === 'success') {
          lastJobStatusEl.textContent = 'Success';
          lastJobStatusEl.className = 'value success';
          lastJobErrorEl.style.display = 'none';
        } else if (lastStatus === 'failed') {
          lastJobStatusEl.textContent = 'Failed';
          lastJobStatusEl.className = 'value error';
          if (lastError) {
            lastJobErrorEl.textContent = lastError;
            lastJobErrorEl.style.display = 'block';
          }
        } else {
          lastJobStatusEl.textContent = 'No runs yet';
          lastJobStatusEl.className = 'value muted';
          lastJobErrorEl.style.display = 'none';
        }
      } catch (error) {
        console.error('Failed to load scheduler status:', error);
        schedulerRunningEl.textContent = 'Error loading status';
        schedulerRunningEl.className = 'value error';
      }
    }

    loadSchedulerStatus();

    refreshStatusBtn.addEventListener('click', () => {
      refreshStatusBtn.textContent = 'Refreshing...';
      loadSchedulerStatus().then(() => {
        refreshStatusBtn.textContent = 'Refresh';
      });
    });

    const testAlertBtn = document.getElementById('test-alert');

    testAlertBtn.addEventListener('click', async () => {
      testAlertBtn.disabled = true;
      testAlertBtn.textContent = 'Sending...';

      try {
        const response = await fetch('/api/test-alert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        });

        const result = await response.json();

        if (result.success) {
          testAlertBtn.textContent = 'Sent!';
          testAlertBtn.style.background = '#4caf50';
          setTimeout(() => {
            testAlertBtn.textContent = 'Test Alert';
            testAlertBtn.style.background = '';
            testAlertBtn.disabled = false;
          }, 3000);
        } else {
          testAlertBtn.textContent = 'Failed';
          testAlertBtn.style.background = '#ef5350';
          setTimeout(() => {
            testAlertBtn.textContent = 'Test Alert';
            testAlertBtn.style.background = '';
            testAlertBtn.disabled = false;
          }, 3000);
        }
      } catch (error) {
        console.error('Failed to send test alert:', error);
        testAlertBtn.textContent = 'Error';
        testAlertBtn.style.background = '#ef5350';
        setTimeout(() => {
          testAlertBtn.textContent = 'Test Alert';
          testAlertBtn.style.background = '';
          testAlertBtn.disabled = false;
        }, 3000);
      }
    });

    saveScheduleBtn.addEventListener('click', async () => {
      const timeParts = scheduleTime.value.split(':');
      const hour = parseInt(timeParts[0], 10);
      const minute = parseInt(timeParts[1], 10);
      const id = scheduleId.value;

      saveScheduleBtn.disabled = true;
      saveScheduleBtn.textContent = 'Saving...';

      try {
        const body = {
          name: scheduleName.value,
          scheduleType: scheduleTypeSelect.value,
          enabled: scheduleEnabled.value === 'true',
          dayOfWeek: parseInt(scheduleDayOfWeek.value, 10),
          hour,
          minute,
          lookbackDays: parseInt(scheduleLookback.value, 10),
          timezone: scheduleTimezone.value,
          grokModel: scheduleGrokModel.value,
          anthropicModel: scheduleAnthropicModel.value,
          wire: scheduleWire.value || undefined,
        };
        
        let response;
        if (id) {
          // Update existing
          response = await fetch('/api/schedules/' + encodeURIComponent(id), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
        } else {
          // Create new
          response = await fetch('/api/schedules', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
        }

        if (!response.ok) throw new Error('Failed to save schedule');

        hideScheduleForm();
        loadSchedules();
        loadSchedulerStatus();
      } catch (error) {
        console.error('Failed to save schedule:', error);
        alert('Failed to save schedule');
      } finally {
        saveScheduleBtn.disabled = false;
        saveScheduleBtn.textContent = 'Save';
      }
    });

    function updateElapsedTime() {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      elapsedTimeEl.textContent = 'Elapsed: ' + (mins > 0 ? mins + 'm ' : '') + secs + 's';
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const startDate = document.getElementById('startDate').value;
      const endDate = document.getElementById('endDate').value;
      const grokModel = grokModelSelect.value;
      const anthropicModel = anthropicModelSelect.value;
      const wireFilter = document.getElementById('wireFilter').value;

      runButton.disabled = true;
      runButton.textContent = 'Starting...';
      progressContainer.classList.add('active');
      progressBar.style.width = '0%';
      progressStep.textContent = 'Initializing job...';

      startTime = Date.now();
      elapsedTimer = setInterval(updateElapsedTime, 1000);
      updateElapsedTime();

      try {
        const response = await fetch('/api/run-job', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ startDate, endDate, grokModel, anthropicModel, wire: wireFilter || undefined })
        });

        const data = await response.json();

        if (data.jobId) {
          subscribeToProgress(data.jobId);
        } else if (data.error) {
          showError(data.error);
        }
      } catch (error) {
        showError('Failed to start job: ' + error.message);
      }
    });

    function subscribeToProgress(jobId) {
      const eventSource = new EventSource('/api/job/' + jobId + '/progress');

      eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.status === 'running' && data.progress) {
          const percent = (data.progress.current / data.progress.total) * 100;
          progressBar.style.width = percent + '%';
          progressStep.textContent = data.progress.step;
        } else if (data.status === 'completed') {
          clearInterval(elapsedTimer);
          eventSource.close();
          window.location.href = '/dashboard?message=' + encodeURIComponent('Success! Processed ' + (data.result?.stats?.totalEntries || 0) + ' entries. File ready for download.');
        } else if (data.status === 'failed') {
          clearInterval(elapsedTimer);
          eventSource.close();
          showError(data.error || 'Job failed');
        }
      };

      eventSource.onerror = () => {
        clearInterval(elapsedTimer);
        eventSource.close();
        showError('Lost connection to server');
      };
    }

    function showError(message) {
      clearInterval(elapsedTimer);
      progressContainer.classList.remove('active');
      runButton.disabled = false;
      runButton.textContent = 'Run Job Now';

      const errorDiv = document.createElement('div');
      errorDiv.className = 'message error';
      errorDiv.textContent = 'Error: ' + message;
      document.querySelector('.main').insertBefore(errorDiv, document.querySelector('.card'));
    }

    // CRM Sync functionality
    const crmStagingEl = document.getElementById('crm-staging-configured');
    const crmPendingEl = document.getElementById('crm-pending-count');
    const crmLookbackInput = document.getElementById('crmLookbackDays');
    const runCrmSyncBtn = document.getElementById('run-crm-sync');
    const crmResultEl = document.getElementById('crm-sync-result');

    async function loadCrmStatus() {
      try {
        const response = await fetch('/api/crm-sync/status');
        if (!response.ok) throw new Error('Failed to fetch');
        const data = await response.json();
        
        crmStagingEl.textContent = data.stagingConfigured ? 'Configured' : 'Not Configured';
        crmStagingEl.className = 'value ' + (data.stagingConfigured ? 'success' : 'warning');
        
        crmPendingEl.textContent = data.stagingConfigured ? data.pendingOrgs.toString() : '-';
        crmPendingEl.className = 'value ' + (data.pendingOrgs > 0 ? 'warning' : 'muted');
      } catch (error) {
        crmStagingEl.textContent = 'Error';
        crmStagingEl.className = 'value error';
        crmPendingEl.textContent = '-';
      }
    }

    loadCrmStatus();

    // Populate scan intake feed dropdown
    const scanWireSelect = document.getElementById('scanWire');
    const queueWireSelect = document.getElementById('queueWire');

    async function loadScanFeeds() {
      try {
        const response = await fetch('/api/feeds');
        if (!response.ok) throw new Error('Failed to fetch feeds');
        const feeds = await response.json();

        let scanOptions = '';
        let queueOptions = '<option value="">All Feeds</option>';
        feeds.forEach(function(f) {
          scanOptions += '<option value="' + escapeHtml(f.key) + '">' + escapeHtml(f.displayName) + '</option>';
          queueOptions += '<option value="' + escapeHtml(f.key) + '">' + escapeHtml(f.displayName) + '</option>';
        });
        scanWireSelect.innerHTML = scanOptions;
        queueWireSelect.innerHTML = queueOptions;
      } catch (error) {
        console.error('Failed to load scan feeds:', error);
      }
    }

    loadScanFeeds();

    // Scan mode toggle — hide variant selector in batch mode
    const scanModeSelect = document.getElementById('scanMode');
    const scanVariantGroup = document.getElementById('scanVariantGroup');
    scanModeSelect.addEventListener('change', function() {
      scanVariantGroup.style.display = scanModeSelect.value === 'batch' ? 'none' : 'flex';
    });

    // Process scan
    const processScanBtn = document.getElementById('process-scan');
    const scanResultEl = document.getElementById('scan-result');

    processScanBtn.addEventListener('click', async function() {
      const wire = scanWireSelect.value;
      const mode = scanModeSelect.value;
      const variant = document.getElementById('scanVariant').value;
      const scanDate = document.getElementById('scanDate').value;
      const rawText = document.getElementById('scanRawText').value;

      if (!wire) { alert('Please select a feed'); return; }
      if (!rawText.trim()) { alert('Please paste scan output'); return; }

      processScanBtn.disabled = true;
      processScanBtn.textContent = 'Processing...';
      scanResultEl.style.display = 'block';
      scanResultEl.innerHTML = '<p style="margin: 0; color: #f5a623;">Processing scan...</p>';

      try {
        const endpoint = mode === 'batch' ? '/api/scan/submit-batch' : '/api/scan/submit';
        const body = mode === 'batch'
          ? { wire, scanDate, rawText }
          : { wire, promptVariant: variant, scanDate, rawText };

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        const data = await response.json();

        if (data.success && data.summary) {
          const s = data.summary;
          let html = '<p style="margin: 0 0 8px; color: #4caf50; font-weight: 600;">Intake complete!</p>';
          html += '<p style="margin: 0; color: #999; font-size: 13px;">';
          html += 'Ingested: ' + s.totalIngested + ' | Duplicates: ' + s.duplicatesFound;
          html += ' | Unique: ' + s.newUnique + ' | Avg Score: ' + s.averageQualityScore;
          html += ' | High Quality: ' + s.highQualityCount;
          html += '</p>';

          if (s.byPrompt && Object.keys(s.byPrompt).length > 0) {
            html += '<p style="margin: 8px 0 4px; color: #999; font-size: 12px; text-transform: uppercase;">By Prompt:</p>';
            for (var key in s.byPrompt) {
              var p = s.byPrompt[key];
              html += '<p style="margin: 0; color: #ccc; font-size: 12px;">' + escapeHtml(key) + ': ' + p.total + ' total, ' + p.duplicates + ' dupes, avg ' + p.avgScore + '</p>';
            }
          }

          if (s.topFinds && s.topFinds.length > 0) {
            html += '<p style="margin: 8px 0 4px; color: #999; font-size: 12px; text-transform: uppercase;">Top Finds:</p>';
            s.topFinds.slice(0, 5).forEach(function(e) {
              html += '<p style="margin: 0; color: #ccc; font-size: 12px;">[' + (e.quality_score || '-') + '] ' + escapeHtml(e.name) + (e.amount ? ' — ' + escapeHtml(e.amount) : '') + '</p>';
            });
          }

          scanResultEl.innerHTML = html;
          loadQueue();
        } else {
          scanResultEl.innerHTML = '<p style="margin: 0; color: #ef5350;">Error: ' + escapeHtml(data.error || 'Unknown error') + '</p>';
        }
      } catch (error) {
        scanResultEl.innerHTML = '<p style="margin: 0; color: #ef5350;">Error: ' + escapeHtml(error.message) + '</p>';
      } finally {
        processScanBtn.disabled = false;
        processScanBtn.textContent = 'Process Scan';
      }
    });

    // Daily queue
    const loadQueueBtn = document.getElementById('load-queue');
    const queueResultsEl = document.getElementById('queue-results');
    const queueCountBadge = document.getElementById('queue-count-badge');

    function scoreColor(score) {
      if (score == null) return '#666';
      if (score >= 60) return '#4caf50';
      if (score >= 40) return '#f5a623';
      return '#ef5350';
    }

    function sourceBadge(scanSource) {
      var badges = {
        'x-scan': { label: 'X', bg: '#1a3a5c', color: '#5b9bd5' },
        'web-search': { label: 'Web', bg: '#1a3c1a', color: '#4caf50' },
        'telegram': { label: 'TG', bg: '#1a3c3c', color: '#26c6da' },
        'email': { label: 'Email', bg: '#3c2a1a', color: '#ff9800' }
      };
      var b = badges[scanSource] || { label: scanSource || '?', bg: '#2a2a2a', color: '#999' };
      return '<span style="background:' + b.bg + '; color:' + b.color + '; padding:2px 6px; border-radius:4px; font-size:11px; font-weight:600;">' + b.label + '</span>';
    }

    async function entryAction(id, action, btnEl) {
      if (btnEl) btnEl.disabled = true;
      try {
        const resp = await fetch('/api/scan/entries/' + id + '/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: action })
        });
        if (!resp.ok) throw new Error('Failed');
        loadQueue();
      } catch (e) {
        console.error('Action failed:', e);
        if (btnEl) btnEl.disabled = false;
      }
    }

    // Event delegation for queue action buttons (avoids inline onclick)
    document.addEventListener('click', function(e) {
      var btn = e.target.closest('.queue-action-btn');
      if (btn) {
        var entryId = parseInt(btn.dataset.entryId, 10);
        var action = btn.dataset.action;
        if (entryId && action) {
          entryAction(entryId, action, btn);
        }
      }
    });

    async function loadQueue() {
      const wire = queueWireSelect.value;
      const minScore = document.getElementById('queueMinScore').value || '40';
      const date = document.getElementById('queueDate').value;

      const params = new URLSearchParams();
      if (wire) params.set('wire', wire);
      params.set('minScore', minScore);
      if (date) params.set('date', date);

      try {
        const response = await fetch('/api/scan/queue?' + params.toString());
        if (!response.ok) throw new Error('Failed to load queue');
        const data = await response.json();

        // Update badge
        if (data.count > 0) {
          queueCountBadge.textContent = data.count + ' new';
          queueCountBadge.style.display = 'inline';
        } else {
          queueCountBadge.style.display = 'none';
        }

        if (data.entries.length === 0) {
          queueResultsEl.innerHTML = '<p style="color: #666;">No entries found for these filters.</p>';
          return;
        }

        let html = '<table><thead><tr><th>Name</th><th>Amount</th><th>Deadline</th><th>Score</th><th>Wire</th><th>Source</th><th>Actions</th></tr></thead><tbody>';
        data.entries.forEach(function(e) {
          const sc = scoreColor(e.quality_score);
          const desc = (e.description || '').length > 80 ? e.description.substring(0, 80) + '...' : (e.description || '');
          html += '<tr id="queue-row-' + e.id + '">';
          html += '<td><div>' + escapeHtml(e.name || '') + '</div>';
          if (desc) html += '<div style="font-size: 11px; color: #888; margin-top: 2px;">' + escapeHtml(desc) + '</div>';
          html += '</td>';
          html += '<td>' + escapeHtml(e.amount || '-') + '</td>';
          html += '<td>' + escapeHtml(e.deadline || '-') + '</td>';
          html += '<td><span style="color: ' + sc + '; font-weight: 600;">' + (e.quality_score != null ? e.quality_score : '-') + '</span></td>';
          html += '<td><code style="background: #0d0d0d; padding: 2px 6px; border-radius: 4px;">' + escapeHtml(e.wire || '') + '</code></td>';
          html += '<td style="white-space: nowrap;">';
          html += sourceBadge(e.scan_source);
          if (e.source_url) {
            html += ' <a href="' + escapeHtml(e.source_url) + '" target="_blank" class="download-link" style="font-size: 12px;">Link</a>';
          }
          html += '</td>';
          html += '<td style="white-space: nowrap;">';
          html += '<button data-entry-id="' + parseInt(e.id) + '" data-action="promote" class="queue-action-btn" style="background: #1b5e20; border: none; color: #4caf50; padding: 5px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; margin-right: 3px;" title="Promote">Promote</button>';
          html += '<button data-entry-id="' + parseInt(e.id) + '" data-action="skip" class="queue-action-btn" style="background: #2a2a2a; border: none; color: #999; padding: 5px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; margin-right: 3px;" title="Skip">Skip</button>';
          html += '<button data-entry-id="' + parseInt(e.id) + '" data-action="archive" class="queue-action-btn" style="background: #4a1515; border: none; color: #ef5350; padding: 5px 8px; border-radius: 4px; cursor: pointer; font-size: 11px;" title="Archive">Archive</button>';
          html += '</td>';
          html += '</tr>';
        });
        html += '</tbody></table>';
        html += '<p style="color: #666; font-size: 12px; margin-top: 8px;">' + data.count + ' entries</p>';

        queueResultsEl.innerHTML = html;
      } catch (error) {
        queueResultsEl.innerHTML = '<p style="color: #ef5350;">Failed to load queue: ' + escapeHtml(error.message) + '</p>';
      }
    }

    // Make entryAction available globally for onclick handlers
    window.entryAction = entryAction;

    loadQueueBtn.addEventListener('click', loadQueue);

    // Prompt Management
    const promptsListEl = document.getElementById('prompts-list');
    const promptForm = document.getElementById('prompt-form');
    const promptEditIdEl = document.getElementById('promptEditId');
    const promptWireSelect = document.getElementById('promptWire');
    const promptLabelInput = document.getElementById('promptLabel');
    const promptSortOrderInput = document.getElementById('promptSortOrder');
    const promptIsActiveSelect = document.getElementById('promptIsActive');
    const promptTextInput = document.getElementById('promptText');
    const promptResponseFormatInput = document.getElementById('promptResponseFormat');
    const savePromptBtn = document.getElementById('save-prompt');
    const cancelPromptBtn = document.getElementById('cancel-prompt');
    const addPromptBtn = document.getElementById('add-prompt');
    const promptTestResultEl = document.getElementById('prompt-test-result');
    let promptsCache = {};

    async function loadPromptFeeds() {
      try {
        const response = await fetch('/api/feeds');
        if (!response.ok) throw new Error('Failed');
        const feeds = await response.json();
        let opts = '';
        feeds.forEach(function(f) {
          opts += '<option value="' + escapeHtml(f.key) + '">' + escapeHtml(f.displayName) + '</option>';
        });
        promptWireSelect.innerHTML = opts;
      } catch (e) {
        console.error('Failed to load prompt feeds:', e);
      }
    }

    loadPromptFeeds();

    async function loadPrompts() {
      try {
        const response = await fetch('/api/scan/prompts');
        if (!response.ok) throw new Error('Failed to fetch prompts');
        const prompts = await response.json();
        promptsCache = {};
        prompts.forEach(function(p) { promptsCache[p.id] = p; });
        renderPromptsList(prompts);
      } catch (error) {
        console.error('Failed to load prompts:', error);
        promptsListEl.innerHTML = '<p style="color: #ef5350;">Failed to load prompts</p>';
      }
    }

    function renderPromptsList(prompts) {
      if (prompts.length === 0) {
        promptsListEl.innerHTML = '<p style="color: #666;">No prompts configured. Click "+ Add Prompt" to create one.</p>';
        return;
      }

      let html = '<table><thead><tr><th>Wire</th><th>Label</th><th>Status</th><th>Order</th><th>Prompt</th><th>Actions</th></tr></thead><tbody>';

      prompts.forEach(function(p) {
        const truncated = (p.promptText || '').length > 80 ? p.promptText.substring(0, 80) + '...' : p.promptText;
        const statusColor = p.isActive ? '#4caf50' : '#666';
        const statusText = p.isActive ? 'Active' : 'Inactive';

        html += '<tr id="prompt-row-' + p.id + '">';
        html += '<td><code style="background: #0d0d0d; padding: 2px 6px; border-radius: 4px;">' + escapeHtml(p.wire) + '</code></td>';
        html += '<td>' + escapeHtml(p.label) + '</td>';
        html += '<td><span style="color: ' + statusColor + ';">' + statusText + '</span></td>';
        html += '<td>' + p.sortOrder + '</td>';
        html += '<td style="font-size: 12px; color: #999; max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">' + escapeHtml(truncated) + '</td>';
        html += '<td style="white-space: nowrap;">';
        html += '<button class="toggle-prompt" data-id="' + p.id + '" data-active="' + p.isActive + '" style="background: #2a2a2a; border: none; color: ' + (p.isActive ? '#f5a623' : '#4caf50') + '; padding: 6px 10px; border-radius: 4px; cursor: pointer; margin-right: 4px; font-size: 12px;">' + (p.isActive ? 'Disable' : 'Enable') + '</button>';
        html += '<button class="test-prompt" data-id="' + p.id + '" style="background: #2a2a2a; border: none; color: #9c27b0; padding: 6px 10px; border-radius: 4px; cursor: pointer; margin-right: 4px; font-size: 12px;">Test</button>';
        html += '<button class="edit-prompt" data-id="' + p.id + '" style="background: #2a2a2a; border: none; color: #f5a623; padding: 6px 10px; border-radius: 4px; cursor: pointer; margin-right: 4px; font-size: 12px;">Edit</button>';
        html += '<button class="delete-prompt" data-id="' + p.id + '" data-label="' + escapeHtml(p.label) + '" style="background: #2a2a2a; border: none; color: #ef5350; padding: 6px 10px; border-radius: 4px; cursor: pointer; font-size: 12px;">Delete</button>';
        html += '</td>';
        html += '</tr>';
        html += '<tr id="prompt-test-row-' + p.id + '" style="display: none;"><td colspan="6" style="padding: 12px; background: #0d0d0d;"><div class="prompt-test-output" style="font-family: monospace; font-size: 12px; white-space: pre-wrap; color: #ccc; max-height: 300px; overflow-y: auto;"></div></td></tr>';
      });

      html += '</tbody></table>';
      promptsListEl.innerHTML = html;

      // Toggle active/inactive
      document.querySelectorAll('.toggle-prompt').forEach(function(btn) {
        btn.addEventListener('click', async function() {
          const id = btn.dataset.id;
          const newActive = btn.dataset.active === 'true' ? false : true;
          btn.disabled = true;
          try {
            const resp = await fetch('/api/scan/prompts/' + id, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ isActive: newActive })
            });
            if (!resp.ok) throw new Error('Failed');
            loadPrompts();
          } catch (e) {
            console.error('Toggle failed:', e);
          } finally {
            btn.disabled = false;
          }
        });
      });

      // Test prompt
      document.querySelectorAll('.test-prompt').forEach(function(btn) {
        btn.addEventListener('click', async function() {
          const id = btn.dataset.id;
          const testRow = document.getElementById('prompt-test-row-' + id);
          const outputEl = testRow.querySelector('.prompt-test-output');

          // Toggle visibility if already showing
          if (testRow.style.display === 'table-row') {
            testRow.style.display = 'none';
            return;
          }

          testRow.style.display = 'table-row';
          outputEl.textContent = 'Running test...';
          outputEl.style.color = '#f5a623';
          btn.disabled = true;
          btn.textContent = 'Running...';

          try {
            const resp = await fetch('/api/scan/prompts/' + id + '/test', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' }
            });
            const data = await resp.json();

            if (data.success) {
              let info = 'Model: ' + escapeHtml(data.model);
              if (data.tokensUsed) info += ' | Tokens: ' + data.tokensUsed;
              outputEl.innerHTML = '<p style="margin: 0 0 8px; color: #4caf50; font-size: 11px;">' + info + '</p>' + escapeHtml(data.content);
              outputEl.style.color = '#ccc';
            } else {
              outputEl.textContent = 'Error: ' + (data.error || 'Unknown error');
              outputEl.style.color = '#ef5350';
            }
          } catch (e) {
            outputEl.textContent = 'Error: ' + e.message;
            outputEl.style.color = '#ef5350';
          } finally {
            btn.disabled = false;
            btn.textContent = 'Test';
          }
        });
      });

      // Edit prompt
      document.querySelectorAll('.edit-prompt').forEach(function(btn) {
        btn.addEventListener('click', function() {
          const id = btn.dataset.id;
          const p = promptsCache[id];
          if (!p) return;
          promptEditIdEl.value = id;
          promptWireSelect.value = p.wire;
          promptLabelInput.value = p.label;
          promptSortOrderInput.value = p.sortOrder;
          promptIsActiveSelect.value = String(p.isActive);
          promptTextInput.value = p.promptText;
          promptResponseFormatInput.value = p.responseFormat || '';
          promptForm.style.display = 'block';
        });
      });

      // Delete prompt
      document.querySelectorAll('.delete-prompt').forEach(function(btn) {
        btn.addEventListener('click', async function() {
          const id = btn.dataset.id;
          const label = btn.dataset.label;
          if (!confirm('Delete prompt "' + label + '"? This cannot be undone.')) return;
          btn.disabled = true;
          try {
            const resp = await fetch('/api/scan/prompts/' + id, { method: 'DELETE' });
            if (!resp.ok) throw new Error('Failed');
            loadPrompts();
          } catch (e) {
            console.error('Delete failed:', e);
          } finally {
            btn.disabled = false;
          }
        });
      });
    }

    loadPrompts();

    addPromptBtn.addEventListener('click', function() {
      promptEditIdEl.value = '';
      promptWireSelect.selectedIndex = 0;
      promptLabelInput.value = '';
      promptSortOrderInput.value = '0';
      promptIsActiveSelect.value = 'true';
      promptTextInput.value = '';
      promptResponseFormatInput.value = '';
      promptForm.style.display = 'block';
    });

    cancelPromptBtn.addEventListener('click', function() {
      promptForm.style.display = 'none';
    });

    savePromptBtn.addEventListener('click', async function() {
      const editId = promptEditIdEl.value;
      const wire = promptWireSelect.value;
      const label = promptLabelInput.value.trim();
      const sortOrder = parseInt(promptSortOrderInput.value) || 0;
      const isActive = promptIsActiveSelect.value === 'true';
      const promptTextVal = promptTextInput.value.trim();
      const responseFormat = promptResponseFormatInput.value.trim();

      if (!wire) { alert('Please select a wire/feed'); return; }
      if (!label) { alert('Label is required'); return; }
      if (!promptTextVal) { alert('Prompt text is required'); return; }

      savePromptBtn.disabled = true;
      savePromptBtn.textContent = 'Saving...';

      try {
        const body = { wire, label, sortOrder, isActive, promptText: promptTextVal, responseFormat: responseFormat || null };
        const url = editId ? '/api/scan/prompts/' + editId : '/api/scan/prompts';
        const method = editId ? 'PUT' : 'POST';

        const resp = await fetch(url, {
          method: method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        if (!resp.ok) {
          const data = await resp.json();
          throw new Error(data.error || 'Failed to save');
        }

        promptForm.style.display = 'none';
        loadPrompts();
      } catch (e) {
        alert('Error: ' + e.message);
      } finally {
        savePromptBtn.disabled = false;
        savePromptBtn.textContent = 'Save Prompt';
      }
    });

    runCrmSyncBtn.addEventListener('click', async () => {
      const lookbackDays = crmLookbackInput.value || 1;
      
      runCrmSyncBtn.disabled = true;
      runCrmSyncBtn.textContent = 'Running...';
      crmResultEl.style.display = 'block';
      crmResultEl.innerHTML = '<p style="margin: 0; color: #f5a623;">Syncing organizations...</p>';

      try {
        const response = await fetch('/api/crm-sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lookbackDays })
        });

        const data = await response.json();

        if (data.success) {
          const p1 = document.createElement('p');
          p1.style.cssText = 'margin: 0; color: #4caf50;';
          p1.textContent = 'Sync complete!';
          const p2 = document.createElement('p');
          p2.style.cssText = 'margin: 8px 0 0; color: #999; font-size: 13px;';
          p2.textContent = 'Entries: ' + data.entriesProcessed + ' | Matched: ' + data.orgsMatched + ' | Created: ' + data.orgsCreated + ' | Skipped: ' + data.orgsSkipped + ' | Duration: ' + (data.duration / 1000).toFixed(1) + 's';
          crmResultEl.innerHTML = '';
          crmResultEl.appendChild(p1);
          crmResultEl.appendChild(p2);
          loadCrmStatus();
        } else {
          const p = document.createElement('p');
          p.style.cssText = 'margin: 0; color: #ef5350;';
          p.textContent = 'Sync failed: ' + (data.error || 'Unknown error');
          crmResultEl.innerHTML = '';
          crmResultEl.appendChild(p);
        }
      } catch (error) {
        const p = document.createElement('p');
        p.style.cssText = 'margin: 0; color: #ef5350;';
        p.textContent = 'Error: ' + error.message;
        crmResultEl.innerHTML = '';
        crmResultEl.appendChild(p);
      } finally {
        runCrmSyncBtn.disabled = false;
        runCrmSyncBtn.textContent = 'Run CRM Sync';
      }
    });

    // ---- Run Scan ----
    const runScanBtn = document.getElementById('run-scan-btn');
    const scanRunWireSelect = document.getElementById('scanRunWire');
    const scanRunProgress = document.getElementById('scan-run-progress');
    const scanRunBar = document.getElementById('scan-run-bar');
    const scanRunStep = document.getElementById('scan-run-step');
    const scanRunResult = document.getElementById('scan-run-result');

    // Populate scan run wire select
    (async function() {
      try {
        const resp = await fetch('/api/feeds');
        if (!resp.ok) return;
        const feeds = await resp.json();
        let opts = '<option value="">All Wires</option>';
        feeds.forEach(function(f) {
          opts += '<option value="' + escapeHtml(f.key) + '">' + escapeHtml(f.displayName) + '</option>';
        });
        scanRunWireSelect.innerHTML = opts;
      } catch (e) { console.error('Failed to load feeds for scan run:', e); }
    })();

    runScanBtn.addEventListener('click', async function() {
      runScanBtn.disabled = true;
      runScanBtn.textContent = 'Starting...';
      scanRunProgress.style.display = 'block';
      scanRunResult.style.display = 'none';
      scanRunBar.style.width = '0%';
      scanRunStep.textContent = 'Initializing...';

      try {
        const body = {};
        if (scanRunWireSelect.value) body.wire = scanRunWireSelect.value;

        const resp = await fetch('/api/scan/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        if (!resp.ok) {
          const data = await resp.json();
          throw new Error(data.error || 'Failed to start scan');
        }

        const { jobId } = await resp.json();
        runScanBtn.textContent = 'Running...';

        // Connect to SSE for progress
        const evtSource = new EventSource('/api/job/' + jobId + '/progress');
        evtSource.onmessage = function(event) {
          try {
            const status = JSON.parse(event.data);
            if (status.progress) {
              const pct = status.progress.total > 0
                ? Math.round((status.progress.current / status.progress.total) * 100)
                : 0;
              scanRunBar.style.width = pct + '%';
              scanRunStep.textContent = status.progress.step || '';
            }
            if (status.status === 'completed') {
              evtSource.close();
              scanRunProgress.style.display = 'none';
              runScanBtn.disabled = false;
              runScanBtn.textContent = 'Run Scan Now';

              const r = status.result;
              if (r) {
                let html = '<p style="color: #4caf50; margin: 0 0 8px; font-weight: 600;">Scan complete!</p>';
                html += '<p style="color: #ccc; margin: 0 0 4px; font-size: 13px;">Prompts: ' + r.promptsExecuted + ' executed';
                if (r.promptsFailed > 0) html += ', <span style="color: #ef5350;">' + r.promptsFailed + ' failed</span>';
                html += ' | Total results: ' + r.totalResults;
                html += ' | Duration: ' + Math.round(r.totalDurationMs / 1000) + 's</p>';
                if (r.intakeSummary) {
                  html += '<p style="color: #999; margin: 4px 0 0; font-size: 13px;">Unique: ' + r.intakeSummary.newUnique + ' | Duplicates: ' + r.intakeSummary.duplicatesFound + ' | High quality: ' + r.intakeSummary.highQualityCount + '</p>';
                }
                if (r.perPrompt && r.perPrompt.length > 0) {
                  html += '<details style="margin-top: 8px;"><summary style="color: #888; cursor: pointer; font-size: 12px;">Per-prompt breakdown</summary><table style="margin-top: 8px;"><thead><tr><th>Wire</th><th>Label</th><th>Results</th><th>Time</th><th>Status</th></tr></thead><tbody>';
                  r.perPrompt.forEach(function(pp) {
                    html += '<tr>';
                    html += '<td><code style="background: #0d0d0d; padding: 2px 6px; border-radius: 4px;">' + escapeHtml(pp.wire) + '</code></td>';
                    html += '<td>' + escapeHtml(pp.label) + '</td>';
                    html += '<td>' + pp.resultCount + '</td>';
                    html += '<td>' + Math.round(pp.durationMs / 1000) + 's</td>';
                    html += '<td style="color: ' + (pp.error ? '#ef5350' : '#4caf50') + ';">' + (pp.error ? escapeHtml(pp.error.substring(0, 60)) : 'OK') + '</td>';
                    html += '</tr>';
                  });
                  html += '</tbody></table></details>';
                }
                scanRunResult.innerHTML = html;
              } else {
                scanRunResult.innerHTML = '<p style="color: #4caf50; margin: 0;">Scan complete!</p>';
              }
              scanRunResult.style.display = 'block';
              // Auto-refresh queue
              loadQueue();
            } else if (status.status === 'failed') {
              evtSource.close();
              scanRunProgress.style.display = 'none';
              runScanBtn.disabled = false;
              runScanBtn.textContent = 'Run Scan Now';
              scanRunResult.innerHTML = '<p style="color: #ef5350; margin: 0;">Scan failed: ' + escapeHtml(status.error || 'Unknown error') + '</p>';
              scanRunResult.style.display = 'block';
            }
          } catch (e) { console.error('SSE parse error:', e); }
        };
        evtSource.onerror = function() {
          evtSource.close();
          runScanBtn.disabled = false;
          runScanBtn.textContent = 'Run Scan Now';
        };
      } catch (error) {
        scanRunProgress.style.display = 'none';
        runScanBtn.disabled = false;
        runScanBtn.textContent = 'Run Scan Now';
        scanRunResult.innerHTML = '<p style="color: #ef5350; margin: 0;">Error: ' + escapeHtml(error.message) + '</p>';
        scanRunResult.style.display = 'block';
      }
    });

    // ---- Prompt Effectiveness Stats ----
    const loadStatsBtn = document.getElementById('load-prompt-stats');
    const statsResultsEl = document.getElementById('prompt-stats-results');
    const statsDaysInput = document.getElementById('statsDays');

    function dupRateColor(rate) {
      if (rate < 0.3) return '#4caf50';
      if (rate < 0.5) return '#f5a623';
      return '#ef5350';
    }

    async function loadPromptStats() {
      const days = statsDaysInput.value || '7';
      try {
        const resp = await fetch('/api/scan/prompt-stats?days=' + days);
        if (!resp.ok) throw new Error('Failed to load stats');
        const data = await resp.json();

        if (!data.prompts || data.prompts.length === 0) {
          statsResultsEl.innerHTML = '<p style="color: #666;">No prompt data found for this period.</p>';
          return;
        }

        let html = '<table><thead><tr><th>Wire</th><th>Label</th><th>Variant</th><th>Total</th><th>Unique</th><th>Dup Rate</th><th>Avg Score</th><th>High Quality</th></tr></thead><tbody>';
        data.prompts.forEach(function(p) {
          const drc = dupRateColor(p.duplicateRate);
          html += '<tr>';
          html += '<td><code style="background: #0d0d0d; padding: 2px 6px; border-radius: 4px;">' + escapeHtml(p.wire) + '</code></td>';
          html += '<td>' + escapeHtml(p.label) + '</td>';
          html += '<td>' + escapeHtml(p.variant || '-') + '</td>';
          html += '<td>' + p.totalResults + '</td>';
          html += '<td>' + p.uniqueResults + '</td>';
          html += '<td style="color: ' + drc + '; font-weight: 600;">' + (p.duplicateRate * 100).toFixed(0) + '%</td>';
          html += '<td style="color: ' + scoreColor(p.avgQualityScore) + ';">' + p.avgQualityScore.toFixed(1) + '</td>';
          html += '<td>' + p.highQualityCount + '</td>';
          html += '</tr>';
        });
        html += '</tbody></table>';

        if (data.overlapStats) {
          const os = data.overlapStats;
          html += '<p style="color: #999; font-size: 13px; margin-top: 12px;">Cross-prompt overlap: <span style="color: ' + dupRateColor(os.overlapRate) + '; font-weight: 600;">' + (os.overlapRate * 100).toFixed(0) + '%</span> (' + os.entriesFoundByMultiple + ' of ' + os.totalUniqueEntries + ' entries found by 2+ prompts)</p>';
        }

        statsResultsEl.innerHTML = html;
      } catch (error) {
        statsResultsEl.innerHTML = '<p style="color: #ef5350;">Failed to load stats: ' + escapeHtml(error.message) + '</p>';
      }
    }

    loadStatsBtn.addEventListener('click', loadPromptStats);
    // Auto-load stats on page load
    loadPromptStats();
  </script>
</body>
</html>
  `.trim();
}

function renderLegacyDownloadPage(filename: string, downloadToken: string): string {
  return renderDownloadPage(filename, downloadToken);
}

function renderDownloadPage(filename: string, downloadToken: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <title>Download - Grant Wire Summarizer</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📡</text></svg>">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d0d0d;
      margin: 0;
      padding: 20px;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      max-width: 500px;
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      padding: 40px;
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.4);
      text-align: center;
    }
    h1 { color: #ffffff; margin-bottom: 8px; font-size: 24px; }
    .filename { color: #f5a623; margin-bottom: 24px; font-family: monospace; }
    .button {
      display: inline-block;
      background: #f5a623;
      color: #0d0d0d;
      padding: 14px 32px;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 600;
      font-size: 16px;
      transition: background 0.2s;
    }
    .button:hover { background: #e6951a; }
    .note { margin-top: 20px; font-size: 14px; color: #666666; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Your file is ready</h1>
    <p class="filename">${escapeHtml(filename)}</p>
    <a href="/download/${encodeURIComponent(downloadToken)}" class="button">Download Markdown</a>
    <p class="note">This is a one-time download link.</p>
  </div>
</body>
</html>
  `.trim();
}

function renderExpiredLinkPage(message: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <title>Link Expired - Grant Wire Summarizer</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📡</text></svg>">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d0d0d;
      margin: 0;
      padding: 20px;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      max-width: 500px;
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      padding: 40px;
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.4);
      text-align: center;
    }
    h1 { color: #ef5350; margin-bottom: 16px; }
    p { color: #999999; margin-bottom: 24px; }
    .button {
      display: inline-block;
      background: #f5a623;
      color: #0d0d0d;
      padding: 12px 24px;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      margin-bottom: 16px;
    }
    .button:hover { background: #e09000; }
    .back {
      display: block;
      margin-top: 16px;
      color: #f5a623;
      text-decoration: none;
    }
    .back:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Link Expired</h1>
    <p>${escapeHtml(message)}</p>
    <form method="POST" action="/resend-link" style="display: inline;">
      <button type="submit" class="button">Resend Download Link</button>
    </form>
    <a href="/" class="back">← Back to login</a>
  </div>
</body>
</html>
  `.trim();
}

function renderResendSuccessPage(): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <title>Link Sent - Grant Wire Summarizer</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📡</text></svg>">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d0d0d;
      margin: 0;
      padding: 20px;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      max-width: 500px;
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      padding: 40px;
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.4);
      text-align: center;
    }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { color: #4caf50; margin-bottom: 16px; }
    p { color: #999999; }
    .back {
      display: inline-block;
      margin-top: 24px;
      color: #f5a623;
      text-decoration: none;
    }
    .back:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">✉️</div>
    <h1>Link Sent!</h1>
    <p>A fresh download link has been sent to your email.<br>Check your inbox and click the new link.</p>
    <a href="/" class="back">← Back to login</a>
  </div>
</body>
</html>
  `.trim();
}

function renderErrorPage(message: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <title>Error - Grant Wire Summarizer</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📡</text></svg>">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d0d0d;
      margin: 0;
      padding: 20px;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      max-width: 500px;
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      padding: 40px;
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.4);
      text-align: center;
    }
    h1 { color: #ef5350; margin-bottom: 16px; }
    p { color: #999999; }
    .back {
      display: inline-block;
      margin-top: 24px;
      color: #f5a623;
      text-decoration: none;
    }
    .back:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Access Error</h1>
    <p>${escapeHtml(message)}</p>
    <a href="/" class="back">← Back to login</a>
  </div>
</body>
</html>
  `.trim();
}

export async function startServer(): Promise<void> {
  // Initialize the scheduler (loads config from database)
  // Wrapped in try-catch so scheduler issues don't prevent server from starting
  try {
    await initScheduler();
    console.log('Scheduler initialized');
  } catch (error) {
    console.error('Scheduler initialization failed (non-fatal):', error);
  }

  // Register Telegram webhook if configured
  if (config.telegram.botToken) {
    try {
      await registerTelegramWebhook();
    } catch (error) {
      console.error('Telegram webhook registration failed (non-fatal):', error);
    }
  } else {
    console.log('[Telegram] Bot token not set, webhook registration skipped');
  }

  const server = app.listen(config.app.port, () => {
    console.log(`Server running on port ${config.app.port}`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[Server] ${signal} received, shutting down gracefully...`);
    stopScheduler();
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
