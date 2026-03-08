import { escapeHtml } from '../utils/html';
import { renderPageShell, FeedNav, CLIENT_ESCAPE_HTML } from './shared';

export function renderPromptsPage(feeds: FeedNav[], forumEnabled: boolean, selectedFeed?: FeedNav): string {
  const extraStyles = `
    /* Wire selector */
    .wire-select-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 24px;
    }
    .wire-select-bar select {
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      font-size: 14px;
      background: var(--bg);
      color: var(--text);
      min-width: 180px;
      color-scheme: dark;
    }
    :root[data-theme="light"] .wire-select-bar select { color-scheme: light; }
    .wire-select-bar select:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
      border-color: var(--accent);
    }
    .wire-select-bar select option {
      background: var(--bg-card);
      color: var(--text);
    }

    /* Source cards */
    .source-cards {
      display: flex;
      gap: 12px;
      margin-bottom: 24px;
      flex-wrap: wrap;
    }
    .source-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 14px 18px;
      min-width: 140px;
      flex: 1;
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
    }
    .source-card:hover, .source-card.active {
      border-color: var(--accent);
      background: rgba(212,160,23,0.04);
    }
    .source-card .source-label {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 4px;
    }
    .source-card .source-meta {
      font-size: 12px;
      color: var(--text-secondary);
      font-family: var(--font-mono);
    }

    /* Section headers */
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
      margin-top: 32px;
    }
    .section-header:first-of-type { margin-top: 0; }
    .section-header h2 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      color: var(--text);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-family: var(--font-mono);
    }
    .section-actions {
      display: flex;
      gap: 8px;
    }
    .section-actions button {
      background: var(--border);
      border: none;
      color: var(--text-secondary);
      padding: 6px 14px;
      border-radius: var(--radius-md);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s;
    }
    .section-actions button:hover { color: var(--accent); }
    .section-actions button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .section-actions button.primary {
      background: var(--accent);
      color: var(--accent-fg);
    }
    .section-actions button.primary:hover { background: var(--accent-hover); }

    /* Prompt cards */
    .prompt-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 14px 18px;
      margin-bottom: 8px;
    }
    .prompt-card .prompt-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 6px;
    }
    .prompt-card .prompt-label {
      font-weight: 600;
      font-size: 14px;
      color: var(--text);
      flex: 1;
    }
    .prompt-card .prompt-variant {
      font-size: 11px;
      background: var(--border);
      color: var(--text-secondary);
      padding: 2px 8px;
      border-radius: 10px;
      font-family: var(--font-mono);
      font-weight: 600;
    }
    .prompt-card .prompt-status {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      font-weight: 600;
    }
    .prompt-status.active { background: rgba(74,222,128,0.15); color: var(--success); }
    .prompt-status.paused { background: rgba(122,138,154,0.15); color: var(--text-muted); }
    .prompt-card .prompt-text {
      font-size: 13px;
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
      font-family: var(--font-mono);
    }
    .prompt-card .prompt-actions {
      display: flex;
      gap: 6px;
      margin-top: 10px;
    }
    .prompt-card .prompt-actions button {
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: var(--text-secondary);
      padding: 5px 12px;
      border-radius: var(--radius-md);
      font-size: 12px;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s;
    }
    .prompt-card .prompt-actions button:hover { color: var(--accent); border-color: var(--accent); }
    .prompt-card .prompt-actions button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .prompt-card .prompt-actions button.danger:hover { color: var(--error); border-color: var(--error); }

    /* Prompt form (add/edit) */
    .prompt-form-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.6);
      z-index: 2000;
      align-items: center;
      justify-content: center;
    }
    .prompt-form-overlay.visible { display: flex; }
    .prompt-form-dialog {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      padding: 28px;
      width: 560px;
      max-width: 95vw;
      max-height: 90vh;
      overflow-y: auto;
    }
    .prompt-form-dialog h3 {
      margin: 0 0 20px;
      font-size: 18px;
      color: var(--text);
    }
    .prompt-lab {
      margin-top: 20px;
      padding-top: 18px;
      border-top: 1px solid var(--border);
      display: grid;
      gap: 14px;
    }
    .prompt-lab-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .prompt-lab-header h4 {
      margin: 0;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-family: var(--font-mono);
      color: var(--text);
    }
    .prompt-lab-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .prompt-lab-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    .lab-panel {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 14px;
      min-height: 220px;
      display: grid;
      align-content: start;
      gap: 10px;
    }
    .lab-panel h5 {
      margin: 0;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-family: var(--font-mono);
      color: var(--text-secondary);
    }
    .lab-placeholder {
      color: var(--text-muted);
      font-size: 13px;
      line-height: 1.5;
    }
    .lab-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      font-size: 12px;
      color: var(--text-secondary);
      font-family: var(--font-mono);
    }
    .lab-metric {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 999px;
    }
    .lab-metric strong {
      color: var(--text);
      font-weight: 600;
    }
    .lab-parsed-list {
      display: grid;
      gap: 10px;
    }
    .lab-result-card {
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 10px 12px;
      background: var(--bg-card);
      display: grid;
      gap: 6px;
    }
    .lab-result-card strong {
      color: var(--text);
    }
    .lab-result-meta {
      color: var(--text-secondary);
      font-size: 12px;
      font-family: var(--font-mono);
    }
    .lab-raw-output {
      margin: 0;
      max-height: 280px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.55;
      color: var(--text-secondary);
      font-family: var(--font-mono);
    }
    .review-score {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 52px;
      padding: 8px 12px;
      border-radius: 999px;
      font-weight: 700;
      font-family: var(--font-mono);
      background: rgba(212,160,23,0.12);
      color: var(--accent);
    }
    .review-summary {
      color: var(--text-secondary);
      font-size: 13px;
      line-height: 1.6;
    }
    .review-list {
      margin: 0;
      padding-left: 18px;
      color: var(--text-secondary);
      font-size: 13px;
      line-height: 1.55;
    }
    .review-list li + li {
      margin-top: 6px;
    }
    .review-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .review-actions button {
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: var(--text-secondary);
      padding: 6px 12px;
      border-radius: var(--radius-md);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .review-actions button:hover {
      color: var(--accent);
      border-color: var(--accent);
    }
    @media (max-width: 960px) {
      .prompt-lab-grid {
        grid-template-columns: 1fr;
      }
    }

    /* Progress bar (Run Scan / Forum) */
    .progress-container {
      margin-top: 16px;
      display: none;
    }
    .progress-container.visible { display: block; }
    .progress-bar-track {
      background: var(--border);
      border-radius: 4px;
      overflow: hidden;
      height: 20px;
    }
    .progress-bar-fill {
      height: 100%;
      width: 0%;
      transition: width 0.3s;
    }
    .progress-bar-fill.scan { background: var(--accent); }
    .progress-bar-fill.forum { background: var(--badge-forum-fg); }
    .progress-step {
      color: var(--text-secondary);
      font-size: 13px;
      margin: 8px 0 0;
    }
    .result-box {
      display: none;
      margin-top: 16px;
      padding: 12px 16px;
      background: var(--bg);
      border-radius: var(--radius-lg);
      border: 1px solid var(--border);
    }
    .result-box.visible { display: block; }

    .placeholder-msg {
      text-align: center;
      color: var(--text-muted);
      padding: 48px 24px;
      font-size: 15px;
    }
  `;

  const selectedFeedKey = selectedFeed?.key || '';
  const feedOptions = feeds.map(f =>
    `<option value="${escapeHtml(f.key)}">${escapeHtml(f.displayName)}</option>`
  ).join('\n            ');

  const content = `
    ${selectedFeed ? '' : `
    <div class="wire-select-bar">
      <select id="wireSelect">
        <option value="">Select a feed\u2026</option>
        ${feedOptions}
      </select>
    </div>
    `}

    <div id="prompts-content"${selectedFeed ? '' : ' style="display: none;"'}>
      <!-- Source summary cards -->
      <div class="source-cards" id="source-cards"></div>

      <!-- X Search Scans section -->
      <div id="section-x_search" style="display: none;">
        <div class="section-header">
          <h2>X Search Scans</h2>
          <div class="section-actions">
            <button type="button" id="add-prompt-x">+ Add</button>
            <button type="button" id="run-scan-btn" class="primary">Run Now</button>
          </div>
        </div>
        <div id="prompts-x_search"></div>
        <div class="progress-container" id="scan-progress" aria-live="polite">
          <div class="progress-bar-track" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100">
            <div class="progress-bar-fill scan" id="scan-bar"></div>
          </div>
          <p class="progress-step" id="scan-step">Initializing\u2026</p>
        </div>
        <div class="result-box" id="scan-result"></div>
      </div>

      <!-- Web Search Scans section -->
      <div id="section-web_search" style="display: none;">
        <div class="section-header">
          <h2>Web Search Scans</h2>
          <div class="section-actions">
            <button type="button" id="add-prompt-web">+ Add</button>
          </div>
        </div>
        <div id="prompts-web_search"></div>
      </div>

      <!-- Forums section -->
      ${forumEnabled ? `
      <div id="section-forum">
        <div class="section-header">
          <h2>Forums (discuss.watch)</h2>
          <div class="section-actions">
            <button type="button" id="run-forum-btn" style="background: var(--bg); border: 1px solid var(--badge-forum-fg); color: var(--badge-forum-fg);">Run Forum Scan</button>
          </div>
        </div>
        <p style="color: var(--text-secondary); font-size: 13px; margin: 0 0 12px;">Searches 150+ Discourse forums for grant-related discussions.</p>
        <div class="progress-container" id="forum-progress" aria-live="polite">
          <div class="progress-bar-track" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100">
            <div class="progress-bar-fill forum" id="forum-bar"></div>
          </div>
          <p class="progress-step" id="forum-step">Initializing\u2026</p>
        </div>
        <div class="result-box" id="forum-result"></div>
      </div>
      ` : ''}

      <!-- Prompt Stats (collapsible) -->
      <details class="card" style="margin-top: 32px;">
        <summary><h2>Prompt Stats</h2></summary>
        <div style="margin-top: 16px;">
          <p class="form-description" style="margin-bottom: 16px;">How well each prompt performs: unique results, duplicate rate, quality scores.</p>
          <div class="form-row" style="margin-bottom: 16px; align-items: flex-end;">
            <div class="form-group">
              <label for="statsDays">Lookback Days</label>
              <input type="number" id="statsDays" min="1" max="90" value="7" style="width: 80px;">
            </div>
            <button type="button" id="load-prompt-stats" class="button secondary">Refresh</button>
          </div>
          <div id="prompt-stats-results">
            <p style="color: var(--text-muted);">Click Refresh to load stats.</p>
          </div>
        </div>
      </details>
    </div>

    <div id="prompts-placeholder" class="placeholder-msg"${selectedFeed ? ' style="display: none;"' : ''}>
      Select a feed to manage scan prompts.
    </div>

    <!-- Prompt form dialog -->
    <div class="prompt-form-overlay" id="prompt-form-overlay">
      <div class="prompt-form-dialog">
        <h3 id="prompt-form-title">Add Prompt</h3>
        <input type="hidden" id="promptEditId" value="">
        <div class="run-form">
          <div class="form-row">
            <div class="form-group" style="flex: 1;">
              <label for="promptLabel">Label</label>
              <input type="text" id="promptLabel" placeholder="e.g. Action Scan">
            </div>
            <div class="form-group">
              <label for="promptToolType">Source</label>
              <select id="promptToolType">
                <option value="x_search">X Search</option>
                <option value="web_search">Web Search</option>
              </select>
            </div>
          </div>
          <div class="form-group">
            <label for="promptText">Prompt Text</label>
            <textarea id="promptText" rows="6" placeholder="Enter scan prompt..." style="width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-md); font-size: 13px; font-family: var(--font-mono); background: var(--bg); color: var(--text); resize: vertical;"></textarea>
          </div>
          <div class="form-group">
            <label for="promptResponseFormat">Response Format (optional)</label>
            <textarea id="promptResponseFormat" rows="3" placeholder="Optional structured output format..." style="width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-md); font-size: 13px; font-family: var(--font-mono); background: var(--bg); color: var(--text); resize: vertical;"></textarea>
          </div>
          <div class="prompt-lab">
            <div class="prompt-lab-header">
              <div>
                <h4>Prompt Lab</h4>
                <p class="form-description" style="margin: 6px 0 0;">Run the draft prompt to inspect actual yield, then ask Claude to critique and tighten it for higher-signal results.</p>
              </div>
              <div class="prompt-lab-actions">
                <button type="button" id="test-draft-prompt" class="button secondary">Run Test</button>
                <button type="button" id="review-draft-prompt" class="button secondary">Review with Claude</button>
              </div>
            </div>
            <div id="prompt-lab-status" class="form-description" aria-live="polite">Testing runs your current draft without saving it.</div>
            <div class="prompt-lab-grid">
              <section class="lab-panel">
                <h5>Test Yield</h5>
                <div id="prompt-test-results" class="lab-placeholder">Run Test to inspect the raw model output, parse count, and extracted opportunities.</div>
              </section>
              <section class="lab-panel">
                <h5>Claude Review</h5>
                <div id="prompt-review-results" class="lab-placeholder">Review with Claude to get feedback on signal quality, parseability, and a revised prompt draft.</div>
              </section>
            </div>
          </div>
          <div class="form-row" style="justify-content: flex-end; gap: 8px;">
            <button type="button" id="cancel-prompt" class="button secondary">Cancel</button>
            <button type="button" id="save-prompt" class="button">Save</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const pageHtml = renderPageShell({
    title: selectedFeed ? selectedFeed.displayName : 'Prompts',
    activePage: selectedFeed ? `feed:${selectedFeed.key}:prompts` : 'queue',
    description: selectedFeed ? `Prompts, scans, and forum runs for ${selectedFeed.displayName}.` : 'Manage scan prompts.',
    content,
    extraStyles,
    feeds,
    feedContext: selectedFeed ? {
      key: selectedFeed.key,
      displayName: selectedFeed.displayName,
      activeTab: 'prompts',
    } : undefined,
  });

  const scriptBlock = `
  <script>
    var FORUM_ENABLED = ${forumEnabled ? 'true' : 'false'};
    var FIXED_WIRE = ${JSON.stringify(selectedFeedKey)};

${CLIENT_ESCAPE_HTML}

    var wireSelect = document.getElementById('wireSelect');
    var promptsContent = document.getElementById('prompts-content');
    var promptsPlaceholder = document.getElementById('prompts-placeholder');
    function currentWire() {
      if (FIXED_WIRE) return FIXED_WIRE;
      return wireSelect ? wireSelect.value : '';
    }

    if (wireSelect) {
      var urlParams = new URLSearchParams(window.location.search);
      var wireParam = urlParams.get('wire');
      if (wireParam) {
        wireSelect.value = wireParam;
      }

      wireSelect.addEventListener('change', function() {
        if (currentWire()) {
          promptsContent.style.display = '';
          if (promptsPlaceholder) promptsPlaceholder.style.display = 'none';
          loadPrompts();
          history.replaceState(null, '', '/prompts?wire=' + encodeURIComponent(currentWire()));
        } else {
          promptsContent.style.display = 'none';
          if (promptsPlaceholder) promptsPlaceholder.style.display = '';
        }
      });
    }

    function scoreColor(score) {
      if (score == null) return 'var(--text-muted)';
      if (score >= 60) return 'var(--success)';
      if (score >= 40) return 'var(--accent)';
      return 'var(--error)';
    }

    // ---- Load all prompts for selected feed ----
    var allPrompts = [];

    async function loadPrompts() {
      if (!currentWire()) return;
      try {
        var resp = await fetch('/api/scan/prompts?wire=' + encodeURIComponent(currentWire()));
        if (!resp.ok) throw new Error('Failed');
        allPrompts = await resp.json();
        renderSourceCards();
        renderPromptSections();
      } catch(e) {
        console.error('Failed to load prompts:', e);
      }
    }

    function renderSourceCards() {
      var xCount = allPrompts.filter(function(p) { return p.toolType === 'x_search'; }).length;
      var webCount = allPrompts.filter(function(p) { return p.toolType === 'web_search'; }).length;
      var xActive = allPrompts.filter(function(p) { return p.toolType === 'x_search' && p.isActive; }).length;
      var webActive = allPrompts.filter(function(p) { return p.toolType === 'web_search' && p.isActive; }).length;

      var html = '';
      html += '<div class="source-card" data-source="x_search">';
      html += '<div class="source-label">X Search</div>';
      html += '<div class="source-meta">' + xCount + ' scan' + (xCount !== 1 ? 's' : '') + ' (' + xActive + ' active)</div>';
      html += '</div>';
      html += '<div class="source-card" data-source="web_search">';
      html += '<div class="source-label">Web Search</div>';
      html += '<div class="source-meta">' + webCount + ' scan' + (webCount !== 1 ? 's' : '') + ' (' + webActive + ' active)</div>';
      html += '</div>';
      if (FORUM_ENABLED) {
        html += '<div class="source-card" data-source="forum">';
        html += '<div class="source-label">Forums</div>';
        html += '<div class="source-meta">discuss.watch</div>';
        html += '</div>';
      }
      document.getElementById('source-cards').innerHTML = html;
    }

    function renderPromptSections() {
      renderPromptList('x_search');
      renderPromptList('web_search');
    }

    function renderPromptList(toolType) {
      var section = document.getElementById('section-' + toolType);
      var container = document.getElementById('prompts-' + toolType);
      var prompts = allPrompts.filter(function(p) { return p.toolType === toolType; });

      section.style.display = 'block';

      if (prompts.length === 0) {
        container.innerHTML = '<p style="color: var(--text-muted); font-size: 13px;">No prompts yet. Click "+ Add" to create one.</p>';
        return;
      }

      var html = '';
      prompts.forEach(function(p) {
        html += '<div class="prompt-card" data-id="' + escapeHtml(p.id) + '">';
        html += '<div class="prompt-header">';
        html += '<span class="prompt-label">' + escapeHtml(p.label || 'Untitled') + '</span>';
        if (p.variant) html += '<span class="prompt-variant">Variant ' + escapeHtml(p.variant) + '</span>';
        html += '<span class="prompt-status ' + (p.isActive ? 'active' : 'paused') + '">' + (p.isActive ? 'Active' : 'Paused') + '</span>';
        html += '</div>';
        html += '<div class="prompt-text">' + escapeHtml((p.promptText || '').substring(0, 120)) + '</div>';
        html += '<div class="prompt-actions">';
        html += '<button data-action="edit" data-id="' + p.id + '">Edit</button>';
        html += '<button data-action="test" data-id="' + p.id + '">Test</button>';
        html += '<button data-action="review" data-id="' + p.id + '">Review</button>';
        html += '<button data-action="toggle" data-id="' + p.id + '" data-active="' + p.isActive + '">' + (p.isActive ? 'Pause' : 'Activate') + '</button>';
        html += '<button data-action="delete" data-id="' + p.id + '" class="danger">Delete</button>';
        html += '</div>';
        html += '</div>';
      });
      container.innerHTML = html;
    }

    // ---- Prompt actions (event delegation) ----
    document.addEventListener('click', function(e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var action = btn.dataset.action;
      var id = btn.dataset.id;

      if (action === 'edit') editPrompt(id);
      else if (action === 'review') openPromptLab(id, 'review');
      else if (action === 'toggle') togglePrompt(id, btn.dataset.active === 'true');
      else if (action === 'test') openPromptLab(id, 'test');
      else if (action === 'delete') deletePrompt(id);
      else if (action === 'apply-review-prompt') applyReviewedPrompt();
      else if (action === 'apply-review-format') applyReviewedFormat();
    });

    async function togglePrompt(id, currentlyActive) {
      try {
        var resp = await fetch('/api/scan/prompts/' + id, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isActive: !currentlyActive })
        });
        if (!resp.ok) throw new Error('Failed');
        loadPrompts();
      } catch(e) {
        alert('Failed to toggle prompt');
      }
    }

    async function deletePrompt(id) {
      if (!confirm('Delete this prompt? This cannot be undone.')) return;
      try {
        var resp = await fetch('/api/scan/prompts/' + id, { method: 'DELETE' });
        if (!resp.ok) throw new Error('Failed');
        loadPrompts();
      } catch(e) {
        alert('Failed to delete prompt');
      }
    }

    // ---- Prompt form (add/edit) ----
    var promptOverlay = document.getElementById('prompt-form-overlay');
    var promptEditIdEl = document.getElementById('promptEditId');
    var promptLabelEl = document.getElementById('promptLabel');
    var promptToolTypeEl = document.getElementById('promptToolType');
    var promptTextEl = document.getElementById('promptText');
    var promptResponseFormatEl = document.getElementById('promptResponseFormat');
    var promptLabStatusEl = document.getElementById('prompt-lab-status');
    var promptTestResultsEl = document.getElementById('prompt-test-results');
    var promptReviewResultsEl = document.getElementById('prompt-review-results');
    var testDraftPromptBtn = document.getElementById('test-draft-prompt');
    var reviewDraftPromptBtn = document.getElementById('review-draft-prompt');
    var savePromptBtn = document.getElementById('save-prompt');
    var cancelPromptBtn = document.getElementById('cancel-prompt');
    var lastLabTestResult = null;
    var lastPromptReview = null;

    function openPromptForm(toolType, prompt) {
      if (prompt) {
        document.getElementById('prompt-form-title').textContent = 'Edit Prompt';
        promptEditIdEl.value = prompt.id;
        promptLabelEl.value = prompt.label || '';
        promptToolTypeEl.value = prompt.toolType || toolType;
        promptTextEl.value = prompt.promptText || '';
        promptResponseFormatEl.value = prompt.responseFormat || '';
      } else {
        document.getElementById('prompt-form-title').textContent = 'Add Prompt';
        promptEditIdEl.value = '';
        promptLabelEl.value = '';
        promptToolTypeEl.value = toolType;
        promptTextEl.value = '';
        promptResponseFormatEl.value = '';
      }
      resetPromptLab();
      promptOverlay.classList.add('visible');
    }

    function closePromptForm() {
      promptOverlay.classList.remove('visible');
      resetPromptLab();
    }

    function editPrompt(id) {
      var p = allPrompts.find(function(pr) { return pr.id === id; });
      if (p) openPromptForm(p.toolType, p);
    }

    function resetPromptLab(statusText) {
      lastLabTestResult = null;
      lastPromptReview = null;
      promptLabStatusEl.textContent = statusText || 'Testing runs your current draft without saving it.';
      promptTestResultsEl.className = 'lab-placeholder';
      promptTestResultsEl.innerHTML = 'Run Test to inspect the raw model output, parse count, and extracted opportunities.';
      promptReviewResultsEl.className = 'lab-placeholder';
      promptReviewResultsEl.innerHTML = 'Review with Claude to get feedback on signal quality, parseability, and a revised prompt draft.';
    }

    function getDraftPromptPayload() {
      return {
        wire: currentWire(),
        label: promptLabelEl.value.trim(),
        toolType: promptToolTypeEl.value,
        promptText: promptTextEl.value.trim(),
        responseFormat: promptResponseFormatEl.value.trim() || undefined
      };
    }

    function renderParsedResults(results) {
      if (!results || !results.length) {
        return '<p class="lab-placeholder" style="margin: 0;">The current output did not parse into opportunities. Tighten the response format or make the fields more explicit.</p>';
      }

      var html = '<div class="lab-parsed-list">';
      results.slice(0, 6).forEach(function(item, index) {
        html += '<article class="lab-result-card">';
        html += '<strong>' + escapeHtml(item.name || ('Result ' + (index + 1))) + '</strong>';
        html += '<div style="color: var(--text-secondary); font-size: 13px; line-height: 1.5;">' + escapeHtml(item.description || 'No description') + '</div>';
        html += '<div class="lab-result-meta">';
        html += 'Amount: ' + escapeHtml(item.amount || '—') + ' | ';
        html += 'Deadline: ' + escapeHtml(item.deadline || '—') + ' | ';
        html += 'URL: ' + escapeHtml(item.sourceUrl || '—');
        html += '</div>';
        html += '</article>';
      });
      html += '</div>';
      return html;
    }

    function renderPromptTestResults(data) {
      var html = '<div class="lab-meta">';
      html += '<span class="lab-metric"><strong>Model</strong> ' + escapeHtml(data.model || 'Unknown') + '</span>';
      html += '<span class="lab-metric"><strong>Tokens</strong> ' + escapeHtml(String(data.tokensUsed || '—')) + '</span>';
      html += '<span class="lab-metric"><strong>Parsed</strong> ' + escapeHtml(String(data.parsedCount || 0)) + '</span>';
      html += '</div>';
      html += '<div>' + renderParsedResults(data.parsedResults || []) + '</div>';
      html += '<div><h5 style="margin: 0 0 8px;">Raw Output</h5><pre class="lab-raw-output">' + escapeHtml(data.content || '') + '</pre></div>';
      promptTestResultsEl.className = '';
      promptTestResultsEl.innerHTML = html;
    }

    function renderReviewList(title, items) {
      var html = '<div>';
      html += '<h5 style="margin: 0 0 8px;">' + escapeHtml(title) + '</h5>';
      if (!items || !items.length) {
        html += '<p class="lab-placeholder" style="margin: 0;">No notes.</p>';
      } else {
        html += '<ul class="review-list">';
        items.forEach(function(item) {
          html += '<li>' + escapeHtml(item) + '</li>';
        });
        html += '</ul>';
      }
      html += '</div>';
      return html;
    }

    function reviewScoreColor(score) {
      if (score >= 80) return 'var(--success)';
      if (score >= 60) return 'var(--accent)';
      return 'var(--error)';
    }

    function renderPromptReview(data) {
      var html = '<div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">';
      html += '<span class="review-score" style="color: ' + reviewScoreColor(data.overallScore || 0) + '; border: 1px solid currentColor; background: transparent;">' + escapeHtml(String(data.overallScore || 0)) + '</span>';
      html += '<span class="lab-metric"><strong>Model</strong> ' + escapeHtml(data.model || 'Claude') + '</span>';
      html += '</div>';
      html += '<p class="review-summary">' + escapeHtml(data.summary || '') + '</p>';
      html += renderReviewList('Strengths', data.strengths || []);
      html += renderReviewList('Risks', data.risks || []);
      html += renderReviewList('Suggestions', data.suggestions || []);
      html += renderReviewList('Expected Improvements', data.expectedImprovements || []);
      html += '<div class="review-actions">';
      html += '<button type="button" data-action="apply-review-prompt">Apply Revised Prompt</button>';
      if (data.revisedResponseFormat) {
        html += '<button type="button" data-action="apply-review-format">Apply Revised Format</button>';
      }
      html += '</div>';
      promptReviewResultsEl.className = '';
      promptReviewResultsEl.innerHTML = html;
    }

    function applyReviewedPrompt() {
      if (!lastPromptReview || !lastPromptReview.revisedPromptText) return;
      promptTextEl.value = lastPromptReview.revisedPromptText;
      promptLabStatusEl.textContent = 'Applied Claude\\u2019s revised prompt to the editor. Re-run the lab before saving.';
      lastLabTestResult = null;
      promptTestResultsEl.className = 'lab-placeholder';
      promptTestResultsEl.innerHTML = 'Draft changed. Re-run Test to inspect the updated yield.';
    }

    function applyReviewedFormat() {
      if (!lastPromptReview) return;
      promptResponseFormatEl.value = lastPromptReview.revisedResponseFormat || '';
      promptLabStatusEl.textContent = 'Applied Claude\\u2019s revised response format. Re-run the lab before saving.';
      lastLabTestResult = null;
      promptTestResultsEl.className = 'lab-placeholder';
      promptTestResultsEl.innerHTML = 'Draft changed. Re-run Test to inspect the updated yield.';
    }

    async function runDraftPromptTest() {
      var payload = getDraftPromptPayload();
      if (!payload.promptText) {
        alert('Prompt text is required before testing.');
        return;
      }

      testDraftPromptBtn.disabled = true;
      testDraftPromptBtn.textContent = 'Testing\\u2026';
      promptLabStatusEl.textContent = 'Running the current draft through the selected scan tool...';

      try {
        var resp = await fetch('/api/scan/prompts/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        var data = await resp.json().catch(function() { return {}; });
        if (!resp.ok) throw new Error(data.error || 'Prompt test failed');
        lastLabTestResult = data;
        renderPromptTestResults(data);
        promptLabStatusEl.textContent = 'Test completed. Review the parsed yield, then ask Claude to critique the prompt.';
      } catch (e) {
        promptLabStatusEl.textContent = 'Test failed.';
        promptTestResultsEl.className = 'lab-placeholder';
        promptTestResultsEl.innerHTML = '<span style="color: var(--error);">Test failed: ' + escapeHtml(e.message || 'Unknown error') + '</span>';
      } finally {
        testDraftPromptBtn.disabled = false;
        testDraftPromptBtn.textContent = 'Run Test';
      }
    }

    async function runDraftPromptReview() {
      var payload = getDraftPromptPayload();
      if (!payload.promptText) {
        alert('Prompt text is required before review.');
        return;
      }

      if (lastLabTestResult) {
        payload.testOutput = lastLabTestResult.content;
        payload.parsedResults = lastLabTestResult.parsedResults;
      }

      reviewDraftPromptBtn.disabled = true;
      reviewDraftPromptBtn.textContent = 'Reviewing\\u2026';
      promptLabStatusEl.textContent = 'Claude is reviewing the draft prompt for signal quality and parseability...';

      try {
        var resp = await fetch('/api/scan/prompts/review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        var data = await resp.json().catch(function() { return {}; });
        if (!resp.ok) throw new Error(data.error || 'Prompt review failed');
        lastPromptReview = data;
        renderPromptReview(data);
        promptLabStatusEl.textContent = 'Claude review complete. Apply the revised draft if it improves the prompt.';
      } catch (e) {
        promptLabStatusEl.textContent = 'Review failed.';
        promptReviewResultsEl.className = 'lab-placeholder';
        promptReviewResultsEl.innerHTML = '<span style="color: var(--error);">Review failed: ' + escapeHtml(e.message || 'Unknown error') + '</span>';
      } finally {
        reviewDraftPromptBtn.disabled = false;
        reviewDraftPromptBtn.textContent = 'Review with Claude';
      }
    }

    async function openPromptLab(id, mode) {
      var p = allPrompts.find(function(pr) { return pr.id === id; });
      if (!p) return;
      openPromptForm(p.toolType, p);
      await runDraftPromptTest();
      if (mode === 'review') {
        await runDraftPromptReview();
      }
    }

    document.getElementById('add-prompt-x').addEventListener('click', function() { openPromptForm('x_search', null); });
    document.getElementById('add-prompt-web').addEventListener('click', function() { openPromptForm('web_search', null); });
    cancelPromptBtn.addEventListener('click', closePromptForm);
    promptOverlay.addEventListener('click', function(e) { if (e.target === promptOverlay) closePromptForm(); });
    testDraftPromptBtn.addEventListener('click', runDraftPromptTest);
    reviewDraftPromptBtn.addEventListener('click', runDraftPromptReview);
    [promptLabelEl, promptToolTypeEl, promptTextEl, promptResponseFormatEl].forEach(function(el) {
      el.addEventListener('input', function() { resetPromptLab('Draft changed. Re-run Test or Claude review before saving.'); });
      el.addEventListener('change', function() { resetPromptLab('Draft changed. Re-run Test or Claude review before saving.'); });
    });

    savePromptBtn.addEventListener('click', async function() {
      if (!currentWire()) return;
      var id = promptEditIdEl.value;
      var label = promptLabelEl.value.trim();
      var toolType = promptToolTypeEl.value;
      var promptText = promptTextEl.value.trim();
      var responseFormat = promptResponseFormatEl.value.trim();

      if (!label) { alert('Label is required'); return; }
      if (!promptText) { alert('Prompt text is required'); return; }

      savePromptBtn.disabled = true;
      savePromptBtn.textContent = 'Saving\\u2026';

      try {
        var body = {
          wire: currentWire(),
          label: label,
          toolType: toolType,
          promptText: promptText,
          responseFormat: responseFormat || undefined,
          isActive: true
        };

        var resp;
        if (id) {
          resp = await fetch('/api/scan/prompts/' + id, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
        } else {
          resp = await fetch('/api/scan/prompts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
        }

        if (!resp.ok) {
          var err = await resp.json();
          throw new Error(err.error || 'Failed to save');
        }

        closePromptForm();
        loadPrompts();
      } catch(e) {
        alert('Failed to save prompt: ' + e.message);
      } finally {
        savePromptBtn.disabled = false;
        savePromptBtn.textContent = 'Save';
      }
    });

    // ---- Run Scan (X Search + Web Search) ----
    var runScanBtn = document.getElementById('run-scan-btn');
    var scanProgress = document.getElementById('scan-progress');
    var scanBar = document.getElementById('scan-bar');
    var scanStep = document.getElementById('scan-step');
    var scanResult = document.getElementById('scan-result');

    runScanBtn.addEventListener('click', async function() {
      if (!currentWire()) return;
      runScanBtn.disabled = true;
      runScanBtn.textContent = 'Starting\\u2026';
      scanProgress.classList.add('visible');
      scanResult.classList.remove('visible');
      scanBar.style.width = '0%';
      scanStep.textContent = 'Initializing\\u2026';

      try {
        var resp = await fetch('/api/scan/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wire: currentWire() })
        });
        if (!resp.ok) {
          var data = await resp.json();
          throw new Error(data.error || 'Failed to start scan');
        }
        var result = await resp.json();
        runScanBtn.textContent = 'Running\\u2026';

        var evtSource = new EventSource('/api/job/' + result.jobId + '/progress');
        evtSource.onmessage = function(event) {
          try {
            var status = JSON.parse(event.data);
            if (status.progress) {
              var pct = status.progress.total > 0
                ? Math.round((status.progress.current / status.progress.total) * 100) : 0;
              scanBar.style.width = pct + '%';
              scanBar.parentElement.setAttribute('aria-valuenow', pct);
              scanStep.textContent = status.progress.step || '';
            }
            if (status.status === 'completed') {
              evtSource.close();
              scanProgress.classList.remove('visible');
              runScanBtn.disabled = false;
              runScanBtn.textContent = 'Run Now';

              var r = status.result;
              if (r) {
                var html = '<p style="color: var(--success); margin: 0 0 8px; font-weight: 600;">Scan complete!</p>';
                html += '<p style="color: var(--text); margin: 0; font-size: 13px;">';
                html += 'Prompts: ' + r.promptsExecuted + ' executed';
                if (r.promptsFailed > 0) html += ', <span style="color: var(--error);">' + r.promptsFailed + ' failed</span>';
                html += ' | Results: ' + r.totalResults;
                html += ' | ' + Math.round(r.totalDurationMs / 1000) + 's</p>';
                if (r.intakeSummary) {
                  html += '<p style="color: var(--text-secondary); margin: 4px 0 0; font-size: 13px;">Unique: ' + r.intakeSummary.newUnique + ' | Dups: ' + r.intakeSummary.duplicatesFound + ' | HQ: ' + r.intakeSummary.highQualityCount + '</p>';
                }
                scanResult.innerHTML = html;
              } else {
                scanResult.innerHTML = '<p style="color: var(--success); margin: 0;">Scan complete!</p>';
              }
              scanResult.classList.add('visible');
              loadPrompts();
            } else if (status.status === 'failed') {
              evtSource.close();
              scanProgress.classList.remove('visible');
              runScanBtn.disabled = false;
              runScanBtn.textContent = 'Run Now';
              scanResult.innerHTML = '<p style="color: var(--error); margin: 0;">Failed: ' + escapeHtml(status.error || 'Unknown') + '</p>';
              scanResult.classList.add('visible');
            }
          } catch(e) { console.error('SSE parse error:', e); }
        };
        evtSource.onerror = function() {
          evtSource.close();
          runScanBtn.disabled = false;
          runScanBtn.textContent = 'Run Now';
        };
      } catch(e) {
        scanProgress.classList.remove('visible');
        runScanBtn.disabled = false;
        runScanBtn.textContent = 'Run Now';
        scanResult.innerHTML = '<p style="color: var(--error); margin: 0;">Error: ' + escapeHtml(e.message) + '</p>';
        scanResult.classList.add('visible');
      }
    });

    // ---- Forum Scan ----
    ${forumEnabled ? `
    var runForumBtn = document.getElementById('run-forum-btn');
    var forumProgress = document.getElementById('forum-progress');
    var forumBar = document.getElementById('forum-bar');
    var forumStep = document.getElementById('forum-step');
    var forumResult = document.getElementById('forum-result');

    runForumBtn.addEventListener('click', async function() {
      if (!currentWire()) return;
      runForumBtn.disabled = true;
      runForumBtn.textContent = 'Starting\\u2026';
      forumProgress.classList.add('visible');
      forumResult.classList.remove('visible');
      forumBar.style.width = '0%';
      forumStep.textContent = 'Initializing\\u2026';

      try {
        var resp = await fetch('/api/forum/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wire: currentWire() })
        });
        if (!resp.ok) {
          var data = await resp.json();
          throw new Error(data.error || 'Failed to start forum scan');
        }
        var result = await resp.json();
        runForumBtn.textContent = 'Running\\u2026';

        var evtSource = new EventSource('/api/job/' + result.jobId + '/progress');
        evtSource.onmessage = function(event) {
          try {
            var status = JSON.parse(event.data);
            if (status.progress) {
              var pct = status.progress.total > 0
                ? Math.round((status.progress.current / status.progress.total) * 100) : 0;
              forumBar.style.width = pct + '%';
              forumBar.parentElement.setAttribute('aria-valuenow', pct);
              forumStep.textContent = status.progress.step || ('Progress: ' + pct + '%');
            }
            if (status.status === 'completed') {
              evtSource.close();
              forumProgress.classList.remove('visible');
              runForumBtn.disabled = false;
              runForumBtn.textContent = 'Run Forum Scan';

              var r = status.result || {};
              var intake = r.intakeSummary || {};
              var html = '<p style="color: var(--badge-forum-fg); margin: 0 0 8px; font-weight: 600;">Forum scan complete</p>';
              html += '<p style="color: var(--text); margin: 0; font-size: 13px;">';
              html += 'Results: ' + (r.totalResults || 0) + ' | ' + Math.round((r.durationMs || 0) / 1000) + 's</p>';
              html += '<p style="color: var(--text-secondary); margin: 4px 0 0; font-size: 13px;">';
              html += 'Unique: ' + (intake.newUnique || 0) + ' | Dups: ' + (intake.duplicatesFound || 0) + ' | HQ: ' + (intake.highQualityCount || 0) + '</p>';
              forumResult.innerHTML = html;
              forumResult.classList.add('visible');
            }
            if (status.status === 'failed') {
              evtSource.close();
              forumProgress.classList.remove('visible');
              runForumBtn.disabled = false;
              runForumBtn.textContent = 'Run Forum Scan';
              forumResult.innerHTML = '<p style="color: var(--error); margin: 0;">Failed: ' + escapeHtml(status.error || 'Unknown') + '</p>';
              forumResult.classList.add('visible');
            }
          } catch(e) { console.error('SSE parse error:', e); }
        };
        evtSource.onerror = function() {
          evtSource.close();
          runForumBtn.disabled = false;
          runForumBtn.textContent = 'Run Forum Scan';
        };
      } catch(e) {
        forumProgress.classList.remove('visible');
        runForumBtn.disabled = false;
        runForumBtn.textContent = 'Run Forum Scan';
        forumResult.innerHTML = '<p style="color: var(--error); margin: 0;">Error: ' + escapeHtml(e.message) + '</p>';
        forumResult.classList.add('visible');
      }
    });
    ` : ''}

    // ---- Prompt Stats ----
    var loadStatsBtn = document.getElementById('load-prompt-stats');
    var statsResultsEl = document.getElementById('prompt-stats-results');
    var statsDaysInput = document.getElementById('statsDays');

    function dupRateColor(rate) {
      if (rate < 0.3) return 'var(--success)';
      if (rate < 0.5) return 'var(--accent)';
      return 'var(--error)';
    }

    async function loadPromptStats() {
      if (!currentWire()) return;
      var days = statsDaysInput.value || '7';
      try {
        var resp = await fetch('/api/scan/prompt-stats?days=' + days + '&wire=' + encodeURIComponent(currentWire()));
        if (!resp.ok) throw new Error('Failed to load stats');
        var data = await resp.json();

        if (!data.prompts || data.prompts.length === 0) {
          statsResultsEl.innerHTML = '<p style="color: var(--text-muted);">No prompt data for this period.</p>';
          return;
        }

        var html = '<table><thead><tr><th>Label</th><th>Variant</th><th>Total</th><th>Unique</th><th>Dup Rate</th><th>Avg Score</th><th>HQ</th></tr></thead><tbody>';
        data.prompts.forEach(function(p) {
          var drc = dupRateColor(p.duplicateRate);
          html += '<tr>';
          html += '<td>' + escapeHtml(p.label) + '</td>';
          html += '<td>' + escapeHtml(p.variant || '-') + '</td>';
          html += '<td>' + p.totalResults + '</td>';
          html += '<td>' + p.uniqueResults + '</td>';
          html += '<td style="color: ' + drc + '; font-weight: 600;">' + (p.duplicateRate * 100).toFixed(0) + '%</td>';
          html += '<td style="color: ' + scoreColor(p.avgQualityScore) + ';">' + p.avgQualityScore.toFixed(1) + '</td>';
          html += '<td>' + p.highQualityCount + '</td>';
          html += '</tr>';
        });
        html += '</tbody></table>';

        if (data.overlapStats) {
          var os = data.overlapStats;
          html += '<p style="color: var(--text-secondary); font-size: 13px; margin-top: 12px;">Overlap: <span style="color: ' + dupRateColor(os.overlapRate) + '; font-weight: 600;">' + (os.overlapRate * 100).toFixed(0) + '%</span> (' + os.entriesFoundByMultiple + '/' + os.totalUniqueEntries + ' found by 2+ prompts)</p>';
        }

        statsResultsEl.innerHTML = html;
      } catch(e) {
        statsResultsEl.innerHTML = '<p style="color: var(--error);">Failed: ' + escapeHtml(e.message) + '</p>';
      }
    }

    loadStatsBtn.addEventListener('click', loadPromptStats);

    // Init: if wire pre-selected, load
    if (currentWire()) {
      promptsContent.style.display = '';
      if (promptsPlaceholder) promptsPlaceholder.style.display = 'none';
      loadPrompts();
    }
  </script>
</body>
</html>
  `;

  return pageHtml + scriptBlock.trim();
}
