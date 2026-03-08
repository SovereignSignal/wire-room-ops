import { escapeHtml } from '../utils/html';
import { renderPageShell, FeedNav, CLIENT_ESCAPE_HTML } from './shared';

export function renderSettingsPage(feeds?: FeedNav[]): string {
  const extraStyles = `
    .badge {
      display: inline-block;
      background: var(--border);
      color: var(--text-secondary);
      font-size: 12px;
      padding: 2px 8px;
      border-radius: 10px;
      margin-left: 8px;
      font-weight: 600;
      font-family: var(--font-mono);
    }
    .scheduler-health {
      margin-top: 24px;
      padding-top: 24px;
      border-top: 1px solid var(--border);
    }
    .scheduler-health h3 {
      margin: 0 0 16px;
      font-size: 11px;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-family: var(--font-mono);
      font-weight: 500;
    }
    .status-item .error-msg {
      font-size: 12px;
      color: var(--error);
      margin-top: 4px;
      font-family: var(--font-mono);
      font-feature-settings: 'tnum';
      word-break: break-word;
    }
    .save-success {
      color: var(--success) !important;
      font-weight: 500;
    }
    .model-row { margin-top: 8px; }
  `;

  const content = `
    <!-- Scheduled Runs -->
    <div class="card">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
        <h2 style="margin: 0;">Scheduled Runs <span class="badge" id="schedule-count-badge">--</span></h2>
        <button type="button" id="add-schedule" class="button" style="padding: 8px 16px; font-size: 13px;">+ Add Schedule</button>
      </div>
      <div id="schedules-list"></div>

      <div id="schedule-form" class="run-form" style="display: none; margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border);">
        <input type="hidden" id="scheduleId" value="">
        <div class="form-row">
          <div class="form-group">
            <label for="scheduleName">Name</label>
            <input type="text" id="scheduleName" value="New Schedule" style="width: 150px;">
          </div>
          <div class="form-group">
            <label for="scheduleType">Type</label>
            <select id="scheduleType">
              <option value="scan-execution">Scan Execution</option>
              <option value="forum-scan">Forum Scan</option>
            </select>
          </div>
          <div class="form-group" id="scheduleFrequencyGroup" style="display: none;">
            <label for="scheduleFrequency">Frequency</label>
            <select id="scheduleFrequency">
              <option value="">Once daily</option>
              <option value="2">Every 2h</option>
              <option value="3">Every 3h</option>
              <option value="4">Every 4h</option>
              <option value="6">Every 6h</option>
              <option value="8">Every 8h</option>
              <option value="12">Every 12h</option>
            </select>
          </div>
          <div class="form-group">
            <label for="scheduleEnabled">Status</label>
            <select id="scheduleEnabled">
              <option value="false">Disabled</option>
              <option value="true">Enabled</option>
            </select>
          </div>
          <div class="form-group" id="scheduleDayOfWeekGroup">
            <label for="scheduleDayOfWeek">Day of Week</label>
            <select id="scheduleDayOfWeek">
              <option value="0">Sunday</option>
              <option value="1">Monday</option>
              <option value="2">Tuesday</option>
              <option value="3">Wednesday</option>
              <option value="4">Thursday</option>
              <option value="5">Friday</option>
              <option value="6">Saturday</option>
            </select>
          </div>
          <div class="form-group">
            <label for="scheduleTime">Time</label>
            <input type="time" id="scheduleTime" value="09:00">
            <p id="time-hint" style="display: none; color: var(--accent); font-size: 11px; margin: 4px 0 0;">Only the minute is used when frequency is set</p>
          </div>
          <div class="form-group">
            <label for="scheduleLookback">Lookback Days</label>
            <input type="number" id="scheduleLookback" min="1" max="30" value="7" style="width: 80px;">
          </div>
          <div class="form-group">
            <label for="scheduleTimezone">Timezone</label>
            <select id="scheduleTimezone">
              <option value="America/Los_Angeles">Pacific (LA)</option>
              <option value="America/Denver">Mountain (Denver)</option>
              <option value="America/Chicago">Central (Chicago)</option>
              <option value="America/New_York">Eastern (NY)</option>
              <option value="UTC">UTC</option>
              <option value="Europe/London">London</option>
              <option value="Europe/Paris">Paris</option>
              <option value="Asia/Tokyo">Tokyo</option>
              <option value="Asia/Singapore">Singapore</option>
            </select>
          </div>
        </div>
        <div class="form-row model-row">
          <div class="form-group">
            <label for="scheduleWire">Feed</label>
            <select id="scheduleWire">
              <option value="">Loading feeds\u2026</option>
            </select>
          </div>
          <div class="form-group">
            <label for="scheduleGrokModel">Grok Model</label>
            <select id="scheduleGrokModel">
              <option value="">Loading\u2026</option>
            </select>
          </div>
          <div class="form-group">
            <label for="scheduleAnthropicModel">Claude Model</label>
            <select id="scheduleAnthropicModel">
              <option value="">Loading\u2026</option>
            </select>
          </div>
          <button type="button" id="save-schedule" class="button">Save</button>
          <button type="button" id="cancel-schedule" class="button secondary">Cancel</button>
        </div>
        <div class="form-row" id="scheduleNotifyRow" style="display: none; margin-top: 12px;">
          <div class="form-group" style="flex: 1;">
            <label for="scheduleNotifyEmails">Notify Emails (comma-separated, empty = default)</label>
            <input type="text" id="scheduleNotifyEmails" placeholder="user@example.com, other@..." style="width: 100%;">
          </div>
        </div>
      </div>

      <div style="margin-top: 16px;">
        <button type="button" id="test-alert" class="button secondary">Test Alert Email</button>
      </div>

      <div class="scheduler-health">
        <h3>Scheduler Health <button id="refresh-status" class="refresh-btn">Refresh</button></h3>
        <div class="status-grid">
          <div class="status-item">
            <div class="label">Scheduler Status</div>
            <div id="scheduler-running" class="value muted">Loading\u2026</div>
          </div>
          <div class="status-item">
            <div class="label">Server Started</div>
            <div id="scheduler-started" class="value muted">Loading\u2026</div>
          </div>
          <div class="status-item">
            <div class="label">Last Job Run</div>
            <div id="last-job-run" class="value muted">Loading\u2026</div>
          </div>
          <div class="status-item">
            <div class="label">Last Job Result</div>
            <div id="last-job-status" class="value muted">Loading\u2026</div>
            <div id="last-job-error" class="error-msg" style="display: none;"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  const pageHtml = renderPageShell({
    title: 'Schedules',
    activePage: 'schedules',
    content,
    extraStyles,
    feeds,
  });

  const scriptBlock = `
  <script>
${CLIENT_ESCAPE_HTML}

    // ============= Schedule Management =============
    var schedulesListEl = document.getElementById('schedules-list');
    var scheduleForm = document.getElementById('schedule-form');
    var scheduleIdEl = document.getElementById('scheduleId');
    var scheduleNameEl = document.getElementById('scheduleName');
    var scheduleTypeSelect = document.getElementById('scheduleType');
    var scheduleEnabledEl = document.getElementById('scheduleEnabled');
    var scheduleDayOfWeekEl = document.getElementById('scheduleDayOfWeek');
    var scheduleDayOfWeekGroup = document.getElementById('scheduleDayOfWeekGroup');
    var scheduleTimeEl = document.getElementById('scheduleTime');
    var scheduleLookbackEl = document.getElementById('scheduleLookback');
    var scheduleGrokModelEl = document.getElementById('scheduleGrokModel');
    var scheduleAnthropicModelEl = document.getElementById('scheduleAnthropicModel');
    var scheduleWireEl = document.getElementById('scheduleWire');
    var scheduleTimezoneEl = document.getElementById('scheduleTimezone');
    var saveScheduleBtn = document.getElementById('save-schedule');
    var cancelScheduleBtn = document.getElementById('cancel-schedule');
    var addScheduleBtn = document.getElementById('add-schedule');
    var scheduleFrequencyGroup = document.getElementById('scheduleFrequencyGroup');
    var scheduleFrequencySelect = document.getElementById('scheduleFrequency');
    var scheduleNotifyRow = document.getElementById('scheduleNotifyRow');
    var scheduleNotifyEmailsEl = document.getElementById('scheduleNotifyEmails');
    var scheduleCountBadge = document.getElementById('schedule-count-badge');

    function toggleScheduleTypeFields() {
      var isScan = scheduleTypeSelect.value === 'scan-execution' || scheduleTypeSelect.value === 'forum-scan';
      scheduleDayOfWeekGroup.style.display = isScan ? 'none' : '';
      scheduleFrequencyGroup.style.display = isScan ? '' : 'none';
      scheduleNotifyRow.style.display = isScan ? '' : 'none';
      document.getElementById('time-hint').style.display = isScan && scheduleFrequencySelect.value ? '' : 'none';
    }
    scheduleTypeSelect.addEventListener('change', toggleScheduleTypeFields);
    scheduleFrequencySelect.addEventListener('change', toggleScheduleTypeFields);

    var cachedWires = [];
    var cachedModels = { grok: [], anthropic: [] };

    async function loadSchedules() {
      try {
        var feedsP = fetch('/api/feeds');
        var modelsP = fetch('/api/models');
        var schedulesP = fetch('/api/schedules');
        var results = await Promise.all([feedsP, modelsP, schedulesP]);

        if (results[0].ok) cachedWires = await results[0].json();
        if (results[1].ok) cachedModels = await results[1].json();

        if (!results[2].ok) throw new Error('Failed to fetch schedules');
        var data = await results[2].json();
        var schedules = data.schedules || [];
        scheduleCountBadge.textContent = schedules.length.toString();

        renderSchedulesList(schedules);
      } catch (error) {
        console.error('Failed to load schedules:', error);
        schedulesListEl.innerHTML = '<p style="color: var(--error);">Failed to load schedules</p>';
      }
    }

    function renderSchedulesList(schedules) {
      if (schedules.length === 0) {
        schedulesListEl.innerHTML = '<p style="color: var(--text-muted);">No schedules configured. Click "+ Add Schedule" to create one.</p>';
        return;
      }

      var dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

      var html = '<table><thead><tr><th>Name</th><th>Type</th><th>Schedule</th><th>Feed</th><th>Status</th><th>Next Run</th><th>Actions</th></tr></thead><tbody>';

      schedules.forEach(function(s) {
        var day = dayNames[s.dayOfWeek];
        var hour12 = s.hour % 12 || 12;
        var ampm = s.hour >= 12 ? 'PM' : 'AM';
        var time = hour12 + ':' + s.minute.toString().padStart(2, '0') + ' ' + ampm;
        var feedMatch = cachedWires.find(function(f) { return f.key === s.wire; });
        var feed = s.wire ? (feedMatch ? feedMatch.displayName : s.wire) : 'All';
        var status = s.enabled ? '<span style="color: var(--success);">Enabled</span>' : '<span style="color: var(--text-muted);">Disabled</span>';
        var tz = s.timezone || 'America/Los_Angeles';
        var tzShort = tz.split('/').pop().replace('_', ' ');
        var isScan = s.scheduleType === 'scan-execution' || s.scheduleType === 'forum-scan';
        var typeLabel = s.scheduleType === 'forum-scan' ? '<span style="color: var(--badge-forum-fg);">Forum</span>' : isScan ? '<span style="color: var(--badge-prompt-fg);">Scan</span>' : 'Summary';
        var nextRun = '-';
        if (s.nextRun) {
          try {
            nextRun = new Date(s.nextRun).toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
          } catch (e) {
            nextRun = new Date(s.nextRun).toLocaleString();
          }
        }

        html += '<tr>';
        html += '<td>' + escapeHtml(s.name || 'Untitled') + '</td>';
        html += '<td>' + typeLabel + '</td>';
        var freqLabel = isScan && s.frequencyHours ? 'Every ' + s.frequencyHours + 'h' : (isScan ? 'Daily' : day);
        html += '<td>' + freqLabel + ' @ ' + (isScan && s.frequencyHours ? ':' + s.minute.toString().padStart(2, '0') : time) + ' <span style="color: var(--text-muted); font-size: 11px;">(' + escapeHtml(tzShort) + ')</span>';
        if (s.notifyEmails) html += '<div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px;">Notify: ' + escapeHtml(s.notifyEmails) + '</div>';
        html += '</td>';
        html += '<td>' + escapeHtml(feed) + '</td>';
        html += '<td>' + status + '</td>';
        html += '<td style="font-size: 12px;">' + escapeHtml(nextRun) + (s.nextRun ? ' <span style="color: var(--text-muted); font-size: 10px;">(' + escapeHtml(tz === 'UTC' ? 'UTC' : tzShort) + ')</span>' : '') + '</td>';
        html += '<td>';
        html += '<button class="edit-schedule" data-id="' + escapeHtml(s.id) + '" style="background: var(--border); border: none; color: var(--accent); padding: 6px 12px; border-radius: 4px; cursor: pointer; margin-right: 8px;">Edit</button>';
        html += '<button class="delete-schedule" data-id="' + escapeHtml(s.id) + '" data-name="' + escapeHtml(s.name || 'Untitled') + '" style="background: var(--border); border: none; color: var(--error); padding: 6px 12px; border-radius: 4px; cursor: pointer;">Delete</button>';
        html += '</td>';
        html += '</tr>';
      });

      html += '</tbody></table>';
      schedulesListEl.innerHTML = html;

      document.querySelectorAll('.edit-schedule').forEach(function(btn) {
        btn.addEventListener('click', function() { editSchedule(btn.dataset.id); });
      });
      document.querySelectorAll('.delete-schedule').forEach(function(btn) {
        btn.addEventListener('click', function() { deleteSchedule(btn.dataset.id, btn.dataset.name); });
      });
    }

    function populateFormDropdowns(schedule) {
      var wireOptions = '<option value="">All Feeds</option>';
      cachedWires.forEach(function(f) {
        var selected = schedule && f.key === schedule.wire ? ' selected' : '';
        wireOptions += '<option value="' + escapeHtml(f.key) + '"' + selected + '>' + escapeHtml(f.displayName) + '</option>';
      });
      scheduleWireEl.innerHTML = wireOptions;

      scheduleGrokModelEl.innerHTML = cachedModels.grok.map(function(m) {
        return '<option value="' + escapeHtml(m.id) + '"' + (schedule && m.id === schedule.grokModel ? ' selected' : '') + '>' + escapeHtml(m.displayName) + '</option>';
      }).join('');

      scheduleAnthropicModelEl.innerHTML = cachedModels.anthropic.map(function(m) {
        return '<option value="' + escapeHtml(m.id) + '"' + (schedule && m.id === schedule.anthropicModel ? ' selected' : '') + '>' + escapeHtml(m.displayName) + '</option>';
      }).join('');
    }

    function showScheduleForm(schedule) {
      scheduleForm.style.display = 'block';
      populateFormDropdowns(schedule);

      if (schedule) {
        scheduleIdEl.value = schedule.id;
        scheduleNameEl.value = schedule.name || '';
        scheduleTypeSelect.value = schedule.scheduleType || 'scan-execution';
        scheduleEnabledEl.value = schedule.enabled.toString();
        scheduleDayOfWeekEl.value = schedule.dayOfWeek.toString();
        scheduleTimeEl.value = schedule.hour.toString().padStart(2, '0') + ':' + schedule.minute.toString().padStart(2, '0');
        scheduleLookbackEl.value = schedule.lookbackDays;
        scheduleTimezoneEl.value = schedule.timezone || 'America/Los_Angeles';
        scheduleFrequencySelect.value = schedule.frequencyHours ? schedule.frequencyHours.toString() : '';
        scheduleNotifyEmailsEl.value = schedule.notifyEmails || '';
      } else {
        scheduleIdEl.value = '';
        scheduleNameEl.value = 'New Schedule';
        scheduleTypeSelect.value = 'scan-execution';
        scheduleEnabledEl.value = 'false';
        scheduleDayOfWeekEl.value = '3';
        scheduleTimeEl.value = '09:00';
        scheduleLookbackEl.value = '7';
        scheduleTimezoneEl.value = 'America/Los_Angeles';
        scheduleFrequencySelect.value = '';
        scheduleNotifyEmailsEl.value = '';
      }
      toggleScheduleTypeFields();
    }

    function hideScheduleForm() {
      scheduleForm.style.display = 'none';
      scheduleIdEl.value = '';
    }

    async function editSchedule(id) {
      try {
        var response = await fetch('/api/schedule?id=' + encodeURIComponent(id));
        if (!response.ok) throw new Error('Failed to fetch schedule');
        var schedule = await response.json();
        showScheduleForm(schedule);
      } catch (error) {
        console.error('Failed to edit schedule:', error);
      }
    }

    async function deleteSchedule(id, name) {
      if (!confirm('Delete schedule "' + name + '"?')) return;
      try {
        var response = await fetch('/api/schedules/' + encodeURIComponent(id), { method: 'DELETE' });
        if (!response.ok) throw new Error('Failed to delete');
        loadSchedules();
        loadSchedulerStatus();
      } catch (error) {
        console.error('Failed to delete schedule:', error);
        alert('Failed to delete schedule');
      }
    }

    addScheduleBtn.addEventListener('click', function() { showScheduleForm(null); });
    cancelScheduleBtn.addEventListener('click', hideScheduleForm);

    loadSchedules();

    // Scheduler health status
    var schedulerRunningEl = document.getElementById('scheduler-running');
    var schedulerStartedEl = document.getElementById('scheduler-started');
    var lastJobRunEl = document.getElementById('last-job-run');
    var lastJobStatusEl = document.getElementById('last-job-status');
    var lastJobErrorEl = document.getElementById('last-job-error');
    var refreshStatusBtn = document.getElementById('refresh-status');

    function formatRelativeTime(dateStr) {
      if (!dateStr) return null;
      var date = new Date(dateStr);
      var now = new Date();
      var diffMs = now - date;
      var diffMins = Math.floor(diffMs / 60000);
      var diffHours = Math.floor(diffMs / 3600000);
      var diffDays = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return diffMins + ' min ago';
      if (diffHours < 24) return diffHours + ' hour' + (diffHours > 1 ? 's' : '') + ' ago';
      if (diffDays < 7) return diffDays + ' day' + (diffDays > 1 ? 's' : '') + ' ago';
      return date.toLocaleDateString();
    }

    async function loadSchedulerStatus() {
      try {
        var response = await fetch('/api/scheduler-status');
        if (!response.ok) throw new Error('Failed to fetch status');
        var status = await response.json();

        var latestSchedule = (status.schedules || [])
          .filter(function(s) { return s.lastJobRun; })
          .sort(function(a, b) { return new Date(b.lastJobRun) - new Date(a.lastJobRun); })[0] || null;

        if (status.isRunning) {
          schedulerRunningEl.textContent = 'Active (' + status.activeSchedules + ' schedule' + (status.activeSchedules !== 1 ? 's' : '') + ')';
          schedulerRunningEl.className = 'value success';
        } else if (status.totalSchedules > 0) {
          schedulerRunningEl.textContent = 'Not Running (restart needed)';
          schedulerRunningEl.className = 'value error';
        } else {
          schedulerRunningEl.textContent = 'No Schedules';
          schedulerRunningEl.className = 'value muted';
        }

        if (status.schedulerStartedAt) {
          var startedAt = formatRelativeTime(status.schedulerStartedAt);
          schedulerStartedEl.textContent = startedAt;
          schedulerStartedEl.className = 'value';
        } else {
          schedulerStartedEl.textContent = 'Not started';
          schedulerStartedEl.className = 'value muted';
        }

        if (latestSchedule && latestSchedule.lastJobRun) {
          var lastRun = formatRelativeTime(latestSchedule.lastJobRun);
          lastJobRunEl.textContent = lastRun + ' (' + latestSchedule.name + ')';
          lastJobRunEl.className = 'value';
        } else {
          lastJobRunEl.textContent = 'Never';
          lastJobRunEl.className = 'value muted';
        }

        var lastStatus = latestSchedule ? latestSchedule.lastJobStatus : null;
        var lastError = latestSchedule ? latestSchedule.lastJobError : null;
        if (lastStatus === 'success') {
          lastJobStatusEl.textContent = 'Success';
          lastJobStatusEl.className = 'value success';
          lastJobErrorEl.style.display = 'none';
        } else if (lastStatus === 'failed') {
          lastJobStatusEl.textContent = 'Failed';
          lastJobStatusEl.className = 'value error';
          if (lastError) {
            lastJobErrorEl.textContent = lastError;
            lastJobErrorEl.style.display = 'block';
          }
        } else {
          lastJobStatusEl.textContent = 'No runs yet';
          lastJobStatusEl.className = 'value muted';
          lastJobErrorEl.style.display = 'none';
        }
      } catch (error) {
        console.error('Failed to load scheduler status:', error);
        schedulerRunningEl.textContent = 'Error loading status';
        schedulerRunningEl.className = 'value error';
      }
    }

    loadSchedulerStatus();

    refreshStatusBtn.addEventListener('click', function() {
      refreshStatusBtn.textContent = 'Refreshing\\u2026';
      loadSchedulerStatus().then(function() {
        refreshStatusBtn.textContent = 'Refresh';
      });
    });

    var testAlertBtn = document.getElementById('test-alert');

    testAlertBtn.addEventListener('click', async function() {
      testAlertBtn.disabled = true;
      testAlertBtn.textContent = 'Sending\\u2026';

      try {
        var response = await fetch('/api/test-alert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        });

        var result = await response.json();

        if (result.success) {
          testAlertBtn.textContent = 'Sent!';
          testAlertBtn.style.background = 'var(--success)';
          setTimeout(function() {
            testAlertBtn.textContent = 'Test Alert';
            testAlertBtn.style.background = '';
            testAlertBtn.disabled = false;
          }, 3000);
        } else {
          testAlertBtn.textContent = 'Failed';
          testAlertBtn.style.background = 'var(--error)';
          setTimeout(function() {
            testAlertBtn.textContent = 'Test Alert';
            testAlertBtn.style.background = '';
            testAlertBtn.disabled = false;
          }, 3000);
        }
      } catch (error) {
        console.error('Failed to send test alert:', error);
        testAlertBtn.textContent = 'Error';
        testAlertBtn.style.background = 'var(--error)';
        setTimeout(function() {
          testAlertBtn.textContent = 'Test Alert';
          testAlertBtn.style.background = '';
          testAlertBtn.disabled = false;
        }, 3000);
      }
    });

    saveScheduleBtn.addEventListener('click', async function() {
      var timeParts = scheduleTimeEl.value.split(':');
      var hour = parseInt(timeParts[0], 10);
      var minute = parseInt(timeParts[1], 10);
      var id = scheduleIdEl.value;

      saveScheduleBtn.disabled = true;
      saveScheduleBtn.textContent = 'Saving\\u2026';

      try {
        var body = {
          name: scheduleNameEl.value,
          scheduleType: scheduleTypeSelect.value,
          enabled: scheduleEnabledEl.value === 'true',
          dayOfWeek: parseInt(scheduleDayOfWeekEl.value, 10),
          hour: hour,
          minute: minute,
          lookbackDays: parseInt(scheduleLookbackEl.value, 10),
          timezone: scheduleTimezoneEl.value,
          grokModel: scheduleGrokModelEl.value,
          anthropicModel: scheduleAnthropicModelEl.value,
          wire: scheduleWireEl.value || undefined,
          frequencyHours: (scheduleTypeSelect.value === 'scan-execution' || scheduleTypeSelect.value === 'forum-scan') && scheduleFrequencySelect.value ? parseInt(scheduleFrequencySelect.value, 10) : undefined,
          notifyEmails: scheduleNotifyEmailsEl.value || undefined,
        };

        var response;
        if (id) {
          response = await fetch('/api/schedules/' + encodeURIComponent(id), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
        } else {
          response = await fetch('/api/schedules', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
        }

        if (!response.ok) throw new Error('Failed to save schedule');

        hideScheduleForm();
        loadSchedules();
        loadSchedulerStatus();
      } catch (error) {
        console.error('Failed to save schedule:', error);
        alert('Failed to save schedule');
      } finally {
        saveScheduleBtn.disabled = false;
        saveScheduleBtn.textContent = 'Save';
      }
    });
  </script>
</body>
</html>
  `;

  return pageHtml + scriptBlock.trim();
}
