import express, { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { validateMagicLink, createMagicLink, createDownloadToken, createSessionToken, validateSession, invalidateSession } from './services/auth';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { getFile, listFiles } from './services/storage';
import { getAvailableWires, closePool, getAllFeeds, getFeedByKey, createFeed, updateFeed, archiveFeed, getEntryCountsByWire, getAllScanPrompts, getScanPromptById, createScanPrompt, updateScanPrompt, deleteScanPrompt, getStatusCounts, getEntriesByStatus, getSeenUrlStats, getSeenUrlsList } from './db';
import { sendScanDigestEmail, sendResendLinkEmail } from './services/email';
import { StoredFile } from './types';
import { jobQueue } from './services/job-queue';
import { getAllModels } from './services/models';
import { getSchedule, getSchedules, setSchedule, addSchedule, removeSchedule, formatScheduleDescription, getNextRunTime, initScheduler, stopScheduler, ScheduleConfig, sendTestAlert, getSchedulerStatus } from './services/scheduler';
import { buildSubmission, buildBatchSubmission } from './services/intake';
import { runDailyIntake, getDailyQueue, getIntakeStats } from './jobs/daily-intake';
import { getPool } from './db';
import { executeScanPrompt } from './services/grok';
import { withRetry } from './services/processor';
import { runScanExecution } from './jobs/scan-execution';
import { runForumScan } from './jobs/forum-scan';
import { getPromptEffectivenessStats } from './services/scan-stats';
import { renderLoginPage } from './views/login';
import { renderSettingsPage } from './views/settings';
import { renderQueuePage } from './views/queue';
import { renderFeedPage } from './views/feed';
import { renderErrorPage, renderLegacyDownloadPage, renderExpiredLinkPage, renderResendSuccessPage } from './views/error';

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
function requireAuth(req: Request, res: Response, next: Function): void {
  if (isDevMode) return next();
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

function isValidUuid(id: string): boolean {
  return UUID_REGEX.test(id);
}

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Landing page - login (dev mode skips straight to first feed)
app.get('/', async (req: Request, res: Response) => {
  const session = req.cookies?.session as string;
  if (isDevMode || (session && validateSession(session))) {
    const returnTo = req.query.returnTo as string;
    if (returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//')) {
      res.redirect(returnTo);
      return;
    }
    try {
      const feeds = await getAllFeeds();
      if (feeds.length > 0) {
        res.redirect(`/feeds/${encodeURIComponent(feeds[0].key)}`);
        return;
      }
    } catch { /* fall through */ }
    res.redirect('/queue');
    return;
  }
  res.send(renderLoginPage());
});

app.get('/logout', (req: Request, res: Response) => {
  const sessionToken = req.cookies?.session as string;
  if (sessionToken) {
    invalidateSession(sessionToken);
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
    const sessionToken = createSessionToken(linkedEmail);
    res.cookie('session', sessionToken, {
      httpOnly: true,
      secure: config.app.url.startsWith('https'),
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000,
    });
    res.json({ ok: true });
  } catch (error) {
    console.error('Privy token verification failed:', error);
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Feed page — the core per-wire dashboard
app.get('/feeds/:key', requireAuth, async (req: Request, res: Response) => {
  try {
    const feedKey = req.params.key;
    const feed = await getFeedByKey(feedKey);
    if (!feed) {
      res.status(404).send(renderErrorPage(`Feed "${feedKey}" not found`));
      return;
    }
    const allFeeds = await getAllFeeds();
    const feedNavs = allFeeds.map(f => ({ key: f.key, displayName: f.displayName }));
    const forumEnabled = config.forum.enabled;
    res.send(renderFeedPage(feedKey, feed.displayName, feedNavs, forumEnabled));
  } catch (error) {
    console.error('Failed to render feed page:', error);
    res.status(500).send(renderErrorPage('Failed to load feed page'));
  }
});

// Dashboard → redirect to first feed
app.get('/dashboard', requireAuth, async (_req: Request, res: Response) => {
  try {
    const feeds = await getAllFeeds();
    if (feeds.length > 0) {
      res.redirect(`/feeds/${encodeURIComponent(feeds[0].key)}`);
    } else {
      res.redirect('/queue');
    }
  } catch {
    res.redirect('/queue');
  }
});

app.get('/queue', requireAuth, async (_req: Request, res: Response) => {
  const allFeeds = await getAllFeeds();
  const feedNavs = allFeeds.map(f => ({ key: f.key, displayName: f.displayName }));
  res.send(renderQueuePage(feedNavs));
});

// Schedules page (formerly Settings)
app.get('/schedules', requireAuth, async (_req: Request, res: Response) => {
  const allFeeds = await getAllFeeds();
  const feedNavs = allFeeds.map(f => ({ key: f.key, displayName: f.displayName }));
  res.send(renderSettingsPage(feedNavs));
});

// Settings → redirect to schedules
app.get('/settings', (_req: Request, res: Response) => {
  res.redirect('/schedules');
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
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
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
      toolType: prompt.toolType,
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
      `UPDATE scan_entries SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id, status`,
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

// API: Scan entries by status (for queue tabs)
app.get('/api/scan/entries', requireAuth, async (req: Request, res: Response) => {
  try {
    const statusParam = (req.query.status as string) || 'queued';
    const statuses = statusParam.split(',').map(s => s.trim()).filter(Boolean);
    const wire = req.query.wire as string | undefined;
    const date = req.query.date as string | undefined;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
      return;
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

    const { entries, total } = await getEntriesByStatus(statuses, { wire, date, limit, offset });

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
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
      return;
    }

    const [counts, urlStats] = await Promise.all([
      getStatusCounts(wire, date),
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

export async function startServer(): Promise<void> {
  // Initialize the scheduler (loads config from database)
  // Wrapped in try-catch so scheduler issues don't prevent server from starting
  try {
    await initScheduler();
    console.log('Scheduler initialized');
  } catch (error) {
    console.error('Scheduler initialization failed (non-fatal):', error);
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
