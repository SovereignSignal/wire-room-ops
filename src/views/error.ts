import { escapeHtml, sharedHead, sharedBaseStyles, sharedCenteredPageStyles } from './shared';

export function renderDownloadPage(filename: string, downloadToken: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  ${sharedHead('Download')}
  <style>
    ${sharedBaseStyles()}
    ${sharedCenteredPageStyles()}
    h1 { color: var(--text); margin-bottom: 8px; font-size: 24px; }
    .filename { color: var(--accent); margin-bottom: 24px; font-family: var(--font-mono); }
    .note { margin-top: 20px; font-size: 14px; color: var(--text-muted); }
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

export function renderLegacyDownloadPage(filename: string, downloadToken: string): string {
  return renderDownloadPage(filename, downloadToken);
}

export function renderExpiredLinkPage(message: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  ${sharedHead('Link Expired')}
  <style>
    ${sharedBaseStyles()}
    ${sharedCenteredPageStyles()}
    h1 { color: var(--error); margin-bottom: 16px; }
    p { color: var(--text-secondary); margin-bottom: 24px; }
    .button { margin-bottom: 16px; }
    .back {
      display: block;
      margin-top: 16px;
      color: var(--accent);
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
    <a href="/" class="back">\u2190 Back to login</a>
  </div>
</body>
</html>
  `.trim();
}

export function renderResendSuccessPage(): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  ${sharedHead('Link Sent')}
  <style>
    ${sharedBaseStyles()}
    ${sharedCenteredPageStyles()}
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { color: var(--success); margin-bottom: 16px; }
    p { color: var(--text-secondary); }
    .back {
      display: inline-block;
      margin-top: 24px;
      color: var(--accent);
      text-decoration: none;
    }
    .back:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">\u2709\uFE0F</div>
    <h1>Link Sent!</h1>
    <p>A fresh download link has been sent to your email.<br>Check your inbox and click the new link.</p>
    <a href="/" class="back">\u2190 Back to login</a>
  </div>
</body>
</html>
  `.trim();
}

export function renderErrorPage(message: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  ${sharedHead('Error')}
  <style>
    ${sharedBaseStyles()}
    ${sharedCenteredPageStyles()}
    h1 { color: var(--error); margin-bottom: 16px; }
    p { color: var(--text-secondary); }
    .back {
      display: inline-block;
      margin-top: 24px;
      color: var(--accent);
      text-decoration: none;
    }
    .back:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Access Error</h1>
    <p>${escapeHtml(message)}</p>
    <a href="/" class="back">\u2190 Back to login</a>
  </div>
</body>
</html>
  `.trim();
}
