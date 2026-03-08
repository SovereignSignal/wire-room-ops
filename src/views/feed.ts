import { escapeHtml } from '../utils/html';
import { renderPageShell, FeedNav, CLIENT_ESCAPE_HTML } from './shared';

export function renderFeedPage(
  feedKey: string,
  feedDisplayName: string,
  feeds: FeedNav[]
): string {
  const extraStyles = `
    .overview-hero {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
    }
    .hero-copy {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .hero-copy h2 {
      margin: 0;
    }
    .hero-actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .overview-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
      gap: 24px;
      align-items: start;
    }
    .stack-card {
      margin-bottom: 0;
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

    .result-box {
      display: none;
      margin-top: 16px;
      padding: 12px 16px;
      background: var(--bg);
      border-radius: var(--radius-lg);
      border: 1px solid var(--border);
    }
    .result-box.visible { display: block; }
    @media (max-width: 960px) {
      .overview-hero {
        flex-direction: column;
      }
      .hero-actions {
        justify-content: flex-start;
      }
      .overview-grid {
        grid-template-columns: 1fr;
      }
    }
  `;

  const content = `
    <div class="card overview-hero">
      <div class="hero-copy">
        <h2>What Needs Attention</h2>
        <p class="form-description">Track this feed’s pending queue, prompt coverage, and recent intake from one place.</p>
      </div>
      <div class="hero-actions">
        <a href="/queue?wire=${encodeURIComponent(feedKey)}&status=queued" class="button">Open Pending Queue</a>
        <a href="/queue?wire=${encodeURIComponent(feedKey)}&status=approved" class="button secondary">View Approved</a>
      </div>
    </div>

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

    <div class="overview-grid">
      <!-- Paste Intake (collapsible) -->
      <details class="card stack-card" open>
        <summary><h2>Manual Intake</h2></summary>
        <div style="margin-top: 16px;">
          <p class="form-description" style="margin-bottom: 16px;">Paste structured Grok scan output to ingest, deduplicate, and score entries for ${escapeHtml(feedDisplayName)}.</p>
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
              <textarea id="scanRawText" rows="8" placeholder="Paste structured Grok output here…" style="width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-md); font-size: 13px; font-family: var(--font-mono); background: var(--bg); color: var(--text); resize: vertical;"></textarea>
            </div>
            <div style="margin-top: 12px;">
              <button type="button" id="process-scan" class="button">Process Intake</button>
            </div>
          </div>
          <div class="result-box" id="paste-result" aria-live="polite"></div>
        </div>
      </details>

      <!-- Recent Results -->
      <div class="card stack-card">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; gap: 12px;">
          <div>
            <h2 style="margin: 0 0 6px;">Recent Queue Items</h2>
            <p class="form-description">The latest high-signal items waiting for review in this feed.</p>
          </div>
          <a href="/queue?wire=${encodeURIComponent(feedKey)}&status=queued" class="button secondary" style="white-space: nowrap;">Open Queue</a>
        </div>
        <div id="recent-results">
          <p style="color: var(--text-muted);">Loading\u2026</p>
        </div>
      </div>
    </div>
  `;

  const pageHtml = renderPageShell({
    title: feedDisplayName,
    activePage: `feed:${feedKey}`,
    description: `Overview, intake, and queue health for ${feedDisplayName}.`,
    content,
    extraStyles,
    feeds,
    feedContext: {
      key: feedKey,
      displayName: feedDisplayName,
      activeTab: 'overview',
    },
  });

  const scriptBlock = `
  <script>
    var FEED_KEY = ${JSON.stringify(feedKey)};

${CLIENT_ESCAPE_HTML}
    function scoreColor(score) {
      if (score == null) return 'var(--text-muted)';
      if (score >= 60) return 'var(--success)';
      if (score >= 40) return 'var(--accent)';
      return 'var(--error)';
    }

    // ---- Load prompts for source card counts ----
    var allPrompts = [];

    async function loadPrompts() {
      try {
        var resp = await fetch('/api/scan/prompts?wire=' + encodeURIComponent(FEED_KEY));
        if (!resp.ok) throw new Error('Failed');
        allPrompts = await resp.json();
        renderSourceCards();
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
      html += '<div class="source-card">';
      html += '<div class="source-label">X Search</div>';
      html += '<div class="source-meta">' + xCount + ' scan' + (xCount !== 1 ? 's' : '') + ' (' + xActive + ' active)</div>';
      html += '</div>';
      html += '<div class="source-card">';
      html += '<div class="source-label">Web Search</div>';
      html += '<div class="source-meta">' + webCount + ' scan' + (webCount !== 1 ? 's' : '') + ' (' + webActive + ' active)</div>';
      html += '</div>';
      document.getElementById('source-cards').innerHTML = html;
    }

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

    // ---- Stat cards ----
    async function updateStatCards() {
      try {
        var resp = await fetch('/api/scan/entries?wire=' + encodeURIComponent(FEED_KEY) + '&status=queued,scored&limit=1');
        if (resp.ok) {
          var data = await resp.json();
          var el = document.getElementById('stat-pending');
          el.textContent = data.total.toString();
          el.className = 'value' + (data.total > 0 ? ' warning' : ' muted');
        }
      } catch(e) {}

      try {
        var resp2 = await fetch('/api/scan/entries?wire=' + encodeURIComponent(FEED_KEY) + '&status=approved&limit=1');
        if (resp2.ok) {
          var data2 = await resp2.json();
          var el2 = document.getElementById('stat-approved');
          el2.textContent = data2.total.toString();
          el2.className = 'value' + (data2.total > 0 ? ' success' : ' muted');
        }
      } catch(e) {}

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
