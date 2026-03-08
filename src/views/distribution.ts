import { escapeHtml } from '../utils/html';
import { renderPageShell, FeedNav, CLIENT_ESCAPE_HTML } from './shared';

export function renderDistributionPage(feeds: FeedNav[], selectedFeed?: FeedNav): string {
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

    /* Section headers */
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }
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

    /* Distribution channel cards */
    .dist-channels {
      display: flex;
      gap: 12px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    .dist-channel-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 14px 18px;
      min-width: 160px;
      flex: 1;
    }
    .dist-channel-card .ch-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 6px;
    }
    .dist-channel-card .ch-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--text);
    }
    .dist-channel-card .ch-status {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      font-weight: 600;
    }
    .ch-status.enabled { background: rgba(74,222,128,0.15); color: var(--success); }
    .ch-status.disabled { background: rgba(122,138,154,0.15); color: var(--text-muted); }
    .dist-channel-card .ch-detail {
      font-size: 12px;
      color: var(--text-secondary);
      font-family: var(--font-mono);
    }
    .dist-channel-card .ch-actions {
      margin-top: 8px;
    }
    .dist-channel-card .ch-actions button {
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: var(--text-secondary);
      padding: 4px 10px;
      border-radius: var(--radius-md);
      font-size: 11px;
      cursor: pointer;
    }
    .dist-channel-card .ch-actions button:hover { color: var(--accent); border-color: var(--accent); }
    .newsletter-output {
      display: none;
      margin-top: 16px;
    }
    .newsletter-output.visible { display: block; }
    .newsletter-output pre {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 16px;
      font-size: 12px;
      font-family: var(--font-mono);
      color: var(--text);
      white-space: pre-wrap;
      word-wrap: break-word;
      max-height: 400px;
      overflow-y: auto;
    }

    /* Distribution config dialog */
    .dist-config-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.6);
      z-index: 2000;
      align-items: center;
      justify-content: center;
    }
    .dist-config-overlay.visible { display: flex; }
    .dist-config-dialog {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      padding: 28px;
      width: 480px;
      max-width: 95vw;
      max-height: 90vh;
      overflow-y: auto;
    }
    .dist-config-dialog h3 {
      margin: 0 0 20px;
      font-size: 18px;
      color: var(--text);
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

    <div id="dist-content"${selectedFeed ? '' : ' style="display: none;"'}>
      <div class="card">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
          <h2 style="margin: 0;">Channels</h2>
          <div class="section-actions">
            <button type="button" id="generate-newsletter-btn" class="button secondary" style="padding: 8px 16px; font-size: 12px;">Generate Newsletter</button>
            <button type="button" id="distribute-btn" class="button" style="padding: 8px 16px; font-size: 12px;">Distribute to Channels</button>
          </div>
        </div>
        <div class="dist-channels" id="dist-channels">
          <p style="color: var(--text-muted);">Loading channels\u2026</p>
        </div>
        <div class="result-box" id="dist-result"></div>
        <div class="newsletter-output" id="newsletter-output">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
            <span style="font-size: 13px; font-weight: 600; color: var(--text);">Newsletter Markdown</span>
            <button type="button" id="copy-newsletter-btn" style="background: var(--border); border: none; color: var(--text-secondary); padding: 4px 12px; border-radius: var(--radius-md); font-size: 11px; cursor: pointer;">Copy</button>
          </div>
          <pre id="newsletter-content"></pre>
        </div>
      </div>
    </div>

    <div id="dist-placeholder" class="placeholder-msg"${selectedFeed ? ' style="display: none;"' : ''}>
      Select a feed to manage distribution channels.
    </div>

    <!-- Distribution config dialog -->
    <div class="dist-config-overlay" id="dist-config-overlay">
      <div class="dist-config-dialog">
        <h3 id="dist-config-title">Configure Channel</h3>
        <input type="hidden" id="distConfigWire" value="">
        <input type="hidden" id="distConfigChannel" value="">
        <div class="run-form" id="dist-config-fields"></div>
        <div class="form-row" style="justify-content: space-between; margin-top: 20px;">
          <div class="form-group" style="flex-direction: row; align-items: center; gap: 8px;">
            <label for="distConfigEnabled" style="margin: 0;">Enabled</label>
            <input type="checkbox" id="distConfigEnabled">
          </div>
          <div style="display: flex; gap: 8px;">
            <button type="button" id="cancel-dist-config" class="button secondary">Cancel</button>
            <button type="button" id="save-dist-config" class="button">Save</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const pageHtml = renderPageShell({
    title: selectedFeed ? selectedFeed.displayName : 'Distribution',
    activePage: selectedFeed ? `feed:${selectedFeed.key}:distribution` : 'queue',
    description: selectedFeed ? `Channel configuration and newsletter generation for ${selectedFeed.displayName}.` : 'Manage distribution channels.',
    content,
    extraStyles,
    feeds,
    feedContext: selectedFeed ? {
      key: selectedFeed.key,
      displayName: selectedFeed.displayName,
      activeTab: 'distribution',
    } : undefined,
  });

  const scriptBlock = `
  <script>
${CLIENT_ESCAPE_HTML}

    var wireSelect = document.getElementById('wireSelect');
    var distContent = document.getElementById('dist-content');
    var distPlaceholder = document.getElementById('dist-placeholder');
    var FIXED_WIRE = ${JSON.stringify(selectedFeedKey)};
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
          distContent.style.display = '';
          if (distPlaceholder) distPlaceholder.style.display = 'none';
          loadDistConfigs();
          history.replaceState(null, '', '/distribution?wire=' + encodeURIComponent(currentWire()));
        } else {
          distContent.style.display = 'none';
          if (distPlaceholder) distPlaceholder.style.display = '';
        }
      });
    }

    // ---- Distribution ----
    var distChannelsEl = document.getElementById('dist-channels');
    var distResult = document.getElementById('dist-result');
    var distributeBtn = document.getElementById('distribute-btn');
    var newsletterBtn = document.getElementById('generate-newsletter-btn');
    var newsletterOutput = document.getElementById('newsletter-output');
    var newsletterContent = document.getElementById('newsletter-content');
    var copyNewsletterBtn = document.getElementById('copy-newsletter-btn');
    var distConfigOverlay = document.getElementById('dist-config-overlay');
    var distConfigWireEl = document.getElementById('distConfigWire');
    var distConfigChannelEl = document.getElementById('distConfigChannel');
    var distConfigFieldsEl = document.getElementById('dist-config-fields');
    var distConfigEnabledEl = document.getElementById('distConfigEnabled');
    var allDistConfigs = [];

    var CHANNEL_FIELDS = {
      telegram: [
        { key: 'channelId', label: 'Channel ID', placeholder: '@channel or -100xxx' }
      ],
      x: [
        { key: 'appKey', label: 'API Key', placeholder: 'App key' },
        { key: 'appSecret', label: 'API Secret', placeholder: 'App secret', secret: true },
        { key: 'accessToken', label: 'Access Token', placeholder: 'User access token', secret: true },
        { key: 'accessSecret', label: 'Access Secret', placeholder: 'User access secret', secret: true },
        { key: 'handle', label: 'Handle', placeholder: '@handle (display only)' }
      ],
      newsletter: [
        { key: 'title', label: 'Newsletter Title', placeholder: 'e.g. The Wire Room Weekly' }
      ]
    };

    async function loadDistConfigs() {
      if (!currentWire()) return;
      try {
        var resp = await fetch('/api/distribution/config?wire=' + encodeURIComponent(currentWire()));
        if (!resp.ok) throw new Error('Failed');
        allDistConfigs = await resp.json();
        renderDistChannels();
      } catch(e) {
        distChannelsEl.innerHTML = '<p style="color: var(--text-muted);">Failed to load distribution config.</p>';
      }
    }

    function getDistConfig(channel) {
      for (var i = 0; i < allDistConfigs.length; i++) {
        if (allDistConfigs[i].channel === channel) return allDistConfigs[i];
      }
      return null;
    }

    function renderDistChannels() {
      var channels = ['telegram', 'x', 'newsletter'];
      var labels = { telegram: 'Telegram', x: 'X / Twitter', newsletter: 'Newsletter' };
      var html = '';
      channels.forEach(function(ch) {
        var cfg = getDistConfig(ch);
        var enabled = cfg && cfg.enabled;
        var detail = '';
        if (ch === 'telegram' && cfg && cfg.config.channelId) detail = cfg.config.channelId;
        else if (ch === 'x' && cfg && cfg.config.handle) detail = cfg.config.handle;
        else if (ch === 'newsletter' && cfg && cfg.config.title) detail = cfg.config.title;
        else detail = 'Not configured';

        html += '<div class="dist-channel-card">';
        html += '<div class="ch-header">';
        html += '<span class="ch-name">' + escapeHtml(labels[ch]) + '</span>';
        html += '<span class="ch-status ' + (enabled ? 'enabled' : 'disabled') + '">' + (enabled ? 'On' : 'Off') + '</span>';
        html += '</div>';
        html += '<div class="ch-detail">' + escapeHtml(detail) + '</div>';
        html += '<div class="ch-actions"><button data-dist-config="' + ch + '">Configure</button></div>';
        html += '</div>';
      });
      distChannelsEl.innerHTML = html;
    }

    // Config dialog
    distChannelsEl.addEventListener('click', function(e) {
      var btn = e.target.closest('[data-dist-config]');
      if (!btn) return;
      openDistConfig(btn.dataset.distConfig);
    });

    function openDistConfig(channel) {
      if (!currentWire()) return;
      var cfg = getDistConfig(channel);
      var fields = CHANNEL_FIELDS[channel] || [];
      var labels = { telegram: 'Telegram', x: 'X / Twitter', newsletter: 'Newsletter' };

      document.getElementById('dist-config-title').textContent = 'Configure ' + labels[channel];
      distConfigWireEl.value = currentWire();
      distConfigChannelEl.value = channel;
      distConfigEnabledEl.checked = cfg ? cfg.enabled : false;

      var html = '';
      fields.forEach(function(f) {
        var val = cfg && cfg.config[f.key] ? cfg.config[f.key] : '';
        var type = f.secret ? 'password' : 'text';
        html += '<div class="form-group">';
        html += '<label for="dist-field-' + f.key + '">' + escapeHtml(f.label) + '</label>';
        html += '<input type="' + type + '" id="dist-field-' + f.key + '" data-field="' + f.key + '" placeholder="' + escapeHtml(f.placeholder || '') + '" value="' + escapeHtml(val) + '" style="padding:10px 12px; border:1px solid var(--border); border-radius:var(--radius-md); font-size:14px; background:var(--bg); color:var(--text);">';
        html += '</div>';
      });
      distConfigFieldsEl.innerHTML = html;
      distConfigOverlay.classList.add('visible');
    }

    function closeDistConfig() {
      distConfigOverlay.classList.remove('visible');
    }

    document.getElementById('cancel-dist-config').addEventListener('click', closeDistConfig);
    distConfigOverlay.addEventListener('click', function(e) { if (e.target === distConfigOverlay) closeDistConfig(); });

    document.getElementById('save-dist-config').addEventListener('click', async function() {
      if (!currentWire()) return;
      var channel = distConfigChannelEl.value;
      var enabled = distConfigEnabledEl.checked;
      var configData = {};
      var fieldInputs = distConfigFieldsEl.querySelectorAll('[data-field]');
      fieldInputs.forEach(function(input) {
        var val = input.value.trim();
        if (val && !val.startsWith('****')) {
          configData[input.dataset.field] = val;
        }
      });

      var saveBtn = this;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving\\u2026';

      try {
        var resp = await fetch('/api/distribution/config/' + encodeURIComponent(currentWire()) + '/' + channel, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: enabled, config: configData })
        });
        if (!resp.ok) {
          var err = await resp.json();
          throw new Error(err.error || 'Failed');
        }
        closeDistConfig();
        loadDistConfigs();
      } catch(e) {
        alert('Failed to save config: ' + e.message);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
    });

    // Distribute button
    distributeBtn.addEventListener('click', async function() {
      if (!currentWire()) return;
      distributeBtn.disabled = true;
      distributeBtn.textContent = 'Distributing\\u2026';
      distResult.classList.remove('visible');
      newsletterOutput.classList.remove('visible');

      try {
        var resp = await fetch('/api/distribution/run/' + encodeURIComponent(currentWire()), { method: 'POST' });
        var data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Failed');

        var html = '<p style="color: var(--success); margin: 0 0 8px; font-weight: 600;">Distribution complete</p>';
        html += '<p style="color: var(--text); margin: 0; font-size: 13px;">';
        html += 'Entries: ' + data.totalEntries + ' | Distributed: ' + data.distributed;
        if (data.failed > 0) html += ' | <span style="color: var(--error);">Failed: ' + data.failed + '</span>';
        if (data.skipped > 0) html += ' | Skipped: ' + data.skipped;
        html += '</p>';
        distResult.innerHTML = html;
        distResult.classList.add('visible');
      } catch(e) {
        distResult.innerHTML = '<p style="color: var(--error); margin: 0;">Error: ' + escapeHtml(e.message) + '</p>';
        distResult.classList.add('visible');
      } finally {
        distributeBtn.disabled = false;
        distributeBtn.textContent = 'Distribute to Channels';
      }
    });

    // Newsletter button
    newsletterBtn.addEventListener('click', async function() {
      if (!currentWire()) return;
      newsletterBtn.disabled = true;
      newsletterBtn.textContent = 'Generating\\u2026';
      newsletterOutput.classList.remove('visible');
      distResult.classList.remove('visible');

      try {
        var resp = await fetch('/api/distribution/newsletter/' + encodeURIComponent(currentWire()));
        var data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Failed');

        newsletterContent.textContent = data.markdown;
        newsletterOutput.classList.add('visible');
      } catch(e) {
        distResult.innerHTML = '<p style="color: var(--error); margin: 0;">Error: ' + escapeHtml(e.message) + '</p>';
        distResult.classList.add('visible');
      } finally {
        newsletterBtn.disabled = false;
        newsletterBtn.textContent = 'Generate Newsletter';
      }
    });

    // Copy newsletter
    copyNewsletterBtn.addEventListener('click', function() {
      var text = newsletterContent.textContent;
      navigator.clipboard.writeText(text).then(function() {
        copyNewsletterBtn.textContent = 'Copied!';
        setTimeout(function() { copyNewsletterBtn.textContent = 'Copy'; }, 2000);
      });
    });

    // Init: if wire pre-selected, load
    if (currentWire()) {
      distContent.style.display = '';
      if (distPlaceholder) distPlaceholder.style.display = 'none';
      loadDistConfigs();
    }
  </script>
</body>
</html>
  `;

  return pageHtml + scriptBlock.trim();
}
