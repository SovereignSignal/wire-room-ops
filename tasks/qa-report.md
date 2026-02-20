# QA Audit Report - GrantWire Summarizer

**Date:** 2026-02-19
**Tested:** Production (Railway) + Local Code Review
**URL:** `https://grant-wire-summarizer-production.up.railway.app/dashboard`

---

## Executive Summary

The application is generally well-built with good auth enforcement on all API endpoints and no SQL injection vulnerabilities. However, there are **critical reliability issues** (server crashes from unhandled DB errors, scheduler that can't recover from failures), **security gaps** (XSS in dynamic HTML, missing CSRF, unauthenticated email endpoint), and **a deploy gap** where new features exist in local code but not on production.

**Total Issues Found: 30** | Critical: 3 | High: 7 | Medium: 13 | Low: 7

---

## CRITICAL (Fix Immediately)

### C1. No `pool.on('error')` Handler - Server Will Crash on Idle DB Disconnect
**Severity:** Critical | **Category:** Reliability
**File:** `src/db/index.ts:7-17`

The Postgres pool has no error handler. When Railway's cloud Postgres drops an idle connection (common), Node.js emits an unhandled error that crashes the entire process. **One-line fix with maximum production impact.**

```typescript
// Add after pool creation:
pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error on idle client:', err.message);
});
```

---

### C2. No Concurrent Job Execution Guard - Duplicate API Spend
**Severity:** Critical | **Category:** Data Integrity / Cost
**File:** `src/server.ts:366-389`

Nothing prevents two simultaneous "Run Job Now" clicks or a manual run overlapping with a scheduled run. Both will make expensive Grok/Claude API calls on the same entries, wasting money and potentially producing duplicate files.

**Fix:** Add a global job lock that returns the existing job ID if one is already running.

---

### C3. Scheduler Sets `isInitialized = true` on Failure - Permanently Broken
**Severity:** Critical | **Category:** Reliability
**File:** `src/services/scheduler.ts:415-418`

If `initScheduler()` fails (e.g., DB temporarily down), it sets `isInitialized = true` in the `catch` block. All subsequent calls silently skip. **The scheduler can never recover without a full server restart.**

**Fix:** Remove `isInitialized = true` from the catch block. Let it retry on next call.

---

## HIGH (Fix This Sprint)

### H1. XSS via Dynamic `onclick` Handlers in Daily Queue
**Severity:** High | **Category:** Security
**File:** `src/server.ts:2838-2840`

Entry IDs are injected directly into inline `onclick` handlers:
```javascript
html += '<button onclick="entryAction(' + e.id + ',\'promote\',this)">';
```
While currently numeric, this pattern is fragile. If entry data ever flows through, it's injectable.

**Fix:** Use event delegation with `data-` attributes instead of inline handlers.

---

### H2. Unescaped Content in `innerHTML` for Prompt Test Results
**Severity:** High | **Category:** Security
**File:** `src/server.ts:2988`

The `info` variable (containing model name and token count) is inserted into `innerHTML` without escaping:
```javascript
outputEl.innerHTML = '<p...>' + info + '</p>' + escapeHtml(data.content);
```

**Fix:** Wrap `info` in `escapeHtml()`.

---

### H3. Missing Input Validation on Date/Score Query Parameters
**Severity:** High | **Category:** Data Integrity
**File:** `src/server.ts:913-914`

`minScore` silently defaults to 40 on parse failure. `date` passes to DB without format validation. No bounds checking.

**Fix:** Validate date format with regex (`/^\d{4}-\d{2}-\d{2}$/`) and clamp minScore to 0-100.

---

### H4. SSE Connections Will Drop on Long-Running Jobs (No Keepalive)
**Severity:** High | **Category:** Reliability
**File:** `src/server.ts:392-424`

The SSE endpoint for job progress has no keepalive mechanism. Scan execution jobs can take 9-14 minutes. Railway/Cloudflare proxies timeout idle connections at 60-120 seconds, silently dropping the progress stream mid-job.

**Fix:** Send `: keepalive\n\n` comment every 30 seconds via `setInterval`.

---

### H5. Deploy Gap - Local Code Has Features Missing from Production
**Severity:** High | **Category:** Operations
**Files:** `src/jobs/scan-execution.ts`, `src/services/scan-stats.ts` (untracked)

The dashboard references `/api/scan/prompt-stats` (returns 404 on prod) and imports from `scan-execution.ts` and `scan-stats.ts` which aren't committed. The production deployment is missing:
- Prompt effectiveness statistics
- Scan execution job type
- Prompt stats UI section

**Fix:** Commit and deploy the pending changes, or guard the UI sections behind feature availability checks.

---

### H6. Memory Leak in JobQueue - No Periodic Cleanup
**Severity:** High | **Category:** Reliability
**File:** `src/services/job-queue.ts:98-110`

`cleanup()` only runs when explicitly called. Completed/failed jobs and their listeners accumulate without bound. Over weeks of uptime, memory grows indefinitely.

**Fix:** Add a periodic cleanup interval (e.g., every 15 minutes).

---

### H7. Auth Token Memory Leak - Download Tokens Never Cleaned Up
**Severity:** High | **Category:** Reliability
**File:** `src/services/auth.ts:128-146`

`createDownloadToken()` never calls `cleanupExpiredTokens()`. Magic link cleanup only runs when new links are created. If no one logs in for days, expired tokens accumulate.

**Fix:** Add periodic cleanup timer (every 15 min) and call cleanup in `createDownloadToken()`.

---

## MEDIUM (Fix Next Sprint)

### M1. Missing CSRF Protection on All State-Changing Endpoints
**Severity:** Medium | **Category:** Security
**Files:** All POST/PUT/DELETE routes in `src/server.ts`

No CSRF tokens. Since auth uses cookies, a malicious page could trigger `/api/run-job`, `/api/feeds` (DELETE), `/api/schedules` (DELETE), etc.

**Fix:** Implement CSRF token middleware.

---

### M2. `/resend-link` Endpoint is Unauthenticated
**Severity:** Medium | **Category:** Security
**File:** `src/server.ts:451-481`

Any client can request email resend of latest file. Only rate-limited (3 per 15 min per IP), bypassable with multiple IPs.

**Fix:** Require session auth or limit to expired download token context.

---

### M3. Session Token Accepted from Request Body (Dual Path)
**Severity:** Medium | **Category:** Security
**File:** `src/server.ts:40-46`

Session extracted from `req.cookies?.session || req.body?.session`. Body fallback increases attack surface (logged in request bodies, not HttpOnly).

**Fix:** Accept sessions only from HttpOnly cookies.

---

### M4. Duplicate `normalizeUrl` Logic - Inconsistent Dedup
**Severity:** Medium | **Category:** Data Integrity
**Files:** `src/db/index.ts:126-141` vs `src/services/intake.ts:358-396`

Two different URL normalization functions. The DB version doesn't normalize twitter.com -> x.com or strip tracking params. Same URL could be "unique" in one pipeline but "duplicate" in another.

**Fix:** Consolidate into a shared utility using the more comprehensive `intake.ts` version.

---

### M5. Timezone Handling Uses Unreliable `toLocaleString()`
**Severity:** Medium | **Category:** Reliability
**File:** `src/services/scheduler.ts:268-299`

DST transitions not properly handled. `toLocaleString()` behavior varies across JS engines.

**Fix:** Use `date-fns-tz` or similar proper timezone library.

---

### M6. Race Condition in Magic Link Token Validation
**Severity:** Medium | **Category:** Security
**File:** `src/services/auth.ts:70-92`

Between checking `tokenData.used` and setting `tokenData.used = true`, a concurrent request could validate the same token. In-memory storage means state is lost on restart too.

**Fix:** Use atomic operations or move to persistent store.

---

### M7. Failed Scheduled Jobs Don't Retry
**Severity:** Medium | **Category:** Reliability
**File:** `src/services/scheduler.ts:132-210`

A single failure = no retry. Users miss their scheduled newsletter if a transient API error occurs.

**Fix:** Implement retry with exponential backoff for transient failures.

---

### M8. Inconsistent Validation - Some IDs Validated, Others Not
**Severity:** Medium | **Category:** Security
**File:** `src/server.ts` (multiple locations)

Prompt IDs have UUID regex validation, but schedule IDs and entry IDs don't have equivalent checks.

**Fix:** Create reusable validation functions for UUID and numeric IDs.

---

### M9. `ensureScanTables()` Runs ~25 DDL Statements Without Transaction
**Severity:** Medium | **Category:** Reliability
**File:** `src/db/index.ts:622-726`

On every startup, 25+ individual `CREATE TABLE/INDEX IF NOT EXISTS` queries run without a transaction. Partial failure could leave schema inconsistent.

**Fix:** Wrap in a transaction using a checked-out client.

---

### M10. N+1 Query Pattern in Daily Intake Pipeline
**Severity:** Medium | **Category:** Performance
**File:** `src/jobs/daily-intake.ts:108-136`

Individual INSERT/UPDATE/SELECT per entry (~120 round-trips for 30 entries). Could be batched.

**Fix:** Use multi-row INSERT with `unnest()` or VALUES batching.

---

### M11. Sequential Entry Processing - Major Performance Bottleneck
**Severity:** Medium | **Category:** Performance
**File:** `src/services/processor.ts:92-120`

Entries processed one at a time with 500ms delays. 50 entries = ~50 minutes. Each entry is independent.

**Fix:** Process in batches of 3-5 concurrent entries (~17 min for 50 entries).

---

### M12. Duplicate API Calls on Page Load
**Severity:** Medium | **Category:** Performance / UX
**File:** `src/server.ts:2007,2158,2191-2193,2345`

`loadSchedules()` internally fetches `/api/feeds` and `/api/models`, while `loadFeeds()` and `loadModels()` also run independently on page load. Results in double fetches.

**Fix:** Deduplicate by having `loadSchedules()` use cached data from prior `loadFeeds()`/`loadModels()` calls.

---

### M13. `rejectUnauthorized: false` in SSL Config
**Severity:** Medium | **Category:** Security
**File:** `src/db/index.ts:11`

Disables certificate verification for all non-localhost connections. Vulnerable to MITM.

**Fix:** Make configurable via env var, default to `true`.

---

## LOW (Backlog)

### L1. Duplicate Utility Functions (`escapeHtml`, `sleep`) Across Files
**Files:** `src/server.ts:30`, `src/services/email.ts:5`, `src/services/processor.ts:12`, `src/services/scraper.ts:41`, `src/services/notion.ts:78`
**Fix:** Extract to shared `src/utils/` module.

### L2. `require()` with `any` Types in Entry Point
**File:** `src/index.ts:1-24`
**Fix:** Use standard TypeScript `import` statements.

### L3. Pervasive `any` Types in Database Layer
**File:** `src/db/index.ts:341,475,547,590,806,863`
**Fix:** Define typed row interfaces and use `QueryParam` union type.

### L4. Retry Logic Not Truly Exponential (No Jitter)
**File:** `src/services/processor.ts:10-34`
**Fix:** Add random jitter to prevent thundering herd.

### L5. No Loading Spinners During AJAX Operations
**File:** `src/server.ts` (multiple form handlers)
**Fix:** Add visual feedback during async operations.

### L6. "All Feeds" Option in Schedule Feed Dropdown
**Browser:** Schedule edit form includes "All Feeds" which may not be valid for a scheduled run.
**Fix:** Remove "All Feeds" from schedule-specific dropdown.

### L7. Process Scan with Empty Input - Silent No-Op
**Browser:** Clicking "Process Scan" with empty textarea does nothing (no error message).
**Fix:** Show validation error: "Please paste scan output first."

---

## Positive Findings

- **Auth properly enforced** on all API endpoints (401 for unauthenticated requests)
- **No SQL injection** - all queries use parameterized placeholders
- **Path traversal protected** - `/api/../etc/passwd` returns clean 404
- **Feed key validation** uses proper regex (`/^[a-z0-9_-]+$/`)
- **File download requires auth** - redirects to login if not authenticated
- **Rate limiting** on `/resend-link` and login endpoints
- **Scheduler health dashboard** accurately shows active schedules and server uptime
- **Daily Queue** properly handles empty state ("No entries found for these filters")
- **CRM Sync** shows configuration status and pending org count correctly
- **Prompt Management** CRUD operations work correctly (create, edit, disable, test, delete)

---

## Recommended Priority Order

1. **C1** - DB pool error handler (1-line fix, prevents production crashes)
2. **C3** - Scheduler init recovery (2-line fix, prevents permanent scheduler death)
3. **C2** - Concurrent job guard (prevents duplicate API spend)
4. **H4** - SSE keepalive (prevents progress loss on long jobs)
5. **H5** - Deploy gap (commit + deploy pending changes)
6. **H6+H7** - Memory leak fixes (periodic cleanup timers)
7. **H1+H2** - XSS fixes (escape dynamic content)
8. **M1** - CSRF protection
9. **M4** - Consolidate URL normalization
10. **M7** - Scheduled job retry logic
