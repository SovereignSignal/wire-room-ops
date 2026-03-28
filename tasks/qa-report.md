# Wire Ops Dashboard QA Report

**Date**: 2026-03-28
**URL Tested**: https://wire-room-ops-production.up.railway.app/
**Browser**: Chrome (via Claude-in-Chrome MCP)
**System Status**: ARRAY ONLINE, all API providers active

---

## 1. Testing Summary

Conducted systematic testing of the production dashboard and full codebase review covering:
- Production page load and authentication
- All 6 navigation tabs (Overview, Scans, Queue, AutoResearch, Database, Settings)
- API endpoint network requests (captured 404 failures)
- Browser console errors
- Route registration correctness (17 route files in src/routes/)
- TypeScript compilation (server + client)
- Route conflict and duplication analysis
- Middleware ordering review
- New features: entry-actions service, drip-distribution job, internal auth middleware

**Overall Health: GOOD** -- the application is functional with active data flowing through all 3 wires. One confirmed bug affecting production dashboard data display, duplicate route handlers (dead code), and a narrow client type definition.

---

## 2. Working Features (Confirmed in Production)

### Authentication and Session
- Privy-based auth works. Session cookie correctly maintained across tab navigation.
- Redirect to login on expired session (tested via `authFetch` 401 handling).
- DEV_MODE properly gated behind explicit env var check.

### Overview Tab
- Loads with real data: 102 ingested this week, 477 published
- Wire stats for ai/crypto/oss with scan counts and quality metrics
- Recent Activity section shows latest entries with wire badges and timestamps
- ARRAY ONLINE indicator with auto-refresh timer

### Queue Tab
- Fully functional with 35+ queued entries visible
- Card view and table view both render correctly
- Approve / Quiet Approve (no distribution) / Skip buttons present and labeled
- Classification labels (GRANT/NEWS/EXPIRED/NOISE) display with correct badges
- Wire tags, source dates, org entity tags all visible
- Filter bar with wire buttons, type filters, signal/timeline dropdowns
- Checkboxes for bulk selection

### Scans Tab
- 40 prompts displayed (9 active across 3 wires, 31 inactive)
- 30-day cost tracking: $25.99 scan + $5.44 classify = $31.43 total ($0.0759/approved entry)
- Prompt scorecard with 21-day window and 4% overlap
- Active prompts show last run times ("3h ago") and next run ("in 6h 10m")
- RUN/EDIT/DEL actions on every prompt

### Database Tab
- Full data browser: 4,093 scan entries across 82 pages
- Sub-tabs: Scan Entries, Intake Runs, Distribution Log, Published, CSV
- Filters: Wire, Status, Search text, From/To date pickers
- Pagination working (Prev/Next, page number buttons)
- DB Connection indicator: gondola.proxy.rlwy.net / railway

### Settings Tab
- Sources panel with wire health cards (ai/crypto/oss)
- Distribution, API Providers, Usage, Integrations, Email sub-sections accessible
- Forum scan trigger button

### AutoResearch Tab
- Active experiment (baseline_v1) with metrics: 11.7% approval rate
- Param inspector, experiment history table, create experiment form all functional
- Manual rollback button present

### Infrastructure
- Health endpoint: `{"status":"ok"}`
- Readiness endpoint: `{"status":"ready","checks":{"db":true,"schedulerInitialized":true}}`
- CSRF protection on all state-changing requests
- SPA fallback correctly excludes /api, /auth, /health paths
- Server TypeScript compiles cleanly (0 errors)

---

## 3. Issues Found

### ISSUE 1: Client calls non-existent `/api/scan/counts` endpoint (404s on every page load)

**Severity**: Medium
**Steps to Reproduce**:
1. Load any page on the dashboard
2. Monitor network requests (Network tab)

**Expected Behavior**: Wire counts (queued/approved/archived/raw per wire) load successfully and display in overview stats and wire count components.

**Actual Behavior**: Three 404 responses on every page load:
- `GET /api/scan/counts?wire=crypto` -> 404
- `GET /api/scan/counts?wire=ai` -> 404
- `GET /api/scan/counts?wire=oss` -> 404

**Root Cause**: The `fetchWireCounts()` function in `client/src/api/index.ts` line 179 calls `/api/scan/counts` but the server route is `/api/scan/status-counts` (defined in `src/routes/scan-entries.ts` line 154). This is a route name mismatch introduced during the route refactoring.

**Impact**: The `wireCounts` state in the Index component is always empty. The "IN QUEUE" and "RAW / INCOMING" stat cards on the Overview tab show 0 or are missing data. The `fetchWireCounts` function degrades gracefully (returns `[]` on failure), so no crash occurs, but the Overview loses per-wire breakdown data.

**Fix**: Change `client/src/api/index.ts` line 179 from:
```
const res = await authFetch(`${BASE}/scan/counts?wire=...`)
```
to:
```
const res = await authFetch(`${BASE}/scan/status-counts?wire=...`)
```
Note: the response shape from `status-counts` is `{ counts: { queued, approved, archived, raw, ... }, seededUrls, totalUrls }` -- the mapping at line 182-188 already expects `.counts.queued` etc. so it should work after the URL fix.

### ISSUE 2: Duplicate route handlers for distribution entry endpoints

**Severity**: Low
**Steps to Reproduce**: Code review of `src/routes/scan-entries.ts` and `src/routes/distribution.ts`.

**Description**: Both routers define identical handlers for:
- `GET /api/scan/entries/:id/distribution` (distribution logs for single entry)
- `POST /api/scan/entries/:id/redistribute` (retry failed distribution)

The `scanEntryRouter` is mounted at `/api/scan` (server.ts line 135, with `requireAuthOrInternalKey`) and the `distributionRouter` is mounted at `/api` (server.ts line 156, with `requireAuth`). Since Express matches routes in registration order, the distribution router's versions at lines 416-463 are dead code.

**Impact**: No functional impact currently. The dead code adds confusion during maintenance and the auth middleware difference (`requireAuthOrInternalKey` vs `requireAuth`) could matter if agent access to these endpoints is needed.

**Fix**: Remove lines 414-463 from `src/routes/distribution.ts` and the corresponding JSDoc entries at lines 18-19.

### ISSUE 3: Client `EntryStatus` type is too narrow

**Severity**: Low
**Steps to Reproduce**: Run `cd client && npx tsc --noEmit`

**Description**: `client/src/types/index.ts` line 1 defines `EntryStatus = 'queued' | 'approved' | 'archived'` but the actual `scan_entries.status` column contains values: `queued`, `approved`, `archived`, `declined`, `duplicate`, `raw`, `skipped`, `deduped`. This causes a TypeScript error in `ScanPromptsTab.tsx` line 899 where the exhaustive ternary chain (checking approved/queued/archived/duplicate/declined) narrows the type to `never` before the `.slice()` fallback.

**Impact**: TypeScript compilation warning in the client (does not block the Vite build). Indicates the client type system doesn't accurately model server data, which could lead to subtle type-related bugs elsewhere.

**Fix**: Widen the type:
```typescript
export type EntryStatus = 'queued' | 'approved' | 'archived' | 'declined' | 'duplicate' | 'raw' | 'skipped' | 'deduped';
```

### ISSUE 4: Missing `react-hook-form` type declaration in client

**Severity**: Low (Non-blocking)
**Steps to Reproduce**: Run `cd client && npx tsc --noEmit`

**Description**: `client/src/components/ui/form.tsx` line 4 imports from `react-hook-form` but the package is not in `client/package.json` dependencies.

**Impact**: TypeScript error during strict checking. Does not affect the Vite build. The `form.tsx` is likely unused shadcn/ui boilerplate.

**Fix**: Either `npm install react-hook-form` in the client directory, or delete `client/src/components/ui/form.tsx` if it's not imported anywhere.

---

## 4. Code Quality Observations (Non-Issues, Positive Findings)

### Route Refactoring Quality
The extraction from monolithic server.ts into 17 route modules is well-executed. Each file has clear JSDoc headers documenting all routes. Middleware is correctly applied at the mount level. Mount ordering in server.ts is sensible (auth first, then specific prefixes, then generic `/api` catches).

### Entry Actions Service
`src/services/entry-actions.ts` is a clean service layer extraction. Proper error types (`ApprovalBlockedError`, `BulkApprovalBlockedError`), dry-run support, audit columns (`actioned_by`, `action_reason`), and fire-and-forget side effects for distribution/summarization/org-linking.

### Internal Auth Middleware
`src/middleware/internal-auth.ts` properly implements a two-tier auth scheme: internal API key for agents OR standard Privy session. The synthetic agent identity is properly attached to the request.

### Drip Distribution Job
`src/jobs/drip-distribution.ts` correctly implements one-entry-per-wire-per-run distribution with 30-day lookback and content quality gates (description >50 chars or enriched_summary present).

### DEV_MODE Security
Properly gated: `process.env.DEV_MODE === 'true'`. Only used in auth middleware. Not a risk as long as the env var is not set in production Railway deployment.

### Telegram Webhook Security
The webhook handler in `src/routes/jobs.ts` correctly rejects all calls if `webhookSecret` is not configured, and validates the `x-telegram-bot-api-secret-token` header before processing.

---

## 5. Proposed Tasks (Prioritized)

### Task 1: Fix `/api/scan/counts` route mismatch [HIGH]
**Effort**: 15 minutes
**Files**: `client/src/api/index.ts`
**Description**: Change the API path from `/api/scan/counts` to `/api/scan/status-counts` in the `fetchWireCounts()` function. This fixes 3 failed network requests on every page load and restores per-wire breakdown data to the Overview tab.

### Task 2: Remove duplicate distribution route handlers [LOW]
**Effort**: 10 minutes
**Files**: `src/routes/distribution.ts`
**Description**: Remove the dead `GET /scan/entries/:id/distribution` and `POST /scan/entries/:id/redistribute` handlers (lines 414-463) that are shadowed by identical handlers in `src/routes/scan-entries.ts`.

### Task 3: Widen client `EntryStatus` type [LOW]
**Effort**: 10 minutes
**Files**: `client/src/types/index.ts`
**Description**: Add missing status values to the `EntryStatus` union type to match server reality. Fixes TypeScript error in ScanPromptsTab.

### Task 4: Clean up unused `react-hook-form` import [LOW]
**Effort**: 5 minutes
**Files**: `client/src/components/ui/form.tsx`
**Description**: Either install the package or remove the unused form component.

---

## 6. Recommendations

### Priority Order
1. **Task 1** (scan/counts fix) -- highest impact, lowest effort. Fixes broken data on every page load.
2. **Tasks 2-4** -- low-priority cleanup, can be batched in a single housekeeping commit.

### Strategic Suggestions
1. **Add API route smoke tests** -- a test that verifies every client `authFetch` URL has a matching server route would catch mismatches like Issue 1 during development.
2. **Client/server type sync** -- consider generating the client types from the server type definitions (or at minimum, keep a shared status enum) to prevent drift.
3. **Network error visibility** -- the `fetchWireCounts` failure is silently swallowed. Consider adding a subtle indicator when background data fetches fail, so operators know when they're seeing stale/incomplete data.
