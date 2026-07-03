import { escapeHtml } from '../utils/html';
import { config } from '../config';

export { escapeHtml, config };


export function sharedHead(title: string): string {
  return `
  <title>${escapeHtml(title)} - Wire Ops</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📡</text></svg>">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <meta name="theme-color" content="#0b0a15">
  <script>(function(){var t=localStorage.getItem('theme');if(t)document.documentElement.setAttribute('data-theme',t)})()</script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  `;
}

export function sharedBaseStyles(): string {
  return `
    :root {
      /* Deep space / satellite array palette — matches client Lovable theme */
      --bg: hsl(245, 35%, 6%);
      --bg-card: hsl(245, 30%, 9%);
      --border: hsl(245, 30%, 16%);
      --input: hsl(245, 25%, 14%);
      --text: hsl(200, 60%, 94%);
      --text-secondary: hsl(220, 15%, 50%);
      --text-muted: hsl(220, 10%, 35%);
      /* Signal cyan accent */
      --accent: hsl(185, 100%, 50%);
      --accent-hover: hsl(185, 100%, 60%);
      --accent-fg: hsl(245, 35%, 6%);
      --success: #4ade80;
      --error: #ef4444;
      --warning: hsl(45, 100%, 55%);
      --radius-sm: 0px;
      --radius-md: 2px;
      --radius-lg: 4px;
      --radius-xl: 6px;
      --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      --font-mono: 'JetBrains Mono', ui-monospace, monospace;
      --font-display: 'Orbitron', sans-serif;
      --badge-x-bg: #1a3a5c; --badge-x-fg: #5b9bd5;
      --badge-web-bg: #1a3c2c; --badge-web-fg: #81c784;
      --badge-tg-bg: #1a3c3c; --badge-tg-fg: #26c6da;
      --badge-email-bg: #3c2a1a; --badge-email-fg: #ff9800;
      --badge-forum-bg: #1a2c3c; --badge-forum-fg: #64b5f6;
      --badge-prompt-bg: #2c1a3c; --badge-prompt-fg: #ce93d8;
      --badge-amount-bg: #1a2c1a;
      --btn-approve-bg: #1b5e20; --btn-approve-fg: var(--success);
      --btn-decline-bg: #4a1515; --btn-decline-fg: var(--error);
      --btn-restore-bg: #1a3a5c; --btn-restore-fg: #5b9bd5;
    }
    :root[data-theme="light"] {
      --bg: #f5f6f8;
      --bg-card: #ffffff;
      --border: #d8dce2;
      --input: #f0f1f3;
      --text: #1a1d23;
      --text-secondary: #5a6270;
      --text-muted: #8a92a0;
      --accent: #b8860b;
      --accent-hover: #d4a017;
      --accent-fg: #ffffff;
      --success: #16a34a;
      --error: #dc2626;
      --warning: #b8860b;
      --badge-x-bg: #dbeafe; --badge-x-fg: #1e40af;
      --badge-web-bg: #dcfce7; --badge-web-fg: #166534;
      --badge-tg-bg: #cffafe; --badge-tg-fg: #155e75;
      --badge-email-bg: #ffedd5; --badge-email-fg: #9a3412;
      --badge-forum-bg: #dbeafe; --badge-forum-fg: #1e40af;
      --badge-prompt-bg: #f3e8ff; --badge-prompt-fg: #7e22ce;
      --badge-amount-bg: #dcfce7;
      --btn-approve-bg: #dcfce7; --btn-approve-fg: #166534;
      --btn-decline-bg: #fee2e2; --btn-decline-fg: #991b1b;
      --btn-restore-bg: #dbeafe; --btn-restore-fg: #1e40af;
    }
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: var(--font-sans);
      background: var(--bg);
      color: var(--text);
      margin: 0;
      color-scheme: dark;
    }
    :root[data-theme="light"] body { color-scheme: light; }
    a { color: var(--accent); }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        transition-duration: 0.01ms !important;
      }
    }
  `;
}

export function sharedCenteredPageStyles(): string {
  return `
    body {
      padding: 20px;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      max-width: 500px;
      width: 100%;
      background: var(--bg-card);
      border: 1px solid var(--border);
      padding: 48px 40px;
      border-radius: var(--radius-xl);
      box-shadow: 0 4px 24px rgba(0,0,0,0.4);
      text-align: center;
    }
    .button {
      display: inline-block;
      background: var(--accent);
      color: var(--accent-fg);
      padding: 14px 24px;
      border: none;
      border-radius: var(--radius-lg);
      font-size: 16px;
      font-family: var(--font-sans);
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      transition: background 0.2s;
    }
    .button:hover { background: var(--accent-hover); box-shadow: 0 0 4px rgba(0,234,255,0.3), 0 0 16px rgba(0,234,255,0.15); }
    .button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  `;
}

