import express, { Request, Response } from 'express';
import { config } from './config';
import { validateMagicLink, createDownloadToken, createSessionToken, validateSession, createLoginMagicLink } from './services/auth';
import { getFile, listFiles } from './services/storage';
import { sendLoginEmail } from './services/email';
import { runWeeklySummaryJob } from './jobs/weekly-summary';
import { StoredFile } from './types';

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

// Trigger job manually
app.post('/api/run-job', async (req: Request, res: Response) => {
  const session = req.body.session;
  
  if (!session || !validateSession(session)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  
  try {
    const result = await runWeeklySummaryJob(false);
    res.redirect(`/dashboard?session=${session}&message=Success! Processed ${result.stats.totalEntries} entries. File ready for download.`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    res.redirect(`/dashboard?session=${session}&message=Error: ${encodeURIComponent(errorMsg)}`);
  }
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

function renderLoginPage(error?: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <title>Sign In - Crypto Grant Wire</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
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
      background: white;
      padding: 48px 40px;
      border-radius: 16px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.2);
    }
    h1 { color: #1a1a2e; margin: 0 0 8px; font-size: 28px; }
    .subtitle { color: #666; margin-bottom: 32px; }
    .form-group { margin-bottom: 20px; }
    label { display: block; margin-bottom: 8px; font-weight: 500; color: #333; }
    input[type="email"] {
      width: 100%;
      padding: 14px 16px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 16px;
      transition: border-color 0.2s;
    }
    input[type="email"]:focus {
      outline: none;
      border-color: #0066cc;
    }
    .button {
      width: 100%;
      background: #0066cc;
      color: white;
      padding: 14px 24px;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    }
    .button:hover { background: #0052a3; }
    .error { 
      background: #fee; 
      color: #c00; 
      padding: 12px 16px; 
      border-radius: 8px; 
      margin-bottom: 20px;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Crypto Grant Wire</h1>
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
  <title>Check Your Email - Crypto Grant Wire</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
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
      background: white;
      padding: 48px 40px;
      border-radius: 16px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.2);
      text-align: center;
    }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { color: #1a1a2e; margin: 0 0 16px; font-size: 24px; }
    p { color: #666; line-height: 1.6; }
    .email { font-weight: 600; color: #333; }
    .back { 
      display: inline-block;
      margin-top: 24px;
      color: #0066cc;
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

  return `
<!DOCTYPE html>
<html>
<head>
  <title>Dashboard - Crypto Grant Wire</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
      background: #f5f7fa;
      margin: 0;
      padding: 0;
      min-height: 100vh;
    }
    .header {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: white;
      padding: 24px 32px;
    }
    .header h1 { margin: 0; font-size: 24px; }
    .header p { margin: 8px 0 0; opacity: 0.8; }
    .main { padding: 32px; max-width: 900px; margin: 0 auto; }
    .card {
      background: white;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      padding: 24px;
      margin-bottom: 24px;
    }
    .card h2 { margin: 0 0 16px; font-size: 18px; color: #333; }
    .message {
      padding: 12px 16px;
      border-radius: 8px;
      margin-bottom: 24px;
      font-size: 14px;
    }
    .message.success { background: #e8f5e9; color: #2e7d32; }
    .message.error { background: #ffebee; color: #c62828; }
    .button {
      display: inline-block;
      background: #0066cc;
      color: white;
      padding: 12px 24px;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      text-decoration: none;
      transition: background 0.2s;
    }
    .button:hover { background: #0052a3; }
    .button.secondary {
      background: #e0e0e0;
      color: #333;
    }
    .button.secondary:hover { background: #d0d0d0; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; }
    th { font-weight: 600; color: #666; font-size: 12px; text-transform: uppercase; }
    .download-link { color: #0066cc; text-decoration: none; font-weight: 500; }
    .download-link:hover { text-decoration: underline; }
    .empty { color: #999; text-align: center; padding: 32px; }
    .run-form { display: flex; gap: 12px; align-items: center; }
    .run-form p { margin: 0; color: #666; font-size: 14px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Crypto Grant Wire</h1>
    <p>Newsletter Automation Dashboard</p>
  </div>
  <div class="main">
    ${message ? `<div class="message ${message.startsWith('Error') ? 'error' : 'success'}">${decodeURIComponent(message)}</div>` : ''}
    
    <div class="card">
      <h2>Generate Weekly Summary</h2>
      <form method="POST" action="/api/run-job" class="run-form">
        <input type="hidden" name="session" value="${session}">
        <button type="submit" class="button">Run Job Now</button>
        <p>Fetches entries from the last 7 days, processes with Grok/Claude, generates markdown.</p>
      </form>
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
  </div>
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
  <title>Download - Crypto Grant Wire</title>
  <style>
    * { box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
      background: #f5f5f5;
      margin: 0;
      padding: 20px;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container { 
      max-width: 500px; 
      background: white;
      padding: 40px;
      border-radius: 12px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      text-align: center;
    }
    h1 { color: #333; margin-bottom: 8px; font-size: 24px; }
    .filename { color: #666; margin-bottom: 24px; font-family: monospace; }
    .button { 
      display: inline-block; 
      background: #0066cc; 
      color: white; 
      padding: 14px 32px; 
      text-decoration: none; 
      border-radius: 8px; 
      font-weight: 500;
      font-size: 16px;
      transition: background 0.2s;
    }
    .button:hover { background: #0052a3; }
    .note { margin-top: 20px; font-size: 14px; color: #888; }
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
  <title>Error - Crypto Grant Wire</title>
  <style>
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
      background: #f5f5f5;
      margin: 0;
      padding: 20px;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container { 
      max-width: 500px; 
      background: white;
      padding: 40px;
      border-radius: 12px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      text-align: center;
    }
    h1 { color: #c00; margin-bottom: 16px; }
    p { color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Access Error</h1>
    <p>${message}</p>
  </div>
</body>
</html>
  `.trim();
}

export function startServer(): void {
  app.listen(config.app.port, () => {
    console.log(`Server running on port ${config.app.port}`);
  });
}

export { app };
