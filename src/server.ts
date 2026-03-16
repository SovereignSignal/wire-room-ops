import path from 'path';
import express, { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { validateMagicLink, createMagicLink, createDownloadToken, createSessionToken, validateSession, invalidateSession, stopAuthCleanup, ensureSessionsTable } from './services/auth';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { getFile, listFiles } from './services/storage';
import { getAvailableWires, closePool, getAllFeeds, ensureFeedsTable, ensureClassificationColumns, getFeedByKey, createFeed, updateFeed, archiveFeed, getEntryCountsByWire, getAllScanPrompts, getScanPromptById, createScanPrompt, updateScanPrompt, deleteScanPrompt, getStatusCounts, getEntriesByStatus, getSeenUrlStats, getSeenUrlsList } from './db';
import { sendScanDigestEmail, sendResendLinkEmail, sendCsvExportEmail } from './services/email';
import { StoredFile } from './types';
import { jobQueue } from './services/job-queue';
import { getAllModels } from './services/models';
import { getSchedule, getSchedules, setSchedule, addSchedule, removeSchedule, formatScheduleDescription, getNextRunTime, initScheduler, stopScheduler, ScheduleConfig, sendTestAlert, getSchedulerStatus } from './services/scheduler';
import { buildSubmission, buildBatchSubmission } from './services/intake';
import { runDailyIntake, getDailyQueue, getIntakeStats } from './jobs/daily-intake';
import { getPool, getDistributionConfigs, upsertDistributionConfig, getDistributionLogs, getDistributionStatusBulk, getDistributionStatusForEntries, getDistributionChannels, getDistributionChannelById, createDistributionChannel, updateDistributionChannel, deleteDistributionChannel, insertApprovedSummary } from './db';
import { executeScanPrompt } from './services/grok';
import { executePerplexityScan } from './services/perplexity';
import { runOrgExtraction, getOrgProfiles, getOrgById, getEntriesByOrg, ensureOrgProfilesTable, extractOrgFromName, upsertOrgProfile, linkEntryToOrg, findSimilarOrg } from './services/org-extractor';
import { mergeOrgs, archiveOrg } from './services/org-merge';
import { enrichSingleOrg, enrichBatch, computeDerivedFields } from './services/org-enricher';
import { ensureIntegrationConfigTable, getIntegrationConfigs, getIntegrationById, upsertIntegration, updateIntegration, deleteIntegration, validateNotionToken, validateNotionDatabase, syncOrgsToNotion } from './services/notion-sync';
import { withRetry } from './services/processor';
import { runScanExecution } from './jobs/scan-execution';
import { runForumScan } from './jobs/forum-scan';
import { syncSummariesToScanEntries, startSummarySync, stopSummarySync } from './jobs/summary-sync';
import { getPromptEffectivenessStats } from './services/scan-stats';
import { distributeEntries, distributeEntry, retryDistribution, generateNewsletterMarkdown, confirmNewsletterDistribution, sendTestMessage } from './services/distribution';
import { parseStructuredOutput } from './services/intake';
import { reviewScanPrompt } from './services/anthropic';
import type { RawScanResult, ToolType } from './types/intake';
import { renderLoginPage } from './views/login';
import { renderErrorPage, renderLegacyDownloadPage, renderExpiredLinkPage, renderResendSuccessPage } from './views/error';
import { handleTelegramUpdate, registerIntakeWebhook, cleanupPendingEntries } from './services/telegram-adapter';
import { processRawEntries } from './jobs/process-raw';
import { runCsvExport } from './jobs/csv-export';
import { databaseRouter } from './routes/database';
import { runEnrichment } from './jobs/enrichment';
import { validateForApproval } from './services/approval-guard';
import { ensureApiProviderTables, refreshProviderCache, getAllProviders, upsertProvider, testProviderConnection, getCachedProvider } from './services/api-provider';
import { ensureApiUsageTables, getUsageSummary, getUsageTimeline, getRecentUsage, getModelPricing, upsertModelPricing } from './services/api-usage';

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
  if (scheduleType && !['scan-execution', 'forum-scan', 'daily-digest'].includes(scheduleType)) {
    return 'scheduleType must be "scan-execution", "forum-scan", or "daily-digest"';
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

// API: Send actual daily digest now (on-demand)
app.post('/api/digest/send-now', requireAuth, async (req: Request, res: Response) => {
  try {
    const pool = getPool();
    const { runDailyDigest, getTopPendingFinds } = await import('./jobs/daily-digest');
    const { sendDailyDigestEmail } = await import('./services/email');
    const { getSchedules } = await import('./services/scheduler');

    // Get configured recipients from the daily-digest schedule
    const allSchedules = getSchedules();
    const digestSchedule = allSchedules.find(s => s.scheduleType === 'daily-digest');
    const recipients = digestSchedule?.notifyEmails
      ? digestSchedule.notifyEmails.split(',').map(e => e.trim()).filter(Boolean)
      : undefined;

    const digest = await runDailyDigest(pool);
    const topFinds = digest.totalPendingReview > 0 ? await getTopPendingFinds(pool, 5) : [];

    await sendDailyDigestEmail(digest, config.app.url, recipients, topFinds);
    res.json({ success: true, message: `Digest sent to ${recipients?.join(', ') || 'default recipients'}`, stats: { wires: digest.wires.length, pendingReview: digest.totalPendingReview } });
  } catch (error) {
    console.error('[DigestNow] Failed:', error);
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to send digest' });
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

// API: Historical backfill for summary sync (large lookback window)
app.post('/api/admin/summary-sync-backfill', requireAuth, async (req: Request, res: Response) => {
  if (!rateLimit('summary-sync-backfill', 1, 30 * 60 * 1000)) {
    res.status(429).json({ error: 'Backfill recently run. Please wait 30 minutes.' });
    return;
  }

  try {
    const pool = getPool();
    const requestedHours = typeof req.body?.lookbackHours === 'number' ? req.body.lookbackHours : 8760;
    const lookbackHours = Math.min(Math.max(1, requestedHours), 17520); // Cap at 2 years
    console.log(`[SummarySync] Backfill triggered with lookbackHours=${lookbackHours}`);
    const result = await syncSummariesToScanEntries(pool, lookbackHours);
    res.json({ success: true, lookbackHours, ...result });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[SummarySync] Backfill failed:', error);
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
function cleanText(s: string): string {
  return s
    .replace(/\[?\[(\d+)\]\]?\([^)]*\)/g, '') // strip [[N]](url) citation refs
    .replace(/```[\w]*\n?/g, '')               // strip code fences
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function autoSummarizeOnApprove(
  entryId: number,
  summaryId: number | null,
  name: string,
  description: string,
  amount: string | null,
  deadline: string | null,
  sourceUrl: string | null,
  wire?: string
): Promise<void> {
  try {
    const pool = getPool();
    const wireLabel = wire === 'ai' ? 'AI funding' : wire === 'oss' ? 'open-source funding' : 'crypto grants';
    const cleanDesc = cleanText(description);
    const cleanName = cleanText(name);

    const prompt = `You are writing a concise opportunity summary for a ${wireLabel} newsletter.

Grant name: ${cleanName}
${amount ? `Amount: ${amount}` : ''}
${deadline ? `Deadline: ${deadline}` : ''}
${sourceUrl && sourceUrl.startsWith('http') ? `Source: ${sourceUrl}` : ''}
Description: ${cleanDesc}

Write a 2-4 sentence newsletter summary. Lead with the organization/program name and a strong action verb. Include all specific numbers (amounts, dates, eligibility requirements). Plain prose, no bullet points, no fluff, no hype words. Max 120 words.`;

    const response = await fetch(`${config.apis.grok.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apis.grok.apiKey}`,
      },
      body: JSON.stringify({
        model: 'grok-4.20-beta-0309-non-reasoning',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      console.warn(`[AutoSummarize] Grok returned ${response.status} for entry ${entryId}`);
      return;
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const summary = data.choices?.[0]?.message?.content?.trim();
    if (!summary || summary.length < 20) return;

    // Update scan_entries
    await pool.query(
      `UPDATE scan_entries SET enriched_summary = $1, updated_at = NOW() WHERE id = $2`,
      [summary, entryId]
    );

    // Patch the summaries row if we have its ID
    if (summaryId) {
      await pool.query(
        `UPDATE summaries SET summary = $1 WHERE id = $2`,
        [summary, summaryId]
      ).catch(err => console.warn(`[AutoSummarize] Failed to patch summaries row ${summaryId}:`, err.message));
    }

    console.log(`[AutoSummarize] Generated summary for entry ${entryId} (${summary.length} chars)`);
  } catch (err) {
    console.error(`[AutoSummarize] Failed for entry ${entryId}:`, err);
  }
}

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

  const entryIds = ids.map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id));
  if (entryIds.length === 0) {
    res.status(400).json({ error: 'No valid entry IDs provided' });
    return;
  }

  try {
    const pool = getPool();

    // Pre-approval validation gate for bulk approve
    if (action === 'approve') {
      const preCheck = await pool.query(
        `SELECT id, name, description, source_url, classification, quality_score, deadline
         FROM scan_entries WHERE id = ANY($1)`,
        [entryIds]
      );

      const blocked: Array<{ id: number; errors: string[]; warnings: string[] }> = [];
      let passCount = 0;

      for (const row of preCheck.rows) {
        const validation = validateForApproval(row);
        if (!validation.valid) {
          blocked.push({ id: row.id, errors: validation.errors, warnings: validation.warnings });
        } else {
          passCount++;
        }
      }

      if (blocked.length > 0 && req.query.force !== 'true') {
        res.status(422).json({
          error: 'Some entries blocked',
          blocked,
          passCount,
          blockCount: blocked.length,
        });
        return;
      }
    }

    // Bulk update status (+ distributable flag on quiet approve)
    const distributable = quiet ? false : true;
    const result = await pool.query(
      `UPDATE scan_entries SET status = $1, distributable = $2, updated_at = NOW()
       WHERE id = ANY($3)
       RETURNING id, status, wire, name, description, enriched_summary, quality_score, amount, deadline, source_url, org_id, scan_date, tags`,
      [newStatus, distributable, entryIds]
    );

    const updated = result.rows;
    const summaryIds: Record<number, number | null> = {};

    // On bulk approve: write each entry to summaries + fire-and-forget distribution
    if (action === 'approve') {
      for (const row of updated) {
        try {
          const sid = await insertApprovedSummary({
            title: row.name,
            summary: row.enriched_summary || row.description || '',
            wire: row.wire,
            qualityScore: row.quality_score,
            entities: {
              amounts: row.amount ? [row.amount] : [],
              deadlines: row.deadline ? [row.deadline] : [],
              source_url: row.source_url,
              orgs: row.tags || [],
            },
          });
          summaryIds[row.id] = sid;
        } catch (err) {
          console.error(`[BulkApprove] Failed to write summary for entry ${row.id}:`, err);
        }

        // Fire-and-forget distribution per entry (skip if quiet approve)
        if (!quiet) {
          setImmediate(() => {
            distributeEntry(row.id, row.wire).catch(err => {
              console.error(`[Distribution] Auto-distribute after bulk approve failed for entry ${row.id}:`, err);
            });
          });
        }

        // Fire-and-forget auto-summarize if enriched_summary is missing/thin
        if (!row.enriched_summary || row.enriched_summary.length < 60) {
          setImmediate(() => {
            autoSummarizeOnApprove(
              row.id, summaryIds[row.id] ?? null, row.name,
              row.description || '', row.amount, row.deadline, row.source_url, row.wire
            ).catch(err => console.error(`[AutoSummarize] Bulk approve failed for entry ${row.id}:`, err));
          });
        }

        // Fire-and-forget org linking + enrichment (with fuzzy dedup)
        if (!row.org_id) {
          setImmediate(async () => {
            try {
              const orgName = extractOrgFromName(row.name);
              if (!orgName) return;
              // Check for similar existing org before creating new
              const similar = await findSimilarOrg(orgName);
              let orgId: number;
              if (similar) {
                orgId = similar.id;
              } else {
                orgId = await upsertOrgProfile(orgName, row.wire, row.scan_date?.toISOString?.()?.split('T')[0]);
              }
              await linkEntryToOrg(row.id, orgId);
              await enrichSingleOrg(orgId).catch(err =>
                console.error(`[OrgEnrich] Bulk approve failed for entry ${row.id}:`, err)
              );
            } catch (err) {
              console.error(`[OrgLink] Bulk approve failed for entry ${row.id}:`, err);
            }
          });
        }
      }
    }

    res.json({ success: true, updated: updated.length, newStatus, summaryIds });
  } catch (error) {
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

    // Pre-approval validation gate for single approve
    let approvalWarnings: string[] = [];
    if (action === 'approve') {
      const preCheck = await pool.query(
        `SELECT id, name, description, source_url, classification, quality_score, deadline
         FROM scan_entries WHERE id = $1`,
        [entryId]
      );

      if (preCheck.rows.length === 0) {
        res.status(404).json({ error: 'Entry not found' });
        return;
      }

      const validation = validateForApproval(preCheck.rows[0]);
      approvalWarnings = validation.warnings;

      if (!validation.valid && req.query.force !== 'true') {
        res.status(422).json({
          error: 'Approval blocked',
          issues: validation.errors,
          warnings: validation.warnings,
        });
        return;
      }
    }

    const distributable = quiet ? false : true;
    const result = await pool.query(
      `UPDATE scan_entries SET status = $1, distributable = $2, updated_at = NOW() WHERE id = $3
       RETURNING id, status, wire, name, description, enriched_summary, quality_score, amount, deadline, source_url, org_id, scan_date, tags`,
      [newStatus, distributable, entryId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }

    let summaryId: number | null = null;

    // On approve: write to summaries table + fire-and-forget distribution
    if (action === 'approve') {
      const row = result.rows[0];

      // Write-through to summaries (master database)
      try {
        summaryId = await insertApprovedSummary({
          title: row.name,
          summary: row.enriched_summary || row.description || '',
          wire: row.wire,
          qualityScore: row.quality_score,
          entities: {
            amounts: row.amount ? [row.amount] : [],
            deadlines: row.deadline ? [row.deadline] : [],
            source_url: row.source_url,
            orgs: row.tags || [],
          },
        });
      } catch (err) {
        console.error(`[Approve] Failed to write summary for entry ${entryId}:`, err);
      }

      // Fire-and-forget distribution (skip if quiet approve)
      if (!quiet) {
        setImmediate(() => {
          distributeEntry(entryId, row.wire).catch(err => {
            console.error(`[Distribution] Auto-distribute after approve failed for entry ${entryId}:`, err);
          });
        });
      }

      // Fire-and-forget auto-summarize if enriched_summary is missing/thin
      if (!row.enriched_summary || row.enriched_summary.length < 60) {
        setImmediate(() => {
          autoSummarizeOnApprove(
            entryId, summaryId, row.name,
            row.description || '', row.amount, row.deadline, row.source_url, row.wire
          ).catch(err => console.error(`[AutoSummarize] Single approve failed for entry ${entryId}:`, err));
        });
      }

      // Fire-and-forget org linking + enrichment (with fuzzy dedup)
      if (!row.org_id) {
        setImmediate(async () => {
          try {
            const orgName = extractOrgFromName(row.name);
            if (!orgName) return;
            // Check for similar existing org before creating new
            const similar = await findSimilarOrg(orgName);
            let orgId: number;
            if (similar) {
              orgId = similar.id;
            } else {
              orgId = await upsertOrgProfile(orgName, row.wire, row.scan_date?.toISOString?.()?.split('T')[0]);
            }
            await linkEntryToOrg(entryId, orgId);
            await enrichSingleOrg(orgId).catch(err =>
              console.error(`[OrgEnrich] Single approve failed for entry ${entryId}:`, err)
            );
          } catch (err) {
            console.error(`[OrgLink] Single approve failed for entry ${entryId}:`, err);
          }
        });
      }
    }

    const response: Record<string, any> = { success: true, newStatus, summaryId };
    if (approvalWarnings.length > 0) {
      response.warnings = approvalWarnings;
    }
    res.json(response);
  } catch (error) {
    console.error('Failed to update entry status:', error);
    res.status(500).json({ error: 'Failed to update entry' });
  }
});

// ============================================================
// Org Profiles API
// ============================================================

// API: List org profiles
app.get('/api/orgs', requireAuth, async (req: Request, res: Response) => {
  try {
    const wire = req.query.wire as string | undefined;
    const search = req.query.search as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const { orgs, total } = await getOrgProfiles({ wire, search, limit, offset });
    res.json({ orgs, total });
  } catch (err) {
    console.error('[API] Failed to list orgs:', err);
    res.status(500).json({ error: 'Failed to list organizations' });
  }
});

// API: Get single org with linked entries
app.get('/api/orgs/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const orgId = parseInt(req.params.id, 10);
    if (isNaN(orgId)) { res.status(400).json({ error: 'Invalid org ID' }); return; }
    const org = await getOrgById(orgId);
    if (!org) { res.status(404).json({ error: 'Org not found' }); return; }
    const entries = await getEntriesByOrg(orgId);
    res.json({ org, entries });
  } catch (err) {
    console.error('[API] Failed to get org:', err);
    res.status(500).json({ error: 'Failed to get organization' });
  }
});

// API: Run org extraction
app.post('/api/orgs/extract', requireAuth, async (req: Request, res: Response) => {
  try {
    const stats = await runOrgExtraction();
    res.json({ success: true, ...stats });
  } catch (err) {
    console.error('[API] Org extraction failed:', err);
    res.status(500).json({ error: 'Org extraction failed' });
  }
});

// API: Merge two orgs (source into target)
app.post('/api/orgs/merge', requireAuth, async (req: Request, res: Response) => {
  try {
    const { sourceId, targetId } = req.body;
    const sId = parseInt(sourceId, 10);
    const tId = parseInt(targetId, 10);
    if (isNaN(sId) || isNaN(tId)) {
      res.status(400).json({ error: 'sourceId and targetId must be valid integers' });
      return;
    }
    const result = await mergeOrgs(sId, tId);
    res.json({ success: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[API] Org merge failed:', err);
    res.status(500).json({ error: msg });
  }
});

// API: Archive (delete) an org
app.delete('/api/orgs/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const orgId = parseInt(req.params.id, 10);
    if (isNaN(orgId)) { res.status(400).json({ error: 'Invalid org ID' }); return; }
    const result = await archiveOrg(orgId);
    res.json({ success: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[API] Org archive failed:', err);
    res.status(500).json({ error: msg });
  }
});

// ============================================================
// Integrations API (Notion CRM Sync)
// ============================================================

// GET /api/integrations — list all integrations
app.get('/api/integrations', requireAuth, async (req: Request, res: Response) => {
  try {
    const provider = req.query.provider as string | undefined;
    const configs = await getIntegrationConfigs(provider);
    // Mask token
    const masked = configs.map(c => ({
      ...c,
      config: {
        ...c.config,
        notion_token: c.config.notion_token ? '****' + c.config.notion_token.slice(-4) : '',
      },
    }));
    res.json(masked);
  } catch (err) {
    console.error('[API] Failed to list integrations:', err);
    res.status(500).json({ error: 'Failed to list integrations' });
  }
});

// GET /api/integrations/:id — get single integration
app.get('/api/integrations/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const config = await getIntegrationById(id);
    if (!config) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({
      ...config,
      config: {
        ...config.config,
        notion_token: config.config.notion_token ? '****' + config.config.notion_token.slice(-4) : '',
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get integration' });
  }
});

// POST /api/integrations — create integration
app.post('/api/integrations', requireAuth, async (req: Request, res: Response) => {
  try {
    const { provider = 'notion', name, enabled = false, config: configData } = req.body;
    if (!name) { res.status(400).json({ error: 'name is required' }); return; }
    const result = await upsertIntegration(provider, name, enabled, configData || {});
    res.json({
      ...result,
      config: {
        ...result.config,
        notion_token: result.config.notion_token ? '****' + result.config.notion_token.slice(-4) : '',
      },
    });
  } catch (err) {
    console.error('[API] Failed to create integration:', err);
    res.status(500).json({ error: 'Failed to create integration' });
  }
});

// PUT /api/integrations/:id — update integration
app.put('/api/integrations/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { enabled, config: configData } = req.body;

    // Merge config — don't overwrite token if not provided
    const existing = await getIntegrationById(id);
    if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

    const mergedConfig = configData
      ? { ...existing.config, ...configData }
      : undefined;

    // If token is masked, keep the existing one
    if (mergedConfig?.notion_token?.startsWith('****')) {
      mergedConfig.notion_token = existing.config.notion_token;
    }

    const result = await updateIntegration(id, { enabled, config: mergedConfig });
    res.json({
      ...result,
      config: {
        ...result.config,
        notion_token: result.config.notion_token ? '****' + result.config.notion_token.slice(-4) : '',
      },
    });
  } catch (err) {
    console.error('[API] Failed to update integration:', err);
    res.status(500).json({ error: 'Failed to update integration' });
  }
});

// DELETE /api/integrations/:id
app.delete('/api/integrations/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    await deleteIntegration(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete integration' });
  }
});

// POST /api/integrations/:id/validate — validate Notion token + database
app.post('/api/integrations/:id/validate', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const integration = await getIntegrationById(id);
    if (!integration) { res.status(404).json({ error: 'Not found' }); return; }

    const token = integration.config.notion_token;
    if (!token) { res.json({ valid: false, error: 'No token configured' }); return; }

    // Validate token
    const tokenResult = await validateNotionToken(token);
    if (!tokenResult.valid) {
      res.json({ valid: false, error: `Token invalid: ${tokenResult.error}` });
      return;
    }

    // Validate database if configured
    const dbId = integration.config.database_id;
    if (dbId) {
      const dbResult = await validateNotionDatabase(token, dbId);
      if (!dbResult.valid) {
        res.json({ valid: false, error: `Database not accessible: ${dbResult.error}`, workspace: tokenResult.workspace });
        return;
      }
      res.json({
        valid: true,
        workspace: tokenResult.workspace,
        database: dbResult.title,
        properties: dbResult.properties,
      });
    } else {
      res.json({ valid: true, workspace: tokenResult.workspace, database: null });
    }
  } catch (err) {
    res.status(500).json({ error: 'Validation failed' });
  }
});

// POST /api/integrations/:id/sync — trigger CRM sync
app.post('/api/integrations/:id/sync', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const stats = await syncOrgsToNotion(id);
    res.json({ success: true, ...stats });
  } catch (err) {
    console.error('[API] Sync failed:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Sync failed' });
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

// API: Run one-time data cleanup migration
app.post('/api/admin/run-migration', requireAuth, async (_req: Request, res: Response) => {
  if (!rateLimit('admin-migration', 1, 30 * 60 * 1000)) {
    res.status(429).json({ error: 'Migration recently run. Please wait 30 minutes.' });
    return;
  }

  try {
    const { runDataCleanup } = await import('./migrations/cleanup-approved-data');
    const pool = getPool();
    const result = await runDataCleanup(pool);
    res.json(result);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Migration] Data cleanup failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// API: Recover self-duplicated entries (entries where duplicate_of_id = own id)
// This fixes a bug where intake registered entries in seen_urls before processRawEntries ran,
// causing them to match themselves during the second dedup pass.
app.post('/api/admin/recover-self-dupes', requireAuth, async (req: Request, res: Response) => {
  if (!rateLimit('recover-self-dupes', 1, 10 * 60 * 1000)) {
    res.status(429).json({ error: 'Recently run. Please wait 10 minutes.' });
    return;
  }
  try {
    const pool = getPool();
    // Find entries that were marked as duplicates of themselves
    const selfDupes = await pool.query(
      `SELECT id FROM scan_entries WHERE status = 'duplicate' AND duplicate_of_id = id`
    );
    if (selfDupes.rows.length === 0) {
      res.json({ recovered: 0, message: 'No self-duplicated entries found' });
      return;
    }
    const ids = selfDupes.rows.map((r: { id: number }) => r.id);
    // Clean up seen_urls and seen_names so reprocessing doesn't re-duplicate
    await pool.query(`DELETE FROM seen_urls WHERE first_seen_entry_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM seen_names WHERE entry_id = ANY($1)`, [ids]);
    // Reset to raw so processRawEntries can reprocess correctly
    await pool.query(
      `UPDATE scan_entries SET status = 'raw', duplicate_of_id = NULL, duplicate_reason = NULL WHERE id = ANY($1)`,
      [ids]
    );
    console.log(`[Admin] Recovered ${ids.length} self-duplicated entries: ${ids.join(', ')}`);
    res.json({ recovered: ids.length, ids });
  } catch (error) {
    console.error('[Admin] recover-self-dupes error:', error);
    res.status(500).json({ error: 'Recovery failed' });
  }
});

// API: Clean up seen records for archived entries (removes stale dedup blockers)
app.post('/api/admin/clean-stale-seen', requireAuth, async (req: Request, res: Response) => {
  if (!rateLimit('clean-stale-seen', 1, 10 * 60 * 1000)) {
    res.status(429).json({ error: 'Recently run. Please wait 10 minutes.' });
    return;
  }
  try {
    const pool = getPool();
    // Find archived entries that have seen_names/seen_urls records (should never happen with the fix)
    const staleNames = await pool.query(
      `DELETE FROM seen_names WHERE entry_id IN (
        SELECT id FROM scan_entries WHERE status = 'archived'
      ) RETURNING entry_id`
    );
    const staleUrls = await pool.query(
      `DELETE FROM seen_urls WHERE first_seen_entry_id IN (
        SELECT id FROM scan_entries WHERE status = 'archived'
      ) RETURNING first_seen_entry_id`
    );
    const cleanedNames = staleNames.rowCount || 0;
    const cleanedUrls = staleUrls.rowCount || 0;
    console.log(`[Admin] Cleaned stale seen records: ${cleanedNames} names, ${cleanedUrls} urls`);
    res.json({ cleanedNames, cleanedUrls });
  } catch (error) {
    console.error('[Admin] clean-stale-seen error:', error);
    res.status(500).json({ error: 'Cleanup failed' });
  }
});

// API: Purge all entries from a given scan_source (deletes entries + seen records)
app.post('/api/admin/purge-source', requireAuth, async (req: Request, res: Response) => {
  if (!rateLimit('purge-source', 1, 30 * 60 * 1000)) {
    res.status(429).json({ error: 'Recently run. Please wait 30 minutes.' });
    return;
  }

  const { source } = req.body;
  if (!source || typeof source !== 'string') {
    res.status(400).json({ error: 'source is required (e.g. "forum", "telegram")' });
    return;
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    // Find all entry IDs for this source
    const { rows } = await client.query(
      `SELECT id FROM scan_entries WHERE scan_source = $1`,
      [source]
    );
    const ids = rows.map((r: any) => r.id);

    if (ids.length === 0) {
      await client.query('ROLLBACK');
      res.json({ deleted: 0, message: `No entries found with scan_source = '${source}'` });
      return;
    }

    // Clear all FK references before deleting entries
    const { rowCount: seenNames } = await client.query(
      `DELETE FROM seen_names WHERE entry_id = ANY($1)`, [ids]
    );
    const { rowCount: seenUrls } = await client.query(
      `DELETE FROM seen_urls WHERE first_seen_entry_id = ANY($1)`, [ids]
    );
    await client.query(
      `DELETE FROM distribution_logs WHERE entry_id = ANY($1)`, [ids]
    );
    // Clear self-referencing duplicate_of_id pointers
    await client.query(
      `UPDATE scan_entries SET duplicate_of_id = NULL WHERE duplicate_of_id = ANY($1)`, [ids]
    );
    // Delete the entries themselves
    const { rowCount: deleted } = await client.query(
      `DELETE FROM scan_entries WHERE scan_source = $1`, [source]
    );

    await client.query('COMMIT');
    console.log(`[Admin] Purged ${deleted} entries with scan_source='${source}' (${seenNames} seen_names, ${seenUrls} seen_urls)`);
    res.json({ deleted, seenNamesRemoved: seenNames, seenUrlsRemoved: seenUrls });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Admin] purge-source error:', error);
    res.status(500).json({ error: 'Purge failed' });
  } finally {
    client.release();
  }
});

// API: Backfill classification for UNCHECKED entries
app.post('/api/admin/classify-backfill', requireAuth, async (req: Request, res: Response) => {
  if (!rateLimit('classify-backfill', 3, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Backfill recently run. Please wait a few minutes.' });
    return;
  }

  try {
    const pool = getPool();
    const limit = Math.min(Math.max(Number(req.body?.limit) || 50, 1), 200);

    const result = await pool.query(
      `SELECT id, name, description, source_url, wire FROM scan_entries
       WHERE classification = 'UNCHECKED' AND status IN ('queued', 'approved')
       ORDER BY status DESC, created_at DESC
       LIMIT $1`,
      [limit]
    );

    if (result.rows.length === 0) {
      res.json({ processed: 0, classified: 0, errors: 0 });
      return;
    }

    const { classifyBatch } = await import('./services/classifier');
    const stats = await classifyBatch(result.rows, pool);

    res.json({ processed: result.rows.length, ...stats });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[ClassifyBackfill] Failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// API: Backfill entity tags for entries missing them
app.post('/api/admin/tag-backfill', requireAuth, async (req: Request, res: Response) => {
  if (!rateLimit('tag-backfill', 3, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Tag backfill recently run. Please wait a few minutes.' });
    return;
  }

  try {
    const pool = getPool();
    const limit = Math.min(Math.max(Number(req.body?.limit) || 100, 1), 500);

    const result = await pool.query(
      `SELECT id, name, description, wire FROM scan_entries
       WHERE (tags IS NULL OR tags = '{}') AND status IN ('queued', 'approved')
       ORDER BY status DESC, created_at DESC
       LIMIT $1`,
      [limit]
    );

    if (result.rows.length === 0) {
      res.json({ processed: 0, tagged: 0, errors: 0 });
      return;
    }

    const { tagBatch } = await import('./services/classifier');
    const stats = await tagBatch(result.rows, pool);

    res.json({ processed: result.rows.length, ...stats });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[TagBackfill] Failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// API: One-time org_profiles cleanup (remove bad data)
app.post('/api/admin/clean-orgs', requireAuth, async (_req: Request, res: Response) => {
  if (!rateLimit('clean-orgs', 1, 30 * 60 * 1000)) {
    res.status(429).json({ error: 'Cleanup recently run. Please wait 30 minutes.' });
    return;
  }

  try {
    const { runOrgCleanup } = await import('./migrations/cleanup-org-profiles');
    const pool = getPool();
    const result = await runOrgCleanup(pool);
    res.json(result);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Admin] Org cleanup failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// API: LLM-powered org deduplication
app.post('/api/admin/dedup-orgs', requireAuth, async (_req: Request, res: Response) => {
  if (!rateLimit('dedup-orgs', 1, 30 * 60 * 1000)) {
    res.status(429).json({ error: 'Dedup recently run. Please wait 30 minutes.' });
    return;
  }

  try {
    const { runOrgDedup } = await import('./migrations/dedup-org-profiles');
    const pool = getPool();
    const result = await runOrgDedup(pool);
    res.json(result);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Admin] Org dedup failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// API: Batch-enrich org profiles via LLM
app.post('/api/admin/enrich-orgs', requireAuth, async (req: Request, res: Response) => {
  if (!rateLimit('enrich-orgs', 1, 10 * 60 * 1000)) {
    res.status(429).json({ error: 'Enrichment recently run. Please wait 10 minutes.' });
    return;
  }

  try {
    const limit = Math.min(Math.max(Number(req.body?.limit) || 50, 1), 200);
    const force = req.body?.force === true;
    const result = await enrichBatch({ force, limit });
    // Also recompute derived fields after enrichment
    const derived = await computeDerivedFields();
    res.json({ ...result, derivedFieldsUpdated: derived.updated });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Admin] Org enrichment failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// --- CSV Export ---

// GET /api/export/csv — direct CSV file download
app.get('/api/export/csv', requireAuth, async (req: Request, res: Response) => {
  const hoursBack = Math.min(168, Math.max(1, parseInt(req.query.hoursBack as string, 10) || 24));

  if (!rateLimit('export-csv-download', 5, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Export recently generated. Please wait a few minutes.' });
    return;
  }

  try {
    const pool = getPool();
    const result = await runCsvExport(pool, hoursBack);
    if (result.entryCount === 0) {
      res.status(200).json({ success: true, message: 'No approved entries in the specified timeframe', entryCount: 0 });
      return;
    }
    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="wireops-export-${dateStr}.csv"`);
    res.send(result.csvContent);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Export] CSV download failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// POST /api/export/csv — generate + email CSV export on demand
app.post('/api/export/csv', requireAuth, async (req: Request, res: Response) => {
  const hoursBack = Math.min(168, Math.max(1, parseInt(req.body?.hoursBack, 10) || 24));

  if (!rateLimit('export-csv-email', 3, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Export email recently sent. Please wait a few minutes.' });
    return;
  }

  try {
    const pool = getPool();
    const result = await runCsvExport(pool, hoursBack);
    if (result.entryCount === 0) {
      res.json({ success: true, message: 'No approved entries in the specified timeframe', entryCount: 0 });
      return;
    }

    // Build download link
    const downloadUrl = result.fileId
      ? createMagicLink(config.email.notificationEmail, result.fileId)
      : null;

    // Resolve recipients from any daily-digest schedule's notifyEmails
    let recipients: string[] | undefined;
    try {
      const schedules = await getSchedules();
      const digestSchedule = schedules.find(s => s.scheduleType === 'daily-digest');
      if (digestSchedule?.notifyEmails) {
        recipients = digestSchedule.notifyEmails.split(',').map(e => e.trim()).filter(Boolean);
      }
    } catch { /* fall back to default notification email */ }

    await sendCsvExportEmail(result, downloadUrl, recipients);
    res.json({ success: true, entryCount: result.entryCount, wires: result.wires });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Export] CSV email failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// --- API Providers ---

const KNOWN_PROVIDERS = new Set(['grok', 'anthropic', 'firecrawl', 'perplexity', 'resend', 'telegram', 'telegram-intake']);

// GET /api/providers — list all providers (masked keys)
app.get('/api/providers', requireAuth, async (_req: Request, res: Response) => {
  try {
    const providers = await getAllProviders();
    const masked = providers.map(p => ({
      ...p,
      api_key: p.api_key ? (p.api_key.length > 8 ? '****' + p.api_key.slice(-4) : '****') : '',
    }));
    res.json(masked);
  } catch (error) {
    console.error('[Providers] Failed to list:', error);
    res.status(500).json({ error: 'Failed to list providers' });
  }
});

// PUT /api/providers/:provider — upsert provider config
app.put('/api/providers/:provider', requireAuth, async (req: Request, res: Response) => {
  const { provider } = req.params;
  if (!KNOWN_PROVIDERS.has(provider)) {
    res.status(400).json({ error: `Unknown provider: ${provider}` });
    return;
  }
  const { api_key, base_url, default_model, enabled, display_name } = req.body;

  // Skip masked values (user didn't change the key)
  const cleanKey = api_key && typeof api_key === 'string' && api_key.startsWith('****') ? undefined : api_key;

  try {
    const result = await upsertProvider(provider, {
      api_key: cleanKey,
      base_url,
      default_model,
      enabled,
      display_name,
    });
    res.json({
      ...result,
      api_key: result.api_key ? (result.api_key.length > 8 ? '****' + result.api_key.slice(-4) : '****') : '',
    });
  } catch (error) {
    console.error('[Providers] Failed to upsert:', error);
    res.status(500).json({ error: 'Failed to update provider' });
  }
});

// POST /api/providers/:provider/test — test connection
app.post('/api/providers/:provider/test', requireAuth, async (req: Request, res: Response) => {
  if (!KNOWN_PROVIDERS.has(req.params.provider)) {
    res.status(400).json({ success: false, error: `Unknown provider: ${req.params.provider}` });
    return;
  }
  try {
    const result = await testProviderConnection(req.params.provider);
    res.json(result);
  } catch (error) {
    console.error('[Providers] Test failed:', error);
    res.status(500).json({ success: false, error: 'Test request failed' });
  }
});

// --- API Usage ---

// GET /api/usage/summary — aggregated usage
app.get('/api/usage/summary', requireAuth, async (req: Request, res: Response) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
    const rows = await getUsageSummary({
      days,
      provider: req.query.provider as string | undefined,
      purpose: req.query.purpose as string | undefined,
      wire: req.query.wire as string | undefined,
    });
    res.json(rows);
  } catch (error) {
    console.error('[Usage] Summary failed:', error);
    res.status(500).json({ error: 'Failed to fetch usage summary' });
  }
});

// GET /api/usage/timeline — daily rollup for charts
app.get('/api/usage/timeline', requireAuth, async (req: Request, res: Response) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90);
    const rows = await getUsageTimeline({
      days,
      provider: req.query.provider as string | undefined,
      granularity: req.query.granularity === 'hour' ? 'hour' : 'day',
    });
    res.json(rows);
  } catch (error) {
    console.error('[Usage] Timeline failed:', error);
    res.status(500).json({ error: 'Failed to fetch usage timeline' });
  }
});

// GET /api/usage/recent — last N raw log entries
app.get('/api/usage/recent', requireAuth, async (req: Request, res: Response) => {
  try {
    const rows = await getRecentUsage({
      limit: Number(req.query.limit) || 50,
      provider: req.query.provider as string | undefined,
    });
    res.json(rows);
  } catch (error) {
    console.error('[Usage] Recent failed:', error);
    res.status(500).json({ error: 'Failed to fetch recent usage' });
  }
});

// --- Model Pricing ---

// GET /api/pricing — list all model pricing
app.get('/api/pricing', requireAuth, async (_req: Request, res: Response) => {
  try {
    const rows = await getModelPricing();
    res.json(rows);
  } catch (error) {
    console.error('[Pricing] Failed to list:', error);
    res.status(500).json({ error: 'Failed to fetch pricing' });
  }
});

// PUT /api/pricing/:provider/:model — update pricing for a model
app.put('/api/pricing/:provider/:model', requireAuth, async (req: Request, res: Response) => {
  const { provider, model } = req.params;
  const { input_cost_per_1m, output_cost_per_1m, per_request_cost } = req.body;

  try {
    const result = await upsertModelPricing(provider, model, {
      input_cost_per_1m,
      output_cost_per_1m,
      per_request_cost,
    });
    res.json(result);
  } catch (error) {
    console.error('[Pricing] Failed to update:', error);
    res.status(500).json({ error: 'Failed to update pricing' });
  }
});

// Database introspection API
app.use('/api/database', requireAuth, databaseRouter);

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
