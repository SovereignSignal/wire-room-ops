import { escapeHtml } from '../utils/html';
import { renderPageShell, FeedNav } from './shared';

export function renderQueuePage(feeds?: FeedNav[]): string {
  const extraStyles = `
    .status-grid {
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    }
    .status-item { text-align: center; }
    .status-item .value { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; font-family: var(--font-mono); font-feature-settings: 'tnum'; }
    .queue-tab-bar {
      display: flex;
      gap: 0;
      border-bottom: 2px solid var(--border);
      margin-bottom: 16px;
    }
    .queue-tab-bar button {
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      margin-bottom: -2px;
      padding: 10px 16px;
      color: var(--text-secondary);
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: color 0.2s, border-color 0.2s;
      font-family: var(--font-sans);
    }
    .queue-tab-bar button:hover { color: var(--text-secondary); }
    .queue-tab-bar button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .queue-tab-bar button.active { color: var(--accent); border-bottom-color: var(--accent); }
    details summary { cursor: pointer; color: var(--text-secondary); font-size: 14px; }
    details summary:hover { color: var(--accent); }
    details[open] summary { color: var(--accent); }
    .entry-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    @media (max-width: 768px) {
      .entry-grid { grid-template-columns: 1fr; }
    }
    .entry-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 0;
      overflow: hidden;
      transition: border-color 0.15s;
    }
    .entry-card:hover { border-color: #2a3a4d; }
    .entry-card .entry-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 8px;
    }
    .entry-card .entry-name {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      line-height: 1.35;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      flex: 1;
    }
    .entry-card .entry-score {
      font-size: 14px;
      font-weight: 700;
      font-family: var(--font-mono);
      flex-shrink: 0;
    }
    .entry-card .entry-desc {
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .entry-card .entry-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    .entry-card .meta-tag {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 160px;
    }
    .entry-card .entry-actions {
      display: flex;
      gap: 6px;
      margin-top: auto;
      padding-top: 4px;
    }
    .entry-card .entry-actions button {
      flex: 1;
      padding: 6px 0;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      transition: opacity 0.15s;
    }
    .entry-card .entry-actions button:hover { opacity: 0.85; }
    .entry-card .entry-actions button:disabled { opacity: 0.4; cursor: not-allowed; }
    .main-inner { max-width: 1100px; }
  `;

  const content = `
    <div class="card">
      <h2>Scan Queue</h2>
      <p class="form-description" style="margin-bottom: 16px;"><strong>Approve</strong> = queue for newsletter. <strong>Review Later</strong> = come back to this. <strong>Decline</strong> = not relevant.</p>

      <div id="stat-tiles" class="status-grid" style="margin-bottom: 16px;"></div>

      <div class="form-row" style="margin-bottom: 16px;">
        <div class="form-group">
          <label for="queueWire">Feed Filter</label>
          <select id="queueWire">
            <option value="">All Feeds</option>
          </select>
        </div>
        <div class="form-group">
          <label for="queueDate">Date</label>
          <select id="queueDate">
            <option value="">All Time</option>
          </select>
        </div>
        <button type="button" id="load-queue" class="button secondary">Refresh</button>
      </div>

      <div class="queue-tab-bar" id="tab-bar">
        <button class="active" data-tab="queued">Pending Review <span id="tab-count-queued"></span></button>
        <button data-tab="approved">Approved <span id="tab-count-approved"></span></button>
        <button data-tab="declined">Declined <span id="tab-count-declined"></span></button>
        <button data-tab="duplicate">Duplicates <span id="tab-count-duplicate"></span></button>
        <button data-tab="skipped">Review Later <span id="tab-count-skipped"></span></button>
      </div>

      <div id="queue-results">
        <p style="color: var(--text-muted);">Loading\u2026</p>
      </div>

      <details id="seeded-urls-details" style="margin-top: 24px;">
        <summary id="seeded-urls-summary">Seeded URLs (loading\u2026)</summary>
        <div id="seeded-urls-content" style="margin-top: 12px;">
          <p style="color: var(--text-muted);">Click to load\u2026</p>
        </div>
      </details>
    </div>
  `;

  const pageHtml = renderPageShell({
    title: 'Daily Queue',
    activePage: 'queue',
    content,
    extraStyles,
    feeds,
  });

  const scriptBlock = `
  <script>
    function escapeHtml(str) {
      var div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    var queueWireSelect = document.getElementById('queueWire');
    var queueDateSelect = document.getElementById('queueDate');
    var queueResultsEl = document.getElementById('queue-results');
    var loadQueueBtn = document.getElementById('load-queue');
    var activeTab = 'queued';

    // Add "Today" option client-side using local date
    var todayStr = new Date().toLocaleDateString('sv-SE');
    var todayOpt = document.createElement('option');
    todayOpt.value = todayStr;
    todayOpt.textContent = 'Today';
    queueDateSelect.appendChild(todayOpt);

    function scoreColor(score) {
      if (score == null) return 'var(--text-muted)';
      if (score >= 60) return 'var(--success)';
      if (score >= 40) return 'var(--accent)';
      return 'var(--error)';
    }

    function sourceBadge(scanSource) {
      var badges = {
        'x-scan': { label: 'X', bg: '#1a3a5c', color: '#5b9bd5' },
        'web-search': { label: 'Web', bg: '#1a3c2c', color: '#81c784' },
        'telegram': { label: 'TG', bg: '#1a3c3c', color: '#26c6da' },
        'email': { label: 'Email', bg: '#3c2a1a', color: '#ff9800' },
        'forum': { label: 'Forum', bg: '#1a2c3c', color: '#64b5f6' }
      };
      var b = badges[scanSource] || { label: scanSource || '?', bg: 'var(--border)', color: 'var(--text-secondary)' };
      return '<span style="background:' + b.bg + '; color:' + b.color + '; padding:2px 6px; border-radius:4px; font-size:11px; font-weight:600;">' + escapeHtml(b.label) + '</span>';
    }

    // Tab bar click
    document.getElementById('tab-bar').addEventListener('click', function(e) {
      var btn = e.target.closest('button[data-tab]');
      if (!btn) return;
      activeTab = btn.dataset.tab;
      document.querySelectorAll('#tab-bar button').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      loadEntries();
    });

    // Entry action (approve/reviewlater/decline/restore)
    document.addEventListener('click', function(e) {
      var btn = e.target.closest('.queue-action-btn');
      if (!btn) return;
      var entryId = parseInt(btn.dataset.entryId, 10);
      var action = btn.dataset.action;
      if (isNaN(entryId) || !action) return;
      btn.disabled = true;
      fetch('/api/scan/entries/' + entryId + '/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action })
      }).then(function(r) {
        if (!r.ok) throw new Error('Failed');
        loadStatusCounts();
        loadEntries();
      }).catch(function(err) {
        console.error('Action failed:', err);
        btn.disabled = false;
      });
    });

    function statusesForTab(tab) {
      if (tab === 'queued') return 'queued,scored';
      if (tab === 'approved') return 'approved';
      if (tab === 'declined') return 'declined,archived';
      if (tab === 'duplicate') return 'duplicate';
      if (tab === 'skipped') return 'skipped';
      return tab;
    }

    async function loadStatusCounts() {
      try {
        var params = new URLSearchParams();
        if (queueWireSelect.value) params.set('wire', queueWireSelect.value);
        if (queueDateSelect.value) params.set('date', queueDateSelect.value);

        var resp = await fetch('/api/scan/status-counts?' + params.toString());
        if (!resp.ok) return;
        var data = await resp.json();
        var c = data.counts || {};
        var queued = (c.queued || 0) + (c.scored || 0);
        var approved = c.approved || 0;
        var declined = (c.declined || 0) + (c.archived || 0);
        var dup = c.duplicate || 0;
        var skipped = c.skipped || 0;

        document.getElementById('tab-count-queued').textContent = '(' + queued + ')';
        document.getElementById('tab-count-approved').textContent = '(' + approved + ')';
        document.getElementById('tab-count-declined').textContent = '(' + declined + ')';
        document.getElementById('tab-count-duplicate').textContent = '(' + dup + ')';
        document.getElementById('tab-count-skipped').textContent = '(' + skipped + ')';

        var tilesHtml = '';
        tilesHtml += '<div class="status-item"><div class="label">Pending</div><div class="value" style="color: var(--accent);">' + queued + '</div></div>';
        tilesHtml += '<div class="status-item"><div class="label">Approved</div><div class="value" style="color: var(--success);">' + approved + '</div></div>';
        tilesHtml += '<div class="status-item"><div class="label">Declined</div><div class="value" style="color: var(--error);">' + declined + '</div></div>';
        tilesHtml += '<div class="status-item"><div class="label">Duplicates</div><div class="value" style="color: var(--text-secondary);">' + dup + '</div></div>';
        tilesHtml += '<div class="status-item"><div class="label">Review Later</div><div class="value" style="color: var(--text-secondary);">' + skipped + '</div></div>';
        tilesHtml += '<div class="status-item"><div class="label">Seeded URLs</div><div class="value" style="color: var(--text-muted);">' + (data.seededUrls || 0) + '</div></div>';
        document.getElementById('stat-tiles').innerHTML = tilesHtml;

        document.getElementById('seeded-urls-summary').textContent = 'Seeded URLs (' + (data.seededUrls || 0) + ' from existing wire content)';
      } catch (err) {
        console.error('Failed to load status counts:', err);
      }
    }

    async function loadEntries() {
      var params = new URLSearchParams();
      params.set('status', statusesForTab(activeTab));
      if (queueWireSelect.value) params.set('wire', queueWireSelect.value);
      if (queueDateSelect.value) params.set('date', queueDateSelect.value);
      params.set('limit', '100');

      try {
        var resp = await fetch('/api/scan/entries?' + params.toString());
        if (!resp.ok) throw new Error('Failed to load entries');
        var data = await resp.json();

        if (data.entries.length === 0) {
          queueResultsEl.innerHTML = '<p style="color: var(--text-muted);">No entries in this tab.</p>';
          return;
        }

        var isDup = activeTab === 'duplicate';
        var showRestore = activeTab === 'skipped' || activeTab === 'declined';
        var showActions = activeTab === 'queued';
        var html = '<div class="entry-grid">';
        data.entries.forEach(function(e) {
          var sc = scoreColor(e.quality_score);
          var desc = (e.description || '').length > 120 ? e.description.substring(0, 120) + '...' : (e.description || '');

          html += '<div class="entry-card">';

          html += '<div class="entry-header">';
          html += '<div class="entry-name">' + escapeHtml(e.name || '') + '</div>';
          if (!isDup && e.quality_score != null) {
            html += '<div class="entry-score" style="color:' + sc + ';">' + e.quality_score + '</div>';
          }
          html += '</div>';

          if (desc) {
            html += '<div class="entry-desc">' + escapeHtml(desc) + '</div>';
          }

          html += '<div class="entry-meta">';
          if (e.amount && e.amount !== '-') {
            var amt = e.amount.length > 20 ? e.amount.substring(0, 20) : e.amount;
            html += '<span class="meta-tag" style="background:#1a2c1a; color:var(--success);">' + escapeHtml(amt) + '</span>';
          }
          if (e.deadline && e.deadline !== '-') {
            var dl = e.deadline.length > 20 ? e.deadline.substring(0, 20) : e.deadline;
            html += '<span class="meta-tag" style="background:var(--bg-card); color:var(--text-secondary);">' + escapeHtml(dl) + '</span>';
          }
          html += '<code style="background:var(--bg-card); padding:2px 6px; border-radius:4px; font-size:11px;">' + escapeHtml(e.wire || '') + '</code>';
          html += sourceBadge(e.scan_source);
          if (e.source_url) {
            html += '<a href="' + escapeHtml(e.source_url) + '" target="_blank" rel="noopener" class="download-link" style="font-size:11px;">Link</a>';
          }
          html += '</div>';

          if (isDup && e.duplicate_reason) {
            html += '<div style="font-size:11px; color:var(--text-muted);">' + escapeHtml(e.duplicate_reason) + '</div>';
          }

          if (showActions) {
            html += '<div class="entry-actions">';
            html += '<button data-entry-id="' + parseInt(e.id) + '" data-action="approve" class="queue-action-btn" style="background:#1b5e20; color:var(--success);">Approve</button>';
            html += '<button data-entry-id="' + parseInt(e.id) + '" data-action="reviewlater" class="queue-action-btn" style="background:var(--border); color:var(--text-secondary);">Later</button>';
            html += '<button data-entry-id="' + parseInt(e.id) + '" data-action="decline" class="queue-action-btn" style="background:#4a1515; color:var(--error);">Decline</button>';
            html += '</div>';
          }
          if (showRestore) {
            html += '<div class="entry-actions">';
            html += '<button data-entry-id="' + parseInt(e.id) + '" data-action="restore" class="queue-action-btn" style="background:#1a3a5c; color:#5b9bd5;">Restore</button>';
            html += '</div>';
          }

          html += '</div>';
        });
        html += '</div>';
        html += '<p style="color:var(--text-muted); font-size:12px; margin-top:12px;">' + data.total + ' total entries</p>';
        queueResultsEl.innerHTML = html;
      } catch (err) {
        queueResultsEl.innerHTML = '<p style="color: var(--error);">Failed to load: ' + escapeHtml(err.message) + '</p>';
      }
    }

    // Seeded URLs lazy load
    var seededLoaded = false;
    document.getElementById('seeded-urls-details').addEventListener('toggle', function() {
      if (this.open && !seededLoaded) {
        seededLoaded = true;
        loadSeededUrls();
      }
    });

    async function loadSeededUrls() {
      var el = document.getElementById('seeded-urls-content');
      try {
        var params = new URLSearchParams();
        if (queueWireSelect.value) params.set('wire', queueWireSelect.value);
        params.set('limit', '100');
        var resp = await fetch('/api/scan/seen-urls?' + params.toString());
        if (!resp.ok) throw new Error('Failed');
        var data = await resp.json();
        if (data.urls.length === 0) {
          el.innerHTML = '<p style="color: var(--text-muted);">No seeded URLs found.</p>';
          return;
        }
        var html = '<table><thead><tr><th>URL</th><th>Wire</th><th>First Seen</th></tr></thead><tbody>';
        data.urls.forEach(function(u) {
          html += '<tr>';
          html += '<td style="font-size: 12px; word-break: break-all;"><a href="' + escapeHtml(u.url) + '" target="_blank" class="download-link">' + escapeHtml(u.url.length > 60 ? u.url.substring(0, 60) + '...' : u.url) + '</a></td>';
          html += '<td><code style="background: var(--bg); padding: 2px 6px; border-radius: 4px;">' + escapeHtml(u.wire || '') + '</code></td>';
          html += '<td style="font-size: 12px;">' + escapeHtml(u.first_seen_date || '-') + '</td>';
          html += '</tr>';
        });
        html += '</tbody></table>';
        if (data.total > data.urls.length) {
          html += '<p style="color: var(--text-muted); font-size: 12px; margin-top: 8px;">Showing ' + data.urls.length + ' of ' + data.total + '</p>';
        }
        el.innerHTML = html;
      } catch (err) {
        el.innerHTML = '<p style="color: var(--error);">Failed to load seeded URLs</p>';
      }
    }

    async function loadFeeds() {
      try {
        var response = await fetch('/api/feeds');
        if (!response.ok) throw new Error('Failed to fetch feeds');
        var feeds = await response.json();
        var options = '<option value="">All Feeds</option>';
        feeds.forEach(function(f) {
          options += '<option value="' + escapeHtml(f.key) + '">' + escapeHtml(f.displayName) + '</option>';
        });
        queueWireSelect.innerHTML = options;
      } catch (error) {
        console.error('Failed to load feeds:', error);
      }
    }

    loadQueueBtn.addEventListener('click', function() {
      seededLoaded = false;
      loadStatusCounts();
      loadEntries();
    });
    queueWireSelect.addEventListener('change', function() {
      seededLoaded = false;
      loadStatusCounts();
      loadEntries();
      if (document.getElementById('seeded-urls-details').open) {
        seededLoaded = true;
        loadSeededUrls();
      }
    });
    queueDateSelect.addEventListener('change', function() {
      loadStatusCounts();
      loadEntries();
    });

    // Auto-load on page open, pre-select wire from URL param if present
    loadFeeds().then(function() {
      var urlParams = new URLSearchParams(window.location.search);
      var wireParam = urlParams.get('wire');
      if (wireParam) {
        queueWireSelect.value = wireParam;
      }
      loadStatusCounts();
      loadEntries();
    });
  </script>
</body>
</html>
  `;

  return pageHtml + scriptBlock.trim();
}
