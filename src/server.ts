import express, { Request, Response } from 'express';
import { config } from './config';
import { validateMagicLink, createDownloadToken } from './services/auth';
import { getFile, listFiles } from './services/storage';

const app = express();

app.use(express.json());

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Magic link landing page - validates token and shows download button
app.get('/download', (req: Request, res: Response) => {
  const token = req.query.token as string;
  
  if (!token) {
    res.status(400).send(renderErrorPage('Missing authentication token'));
    return;
  }
  
  const validation = validateMagicLink(token);
  
  if (!validation.valid || !validation.fileId) {
    res.status(401).send(renderErrorPage(validation.error || 'Invalid link'));
    return;
  }
  
  const file = getFile(validation.fileId);
  
  if (!file) {
    res.status(404).send(renderErrorPage('File not found'));
    return;
  }
  
  // Create a one-time download token
  const downloadToken = createDownloadToken(validation.fileId);
  
  res.send(renderDownloadPage(file.filename, downloadToken));
});

// Actual file download endpoint
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
  
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.send(file.content);
});

// List recent files (for admin/debugging)
app.get('/api/files', (_req: Request, res: Response) => {
  const files = listFiles();
  res.json(files.map(f => ({
    id: f.id,
    filename: f.filename,
    createdAt: f.createdAt,
    dateRange: f.dateRange,
  })));
});

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
