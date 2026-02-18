import express, { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { validateMagicLink, createDownloadToken, createSessionToken, validateSession, createLoginMagicLink } from './services/auth';
import { getFile, listFiles } from './services/storage';
import { getAvailableWires, closePool } from './db';
import { sendLoginEmail } from './services/email';
import { runWeeklySummaryJob } from './jobs/weekly-summary';
import { StoredFile } from './types';
import { jobQueue } from './services/job-queue';
import { getAllModels } from './services/models';
import { getSchedule, getSchedules, setSchedule, addSchedule, removeSchedule, formatScheduleDescription, getNextRunTime, initScheduler, stopScheduler, ScheduleConfig, sendTestAlert, getSchedulerStatus } from './services/scheduler';
import { runCrmSyncJob, getStagingOrgs, CrmSyncJobResult } from './services/crm-sync';
import { isStagingConfigured } from './services/notion';

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// HTML escaping to prevent XSS
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Auth middleware - checks session from HttpOnly cookie (with POST body fallback)
function requireAuth(req: Request, res: Response, next: Function): void {
  const session = (req.cookies?.session || req.body?.session) as string;
  if (!session || !validateSession(session)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// Simple in-memory rate limiter
const rateLimitStore = new Map<string, number[]>();

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

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
    secure: config.app.port !== 3000,
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

// Trigger job manually (async with job queue)
app.post('/api/run-job', requireAuth, async (req: Request, res: Response) => {
  if (!rateLimit('run-job', 3, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Too many job requests. Please wait before trying again.' });
    return;
  }

  // Parse date range from request
  const { startDate, endDate, grokModel, anthropicModel, wire } = req.body;
  let dateRange: { start: Date; end: Date } | undefined;

  if (startDate && endDate) {
    dateRange = {
      start: new Date(startDate),
      end: new Date(endDate),
    };
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
      jobQueue.cleanup();
    }
  })().catch(error => {
    console.error('Unexpected error in job runner:', error);
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

  // Subscribe to job updates
  const unsubscribe = jobQueue.subscribe(jobId, (status) => {
    res.write(`data: ${JSON.stringify(status)}\n\n`);

    // Close connection when job is complete or failed
    if (status.status === 'completed' || status.status === 'failed') {
      setTimeout(() => {
        res.end();
      }, 100);
    }
  });

  // Clean up on client disconnect
  req.on('close', () => {
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
// Rate-limited since it triggers email sends and is accessible without auth
// (called from expired download link pages)
app.post('/resend-link', async (req: Request, res: Response) => {
  const clientIp = req.ip || 'unknown';
  if (!rateLimit(`resend:${clientIp}`, 3, 15 * 60 * 1000)) {
    res.status(429).send(renderErrorPage('Too many requests. Please try again later.'));
    return;
  }

  try {
    const files = await listFiles();
    
    if (files.length === 0) {
      res.send(renderErrorPage('No files available. Please run the job first.'));
      return;
    }
    
    // Get the most recent file
    const latestFile = files[0];
    
    // Create a new magic link and send email
    const { createMagicLink } = require('./services/auth');
    const { sendResendLinkEmail } = require('./services/email');
    
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
  const { dayOfWeek, hour, minute, lookbackDays } = body;
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

  const { name, enabled, dayOfWeek, hour, minute, lookbackDays, grokModel, anthropicModel, timezone, wire } = req.body;

  const scheduleData: Partial<Omit<ScheduleConfig, 'id'>> = {};

  if (name) scheduleData.name = name;
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

  const validationError = validateScheduleParams(req.body);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const { name, enabled, dayOfWeek, hour, minute, lookbackDays, grokModel, anthropicModel, timezone, wire } = req.body;

  const updates: Partial<Omit<ScheduleConfig, 'id'>> = {};

  if (name !== undefined) updates.name = name;
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

  const { name, enabled, dayOfWeek, hour, minute, lookbackDays, grokModel, anthropicModel, timezone, wire } = req.body;

  const updates: Partial<Omit<ScheduleConfig, 'id'>> = {};

  if (name !== undefined) updates.name = name;
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
            <label for="scheduleEnabled">Status</label>
            <select id="scheduleEnabled">
              <option value="false">Disabled</option>
              <option value="true">Enabled</option>
            </select>
          </div>
          <div class="form-group">
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

    // Fetch and populate wires/feeds on page load
    const wireFilterSelect = document.getElementById('wireFilter');
    
    async function loadWires() {
      try {
        const response = await fetch('/api/wires');
        if (!response.ok) throw new Error('Failed to fetch wires');
        const wires = await response.json();

        // Build options: "All Feeds" first, then each wire
        let options = '<option value="">All Feeds</option>';
        wires.forEach(w => {
          options += '<option value="' + escapeHtml(w.wire) + '">' + escapeHtml(w.displayName) + ' (' + w.entryCount + ' entries)</option>';
        });
        wireFilterSelect.innerHTML = options;
      } catch (error) {
        console.error('Failed to load wires:', error);
        wireFilterSelect.innerHTML = '<option value="">All Feeds</option>';
      }
    }

    loadWires();

    // Schedule management
    const schedulesListEl = document.getElementById('schedules-list');
    const scheduleForm = document.getElementById('schedule-form');
    const scheduleId = document.getElementById('scheduleId');
    const scheduleName = document.getElementById('scheduleName');
    const scheduleEnabled = document.getElementById('scheduleEnabled');
    const scheduleDayOfWeek = document.getElementById('scheduleDayOfWeek');
    const scheduleTime = document.getElementById('scheduleTime');
    const scheduleLookback = document.getElementById('scheduleLookback');
    const scheduleGrokModel = document.getElementById('scheduleGrokModel');
    const scheduleAnthropicModel = document.getElementById('scheduleAnthropicModel');
    const scheduleWire = document.getElementById('scheduleWire');
    const scheduleTimezone = document.getElementById('scheduleTimezone');
    const saveScheduleBtn = document.getElementById('save-schedule');
    const cancelScheduleBtn = document.getElementById('cancel-schedule');
    const addScheduleBtn = document.getElementById('add-schedule');
    
    let cachedWires = [];
    let cachedModels = { grok: [], anthropic: [] };

    async function loadSchedules() {
      try {
        // Load wires and models first
        const [wiresRes, modelsRes, schedulesRes] = await Promise.all([
          fetch('/api/wires'),
          fetch('/api/models'),
          fetch('/api/schedules')
        ]);
        
        if (wiresRes.ok) cachedWires = await wiresRes.json();
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
      
      let html = '<table><thead><tr><th>Name</th><th>Schedule</th><th>Feed</th><th>Status</th><th>Next Run</th><th>Actions</th></tr></thead><tbody>';
      
      schedules.forEach(s => {
        const day = dayNames[s.dayOfWeek];
        const hour12 = s.hour % 12 || 12;
        const ampm = s.hour >= 12 ? 'PM' : 'AM';
        const time = hour12 + ':' + s.minute.toString().padStart(2, '0') + ' ' + ampm;
        const feed = s.wire ? s.wire.toUpperCase() : 'All';
        const status = s.enabled ? '<span style="color: #4caf50;">Enabled</span>' : '<span style="color: #666;">Disabled</span>';
        const tz = s.timezone || 'America/Los_Angeles';
        const tzShort = tz.split('/').pop().replace('_', ' ');
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
        html += '<td>' + day + ' @ ' + time + ' <span style="color: #666; font-size: 11px;">(' + escapeHtml(tzShort) + ')</span></td>';
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
      // Wires
      let wireOptions = '<option value="">All Feeds</option>';
      cachedWires.forEach(w => {
        const selected = schedule && w.wire === schedule.wire ? ' selected' : '';
        wireOptions += '<option value="' + escapeHtml(w.wire) + '"' + selected + '>' + escapeHtml(w.displayName) + '</option>';
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
        scheduleEnabled.value = schedule.enabled.toString();
        scheduleDayOfWeek.value = schedule.dayOfWeek.toString();
        scheduleTime.value = schedule.hour.toString().padStart(2, '0') + ':' + schedule.minute.toString().padStart(2, '0');
        scheduleLookback.value = schedule.lookbackDays;
        scheduleTimezone.value = schedule.timezone || 'America/Los_Angeles';
      } else {
        scheduleId.value = '';
        scheduleName.value = 'New Schedule';
        scheduleEnabled.value = 'false';
        scheduleDayOfWeek.value = '3';
        scheduleTime.value = '09:00';
        scheduleLookback.value = '7';
        scheduleTimezone.value = 'America/Los_Angeles';
      }
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

        // Scheduler running status
        if (status.isRunning) {
          schedulerRunningEl.textContent = 'Active';
          schedulerRunningEl.className = 'value success';
        } else if (status.config.enabled) {
          schedulerRunningEl.textContent = 'Not Running (restart needed)';
          schedulerRunningEl.className = 'value error';
        } else {
          schedulerRunningEl.textContent = 'Disabled';
          schedulerRunningEl.className = 'value muted';
        }

        // Server started time
        if (status.schedulerStartedAt) {
          const startedAt = formatRelativeTime(status.schedulerStartedAt);
          schedulerStartedEl.textContent = startedAt;
          schedulerStartedEl.className = 'value';
        } else {
          schedulerStartedEl.textContent = 'Not started';
          schedulerStartedEl.className = 'value muted';
        }

        // Last job run
        if (status.lastJobRun) {
          const lastRun = formatRelativeTime(status.lastJobRun);
          lastJobRunEl.textContent = lastRun;
          lastJobRunEl.className = 'value';
        } else {
          lastJobRunEl.textContent = 'Never';
          lastJobRunEl.className = 'value muted';
        }

        // Last job status
        if (status.lastJobStatus === 'success') {
          lastJobStatusEl.textContent = 'Success';
          lastJobStatusEl.className = 'value success';
          lastJobErrorEl.style.display = 'none';
        } else if (status.lastJobStatus === 'failed') {
          lastJobStatusEl.textContent = 'Failed';
          lastJobStatusEl.className = 'value error';
          if (status.lastJobError) {
            lastJobErrorEl.textContent = status.lastJobError;
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
