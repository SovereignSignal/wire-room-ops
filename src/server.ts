import path from 'path';
import express, { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { validateMagicLink, createMagicLink, createDownloadToken, createSessionToken, validateSession, invalidateSession, stopAuthCleanup, ensureSessionsTable } from './services/auth';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { getFile, listFiles } from './services/storage';
import { getAvailableWires, closePool, getAllFeeds, ensureFeedsTable, ensureClassificationColumns, getFeedByKey, createFeed, updateFeed, archiveFeed, getEntryCountsByWire, getAllScanPrompts, getScanPromptById, createScanPrompt, updateScanPrompt, deleteScanPrompt, getStatusCounts, getEntriesByStatus, getSeenUrlStats, getSeenUrlsList } from './db';
import { sendScanDigestEmail, sendResendLinkEmail } from './services/email';
import { StoredFile } from './types';
import { jobQueue } from './services/job-queue';
import { getAllModels } from './services/models';
import { getSchedule, getSchedules, setSchedule, addSchedule, removeSchedule, formatScheduleDescription, getNextRunTime, initScheduler, stopScheduler, ScheduleConfig, sendTestAlert, getSchedulerStatus } from './services/scheduler';
import { buildSubmission, buildBatchSubmission } from './services/intake';
import { runDailyIntake, getDailyQueue, getIntakeStats } from './jobs/daily-intake';
import { getPool, getDistributionConfigs, upsertDistributionConfig, getDistributionLogs, getDistributionStatusBulk, getDistributionStatusForEntries, getDistributionChannels, getDistributionChannelById, createDistributionChannel, updateDistributionChannel, deleteDistributionChannel } from './db';
import { executeScanPrompt } from './services/grok';
import { withRetry } from './services/processor';
import { runScanExecution } from './jobs/scan-execution';
import { runForumScan } from './jobs/forum-scan';
import { syncSummariesToScanEntries, startSummarySync, stopSummarySync } from './jobs/summary-sync';
import { getPromptEffectivenessStats } from './services/scan-stats';
import { distributeEntries, distributeEntry, retryDistribution, generateNewsletterMarkdown, sendTestMessage } from './services/distribution';
import { parseStructuredOutput } from './services/intake';
import { reviewScanPrompt } from './services/anthropic';
import type { RawScanResult, ToolType } from './types/intake';
import { renderLoginPage } from './views/login';
import { renderErrorPage, renderLegacyDownloadPage, renderExpiredLinkPage, renderResendSuccessPage } from './views/error';
import { handleTelegramUpdate, registerIntakeWebhook, cleanupPendingEntries } from './services/telegram-adapter';
import { processRawEntries } from './jobs/process-raw';
import { databaseRouter } from './routes/database';

const app = express();
const privyJwks = jwksClient({
  jwksUri: `https://auth.privy.io/api/v1/apps/${config.privy.appId}/jwks.json`,
  cache: true,
  rateLimit: true,
});

function verifyPrivyToken(token: string): Promise<jwt.JwtPayload> {
  return new Promise((resolve, reject) => {
    jwt.verify(token, (header, callback) => {
      privyJwks.getSigningKey(header.kid, (err, key) => {
        if (err) return callback(err);
        callback(null, key?.getPublicKey());
      });
    }, {
      issuer: 'privy.io',
      audience: config.privy.appId,
    }, (err, decoded) => {
      if (err) return reject(err);
      resolve(decoded as jwt.JwtPayload);
    });
  });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Dev mode: skip auth (set DEV_MODE=true in .env, or auto-detected when Privy credentials are placeholders)
const isDevMode = process.env.DEV_MODE === 'true' || !config.privy.appId || config.privy.appId.includes('placeholder');

// Auth middleware - checks session from HttpOnly cookie only
async function requireAuth(req: Request, res: Response, next: Function): Promise<void> {
  if (isDevMode) return next();
  const session = req.cookies?.session as string;
  if (!session || !(await validateSession(session))) {
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
const rateLimitCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of rateLimitStore.entries()) {
    const recent = timestamps.filter(t => now - t < 15 * 60 * 1000);
    if (recent.length === 0) {
      rateLimitStore.delete(key);
    }
  }
}, 15 * 60 * 1000);
rateLimitCleanupTimer.unref();

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
const FEED_KEY_REGEX = /^[a-z0-9_-]+$/;

function isValidUuid(id: string): boolean {
  return UUID_REGEX.test(id);
}

function isValidFeedKey(key: string): boolean {
  return FEED_KEY_REGEX.test(key);
}

function slugifyFeedKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

async function resolveFeedKey(rawKey: unknown, displayName: string): Promise<{ key: string; autoGenerated: boolean }> {
  if (typeof rawKey === 'string' && rawKey.trim()) {
    const normalizedKey = rawKey.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (normalizedKey !== rawKey.trim()) {
      throw new Error('key must be lowercase alphanumeric (with - or _)');
    }
    if (normalizedKey.length === 0 || normalizedKey.length > 50) {
      throw new Error('key must be between 1 and 50 characters');
    }

    return { key: normalizedKey, autoGenerated: false };
  }

  const baseKey = slugifyFeedKey(displayName).slice(0, 50) || 'feed';
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
    const trimmedBase = baseKey.slice(0, Math.max(1, 50 - suffix.length)).replace(/-+$/g, '') || 'feed';
    const candidate = `${trimmedBase}${suffix}`;
    const existing = await getFeedByKey(candidate);
    if (!existing) {
      return { key: candidate, autoGenerated: true };
    }
  }

  throw new Error('Unable to generate a unique feed key');
}

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

  if (!displayName || typeof displayName !== 'string') {
    res.status(400).json({ error: 'displayName is required' });
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
    const resolvedKey = await resolveFeedKey(key, displayName);
    const existing = await getFeedByKey(resolvedKey.key);
    if (existing) {
      res.status(409).json({ error: resolvedKey.autoGenerated ? 'A similar feed already exists' : 'Feed with this key already exists' });
      return;
    }

    const feed = await createFeed({
      key: resolvedKey.key,
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
    if (error instanceof Error && (error.message === 'key must be lowercase alphanumeric (with - or _)' || error.message === 'key must be between 1 and 50 characters' || error.message === 'Unable to generate a unique feed key')) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error('Failed to create feed:', error);
    res.status(500).json({ error: 'Failed to create feed' });
  }
});

// API: Update feed
app.put('/api/feeds/:key', requireAuth, async (req: Request, res: Response) => {
  const { key } = req.params;
  if (!key || !isValidFeedKey(key)) {
    res.status(400).json({ error: 'Invalid feed key' });
    return;
  }
  const { displayName, titleTemplate, sortOrder, archived } = req.body;

  const updates: { displayName?: string; titleTemplate?: string; sortOrder?: number; archived?: boolean } = {};
  if (displayName !== undefined) updates.displayName = displayName;
  if (titleTemplate !== undefined) updates.titleTemplate = titleTemplate;
  if (typeof sortOrder === 'number') updates.sortOrder = sortOrder;
  if (typeof archived === 'boolean') updates.archived = archived;

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
  if (!key || !isValidFeedKey(key)) {
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
  
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
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
  
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
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
  const { dayOfWeek, hour, minute, lookbackDays, scheduleType, frequencyHours, notifyEmails } = body;
  if (scheduleType && !['scan-execution', 'forum-scan'].includes(scheduleType)) {
    return 'scheduleType must be "scan-execution" or "forum-scan"';
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
  if (typeof frequencyHours === 'number' && (frequencyHours < 1 || frequencyHours > 23)) {
    return 'frequencyHours must be between 1 and 23';
  }
  if (notifyEmails !== undefined && typeof notifyEmails !== 'string') {
    return 'notifyEmails must be a comma-separated string of email addresses';
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

  const { name, enabled, dayOfWeek, hour, minute, lookbackDays, grokModel, anthropicModel, timezone, wire, scheduleType, frequencyHours, notifyEmails } = req.body;

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
  if (typeof frequencyHours === 'number') scheduleData.frequencyHours = frequencyHours;
  if (notifyEmails !== undefined) scheduleData.notifyEmails = notifyEmails || undefined;

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

  const { name, enabled, dayOfWeek, hour, minute, lookbackDays, grokModel, anthropicModel, timezone, wire, scheduleType, frequencyHours, notifyEmails } = req.body;

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
  if (frequencyHours !== undefined) updates.frequencyHours = typeof frequencyHours === 'number' ? frequencyHours : undefined;
  if (notifyEmails !== undefined) updates.notifyEmails = notifyEmails || undefined;

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
  const validationError = validateScheduleParams(req.body);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

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
      WHERE created_at >= NOW() - INTERVAL '7 days'
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
    res.json(prompts);
  } catch (error) {
    console.error('Failed to fetch scan prompts:', error);
    res.status(500).json({ error: 'Failed to fetch scan prompts' });
  }
});

// API: Create scan prompt
app.post('/api/scan/prompts', requireAuth, async (req: Request, res: Response) => {
  const { wire, label, promptText, responseFormat, isActive, sortOrder, toolType, variant } = req.body;

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
  if (toolType && !['x_search', 'web_search'].includes(toolType)) {
    res.status(400).json({ error: 'toolType must be "x_search" or "web_search"' });
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

  const { wire, label, promptText, responseFormat, isActive, sortOrder, toolType, variant } = req.body;
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
    if (!['x_search', 'web_search'].includes(toolType)) {
      res.status(400).json({ error: 'toolType must be "x_search" or "web_search"' });
      return;
    }
    updates.toolType = toolType;
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
  parsedResults?: RawScanResult[];
  testOutput?: string | null;
} {
  return {
    wire: typeof body.wire === 'string' ? body.wire : undefined,
    label: typeof body.label === 'string' ? body.label : undefined,
    promptText: typeof body.promptText === 'string' ? body.promptText.trim() : '',
    responseFormat: typeof body.responseFormat === 'string' ? body.responseFormat : undefined,
    toolType: body.toolType === 'web_search' ? 'web_search' : 'x_search',
    parsedResults: Array.isArray(body.parsedResults) ? body.parsedResults as RawScanResult[] : undefined,
    testOutput: typeof body.testOutput === 'string' ? body.testOutput : undefined,
  };
}

async function executePromptLabTest(input: {
  promptText: string;
  responseFormat?: string | null;
  toolType: ToolType;
}) {
  const result = await withRetry(() => executeScanPrompt(input.promptText, {
    responseFormat: input.responseFormat,
    toolType: input.toolType,
  }));
  const parsedResults = parseStructuredOutput(result.content);
  return {
    success: true,
    content: result.content,
    parsedResults,
    parsedCount: parsedResults.length,
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
    }));
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

// API: Queue action on single entry (approve/decline/reviewlater/restore)
app.post('/api/scan/entries/:id/action', requireAuth, async (req: Request, res: Response) => {
  const entryId = parseInt(req.params.id, 10);
  if (isNaN(entryId)) {
    res.status(400).json({ error: 'Invalid entry ID' });
    return;
  }

  const { action } = req.body;
  const actionMap: Record<string, string> = {
    approve: 'approved',
    decline: 'declined',
    reviewlater: 'skipped',
    restore: 'queued',
  };

  const newStatus = actionMap[action];
  if (!newStatus) {
    res.status(400).json({ error: 'Invalid action. Must be approve, decline, reviewlater, or restore.' });
    return;
  }

  try {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE scan_entries SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id, status, wire`,
      [newStatus, entryId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }

    // Fire-and-forget distribution when an entry is approved — single entry only
    if (action === 'approve') {
      const wire = result.rows[0].wire;
      setImmediate(() => {
        distributeEntry(entryId, wire).catch(err => {
          console.error(`[Distribution] Auto-distribute after approve failed for entry ${entryId}:`, err);
        });
      });
    }

    res.json({ success: true, newStatus });
  } catch (error) {
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

  const { wire } = req.body;
  if (!wire || typeof wire !== 'string') {
    res.status(400).json({ error: 'Missing or invalid wire' });
    return;
  }

  try {
    // Validate against active wires from DB
    const activeWires = await getAvailableWires();
    const validWireKeys = activeWires.map((w: any) => w.key || w);
    if (!validWireKeys.includes(wire)) {
      res.status(400).json({ error: `Invalid wire "${wire}". Must be one of: ${validWireKeys.join(', ')}` });
      return;
    }

    const pool = getPool();
    const result = await pool.query(
      `UPDATE scan_entries SET wire = $1, updated_at = NOW() WHERE id = $2 RETURNING id, wire`,
      [wire, entryId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }

    res.json({ success: true, wire: result.rows[0].wire });
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

    let { entries, total } = await getEntriesByStatus(statuses, { wire, date, promptId, limit, offset });

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

function maskConfig(channel: string, cfg: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg)) {
    // Mask secret-looking keys
    if (['appSecret', 'accessSecret', 'accessToken', 'appKey'].includes(k)) {
      masked[k] = v ? '****' + v.slice(-4) : '';
    } else {
      masked[k] = v;
    }
  }
  return masked;
}

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
    const mergedConfig = { ...(current?.config || {}), ...(configData || {}) };

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
    const markdown = await generateNewsletterMarkdown(wire, displayName);
    res.json({ success: true, markdown });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Distribution] Newsletter generation failed:', error);
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

function maskCredentials(creds: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(creds)) {
    if (['bot_token', 'webhook_url', 'api_key'].includes(k) && v) {
      masked[k] = v.length > 8 ? '****' + v.slice(-4) : '****';
    } else {
      masked[k] = v;
    }
  }
  return masked;
}

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

// Database introspection API
app.use('/api/database', requireAuth, databaseRouter);

// Serve React dashboard (built client)
const clientDist = path.join(__dirname, '../dist/client');
app.use(express.static(clientDist));

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

  // Initialize the scheduler (loads config from database)
  // Wrapped in try-catch so scheduler issues don't prevent server from starting
  try {
    await initScheduler();
    console.log('Scheduler initialized');
  } catch (error) {
    console.error('Scheduler initialization failed (non-fatal):', error);
  }

  // Start the summary sync bridge (tele-sum summaries → approved scan_entries)
  try {
    startSummarySync(getPool(), 15);
  } catch (error) {
    console.error('Summary sync startup failed (non-fatal):', error);
  }

  // Register Telegram intake webhook if configured
  if (config.telegramIntake.botToken) {
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
