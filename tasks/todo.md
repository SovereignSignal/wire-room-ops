# QA Fix Implementation Plan

## Batch 1: Shared Utilities (Foundation)
- [x] Extract `escapeHtml` to `src/utils/html.ts`
- [x] Extract `sleep` to `src/utils/async.ts`
- [x] Consolidate `normalizeUrl` to `src/utils/url.ts`
- [x] Update all imports in consumer files

## Batch 2: Critical Fixes
- [x] C1: Add `pool.on('error')` handler in `src/db/index.ts`
- [x] C2: Add concurrent job guard in `src/server.ts`
- [x] C3: Fix scheduler `isInitialized` on failure in `src/services/scheduler.ts`

## Batch 3: DB Layer (`src/db/index.ts`)
- [x] Pool config: add idleTimeout, connectionTimeout
- [x] SSL: make `rejectUnauthorized` configurable (M13)
- [x] DDL: wrap `ensureScanTables()` in transaction (M9)
- [ ] Types: replace `any[]` with `QueryParam` union (L3 — deferred, low risk)

## Batch 4: Auth + Job Queue
- [x] `auth.ts`: Add periodic cleanup timer for tokens/sessions (H7)
- [x] `auth.ts`: Add cleanup call to `createDownloadToken()` (H7)
- [x] `job-queue.ts`: Add periodic cleanup + time-based expiration (H6)

## Batch 5: Server.ts Fixes
- [x] H1: XSS - Replace inline onclick with event delegation
- [x] H2: XSS - `data.model` already wrapped in `escapeHtml()`, verified safe
- [x] H3: Input validation on date/score params
- [x] H4: SSE keepalive for long jobs
- [x] M1: CSRF origin checking on all state-changing requests
- [x] M2: Auth on `/resend-link`
- [x] M3: Remove session-from-body fallback
- [x] M8: Consistent UUID validation on schedule + scan endpoints
- [x] M12: Deduplicate page-load `/api/feeds` calls via shared cache

## Batch 6: Scheduler + Processor
- [x] M7: Scheduled job retry logic (single retry after 5 min)
- [x] M10: Batch INSERT in daily-intake Phase 1 (chunks of 50)
- [x] M11: Concurrent entry processing (3 at a time)
- [x] L4: Retry jitter (random 0-30% added to delays)

## Batch 7: Cleanup
- [x] L2: `index.ts` require -> import (proper TypeScript imports)
- [x] Update CLAUDE.md with new utils, fixes, security layers

## Deferred (Low Priority / Won't Fix)
- L3: `any[]` types in DB layer — minor, pg accepts `any[]` for params
- L6: "All Feeds" in schedule dropdown — valid option (empty wire = all feeds)
- L7: Process Scan empty validation — already exists (line 2829)
- M5: Timezone handling — `toLocaleString` works for single-instance Node.js
- M6: Magic link race condition — Node.js single-threaded, no real race
- L5: Loading spinners — cosmetic, low priority

## Review Notes
- All changes compile cleanly (`npx tsc --noEmit` passes)
- H5 (deploy gap) will be resolved when these changes are committed and deployed
