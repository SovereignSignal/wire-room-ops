import { escapeHtml } from '../utils/html';
import { config } from '../config';

export { escapeHtml, config };

export function sharedHead(title: string): string {
  return `
  <title>${escapeHtml(title)} - Wire Ops</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📡</text></svg>">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="theme-color" content="#080c14">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  `;
}

export function sharedBaseStyles(): string {
  return `
    :root {
      --bg: #080c14;
      --bg-card: #0f1a2a;
      --border: #1a2a3d;
      --input: #0a1220;
      --text: #e0e4e8;
      --text-secondary: #7a8a9a;
      --text-muted: #4a5a6a;
      --accent: #d4a017;
      --accent-hover: #e8b01e;
      --accent-fg: #080c14;
      --success: #4ade80;
      --error: #ef4444;
      --warning: #d4a017;
      --radius-sm: 0px;
      --radius-md: 2px;
      --radius-lg: 4px;
      --radius-xl: 6px;
      --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      --font-mono: 'JetBrains Mono', ui-monospace, monospace;
    }
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: var(--font-sans);
      background: var(--bg);
      color: var(--text);
      margin: 0;
      color-scheme: dark;
    }
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
    .button:hover { background: var(--accent-hover); box-shadow: 0 0 4px rgba(212,160,23,0.3), 0 0 16px rgba(212,160,23,0.15); }
    .button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  `;
}

/** Shared form/button/table/card CSS used by dashboard pages inside the sidebar shell */
export function sharedDashboardStyles(): string {
  return `
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      padding: 24px;
      margin-bottom: 24px;
    }
    .card h2 { margin: 0 0 16px; font-size: 18px; color: var(--text); }
    details.card summary {
      cursor: pointer;
      list-style: none;
      display: flex;
      align-items: center;
      gap: 0;
      user-select: none;
    }
    details.card summary::-webkit-details-marker { display: none; }
    details.card summary::before {
      content: '\\25b6';
      font-size: 10px;
      color: var(--text-muted);
      margin-right: 10px;
      transition: transform 0.2s;
      flex-shrink: 0;
    }
    details.card[open] > summary::before {
      transform: rotate(90deg);
    }
    details.card summary h2 { margin: 0; flex: 1; }
    .message {
      padding: 12px 16px;
      border-radius: var(--radius-lg);
      margin-bottom: 24px;
      font-size: 14px;
    }
    .message.success {
      background: rgba(74, 222, 128, 0.15);
      color: var(--success);
      border: 1px solid rgba(74, 222, 128, 0.3);
    }
    .message.error {
      background: rgba(239, 68, 68, 0.15);
      color: var(--error);
      border: 1px solid rgba(239, 68, 68, 0.3);
    }
    .button {
      display: inline-block;
      background: var(--accent);
      color: var(--accent-fg);
      padding: 12px 24px;
      border: none;
      border-radius: var(--radius-lg);
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      transition: background 0.2s;
    }
    .button:hover { background: var(--accent-hover); box-shadow: 0 0 4px rgba(212,160,23,0.3), 0 0 16px rgba(212,160,23,0.15); }
    .button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .button:disabled {
      background: var(--text-muted);
      cursor: not-allowed;
    }
    .button.secondary {
      background: var(--border);
      color: var(--text);
    }
    .button.secondary:hover { background: #1a2a3d; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid var(--border); }
    th { font-weight: 500; color: var(--text-secondary); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; font-family: var(--font-mono); }
    td { color: var(--text); font-variant-numeric: tabular-nums; font-feature-settings: 'tnum'; }
    .download-link { color: var(--accent); text-decoration: none; font-weight: 500; }
    .download-link:hover { text-decoration: underline; }
    .empty { color: var(--text-muted); text-align: center; padding: 32px; }
    .run-form { display: flex; flex-direction: column; gap: 16px; }
    .form-row { display: flex; gap: 16px; align-items: flex-end; flex-wrap: wrap; }
    .form-group { display: flex; flex-direction: column; gap: 6px; }
    .form-group label { font-size: 10px; color: var(--text-secondary); text-transform: uppercase; font-weight: 500; letter-spacing: 0.05em; font-family: var(--font-mono); }
    .form-group input[type="date"],
    .form-group input[type="time"],
    .form-group input[type="number"],
    .form-group input[type="text"],
    .form-group select {
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      font-size: 14px;
      background: var(--bg);
      color: var(--text);
      min-width: 120px;
      color-scheme: dark;
    }
    .form-group input:focus-visible,
    .form-group select:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
      border-color: var(--accent);
    }
    .form-group select option {
      background: var(--bg-card);
      color: var(--text);
    }
    .form-description { color: var(--text-muted); font-size: 14px; margin: 0; }
    .status-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
    }
    .status-item {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 12px 16px;
    }
    .status-item .label {
      font-size: 10px;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 4px;
      font-family: var(--font-mono);
      font-weight: 500;
    }
    .status-item .value {
      font-size: 14px;
      color: var(--text);
      font-family: var(--font-mono);
      font-feature-settings: 'tnum';
    }
    .status-item .value.success { color: var(--success); }
    .status-item .value.error { color: var(--error); }
    .status-item .value.warning { color: var(--accent); }
    .status-item .value.muted { color: var(--text-muted); }
    .refresh-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-secondary);
      padding: 6px 12px;
      border-radius: var(--radius-md);
      font-size: 12px;
      cursor: pointer;
      margin-left: 12px;
    }
    .refresh-btn:hover { border-color: var(--accent); color: var(--accent); }
    .refresh-btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .skip-link {
      position: absolute;
      left: -9999px;
      top: auto;
      width: 1px;
      height: 1px;
      overflow: hidden;
    }
    .skip-link:focus {
      position: fixed;
      top: 8px;
      left: 8px;
      width: auto;
      height: auto;
      padding: 8px 16px;
      background: var(--accent);
      color: var(--accent-fg);
      border-radius: 4px;
      z-index: 9999;
      font-weight: 600;
    }
  `;
}

export interface FeedNav {
  key: string;
  displayName: string;
}

export interface PageShellOptions {
  title: string;
  activePage: 'queue' | 'schedules' | string;  // string for 'feed:<key>'
  content: string;
  extraHead?: string;
  extraStyles?: string;
  feeds?: FeedNav[];
}

export function renderPageShell(opts: PageShellOptions): string {
  const { title, activePage, content, extraHead, extraStyles, feeds } = opts;

  function navItem(label: string, href: string, page: string): string {
    const isActive = activePage === page;
    const activeClass = isActive ? ' nav-active' : '';
    return `<a href="${href}" class="nav-item${activeClass}">${escapeHtml(label)}</a>`;
  }

  // Build feeds section — server-rendered if feeds array provided, JS fallback otherwise
  function feedsSection(): string {
    const feedLinks = (feeds || []).map(f => {
      const isActive = activePage === `feed:${f.key}`;
      const activeClass = isActive ? ' nav-active' : '';
      return `<a href="/feeds/${encodeURIComponent(f.key)}" class="nav-item nav-feed${activeClass}">${escapeHtml(f.displayName)}</a>`;
    }).join('\n        ');

    return `
        <div class="nav-section-label">Feeds</div>
        <div id="feeds-nav">
          ${feedLinks || '<span class="nav-loading">Loading...</span>'}
        </div>
        <a href="/feeds/new" class="nav-item nav-add-feed">+ Add Feed</a>`;
  }

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  ${sharedHead(title)}
  <style>
    ${sharedBaseStyles()}
    ${sharedDashboardStyles()}
    body {
      padding: 0;
      min-height: 100vh;
      overflow: hidden;
    }
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 0;
      background: repeating-linear-gradient(
        180deg, transparent 0px, transparent 48px,
        rgba(17, 29, 48, 0.3) 48px, rgba(17, 29, 48, 0.3) 49px
      );
      mask-image: linear-gradient(180deg, transparent 0%, black 10%, black 90%, transparent 100%);
      -webkit-mask-image: linear-gradient(180deg, transparent 0%, black 10%, black 90%, transparent 100%);
    }

    /* Sidebar layout */
    .shell-layout {
      display: flex;
      height: 100vh;
      position: relative;
      z-index: 1;
    }
    .sidebar {
      width: 220px;
      flex-shrink: 0;
      background: var(--bg-card);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow-y: auto;
    }
    .sidebar-logo {
      padding: 24px 20px 20px;
      border-bottom: 1px solid var(--border);
    }
    .sidebar-logo h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 700;
    }
    .sidebar-logo .logo-wire { color: var(--text); }
    .sidebar-logo .logo-ops { color: var(--accent); }
    .sidebar-nav {
      padding: 16px 0;
      flex: 1;
      display: flex;
      flex-direction: column;
    }
    .nav-item {
      display: block;
      padding: 10px 20px;
      color: var(--text-secondary);
      text-decoration: none;
      font-size: 14px;
      font-weight: 500;
      border-left: 3px solid transparent;
      transition: color 0.15s, border-color 0.15s, background 0.15s;
    }
    .nav-item:hover {
      color: var(--text);
      background: rgba(255,255,255,0.03);
    }
    .nav-active {
      color: var(--accent) !important;
      border-left-color: var(--accent);
      background: rgba(212,160,23,0.06);
    }
    .nav-section-label {
      padding: 16px 20px 6px;
      font-size: 10px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-family: var(--font-mono);
    }
    .nav-feed {
      padding-left: 28px;
      font-size: 13px;
    }
    .nav-add-feed {
      padding-left: 28px;
      font-size: 13px;
      color: var(--text-muted) !important;
    }
    .nav-add-feed:hover {
      color: var(--accent) !important;
    }
    .nav-loading {
      display: block;
      padding: 8px 28px;
      font-size: 12px;
      color: var(--text-muted);
    }
    .nav-spacer { flex: 1; }
    .sidebar-footer {
      padding: 16px 20px;
      border-top: 1px solid var(--border);
    }
    .sidebar-footer a {
      color: var(--text-muted);
      text-decoration: none;
      font-size: 13px;
    }
    .sidebar-footer a:hover { color: var(--text-secondary); }

    .main-content {
      flex: 1;
      overflow-y: auto;
      padding: 32px;
    }
    .main-inner {
      max-width: 960px;
      margin: 0 auto;
    }
    .page-title {
      font-size: 22px;
      font-weight: 700;
      margin: 0 0 24px;
      color: var(--text);
    }

    /* Mobile hamburger */
    .hamburger {
      display: none;
      position: fixed;
      top: 12px;
      left: 12px;
      z-index: 1001;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      color: var(--text);
      padding: 8px 12px;
      cursor: pointer;
      font-size: 20px;
      line-height: 1;
    }
    .sidebar-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.5);
      z-index: 999;
    }

    @media (max-width: 768px) {
      .hamburger { display: block; }
      .sidebar {
        position: fixed;
        left: -260px;
        top: 0;
        bottom: 0;
        z-index: 1000;
        transition: left 0.25s ease;
        width: 240px;
      }
      .sidebar.open { left: 0; }
      .sidebar-overlay.open { display: block; }
      .main-content { padding: 56px 16px 24px; }
    }
    ${extraStyles || ''}
  </style>
  ${extraHead || ''}
</head>
<body>
  <a href="#main-content" class="skip-link">Skip to content</a>
  <button class="hamburger" id="hamburger-btn" aria-label="Toggle navigation">&#9776;</button>
  <div class="sidebar-overlay" id="sidebar-overlay"></div>
  <div class="shell-layout">
    <nav class="sidebar" id="sidebar">
      <div class="sidebar-logo">
        <h1>&#x1F4E1; <span class="logo-wire">Wire</span> <span class="logo-ops">Ops</span></h1>
      </div>
      <div class="sidebar-nav">
        ${navItem('Queue', '/queue', 'queue')}
        ${feedsSection()}
        <div class="nav-spacer"></div>
        ${navItem('Schedules', '/schedules', 'schedules')}
      </div>
      <div class="sidebar-footer">
        <a href="/logout">Logout</a>
      </div>
    </nav>
    <main class="main-content" id="main-content">
      <div class="main-inner">
        <h1 class="page-title">${escapeHtml(title)}</h1>
        ${content}
      </div>
    </main>
  </div>
  <script>
    (function() {
      var hamburger = document.getElementById('hamburger-btn');
      var sidebar = document.getElementById('sidebar');
      var overlay = document.getElementById('sidebar-overlay');
      if (hamburger && sidebar && overlay) {
        hamburger.addEventListener('click', function() {
          sidebar.classList.toggle('open');
          overlay.classList.toggle('open');
        });
        overlay.addEventListener('click', function() {
          sidebar.classList.remove('open');
          overlay.classList.remove('open');
        });
      }
      // JS fallback: load feeds dynamically if server didn't render them
      var feedsNav = document.getElementById('feeds-nav');
      if (feedsNav && feedsNav.querySelector('.nav-loading')) {
        fetch('/api/feeds').then(function(r) { return r.json(); }).then(function(feeds) {
          var activePage = ${JSON.stringify(activePage)};
          feedsNav.innerHTML = feeds.map(function(f) {
            var isActive = activePage === 'feed:' + f.key;
            return '<a href="/feeds/' + encodeURIComponent(f.key) + '" class="nav-item nav-feed' + (isActive ? ' nav-active' : '') + '">' + f.display_name + '</a>';
          }).join('');
        }).catch(function() {
          feedsNav.innerHTML = '<span class="nav-loading">Failed to load</span>';
        });
      }
    })();
  </script>
`.trim();
}
