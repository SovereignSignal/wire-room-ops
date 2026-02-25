# Wire Ops Dashboard QA Report

**Date**: 2026-02-23
**URL Tested**: https://wire-room-ops-production.up.railway.app/
**Server Health**: OK (timestamp: 2026-02-24T02:55:11.795Z)

---

## 1. Testing Summary

Conducted systematic testing of the Wire Ops dashboard covering: login flow, dashboard rendering, schedule management, queue page, scan prompts, distribution setup, API health, and logout flow.

**Overall Health**: The backend APIs are healthy and the dashboard main page functions well. One **critical bug** was found and fixed: the `/queue` page is completely broken due to a JavaScript syntax error that prevents all client-side code from executing.

---

## 2. Working Features (Confirmed Functional)

### Login Flow
- Privy login page renders correctly at `/` with branding and "Sign In" button
- Clicking "Sign In" triggers Privy authentication modal
- Cached Privy sessions auto-authenticate and redirect to `/dashboard`
- Session cookie is set correctly (HttpOnly, secure, sameSite lax)

### Dashboard Main Page
- All sections render and load data correctly:
  - **Generate Weekly Summary**: Date pickers, feed selector, model selectors (Grok 4.1 Fast, Claude Sonnet 4.6), "Run Job Now" button all present
  - **Generated Files**: 2 files listed with download links
  - **Feed Management**: 3 feeds shown (crypto: 3163, ai: 13, oss: 3) with Edit/Archive actions
  - **Scheduled Runs**: All 6 schedules display correctly after async load:
    - 3 Weekly Summary schedules (crypto/ai/oss, Wed mornings, enabled)
    - 3 Scan Execution schedules (crypto/ai/oss, every 12h, enabled)
  - **Scheduler Health**: Shows "Active (6 schedules)", server started 3 hours ago
  - **CRM Org Sync**: Staging DB configured, 0 pending orgs
  - **Run Scan**: Wire filter dropdown + "Run Scan Now" button functional
  - **Forum Scan**: Wire filter + "Run Forum Scan" button present
  - **Scan Intake**: Feed/Mode/Variant/Date selectors + textarea + "Process Scan" button
  - **Daily Queue (inline)**: Stats grid, feed/score/date filters, "Load Queue" button -- returns "No entries found" for today's date correctly
  - **Prompt Management**: All 9 prompts displayed (3 per wire: A/B/C variants, all x_search, all Active) with Disable/Test/Edit/Delete actions
  - **Prompt Effectiveness**: Stats loaded with data from last 7 days; cross-prompt overlap 1%

### Logout Flow
- `/logout` clears session cookie and redirects to login page
- Subsequent access to `/dashboard` or `/queue` redirects to login

### API Health
- `/health` returns `{"status":"ok"}` with timestamp
- All tested API endpoints respond correctly:
  - `/api/feeds` (3 feeds)
  - `/api/schedules` (6 schedules)
  - `/api/scheduler-status` (active, 6 schedules)
  - `/api/scan/status-counts` (31 queued, 3 approved, 2 skipped, 30 duplicates, 96 archived)
  - `/api/scan/entries?status=queued,scored` (31 entries)
  - `/api/scan/entries?status=approved` (3 entries)
  - `/api/models` (returns Grok and Claude model lists)

### Schedule Configuration
- Scan execution schedules exist and are active
- Next scan run: Feb 24, 12:00 AM Pacific (08:00 UTC) -- approximately 5 hours from test time
- Scans run every 12 hours for each wire (crypto/ai/oss)
- 9 active prompts will execute during scheduled scans

---

## 3. Issues Found

### CRITICAL: Queue Page (/queue) JavaScript Completely Broken

**Severity**: Critical
**Steps to Reproduce**:
1. Navigate to https://wire-room-ops-production.up.railway.app/queue
2. Page renders HTML structure but shows "Loading..." indefinitely
3. Tabs, filters, and Refresh button are non-functional

**Expected Behavior**: Page should load 31 pending entries with Approve/Review Later/Decline buttons, show tab counts, and allow entry management.

**Actual Behavior**: Page shows "Loading..." forever. All JavaScript functions are undefined (`loadFeeds`, `loadStatusCounts`, `loadEntries`, `escapeHtml` -- all `undefined`). The entire `<script>` block fails to parse.

**Root Cause**: JavaScript syntax error: `Unexpected identifier 'tnum'`

In `renderQueuePage()`, lines 4660-4662 of `src/server.ts`, inline JavaScript builds HTML strings containing `font-feature-settings: 'tnum'` with escaped single quotes `\'tnum\'`. Since this JavaScript code is embedded inside a TypeScript template literal (backtick string), the `\'` escape sequences are consumed by the template literal engine. The rendered HTML output contains unescaped `'tnum'` which breaks the JavaScript string parsing:

```javascript
// TypeScript source (inside template literal):
tilesHtml += '...font-feature-settings: \'tnum\';">' + queued + '...';

// Rendered JavaScript in browser:
tilesHtml += '...font-feature-settings: 'tnum';">' + queued + '...';
//                                       ^ This terminates the JS string prematurely
```

**Fix Applied**: Removed redundant inline `font-family` and `font-feature-settings` styles from the three affected lines. The `.status-item .value` CSS class already defines these properties, making the inline styles unnecessary.

**Impact**: This bug makes the queue page -- the primary interface for approving entries -- completely unusable. Users cannot approve, decline, or review entries via the queue page. The dashboard's inline "Daily Queue" section partially works but lacks the tab navigation and distribution status features.

### HIGH: Distribution Not Firing on Approved Entries

**Severity**: High
**Steps to Reproduce**:
1. Check approved entries via API: `GET /api/scan/entries?status=approved`
2. All 3 approved entries have empty `distribution_logs` arrays

**Expected Behavior**: Approved entries should have distribution logs showing Telegram and X posting status.

**Actual Behavior**: `distribution_logs: []` for all approved entries.

**Potential Root Cause**: Either `DISTRIBUTION_ENABLED` is not set to `true` in the Railway environment variables, or the Telegram channel IDs and X API credentials are not configured for the relevant wires. The distribution system is opt-in and requires explicit environment variable configuration.

**Impact**: Entries approved today or tomorrow will not be posted to Telegram or X channels. This directly blocks the user's success criteria of having approved entries post to Telegram and X.

### MEDIUM: Scheduler "Last Job Run" Shows "Never"

**Severity**: Medium
**Steps to Reproduce**:
1. View Scheduler Health section on dashboard
2. "Last Job Run" shows "Never", "Last Job Result" shows "No runs yet"

**Expected Behavior**: If scans have been producing entries (visible in prompt effectiveness stats), the scheduler should show when the last job ran.

**Actual Behavior**: Shows "Never" even though prompt effectiveness data shows scan results from the last 7 days.

**Potential Root Cause**: The server was restarted ~3 hours ago. Scheduler job history is stored in-memory and resets on restart. The existing entries were produced by a prior server instance. This is expected behavior but confusing to operators.

**Impact**: Low operational impact -- the scheduler is active and schedules are configured. The display is misleading but not blocking.

### LOW: Dashboard Loads Async Data Slowly (Race Condition with Scroll)

**Severity**: Low
**Steps to Reproduce**:
1. Load dashboard page
2. Immediately scroll down to Scheduled Runs section
3. Only 3 of 6 schedules may be visible initially

**Expected Behavior**: All 6 schedules should render promptly.

**Actual Behavior**: The schedule table renders incrementally. The 3 weekly summary schedules appear first, and the 3 scan execution schedules appear after the async API calls complete. If the user scrolls past before data loads, they may think scan schedules are missing.

**Potential Root Cause**: The `loadSchedules()` function makes 3 parallel API calls (`/api/feeds`, `/api/models`, `/api/schedules`) and renders after all resolve. Network latency on Railway causes a noticeable delay.

**Impact**: Minor UX concern. Adding loading skeletons or a "loading schedules..." indicator would prevent confusion.

---

## 4. Overnight Scan Readiness Assessment

### Will scans run overnight?
**YES** -- Scan execution schedules are active:
- Crypto, AI, OSS scans scheduled every 12h
- Next run: Feb 24, 12:00 AM Pacific (08:00 UTC)
- 9 active prompts (3 per wire, all x_search tool)
- Grok API key appears configured (prompts have been producing results)

### Will the email be delivered?
**LIKELY** -- Weekly summary schedules run on Wednesdays. Scan execution schedules run daily. The scan completion will populate the queue with new entries. Whether a digest email is sent depends on the schedule's `notifyEmails` configuration (not visible in current schedules).

### Can the user approve entries tomorrow?
**NOT VIA /queue PAGE** -- The queue page is broken (critical bug above). However:
- The fix has been applied locally and needs to be deployed
- Alternatively, the dashboard's inline "Daily Queue" section works for basic approval
- API-level approval works (`POST /api/scan/entries/:id/action`)

### Will approved entries post to Telegram and X?
**UNCERTAIN** -- Distribution logs are empty for existing approved entries. This suggests distribution may not be enabled. Need to verify:
1. `DISTRIBUTION_ENABLED=true` is set in Railway env vars
2. `TELEGRAM_CHANNEL_CRYPTO`, `TELEGRAM_CHANNEL_AI`, `TELEGRAM_CHANNEL_OSS` are set
3. `X_CRYPTO_API_KEY` (and 3 companion vars) are set for each wire

---

## 5. Recommended Immediate Actions

### P0 - Deploy Queue Page Fix (blocks approval workflow)
The `src/server.ts` fix for the queue page JavaScript syntax error needs to be committed and deployed. This is the single most impactful action.

### P0 - Verify Distribution Environment Variables
Check Railway dashboard for:
- `DISTRIBUTION_ENABLED=true`
- Telegram channel IDs for each wire
- X API credentials for each wire

### P1 - Verify Scan Execution Will Produce Results
Run a manual scan via the dashboard "Run Scan Now" button to confirm the Grok API key is working and prompts produce parseable output.
