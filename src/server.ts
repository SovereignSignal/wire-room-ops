import express, { Request, Response } from 'express';
import { config } from './config';
import { validateMagicLink, createDownloadToken, createSessionToken, validateSession, createLoginMagicLink } from './services/auth';
import { getFile, listFiles } from './services/storage';
import { sendLoginEmail } from './services/email';
import { runWeeklySummaryJob } from './jobs/weekly-summary';
import { StoredFile } from './types';
import { jobQueue } from './services/job-queue';
import { getAllModels } from './services/models';
import { getSchedule, setSchedule, formatScheduleDescription, getNextRunTime, initScheduler, ScheduleConfig, sendTestAlert, getSchedulerStatus } from './services/scheduler';

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Landing page - login form
app.get('/', (req: Request, res: Response) => {
  const session = req.query.session as string;
  if (session && validateSession(session)) {
    res.redirect(`/dashboard?session=${session}`);
    return;
  }
  res.send(renderLoginPage());
});

// Handle login request - send magic link
app.post('/login', async (req: Request, res: Response) => {
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

// Magic link auth - creates session and redirects to dashboard
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
  res.redirect(`/dashboard?session=${sessionToken}`);
});

// Dashboard - main interface
app.get('/dashboard', (req: Request, res: Response) => {
  const session = req.query.session as string;
  
  if (!session || !validateSession(session)) {
    res.redirect('/');
    return;
  }
  
  const files = listFiles();
  const message = req.query.message as string;
  res.send(renderDashboard(files, session, message));
});

// API: Get available models
app.get('/api/models', async (req: Request, res: Response) => {
  const session = req.query.session as string;

  if (!session || !validateSession(session)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const models = await getAllModels();
    res.json(models);
  } catch (error) {
    console.error('Failed to fetch models:', error);
    res.status(500).json({ error: 'Failed to fetch models' });
  }
});

// Trigger job manually (async with job queue)
app.post('/api/run-job', async (req: Request, res: Response) => {
  const session = req.body.session;

  if (!session || !validateSession(session)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // Parse date range from request
  const { startDate, endDate, grokModel, anthropicModel } = req.body;
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
        onProgress: (current, total, step) => {
          jobQueue.updateProgress(jobId, { current, total, step });
        },
      });

      jobQueue.completeJob(jobId, result);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      jobQueue.failJob(jobId, errorMsg);
    }

    jobQueue.cleanup();
  })();
});

// SSE endpoint for job progress
app.get('/api/job/:jobId/progress', (req: Request, res: Response) => {
  const session = req.query.session as string;

  if (!session || !validateSession(session)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

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
app.get('/file/:fileId', (req: Request, res: Response) => {
  const session = req.query.session as string;
  const fileId = req.params.fileId;
  
  if (!session || !validateSession(session)) {
    res.redirect('/');
    return;
  }
  
  const file = getFile(fileId);
  
  if (!file) {
    res.status(404).send(renderErrorPage('File not found'));
    return;
  }
  
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.send(file.content);
});

// Legacy download endpoint for email links
app.get('/download', (req: Request, res: Response) => {
  const token = req.query.token as string;
  
  if (!token) {
    res.redirect('/');
    return;
  }
  
  const validation = validateMagicLink(token);
  
  if (!validation.valid || !validation.fileId) {
    res.send(renderErrorPage(validation.error || 'Invalid link'));
    return;
  }
  
  const file = getFile(validation.fileId);
  
  if (!file) {
    res.status(404).send(renderErrorPage('File not found'));
    return;
  }
  
  const downloadToken = createDownloadToken(validation.fileId);
  res.send(renderLegacyDownloadPage(file.filename, downloadToken));
});

// Legacy file download
app.get('/download/:token', (req: Request, res: Response) => {
  const token = req.params.token;
  const validation = validateMagicLink(token);
  
  if (!validation.valid || !validation.fileId) {
    res.status(401).send(renderErrorPage(validation.error || 'Invalid or expired download link'));
    return;
  }
  
  const file = getFile(validation.fileId);
  
  if (!file) {
    res.status(404).send(renderErrorPage('File not found'));
    return;
  }
  
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.send(file.content);
});

// API: List files
app.get('/api/files', (req: Request, res: Response) => {
  const session = req.query.session as string;

  if (!session || !validateSession(session)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const files = listFiles();
  res.json(files.map(f => ({
    id: f.id,
    filename: f.filename,
    createdAt: f.createdAt,
    dateRange: f.dateRange,
  })));
});

// API: Get schedule
app.get('/api/schedule', (req: Request, res: Response) => {
  const session = req.query.session as string;

  if (!session || !validateSession(session)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const schedule = getSchedule();
  const nextRun = getNextRunTime();
  const description = formatScheduleDescription(schedule);

  res.json({
    ...schedule,
    description,
    nextRun: nextRun?.toISOString() || null,
  });
});

// API: Update schedule
app.post('/api/schedule', async (req: Request, res: Response) => {
  const session = req.body.session;

  if (!session || !validateSession(session)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { enabled, dayOfWeek, hour, minute, lookbackDays, grokModel, anthropicModel, timezone } = req.body;

  const updates: Partial<ScheduleConfig> = {};

  if (typeof enabled === 'boolean') updates.enabled = enabled;
  if (typeof dayOfWeek === 'number') updates.dayOfWeek = dayOfWeek;
  if (typeof hour === 'number') updates.hour = hour;
  if (typeof minute === 'number') updates.minute = minute;
  if (typeof lookbackDays === 'number') updates.lookbackDays = lookbackDays;
  if (grokModel) updates.grokModel = grokModel;
  if (anthropicModel) updates.anthropicModel = anthropicModel;
  if (timezone) updates.timezone = timezone;

  try {
    const newSchedule = await setSchedule(updates);
    const nextRun = getNextRunTime();
    const description = formatScheduleDescription(newSchedule);

    res.json({
      ...newSchedule,
      description,
      nextRun: nextRun?.toISOString() || null,
    });
  } catch (error) {
    console.error('Failed to update schedule:', error);
    res.status(500).json({ error: 'Failed to update schedule' });
  }
});

// API: Send test alert to verify email configuration
app.post('/api/test-alert', async (req: Request, res: Response) => {
  const session = req.body.session;

  if (!session || !validateSession(session)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

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
app.get('/api/scheduler-status', (req: Request, res: Response) => {
  const session = req.query.session as string;

  if (!session || !validateSession(session)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const status = getSchedulerStatus();
  res.json(status);
});

function renderLoginPage(error?: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <title>Sign In - CryptoGrantWire</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cellipse cx='50' cy='35' rx='35' ry='20' fill='none' stroke='%23f5a623' stroke-width='6'/%3E%3Cellipse cx='50' cy='35' rx='20' ry='12' fill='none' stroke='%23f5a623' stroke-width='4'/%3E%3Ccircle cx='50' cy='35' r='6' fill='%23f5a623'/%3E%3Cline x1='50' y1='45' x2='50' y2='85' stroke='%23f5a623' stroke-width='6' stroke-linecap='round'/%3E%3Cline x1='35' y1='90' x2='65' y2='90' stroke='%23f5a623' stroke-width='6' stroke-linecap='round'/%3E%3C/svg%3E">
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
    <h1 class="logo"><span class="logo-crypto">Crypto</span><span class="logo-grant">Grant</span><span class="logo-wire">Wire</span></h1>
    <p class="subtitle">Sign in to access your dashboard</p>
    ${error ? `<div class="error">${error}</div>` : ''}
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
  <title>Check Your Email - CryptoGrantWire</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cellipse cx='50' cy='35' rx='35' ry='20' fill='none' stroke='%23f5a623' stroke-width='6'/%3E%3Cellipse cx='50' cy='35' rx='20' ry='12' fill='none' stroke='%23f5a623' stroke-width='4'/%3E%3Ccircle cx='50' cy='35' r='6' fill='%23f5a623'/%3E%3Cline x1='50' y1='45' x2='50' y2='85' stroke='%23f5a623' stroke-width='6' stroke-linecap='round'/%3E%3Cline x1='35' y1='90' x2='65' y2='90' stroke='%23f5a623' stroke-width='6' stroke-linecap='round'/%3E%3C/svg%3E">
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
    <p>We sent a magic link to<br><span class="email">${email}</span></p>
    <p>Click the link in the email to sign in.</p>
    <a href="/" class="back">← Back to login</a>
  </div>
</body>
</html>
  `.trim();
}

function renderDashboard(files: StoredFile[], session: string, message?: string): string {
  const fileRows = files.length > 0
    ? files.map(f => `
        <tr>
          <td>${f.filename}</td>
          <td>${new Date(f.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
          <td><a href="/file/${f.id}?session=${session}" class="download-link">Download</a></td>
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
  <title>Dashboard - CryptoGrantWire</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cellipse cx='50' cy='35' rx='35' ry='20' fill='none' stroke='%23f5a623' stroke-width='6'/%3E%3Cellipse cx='50' cy='35' rx='20' ry='12' fill='none' stroke='%23f5a623' stroke-width='4'/%3E%3Ccircle cx='50' cy='35' r='6' fill='%23f5a623'/%3E%3Cline x1='50' y1='45' x2='50' y2='85' stroke='%23f5a623' stroke-width='6' stroke-linecap='round'/%3E%3Cline x1='35' y1='90' x2='65' y2='90' stroke='%23f5a623' stroke-width='6' stroke-linecap='round'/%3E%3C/svg%3E">
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
      <h1 class="logo"><span class="logo-crypto">Crypto</span><span class="logo-grant">Grant</span><span class="logo-wire">Wire</span></h1>
      <p>Newsletter Automation Dashboard</p>
    </div>
  </div>
  <div class="main">
    ${message ? `<div class="message ${message.startsWith('Error') ? 'error' : 'success'}">${decodeURIComponent(message)}</div>` : ''}

    <div class="card">
      <h2>Generate Weekly Summary</h2>
      <form id="job-form" class="run-form">
        <input type="hidden" name="session" value="${session}">
        <div class="form-row">
          <div class="form-group">
            <label for="startDate">Start Date</label>
            <input type="date" id="startDate" name="startDate" value="${formatDate(startDate)}">
          </div>
          <div class="form-group">
            <label for="endDate">End Date</label>
            <input type="date" id="endDate" name="endDate" value="${formatDate(endDate)}">
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
      <h2>Scheduled Runs</h2>
      <div id="schedule-form" class="run-form">
        <div class="form-row">
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
        </div>
        <div class="form-row model-row">
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
          <button type="button" id="save-schedule" class="button">Save Schedule</button>
          <button type="button" id="test-alert" class="button secondary">Test Alert</button>
        </div>
        <div id="schedule-status" class="schedule-status">
          <p id="schedule-description">Loading schedule...</p>
          <p id="schedule-next-run" class="next-run"></p>
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
  </div>

  <script>
    const form = document.getElementById('job-form');
    const runButton = document.getElementById('run-button');
    const progressContainer = document.getElementById('progress-container');
    const progressBar = document.getElementById('progress-bar');
    const progressStep = document.getElementById('progress-step');
    const elapsedTimeEl = document.getElementById('elapsed-time');
    const grokModelSelect = document.getElementById('grokModel');
    const anthropicModelSelect = document.getElementById('anthropicModel');
    const session = '${session}';
    let startTime;
    let elapsedTimer;

    // Fetch and populate models on page load
    async function loadModels() {
      try {
        const response = await fetch('/api/models?session=' + session);
        if (!response.ok) throw new Error('Failed to fetch models');
        const models = await response.json();

        // Populate Grok models
        grokModelSelect.innerHTML = models.grok.map((m, i) =>
          '<option value="' + m.id + '"' + (i === 0 ? ' selected' : '') + '>' + m.displayName + '</option>'
        ).join('');

        // Populate Anthropic models
        anthropicModelSelect.innerHTML = models.anthropic.map((m, i) =>
          '<option value="' + m.id + '"' + (i === 0 ? ' selected' : '') + '>' + m.displayName + '</option>'
        ).join('');
      } catch (error) {
        console.error('Failed to load models:', error);
        grokModelSelect.innerHTML = '<option value="grok-4-1-fast-reasoning">Grok 4.1 Fast (Reasoning)</option>';
        anthropicModelSelect.innerHTML = '<option value="claude-opus-4-5-20251101">Claude Opus 4.5</option>';
      }
    }

    loadModels();

    // Schedule management
    const scheduleEnabled = document.getElementById('scheduleEnabled');
    const scheduleDayOfWeek = document.getElementById('scheduleDayOfWeek');
    const scheduleTime = document.getElementById('scheduleTime');
    const scheduleLookback = document.getElementById('scheduleLookback');
    const scheduleGrokModel = document.getElementById('scheduleGrokModel');
    const scheduleAnthropicModel = document.getElementById('scheduleAnthropicModel');
    const saveScheduleBtn = document.getElementById('save-schedule');
    const scheduleDescription = document.getElementById('schedule-description');
    const scheduleNextRun = document.getElementById('schedule-next-run');

    async function loadSchedule() {
      try {
        const response = await fetch('/api/schedule?session=' + session);
        if (!response.ok) throw new Error('Failed to fetch schedule');
        const schedule = await response.json();

        scheduleEnabled.value = schedule.enabled.toString();
        scheduleDayOfWeek.value = schedule.dayOfWeek.toString();
        const hour = schedule.hour.toString().padStart(2, '0');
        const minute = schedule.minute.toString().padStart(2, '0');
        scheduleTime.value = hour + ':' + minute;
        scheduleLookback.value = schedule.lookbackDays;

        scheduleDescription.textContent = schedule.description;
        if (schedule.nextRun) {
          const nextDate = new Date(schedule.nextRun);
          scheduleNextRun.textContent = 'Next run: ' + nextDate.toLocaleString();
        } else {
          scheduleNextRun.textContent = '';
        }

        // Also load models for schedule dropdowns
        const modelsResponse = await fetch('/api/models?session=' + session);
        if (modelsResponse.ok) {
          const models = await modelsResponse.json();

          scheduleGrokModel.innerHTML = models.grok.map(m =>
            '<option value="' + m.id + '"' + (m.id === schedule.grokModel ? ' selected' : '') + '>' + m.displayName + '</option>'
          ).join('');

          scheduleAnthropicModel.innerHTML = models.anthropic.map(m =>
            '<option value="' + m.id + '"' + (m.id === schedule.anthropicModel ? ' selected' : '') + '>' + m.displayName + '</option>'
          ).join('');
        }
      } catch (error) {
        console.error('Failed to load schedule:', error);
        scheduleDescription.textContent = 'Failed to load schedule';
      }
    }

    loadSchedule();

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
        const response = await fetch('/api/scheduler-status?session=' + session);
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
          body: JSON.stringify({ session })
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

      saveScheduleBtn.disabled = true;
      saveScheduleBtn.textContent = 'Saving...';

      try {
        const response = await fetch('/api/schedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session,
            enabled: scheduleEnabled.value === 'true',
            dayOfWeek: parseInt(scheduleDayOfWeek.value, 10),
            hour,
            minute,
            lookbackDays: parseInt(scheduleLookback.value, 10),
            grokModel: scheduleGrokModel.value,
            anthropicModel: scheduleAnthropicModel.value,
          })
        });

        if (!response.ok) throw new Error('Failed to save schedule');
        const schedule = await response.json();

        scheduleDescription.textContent = schedule.description;
        scheduleDescription.classList.add('save-success');
        setTimeout(() => scheduleDescription.classList.remove('save-success'), 2000);

        if (schedule.nextRun) {
          const nextDate = new Date(schedule.nextRun);
          scheduleNextRun.textContent = 'Next run: ' + nextDate.toLocaleString();
        } else {
          scheduleNextRun.textContent = '';
        }

        // Refresh scheduler health status after saving
        loadSchedulerStatus();
      } catch (error) {
        console.error('Failed to save schedule:', error);
        scheduleDescription.textContent = 'Failed to save schedule';
      } finally {
        saveScheduleBtn.disabled = false;
        saveScheduleBtn.textContent = 'Save Schedule';
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
          body: JSON.stringify({ session, startDate, endDate, grokModel, anthropicModel })
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
      const eventSource = new EventSource('/api/job/' + jobId + '/progress?session=' + session);

      eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.status === 'running' && data.progress) {
          const percent = (data.progress.current / data.progress.total) * 100;
          progressBar.style.width = percent + '%';
          progressStep.textContent = data.progress.step;
        } else if (data.status === 'completed') {
          clearInterval(elapsedTimer);
          eventSource.close();
          window.location.href = '/dashboard?session=' + session + '&message=' + encodeURIComponent('Success! Processed ' + (data.result?.stats?.totalEntries || 0) + ' entries. File ready for download.');
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
  <title>Download - CryptoGrantWire</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cellipse cx='50' cy='35' rx='35' ry='20' fill='none' stroke='%23f5a623' stroke-width='6'/%3E%3Cellipse cx='50' cy='35' rx='20' ry='12' fill='none' stroke='%23f5a623' stroke-width='4'/%3E%3Ccircle cx='50' cy='35' r='6' fill='%23f5a623'/%3E%3Cline x1='50' y1='45' x2='50' y2='85' stroke='%23f5a623' stroke-width='6' stroke-linecap='round'/%3E%3Cline x1='35' y1='90' x2='65' y2='90' stroke='%23f5a623' stroke-width='6' stroke-linecap='round'/%3E%3C/svg%3E">
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
    <p class="filename">${filename}</p>
    <a href="/download/${downloadToken}" class="button">Download Markdown</a>
    <p class="note">This is a one-time download link.</p>
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
  <title>Error - CryptoGrantWire</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cellipse cx='50' cy='35' rx='35' ry='20' fill='none' stroke='%23f5a623' stroke-width='6'/%3E%3Cellipse cx='50' cy='35' rx='20' ry='12' fill='none' stroke='%23f5a623' stroke-width='4'/%3E%3Ccircle cx='50' cy='35' r='6' fill='%23f5a623'/%3E%3Cline x1='50' y1='45' x2='50' y2='85' stroke='%23f5a623' stroke-width='6' stroke-linecap='round'/%3E%3Cline x1='35' y1='90' x2='65' y2='90' stroke='%23f5a623' stroke-width='6' stroke-linecap='round'/%3E%3C/svg%3E">
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
    <p>${message}</p>
    <a href="/" class="back">← Back to login</a>
  </div>
</body>
</html>
  `.trim();
}

export async function startServer(): Promise<void> {
  // Initialize the scheduler (loads config from database)
  await initScheduler();

  app.listen(config.app.port, () => {
    console.log(`Server running on port ${config.app.port}`);
    console.log(`Scheduler initialized`);
  });
}

export { app };
