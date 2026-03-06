import { escapeHtml } from '../utils/html';
import { renderPageShell, FeedNav, CLIENT_ESCAPE_HTML } from './shared';

export function renderFeedPage(
  feedKey: string,
  feedDisplayName: string,
  feeds: FeedNav[],
  forumEnabled: boolean
): string {
  const extraStyles = `
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
    .progress-bar-fill.forum { background: #64b5f6; }
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

    /* Recent results */
    .recent-entry {
      display: flex;
      align-items: baseline;
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px solid var(--border);
      font-size: 13px;
    }
    .recent-entry:last-child { border-bottom: none; }
    .recent-entry .entry-score {
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 600;
      min-width: 32px;
    }
    .recent-entry .entry-name {
      flex: 1;
      color: var(--text);
    }
    .recent-entry .entry-amount {
      color: var(--text-secondary);
      font-family: var(--font-mono);
      font-size: 12px;
    }
  `;

  const content = `
    <!-- Stats row -->
    <div class="status-grid" style="margin-bottom: 24px;">
      <div class="status-item">
        <div class="label">Pending</div>
        <div class="value muted" id="stat-pending">--</div>
      </div>
      <div class="status-item">
        <div class="label">Approved</div>
        <div class="value muted" id="stat-approved">--</div>
      </div>
      <div class="status-item">
        <div class="label">Scanned Today</div>
        <div class="value muted" id="stat-today">--</div>
      </div>
      <div class="status-item">
        <div class="label">Active Prompts</div>
        <div class="value muted" id="stat-prompts">--</div>
      </div>
    </div>

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
          <button type="button" id="run-forum-btn" style="background: #0a1520; border: 1px solid #64b5f6; color: #64b5f6;">Run Forum Scan</button>
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

    <!-- Paste Intake (collapsible) -->
    <details class="card" style="margin-top: 32px;">
      <summary><h2>Paste Intake</h2></summary>
      <div style="margin-top: 16px;">
        <p class="form-description" style="margin-bottom: 16px;">Paste structured Grok scan output to ingest, deduplicate, and score entries.</p>
        <div class="run-form">
          <div class="form-row">
            <div class="form-group">
              <label for="scanMode">Mode</label>
              <select id="scanMode">
                <option value="single">Single Prompt</option>
                <option value="batch">Batch (All Prompts)</option>
              </select>
            </div>
            <div class="form-group" id="scanVariantGroup">
              <label for="scanVariant">Prompt Variant</label>
              <select id="scanVariant">
                <option value="A">A - Action</option>
                <option value="B">B - Landscape</option>
                <option value="C">C - Open Sweep</option>
              </select>
            </div>
            <div class="form-group">
              <label for="scanDate">Scan Date</label>
              <input type="date" id="scanDate" value="${new Date().toISOString().split('T')[0]}">
            </div>
          </div>
          <div class="form-group" style="margin-top: 12px;">
            <label for="scanRawText">Raw Scan Output</label>
            <textarea id="scanRawText" rows="8" placeholder="Paste structured Grok output here..." style="width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-md); font-size: 13px; font-family: var(--font-mono); background: var(--bg); color: var(--text); resize: vertical;"></textarea>
          </div>
          <div style="margin-top: 12px;">
            <button type="button" id="process-scan" class="button">Process Scan</button>
          </div>
        </div>
        <div class="result-box" id="paste-result"></div>
      </div>
    </details>

    <!-- Prompt Stats (collapsible) -->
    <details class="card">
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

    <!-- Recent Results -->
    <div class="card" style="margin-top: 8px;">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
        <h2 style="margin: 0;">Recent Results</h2>
        <a href="/queue?wire=${encodeURIComponent(feedKey)}" style="font-size: 13px; font-weight: 600;">View Queue &rarr;</a>
      </div>
      <div id="recent-results">
        <p style="color: var(--text-muted);">Loading\u2026</p>
      </div>
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
          <div class="form-row" style="justify-content: flex-end; gap: 8px;">
            <button type="button" id="cancel-prompt" class="button secondary">Cancel</button>
            <button type="button" id="save-prompt" class="button">Save</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const pageHtml = renderPageShell({
    title: feedDisplayName,
    activePage: `feed:${feedKey}`,
    content,
    extraStyles,
    feeds,
  });

  const scriptBlock = `
  <script>
    var FEED_KEY = ${JSON.stringify(feedKey)};
    var FORUM_ENABLED = ${forumEnabled ? 'true' : 'false'};

${CLIENT_ESCAPE_HTML}
    function scoreColor(score) {
      if (score == null) return 'var(--text-muted)';
      if (score >= 60) return 'var(--success)';
      if (score >= 40) return 'var(--accent)';
      return 'var(--error)';
    }

    // ---- Load all prompts for this feed ----
    var allPrompts = [];

    async function loadPrompts() {
      try {
        var resp = await fetch('/api/scan/prompts?wire=' + encodeURIComponent(FEED_KEY));
        if (!resp.ok) throw new Error('Failed');
        allPrompts = await resp.json();
        renderSourceCards();
        renderPromptSections();
        updateStatCards();
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
        html += '<button data-action="toggle" data-id="' + p.id + '" data-active="' + p.isActive + '">' + (p.isActive ? 'Pause' : 'Activate') + '</button>';
        html += '<button data-action="test" data-id="' + p.id + '">Test</button>';
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
      else if (action === 'toggle') togglePrompt(id, btn.dataset.active === 'true');
      else if (action === 'test') testPrompt(id, btn);
      else if (action === 'delete') deletePrompt(id);
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

    async function testPrompt(id, btn) {
      var origText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Testing\\u2026';
      try {
        var resp = await fetch('/api/scan/prompts/' + id + '/test', { method: 'POST' });
        var data = await resp.json();
        if (data.success) {
          btn.textContent = 'OK!';
          btn.style.color = 'var(--success)';
          setTimeout(function() { btn.textContent = origText; btn.style.color = ''; btn.disabled = false; }, 2000);
        } else {
          throw new Error(data.error || 'Test failed');
        }
      } catch(e) {
        alert('Test failed: ' + e.message);
        btn.textContent = origText;
        btn.disabled = false;
      }
    }

    // ---- Prompt form (add/edit) ----
    var promptOverlay = document.getElementById('prompt-form-overlay');
    var promptEditIdEl = document.getElementById('promptEditId');
    var promptLabelEl = document.getElementById('promptLabel');
    var promptToolTypeEl = document.getElementById('promptToolType');
    var promptTextEl = document.getElementById('promptText');
    var promptResponseFormatEl = document.getElementById('promptResponseFormat');
    var savePromptBtn = document.getElementById('save-prompt');
    var cancelPromptBtn = document.getElementById('cancel-prompt');

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
      promptOverlay.classList.add('visible');
    }

    function closePromptForm() {
      promptOverlay.classList.remove('visible');
    }

    function editPrompt(id) {
      var p = allPrompts.find(function(pr) { return pr.id === id; });
      if (p) openPromptForm(p.toolType, p);
    }

    document.getElementById('add-prompt-x').addEventListener('click', function() { openPromptForm('x_search', null); });
    document.getElementById('add-prompt-web').addEventListener('click', function() { openPromptForm('web_search', null); });
    cancelPromptBtn.addEventListener('click', closePromptForm);
    promptOverlay.addEventListener('click', function(e) { if (e.target === promptOverlay) closePromptForm(); });

    savePromptBtn.addEventListener('click', async function() {
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
          wire: FEED_KEY,
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
          body: JSON.stringify({ wire: FEED_KEY })
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
              loadRecentResults();
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
          body: JSON.stringify({ wire: FEED_KEY })
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
              var html = '<p style="color: #64b5f6; margin: 0 0 8px; font-weight: 600;">Forum scan complete</p>';
              html += '<p style="color: var(--text); margin: 0; font-size: 13px;">';
              html += 'Results: ' + (r.totalResults || 0) + ' | ' + Math.round((r.durationMs || 0) / 1000) + 's</p>';
              html += '<p style="color: var(--text-secondary); margin: 4px 0 0; font-size: 13px;">';
              html += 'Unique: ' + (intake.newUnique || 0) + ' | Dups: ' + (intake.duplicatesFound || 0) + ' | HQ: ' + (intake.highQualityCount || 0) + '</p>';
              forumResult.innerHTML = html;
              forumResult.classList.add('visible');
              loadRecentResults();
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

    // ---- Paste Intake ----
    var scanModeSelect = document.getElementById('scanMode');
    var scanVariantGroup = document.getElementById('scanVariantGroup');

    scanModeSelect.addEventListener('change', function() {
      scanVariantGroup.style.display = scanModeSelect.value === 'batch' ? 'none' : 'flex';
    });

    document.getElementById('process-scan').addEventListener('click', async function() {
      var btn = this;
      var mode = scanModeSelect.value;
      var variant = document.getElementById('scanVariant').value;
      var scanDate = document.getElementById('scanDate').value;
      var rawText = document.getElementById('scanRawText').value;
      var resultEl = document.getElementById('paste-result');

      if (!rawText.trim()) { alert('Please paste scan output'); return; }

      btn.disabled = true;
      btn.textContent = 'Processing\\u2026';
      resultEl.classList.add('visible');
      resultEl.innerHTML = '<p style="margin: 0; color: var(--accent);">Processing\\u2026</p>';

      try {
        var endpoint = mode === 'batch' ? '/api/scan/submit-batch' : '/api/scan/submit';
        var body = mode === 'batch'
          ? { wire: FEED_KEY, scanDate: scanDate, rawText: rawText }
          : { wire: FEED_KEY, promptVariant: variant, scanDate: scanDate, rawText: rawText };

        var response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        var data = await response.json();

        if (data.success && data.summary) {
          var s = data.summary;
          var html = '<p style="margin: 0 0 8px; color: var(--success); font-weight: 600;">Intake complete!</p>';
          html += '<p style="margin: 0; color: var(--text-secondary); font-size: 13px;">';
          html += 'Ingested: ' + s.totalIngested + ' | Dups: ' + s.duplicatesFound;
          html += ' | Unique: ' + s.newUnique + ' | Avg: ' + s.averageQualityScore;
          html += ' | HQ: ' + s.highQualityCount + '</p>';
          resultEl.innerHTML = html;
          loadRecentResults();
        } else {
          resultEl.innerHTML = '<p style="margin: 0; color: var(--error);">Error: ' + escapeHtml(data.error || 'Unknown') + '</p>';
        }
      } catch(e) {
        resultEl.innerHTML = '<p style="margin: 0; color: var(--error);">Error: ' + escapeHtml(e.message) + '</p>';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Process Scan';
      }
    });

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
      var days = statsDaysInput.value || '7';
      try {
        var resp = await fetch('/api/scan/prompt-stats?days=' + days + '&wire=' + encodeURIComponent(FEED_KEY));
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

    // ---- Stat cards ----
    async function updateStatCards() {
      // Pending count for this wire
      try {
        var resp = await fetch('/api/scan/entries?wire=' + encodeURIComponent(FEED_KEY) + '&status=queued,scored&limit=1');
        if (resp.ok) {
          var data = await resp.json();
          var el = document.getElementById('stat-pending');
          el.textContent = data.total.toString();
          el.className = 'value' + (data.total > 0 ? ' warning' : ' muted');
        }
      } catch(e) {}

      // Approved count
      try {
        var resp2 = await fetch('/api/scan/entries?wire=' + encodeURIComponent(FEED_KEY) + '&status=approved&limit=1');
        if (resp2.ok) {
          var data2 = await resp2.json();
          var el2 = document.getElementById('stat-approved');
          el2.textContent = data2.total.toString();
          el2.className = 'value' + (data2.total > 0 ? ' success' : ' muted');
        }
      } catch(e) {}

      // Scanned today
      try {
        var today = new Date().toISOString().split('T')[0];
        var resp3 = await fetch('/api/scan/entries?wire=' + encodeURIComponent(FEED_KEY) + '&status=raw,queued,scored,approved,declined,archived&date=' + today + '&limit=1');
        if (resp3.ok) {
          var data3 = await resp3.json();
          var el3 = document.getElementById('stat-today');
          el3.textContent = data3.total.toString();
          el3.className = 'value' + (data3.total > 0 ? ' success' : ' muted');
        }
      } catch(e) {}

      // Active prompts
      var activeCount = allPrompts.filter(function(p) { return p.isActive; }).length;
      var el4 = document.getElementById('stat-prompts');
      el4.textContent = activeCount.toString();
      el4.className = 'value' + (activeCount > 0 ? ' success' : ' muted');
    }

    // ---- Recent Results ----
    async function loadRecentResults() {
      var container = document.getElementById('recent-results');
      try {
        var resp = await fetch('/api/scan/entries?wire=' + encodeURIComponent(FEED_KEY) + '&status=queued,scored&limit=5');
        if (!resp.ok) throw new Error('Failed');
        var data = await resp.json();

        if (!data.entries || data.entries.length === 0) {
          container.innerHTML = '<p style="color: var(--text-muted); font-size: 13px;">No recent entries.</p>';
          return;
        }

        var html = '';
        data.entries.forEach(function(e) {
          html += '<div class="recent-entry">';
          html += '<span class="entry-score" style="color: ' + scoreColor(e.quality_score) + ';">' + (e.quality_score != null ? e.quality_score : '-') + '</span>';
          html += '<span class="entry-name">' + escapeHtml(e.name || 'Untitled') + '</span>';
          if (e.amount) html += '<span class="entry-amount">' + escapeHtml(e.amount) + '</span>';
          html += '</div>';
        });
        container.innerHTML = html;
      } catch(e) {
        container.innerHTML = '<p style="color: var(--error); font-size: 13px;">Failed to load.</p>';
      }
    }

    // ---- Init ----
    loadPrompts();
    loadRecentResults();
  </script>
</body>
</html>
  `;

  return pageHtml + scriptBlock.trim();
}
