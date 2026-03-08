import { escapeHtml } from '../utils/html';
import { renderPageShell, FeedNav, CLIENT_ESCAPE_HTML } from './shared';

export function renderQueuePage(feeds?: FeedNav[]): string {
  const feedOptions = (feeds || []).map(feed =>
    `<option value="${escapeHtml(feed.key)}">${escapeHtml(feed.displayName)}</option>`
  ).join('');

  const extraStyles = `
    .queue-summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 12px;
    }
    .summary-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 14px 16px;
    }
    .summary-card .label {
      font-size: 10px;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-family: var(--font-mono);
      font-weight: 600;
      margin-bottom: 6px;
    }
    .summary-card .value {
      font-size: 24px;
      font-weight: 700;
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
    }
    .summary-card .value.pending { color: var(--accent); }
    .summary-card .value.approved { color: var(--success); }
    .summary-card .value.declined { color: var(--error); }
    .summary-card .value.muted { color: var(--text-secondary); }
    .filter-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr)) auto auto;
      gap: 12px;
      align-items: end;
      margin-bottom: 16px;
    }
    .filter-grid .form-group {
      min-width: 0;
    }
    .status-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    .status-tab {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--bg);
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      transition: border-color 0.15s, color 0.15s, background 0.15s;
      touch-action: manipulation;
    }
    .status-tab:hover {
      border-color: var(--accent);
      color: var(--text);
    }
    .status-tab.active {
      border-color: var(--accent);
      background: rgba(212,160,23,0.08);
      color: var(--accent);
    }
    .status-tab .count {
      min-width: 18px;
      text-align: center;
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
    }
    .workspace-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(320px, 420px);
      gap: 20px;
      align-items: start;
    }
    .results-panel,
    .detail-panel {
      margin-bottom: 0;
    }
    .results-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 16px;
    }
    .results-header h2,
    .detail-title {
      margin: 0 0 6px;
    }
    .pagination-controls {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .pagination-label {
      color: var(--text-secondary);
      font-size: 12px;
      font-family: var(--font-mono);
    }
    .entry-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .entry-row {
      width: 100%;
      text-align: left;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      border-radius: var(--radius-lg);
      padding: 14px 16px;
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
      touch-action: manipulation;
    }
    .entry-row:hover {
      border-color: var(--accent);
      background: rgba(212,160,23,0.03);
    }
    .entry-row.active {
      border-color: var(--accent);
      background: rgba(212,160,23,0.06);
    }
    .entry-row-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      margin-bottom: 8px;
    }
    .entry-row-name {
      font-size: 14px;
      font-weight: 600;
      line-height: 1.4;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .entry-row-score {
      flex: 0 0 auto;
      font-family: var(--font-mono);
      font-size: 14px;
      font-weight: 700;
    }
    .entry-row-desc {
      color: var(--text-secondary);
      font-size: 12px;
      line-height: 1.5;
      margin: 0 0 10px;
      overflow-wrap: anywhere;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .entry-meta,
    .detail-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      background: var(--bg-card);
      color: var(--text-secondary);
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .pill.amount {
      background: var(--badge-amount-bg);
      color: var(--success);
    }
    .pill.status-approved {
      background: rgba(74, 222, 128, 0.15);
      color: var(--success);
    }
    .pill.status-declined {
      background: rgba(239, 68, 68, 0.15);
      color: var(--error);
    }
    .pill.status-skipped,
    .pill.status-duplicate {
      background: rgba(122, 138, 154, 0.15);
      color: var(--text-secondary);
    }
    .pill.status-queued {
      background: rgba(212,160,23,0.12);
      color: var(--accent);
    }
    .detail-shell {
      position: relative;
    }
    .detail-backdrop {
      display: none;
    }
    .detail-panel {
      position: sticky;
      top: 0;
      min-height: 420px;
      max-height: calc(100vh - 96px);
      overflow: auto;
    }
    .detail-panel.empty {
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      text-align: center;
    }
    .detail-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      margin-bottom: 12px;
    }
    .detail-description {
      margin: 0 0 16px;
      color: var(--text-secondary);
      line-height: 1.6;
      overflow-wrap: anywhere;
    }
    .detail-section {
      padding-top: 16px;
      margin-top: 16px;
      border-top: 1px solid var(--border);
    }
    .detail-section h3 {
      margin: 0 0 12px;
      font-size: 11px;
      font-family: var(--font-mono);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-secondary);
    }
    .detail-meta {
      display: grid;
      gap: 10px;
    }
    .detail-meta-row {
      display: grid;
      grid-template-columns: 110px minmax(0, 1fr);
      gap: 12px;
      align-items: start;
    }
    .detail-meta-row .meta-label {
      color: var(--text-secondary);
      font-size: 12px;
      font-family: var(--font-mono);
    }
    .detail-meta-row .meta-value {
      color: var(--text);
      font-size: 13px;
      line-height: 1.5;
      overflow-wrap: anywhere;
    }
    .detail-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .detail-secondary-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 12px;
    }
    .detail-close {
      display: none;
      background: var(--border);
      border: none;
      border-radius: 999px;
      width: 32px;
      height: 32px;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
    }
    .detail-empty-title {
      font-size: 16px;
      margin: 0 0 8px;
      color: var(--text);
    }
    .queue-feedback {
      position: fixed;
      right: 16px;
      bottom: 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      z-index: 1600;
      pointer-events: none;
    }
    .toast {
      min-width: 260px;
      max-width: 360px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 12px 14px;
      box-shadow: 0 14px 30px rgba(0, 0, 0, 0.25);
      pointer-events: auto;
    }
    .toast.success {
      border-color: rgba(74, 222, 128, 0.4);
    }
    .toast.error {
      border-color: rgba(239, 68, 68, 0.4);
    }
    .toast-title {
      font-size: 13px;
      font-weight: 700;
      margin-bottom: 4px;
    }
    .toast-body {
      color: var(--text-secondary);
      font-size: 12px;
      line-height: 1.5;
      margin-bottom: 10px;
    }
    .toast-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .toast-action {
      background: var(--border);
      border: none;
      color: var(--text);
      border-radius: 999px;
      padding: 6px 10px;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      touch-action: manipulation;
    }
    .diagnostics-card {
      margin-top: 24px;
    }
    .diagnostics-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 16px;
    }
    .diagnostics-header h2 {
      margin: 0 0 6px;
    }
    .diagnostics-body[hidden] {
      display: none;
    }
    .diagnostics-summary {
      margin: 0 0 12px;
      color: var(--text-secondary);
      font-size: 13px;
    }
    .table-scroll {
      overflow-x: auto;
    }
    .queue-empty {
      padding: 32px 0;
      color: var(--text-muted);
      text-align: center;
    }
    @media (max-width: 1100px) {
      .filter-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr)) auto auto;
      }
    }
    @media (max-width: 960px) {
      .workspace-grid {
        grid-template-columns: 1fr;
      }
      .detail-backdrop.mobile-open {
        display: block;
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        z-index: 1000;
      }
      .detail-panel {
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        top: auto;
        max-height: 82vh;
        min-height: 260px;
        border-radius: 16px 16px 0 0;
        transform: translateY(105%);
        transition: transform 0.2s ease;
        z-index: 1001;
      }
      .detail-panel.mobile-open {
        transform: translateY(0);
      }
      .detail-close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
    }
    @media (max-width: 720px) {
      .filter-grid {
        grid-template-columns: 1fr;
      }
      .results-header,
      .diagnostics-header {
        flex-direction: column;
      }
      .detail-meta-row {
        grid-template-columns: 1fr;
        gap: 4px;
      }
      .queue-feedback {
        left: 16px;
        right: 16px;
      }
      .toast {
        min-width: 0;
        max-width: none;
      }
    }
    .main-inner { max-width: 1200px; }
  `;

  const content = `
    <div id="queue-feedback" class="queue-feedback" aria-live="polite" aria-atomic="true"></div>

    <div class="card">
      <div style="margin-bottom: 16px;">
        <h2 style="margin: 0 0 8px;">Review Workspace</h2>
        <p class="form-description">Triage entries quickly, keep your current view shareable, and move diagnostics out of the critical review path.</p>
      </div>
      <div id="queue-summary" class="queue-summary">
        <p class="form-description">Loading summary…</p>
      </div>
    </div>

    <div class="card">
      <div class="filter-grid">
        <div class="form-group">
          <label for="queueWire">Feed</label>
          <select id="queueWire" name="wire" autocomplete="off">
            <option value="">All Feeds</option>
            ${feedOptions}
          </select>
        </div>
        <div class="form-group">
          <label for="queuePrompt">Prompt</label>
          <select id="queuePrompt" name="promptId" autocomplete="off">
            <option value="">All Prompts</option>
          </select>
        </div>
        <div class="form-group">
          <label for="queueDate">Date</label>
          <input type="date" id="queueDate" name="date" autocomplete="off">
        </div>
        <button type="button" id="reset-filters" class="button secondary">Reset</button>
        <button type="button" id="copy-view-link" class="button secondary">Copy View Link</button>
      </div>

      <div class="status-tabs" id="queue-tabs" role="tablist" aria-label="Queue status views">
        <button type="button" class="status-tab" data-status="queued" aria-pressed="false">Pending Review <span class="count" id="tab-count-queued">0</span></button>
        <button type="button" class="status-tab" data-status="approved" aria-pressed="false">Approved <span class="count" id="tab-count-approved">0</span></button>
        <button type="button" class="status-tab" data-status="declined" aria-pressed="false">Declined <span class="count" id="tab-count-declined">0</span></button>
        <button type="button" class="status-tab" data-status="duplicate" aria-pressed="false">Duplicates <span class="count" id="tab-count-duplicate">0</span></button>
        <button type="button" class="status-tab" data-status="skipped" aria-pressed="false">Review Later <span class="count" id="tab-count-skipped">0</span></button>
      </div>
    </div>

    <div class="workspace-grid">
      <div class="card results-panel">
        <div class="results-header">
          <div>
            <h2 style="margin: 0 0 6px;">Queue Items</h2>
            <p id="queue-results-caption" class="form-description">Loading entries…</p>
          </div>
          <div class="pagination-controls">
            <button type="button" id="prev-page" class="button secondary">Previous</button>
            <span id="page-label" class="pagination-label">Page 1</span>
            <button type="button" id="next-page" class="button secondary">Next</button>
          </div>
        </div>
        <div id="queue-list" class="entry-list" aria-live="polite"></div>
      </div>

      <div class="detail-shell">
        <div class="detail-backdrop" id="detail-backdrop"></div>
        <aside id="queue-detail" class="card detail-panel empty" aria-live="polite"></aside>
      </div>
    </div>

    <div class="card diagnostics-card">
      <div class="diagnostics-header">
        <div>
          <h2>Diagnostics</h2>
          <p class="form-description">Seeded URLs from existing wire content live here so review stays focused on decision-making.</p>
        </div>
        <button type="button" id="toggle-diagnostics" class="button secondary">Show Seeded URLs</button>
      </div>
      <div id="diagnostics-body" class="diagnostics-body" hidden>
        <p id="seeded-urls-summary" class="diagnostics-summary">Loading diagnostics…</p>
        <div id="seeded-urls-content"></div>
      </div>
    </div>
  `;

  const pageHtml = renderPageShell({
    title: 'Queue',
    activePage: 'queue',
    description: 'Review pending opportunities, maintain a stable workflow, and share the exact state of your queue via URL.',
    content,
    extraStyles,
    feeds,
  });

  const scriptBlock = `
  <script>
${CLIENT_ESCAPE_HTML}

    var TAB_CONFIG = {
      queued: { label: 'Pending Review', statuses: 'queued,scored', empty: 'No entries are waiting for review in this view.' },
      approved: { label: 'Approved', statuses: 'approved', empty: 'No approved entries match this view.' },
      declined: { label: 'Declined', statuses: 'declined,archived', empty: 'No declined entries match this view.' },
      duplicate: { label: 'Duplicates', statuses: 'duplicate', empty: 'No duplicates match this view.' },
      skipped: { label: 'Review Later', statuses: 'skipped', empty: 'No deferred entries match this view.' }
    };
    var PAGE_SIZE = 25;
    var allPrompts = [];
    var currentEntries = [];
    var currentTotal = 0;
    var diagnosticsLoaded = false;
    var diagnosticsOpen = false;
    var mobileDetailOpen = false;
    var queueState = readStateFromUrl();

    var queueWireSelect = document.getElementById('queueWire');
    var queuePromptSelect = document.getElementById('queuePrompt');
    var queueDateInput = document.getElementById('queueDate');
    var queueListEl = document.getElementById('queue-list');
    var queueSummaryEl = document.getElementById('queue-summary');
    var queueDetailEl = document.getElementById('queue-detail');
    var queueCaptionEl = document.getElementById('queue-results-caption');
    var prevPageBtn = document.getElementById('prev-page');
    var nextPageBtn = document.getElementById('next-page');
    var pageLabelEl = document.getElementById('page-label');
    var queueTabsEl = document.getElementById('queue-tabs');
    var feedbackEl = document.getElementById('queue-feedback');
    var detailBackdropEl = document.getElementById('detail-backdrop');
    var copyViewLinkBtn = document.getElementById('copy-view-link');
    var resetFiltersBtn = document.getElementById('reset-filters');
    var diagnosticsBodyEl = document.getElementById('diagnostics-body');
    var toggleDiagnosticsBtn = document.getElementById('toggle-diagnostics');
    var seededSummaryEl = document.getElementById('seeded-urls-summary');
    var seededContentEl = document.getElementById('seeded-urls-content');

    function isMobileViewport() {
      return window.matchMedia('(max-width: 960px)').matches;
    }

    function normalizeStatus(status) {
      return TAB_CONFIG[status] ? status : 'queued';
    }

    function readStateFromUrl() {
      var params = new URLSearchParams(window.location.search);
      var status = normalizeStatus(params.get('status') || 'queued');
      var page = parseInt(params.get('page') || '1', 10);
      var entry = parseInt(params.get('entry') || '', 10);
      var date = params.get('date') || '';

      return {
        wire: params.get('wire') || '',
        promptId: params.get('promptId') || '',
        date: /^\\d{4}-\\d{2}-\\d{2}$/.test(date) ? date : '',
        status: status,
        page: Number.isFinite(page) && page > 0 ? page : 1,
        entry: Number.isFinite(entry) ? entry : null,
      };
    }

    function syncStateToUrl(replace) {
      var params = new URLSearchParams();
      params.set('status', queueState.status);
      params.set('page', String(queueState.page));
      if (queueState.wire) params.set('wire', queueState.wire);
      if (queueState.promptId) params.set('promptId', queueState.promptId);
      if (queueState.date) params.set('date', queueState.date);
      if (queueState.entry) params.set('entry', String(queueState.entry));
      var nextUrl = '/queue?' + params.toString();
      if (replace) {
        window.history.replaceState({}, '', nextUrl);
      } else {
        window.history.pushState({}, '', nextUrl);
      }
    }

    function applyStateToControls() {
      queueWireSelect.value = queueState.wire;
      renderPromptOptions();
      queuePromptSelect.value = queueState.promptId;
      queueDateInput.value = queueState.date;
      updateTabButtons();
    }

    function updateTabButtons() {
      queueTabsEl.querySelectorAll('[data-status]').forEach(function(button) {
        var isActive = button.dataset.status === queueState.status;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });
    }

    function getPromptLabel(promptId) {
      var match = allPrompts.find(function(prompt) { return prompt.id === promptId; });
      return match ? match.label : '';
    }

    function renderPromptOptions() {
      var filteredPrompts = queueState.wire
        ? allPrompts.filter(function(prompt) { return prompt.wire === queueState.wire; })
        : allPrompts;

      var options = '<option value="">All Prompts</option>';
      filteredPrompts.forEach(function(prompt) {
        var label = queueState.wire ? prompt.label : prompt.label + ' (' + prompt.wire + ')';
        options += '<option value="' + escapeHtml(prompt.id) + '">' + escapeHtml(label) + '</option>';
      });
      queuePromptSelect.innerHTML = options;

      if (queueState.promptId && !filteredPrompts.some(function(prompt) { return prompt.id === queueState.promptId; })) {
        queueState.promptId = '';
      }
    }

    function scoreColor(score) {
      if (score == null) return 'var(--text-muted)';
      if (score >= 60) return 'var(--success)';
      if (score >= 40) return 'var(--accent)';
      return 'var(--error)';
    }

    function sourceBadge(scanSource) {
      var badges = {
        'x-scan': { label: 'X', bg: 'var(--badge-x-bg)', color: 'var(--badge-x-fg)' },
        'web-search': { label: 'Web', bg: 'var(--badge-web-bg)', color: 'var(--badge-web-fg)' },
        telegram: { label: 'TG', bg: 'var(--badge-tg-bg)', color: 'var(--badge-tg-fg)' },
        email: { label: 'Email', bg: 'var(--badge-email-bg)', color: 'var(--badge-email-fg)' },
        forum: { label: 'Forum', bg: 'var(--badge-forum-bg)', color: 'var(--badge-forum-fg)' }
      };
      var badge = badges[scanSource] || { label: scanSource || '?', bg: 'var(--border)', color: 'var(--text-secondary)' };
      return '<span class="pill" style="background:' + badge.bg + '; color:' + badge.color + ';">' + escapeHtml(badge.label) + '</span>';
    }

    function promptBadge(promptId) {
      var label = getPromptLabel(promptId);
      if (!label) return '';
      return '<span class="pill" style="background: var(--badge-prompt-bg); color: var(--badge-prompt-fg);">' + escapeHtml(label) + '</span>';
    }

    function statusBadge(status) {
      var mapping = {
        queued: 'Pending Review',
        scored: 'Pending Review',
        approved: 'Approved',
        declined: 'Declined',
        archived: 'Declined',
        duplicate: 'Duplicate',
        skipped: 'Review Later'
      };
      var normalized = status === 'archived' ? 'declined' : (status === 'scored' ? 'queued' : status);
      return '<span class="pill status-' + escapeHtml(normalized || 'queued') + '">' + escapeHtml(mapping[status] || status || 'Unknown') + '</span>';
    }

    function renderDistributionPills(entry) {
      var statusMap = entry.distributionStatus || {};
      var channels = ['telegram', 'x', 'newsletter'];
      var labels = { telegram: 'TG', x: 'X', newsletter: 'NL' };
      return channels.map(function(channel) {
        var status = statusMap[channel] || 'none';
        var className = status === 'success' ? 'status-approved' : (status === 'failed' ? 'status-declined' : '');
        var label = labels[channel] + ': ' + (status === 'none' ? '—' : status);
        return '<span class="pill ' + className + '">' + escapeHtml(label) + '</span>';
      }).join('');
    }

    function renderSummaryCards(counts) {
      var queued = (counts.queued || 0) + (counts.scored || 0);
      var approved = counts.approved || 0;
      var declined = (counts.declined || 0) + (counts.archived || 0);
      var duplicate = counts.duplicate || 0;
      var skipped = counts.skipped || 0;

      queueSummaryEl.innerHTML =
        '<div class="summary-card"><div class="label">Pending</div><div class="value pending">' + queued + '</div></div>' +
        '<div class="summary-card"><div class="label">Approved</div><div class="value approved">' + approved + '</div></div>' +
        '<div class="summary-card"><div class="label">Declined</div><div class="value declined">' + declined + '</div></div>' +
        '<div class="summary-card"><div class="label">Duplicates</div><div class="value muted">' + duplicate + '</div></div>' +
        '<div class="summary-card"><div class="label">Review Later</div><div class="value muted">' + skipped + '</div></div>';

      document.getElementById('tab-count-queued').textContent = String(queued);
      document.getElementById('tab-count-approved').textContent = String(approved);
      document.getElementById('tab-count-declined').textContent = String(declined);
      document.getElementById('tab-count-duplicate').textContent = String(duplicate);
      document.getElementById('tab-count-skipped').textContent = String(skipped);
    }

    function renderQueueList() {
      if (currentEntries.length === 0) {
        queueListEl.innerHTML = '<div class="queue-empty">' + escapeHtml(TAB_CONFIG[queueState.status].empty) + '</div>';
        return;
      }

      var html = currentEntries.map(function(entry) {
        var isActive = queueState.entry === entry.id;
        var description = (entry.description || '').trim();
        var shortDescription = description.length > 160 ? description.substring(0, 157) + '…' : description;

        return '<button type="button" class="entry-row' + (isActive ? ' active' : '') + '" data-entry-id="' + entry.id + '">' +
          '<div class="entry-row-header">' +
            '<div class="entry-row-name">' + escapeHtml(entry.name || 'Untitled') + '</div>' +
            (entry.quality_score != null ? '<div class="entry-row-score" style="color:' + scoreColor(entry.quality_score) + ';">' + entry.quality_score + '</div>' : '') +
          '</div>' +
          (shortDescription ? '<p class="entry-row-desc">' + escapeHtml(shortDescription) + '</p>' : '') +
          '<div class="entry-meta">' +
            statusBadge(entry.status) +
            (entry.amount ? '<span class="pill amount">' + escapeHtml(entry.amount) + '</span>' : '') +
            (entry.deadline ? '<span class="pill">' + escapeHtml(entry.deadline) + '</span>' : '') +
            '<span class="pill">' + escapeHtml(entry.wire || '') + '</span>' +
            sourceBadge(entry.scan_source) +
            promptBadge(entry.prompt_id) +
            (queueState.status === 'approved' ? renderDistributionPills(entry) : '') +
          '</div>' +
        '</button>';
      }).join('');

      queueListEl.innerHTML = html;
    }

    function formatDate(value) {
      if (!value) return '—';
      var date = new Date(value);
      if (isNaN(date.getTime())) return value;
      return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
    }

    function entryActions(entry) {
      var actions = [];
      if (entry.status === 'queued' || entry.status === 'scored') {
        actions.push('<button type="button" class="button" data-queue-action="approve" data-entry-id="' + entry.id + '">Approve</button>');
        actions.push('<button type="button" class="button secondary" data-queue-action="reviewlater" data-entry-id="' + entry.id + '">Review Later</button>');
        actions.push('<button type="button" class="button secondary" data-queue-action="decline" data-entry-id="' + entry.id + '">Decline</button>');
      } else if (entry.status === 'approved' || entry.status === 'skipped' || entry.status === 'declined' || entry.status === 'archived') {
        actions.push('<button type="button" class="button secondary" data-queue-action="restore" data-entry-id="' + entry.id + '">Move Back To Queue</button>');
      }
      return actions.join('');
    }

    function renderDetail() {
      var selectedEntry = currentEntries.find(function(entry) { return entry.id === queueState.entry; });
      if (!selectedEntry) {
        queueDetailEl.className = 'card detail-panel empty';
        queueDetailEl.innerHTML =
          '<div>' +
            '<p class="detail-empty-title">Select an entry</p>' +
            '<p class="form-description">Choose an item from the left to inspect the full description, metadata, and available actions.</p>' +
          '</div>';
        closeMobileDetail();
        return;
      }

      queueDetailEl.className = 'card detail-panel' + (mobileDetailOpen ? ' mobile-open' : '');

      var metaRows = [
        { label: 'Feed', value: escapeHtml(selectedEntry.wire || '—') },
        { label: 'Source', value: escapeHtml(selectedEntry.scan_source || '—') },
        { label: 'Prompt', value: escapeHtml(getPromptLabel(selectedEntry.prompt_id) || '—') },
        { label: 'Amount', value: escapeHtml(selectedEntry.amount || '—') },
        { label: 'Deadline', value: escapeHtml(selectedEntry.deadline || '—') },
        { label: 'Scan Date', value: escapeHtml(selectedEntry.scan_date || formatDate(selectedEntry.created_at)) },
        { label: 'Created', value: escapeHtml(formatDate(selectedEntry.created_at)) }
      ];
      if (selectedEntry.duplicate_reason) {
        metaRows.push({ label: 'Duplicate Reason', value: escapeHtml(selectedEntry.duplicate_reason) });
      }

      var metaHtml = metaRows.map(function(row) {
        return '<div class="detail-meta-row"><div class="meta-label">' + row.label + '</div><div class="meta-value">' + row.value + '</div></div>';
      }).join('');

      var distributionSection = queueState.status === 'approved'
        ? '<div class="detail-section"><h3>Distribution</h3><div class="detail-badges">' + renderDistributionPills(selectedEntry) + '</div></div>'
        : '';

      queueDetailEl.innerHTML =
        '<div class="detail-head">' +
          '<div>' +
            '<div class="detail-badges" style="margin-bottom: 10px;">' +
              statusBadge(selectedEntry.status) +
              (selectedEntry.quality_score != null ? '<span class="pill" style="color:' + scoreColor(selectedEntry.quality_score) + ';">Score ' + selectedEntry.quality_score + '</span>' : '') +
            '</div>' +
            '<h2 class="detail-title">' + escapeHtml(selectedEntry.name || 'Untitled') + '</h2>' +
          '</div>' +
          '<button type="button" class="detail-close" id="close-detail" aria-label="Close entry details">&times;</button>' +
        '</div>' +
        (selectedEntry.description ? '<p class="detail-description">' + escapeHtml(selectedEntry.description) + '</p>' : '<p class="detail-description">No description provided.</p>') +
        '<div class="detail-actions">' + entryActions(selectedEntry) + '</div>' +
        '<div class="detail-secondary-actions">' +
          (selectedEntry.source_url ? '<a href="' + escapeHtml(selectedEntry.source_url) + '" target="_blank" rel="noopener" class="button secondary">Open Source</a>' : '') +
          '<button type="button" class="button secondary" id="copy-source-link" data-source-link="' + escapeHtml(selectedEntry.source_url || '') + '">Copy Source Link</button>' +
        '</div>' +
        '<div class="detail-section"><h3>Metadata</h3><div class="detail-meta">' + metaHtml + '</div></div>' +
        distributionSection;

      var closeBtn = document.getElementById('close-detail');
      if (closeBtn) {
        closeBtn.addEventListener('click', closeMobileDetail);
      }
      var copyBtn = document.getElementById('copy-source-link');
      if (copyBtn) {
        copyBtn.addEventListener('click', function() {
          var sourceLink = copyBtn.dataset.sourceLink;
          if (!sourceLink) return;
          navigator.clipboard.writeText(sourceLink).then(function() {
            showToast({ type: 'success', title: 'Copied source link', body: 'The source URL is on your clipboard.' });
          });
        });
      }
    }

    function updatePagination() {
      var totalPages = Math.max(1, Math.ceil(currentTotal / PAGE_SIZE));
      pageLabelEl.textContent = 'Page ' + queueState.page + ' of ' + totalPages;
      prevPageBtn.disabled = queueState.page <= 1;
      nextPageBtn.disabled = queueState.page >= totalPages;
    }

    function updateResultsCaption() {
      var totalPages = Math.max(1, Math.ceil(currentTotal / PAGE_SIZE));
      queueCaptionEl.textContent = TAB_CONFIG[queueState.status].label + ' • ' + currentTotal + ' total result' + (currentTotal === 1 ? '' : 's') + ' • page ' + queueState.page + ' of ' + totalPages;
    }

    async function loadPrompts() {
      try {
        var resp = await fetch('/api/scan/prompts');
        if (!resp.ok) throw new Error('Failed to load prompts');
        allPrompts = await resp.json();
        renderPromptOptions();
      } catch (error) {
        console.error('Failed to load prompts:', error);
      }
    }

    async function loadSummary() {
      var params = new URLSearchParams();
      if (queueState.wire) params.set('wire', queueState.wire);
      if (queueState.promptId) params.set('promptId', queueState.promptId);
      if (queueState.date) params.set('date', queueState.date);

      try {
        var resp = await fetch('/api/scan/status-counts?' + params.toString());
        if (!resp.ok) throw new Error('Failed to load summary');
        var data = await resp.json();
        renderSummaryCards(data.counts || {});
        seededSummaryEl.textContent = (data.seededUrls || 0) + ' seeded URL' + ((data.seededUrls || 0) === 1 ? '' : 's') + ' currently match this diagnostics view.';
      } catch (error) {
        console.error('Failed to load status counts:', error);
      }
    }

    function selectEntry(entryId, replace) {
      queueState.entry = entryId;
      syncStateToUrl(!!replace);
      if (isMobileViewport()) {
        mobileDetailOpen = true;
        queueDetailEl.classList.add('mobile-open');
        detailBackdropEl.classList.add('mobile-open');
      }
      renderQueueList();
      renderDetail();
    }

    function closeMobileDetail() {
      mobileDetailOpen = false;
      queueDetailEl.classList.remove('mobile-open');
      detailBackdropEl.classList.remove('mobile-open');
    }

    async function loadEntries() {
      queueListEl.innerHTML = '<div class="queue-empty">Loading entries…</div>';
      queueCaptionEl.textContent = 'Loading entries…';

      var params = new URLSearchParams();
      params.set('status', TAB_CONFIG[queueState.status].statuses);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String((queueState.page - 1) * PAGE_SIZE));
      params.set('includeDistributionStatus', '1');
      if (queueState.wire) params.set('wire', queueState.wire);
      if (queueState.promptId) params.set('promptId', queueState.promptId);
      if (queueState.date) params.set('date', queueState.date);

      try {
        var resp = await fetch('/api/scan/entries?' + params.toString());
        if (!resp.ok) throw new Error('Failed to load entries');
        var data = await resp.json();
        currentEntries = data.entries || [];
        currentTotal = data.total || 0;

        var totalPages = Math.max(1, Math.ceil(currentTotal / PAGE_SIZE));
        if (queueState.page > totalPages) {
          queueState.page = totalPages;
          syncStateToUrl(true);
          return loadEntries();
        }

        if (currentEntries.length === 0) {
          queueState.entry = null;
          syncStateToUrl(true);
        } else if (!currentEntries.some(function(entry) { return entry.id === queueState.entry; })) {
          queueState.entry = currentEntries[0].id;
          syncStateToUrl(true);
        }

        renderQueueList();
        renderDetail();
        updatePagination();
        updateResultsCaption();
      } catch (error) {
        queueListEl.innerHTML = '<div class="queue-empty" style="color: var(--error);">Failed to load entries.</div>';
        queueCaptionEl.textContent = 'Unable to load queue data.';
        console.error('Failed to load entries:', error);
      }
    }

    function renderSeededUrls(urls, total) {
      if (!urls.length) {
        seededContentEl.innerHTML = '<p class="form-description">No seeded URLs match the current feed filter.</p>';
        return;
      }

      var rows = urls.map(function(item) {
        var shortened = item.url.length > 80 ? item.url.substring(0, 77) + '…' : item.url;
        return '<tr>' +
          '<td style="font-size: 12px; word-break: break-all;"><a class="download-link" href="' + escapeHtml(item.url) + '" target="_blank" rel="noopener">' + escapeHtml(shortened) + '</a></td>' +
          '<td><span class="pill">' + escapeHtml(item.wire || '') + '</span></td>' +
          '<td>' + escapeHtml(item.first_seen_date || '—') + '</td>' +
        '</tr>';
      }).join('');

      var note = total > urls.length
        ? '<p class="form-description" style="margin-top: 12px;">Showing ' + urls.length + ' of ' + total + ' seeded URLs.</p>'
        : '';

      seededContentEl.innerHTML =
        '<div class="table-scroll"><table><thead><tr><th>URL</th><th>Feed</th><th>First Seen</th></tr></thead><tbody>' + rows + '</tbody></table></div>' + note;
    }

    async function loadSeededUrls() {
      if (!diagnosticsOpen) return;

      seededContentEl.innerHTML = '<p class="form-description">Loading diagnostics…</p>';
      var params = new URLSearchParams();
      params.set('limit', '50');
      if (queueState.wire) params.set('wire', queueState.wire);

      try {
        var resp = await fetch('/api/scan/seen-urls?' + params.toString());
        if (!resp.ok) throw new Error('Failed');
        var data = await resp.json();
        diagnosticsLoaded = true;
        renderSeededUrls(data.urls || [], data.total || 0);
      } catch (error) {
        seededContentEl.innerHTML = '<p class="form-description" style="color: var(--error);">Failed to load seeded URLs.</p>';
      }
    }

    function showToast(options) {
      var toast = document.createElement('div');
      toast.className = 'toast ' + (options.type || 'success');
      var actionsHtml = '';
      if (options.undo) {
        actionsHtml += '<button type="button" class="toast-action" data-toast-undo="true">Undo</button>';
      }
      actionsHtml += '<button type="button" class="toast-action" data-toast-close="true">Dismiss</button>';
      toast.innerHTML =
        '<div class="toast-title">' + escapeHtml(options.title) + '</div>' +
        '<div class="toast-body">' + escapeHtml(options.body || '') + '</div>' +
        '<div class="toast-actions">' + actionsHtml + '</div>';

      feedbackEl.appendChild(toast);

      var undoBtn = toast.querySelector('[data-toast-undo]');
      if (undoBtn) {
        undoBtn.addEventListener('click', function() {
          options.undo();
          toast.remove();
        });
      }
      var closeBtn = toast.querySelector('[data-toast-close]');
      if (closeBtn) {
        closeBtn.addEventListener('click', function() {
          toast.remove();
        });
      }

      setTimeout(function() {
        toast.remove();
      }, options.persistent ? 9000 : 5000);
    }

    async function performEntryAction(entryId, action, silentUndo) {
      try {
        var resp = await fetch('/api/scan/entries/' + entryId + '/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: action })
        });
        var data = await resp.json().catch(function() { return {}; });
        if (!resp.ok) throw new Error(data.error || 'Failed to update entry');

        if (!silentUndo) {
          if (action === 'restore') {
            showToast({
              type: 'success',
              title: 'Returned to queue',
              body: 'The entry is back in Pending Review.'
            });
          } else {
            var labels = { approve: 'Approved', reviewlater: 'Moved to Review Later', decline: 'Declined' };
            showToast({
              type: 'success',
              title: labels[action] || 'Updated',
              body: 'Undo returns the entry to Pending Review.',
              undo: function() {
                performEntryAction(entryId, 'restore', true);
              }
            });
          }
        }

        await Promise.all([loadSummary(), loadEntries()]);
        if (diagnosticsOpen) {
          loadSeededUrls();
        }
      } catch (error) {
        console.error('Failed to update entry:', error);
        showToast({
          type: 'error',
          title: 'Action failed',
          body: error.message || 'Unable to update this entry right now.',
          persistent: true
        });
      }
    }

    async function refreshQueue(replace) {
      syncStateToUrl(!!replace);
      applyStateToControls();
      await Promise.all([loadSummary(), loadEntries()]);
      if (diagnosticsOpen) {
        loadSeededUrls();
      }
    }

    queueTabsEl.addEventListener('click', function(event) {
      var button = event.target.closest('[data-status]');
      if (!button) return;
      queueState.status = normalizeStatus(button.dataset.status || 'queued');
      queueState.page = 1;
      queueState.entry = null;
      refreshQueue(false);
    });

    queueWireSelect.addEventListener('change', function() {
      queueState.wire = queueWireSelect.value;
      queueState.page = 1;
      queueState.entry = null;
      queueState.promptId = '';
      diagnosticsLoaded = false;
      refreshQueue(false);
    });

    queuePromptSelect.addEventListener('change', function() {
      queueState.promptId = queuePromptSelect.value;
      queueState.page = 1;
      queueState.entry = null;
      refreshQueue(false);
    });

    queueDateInput.addEventListener('change', function() {
      queueState.date = queueDateInput.value;
      queueState.page = 1;
      queueState.entry = null;
      refreshQueue(false);
    });

    resetFiltersBtn.addEventListener('click', function() {
      queueState = { wire: '', promptId: '', date: '', status: 'queued', page: 1, entry: null };
      diagnosticsLoaded = false;
      closeMobileDetail();
      refreshQueue(false);
    });

    copyViewLinkBtn.addEventListener('click', function() {
      navigator.clipboard.writeText(window.location.href).then(function() {
        showToast({
          type: 'success',
          title: 'Copied view link',
          body: 'This URL reopens the current queue view.'
        });
      });
    });

    prevPageBtn.addEventListener('click', function() {
      if (queueState.page <= 1) return;
      queueState.page -= 1;
      queueState.entry = null;
      refreshQueue(false);
    });

    nextPageBtn.addEventListener('click', function() {
      var totalPages = Math.max(1, Math.ceil(currentTotal / PAGE_SIZE));
      if (queueState.page >= totalPages) return;
      queueState.page += 1;
      queueState.entry = null;
      refreshQueue(false);
    });

    queueListEl.addEventListener('click', function(event) {
      var button = event.target.closest('[data-entry-id]');
      if (!button) return;
      selectEntry(parseInt(button.dataset.entryId, 10), false);
    });

    queueDetailEl.addEventListener('click', function(event) {
      var actionButton = event.target.closest('[data-queue-action]');
      if (!actionButton) return;
      var entryId = parseInt(actionButton.dataset.entryId, 10);
      var action = actionButton.dataset.queueAction;
      if (!entryId || !action) return;
      performEntryAction(entryId, action, false);
    });

    detailBackdropEl.addEventListener('click', closeMobileDetail);

    toggleDiagnosticsBtn.addEventListener('click', function() {
      diagnosticsOpen = !diagnosticsOpen;
      diagnosticsBodyEl.hidden = !diagnosticsOpen;
      toggleDiagnosticsBtn.textContent = diagnosticsOpen ? 'Hide Seeded URLs' : 'Show Seeded URLs';
      if (diagnosticsOpen && !diagnosticsLoaded) {
        loadSeededUrls();
      }
    });

    window.addEventListener('popstate', function() {
      queueState = readStateFromUrl();
      closeMobileDetail();
      refreshQueue(true);
    });

    loadPrompts().then(function() {
      applyStateToControls();
      return refreshQueue(true);
    });
  </script>
</body>
</html>
  `;

  return pageHtml + scriptBlock.trim();
}
