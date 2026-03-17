# Wire Ops Dashboard QA Report

**Date**: 2026-03-16
**URL Tested**: https://wire-room-ops-production.up.railway.app/
**Browser**: Chrome (via Claude-in-Chrome MCP)
**System Status**: ARRAY ONLINE, all API providers active

---

## 1. Testing Summary

Conducted systematic testing of the Wire Ops React SPA dashboard covering: Overview tab, Scans tab (prompts, edit dialog, tool type dropdown), Queue tab (filters, entries, duplicates), Database tab, Settings tab (Sources, Distribution, API Providers), and general UI/console/network health.

**Overall Health**: The dashboard is in good shape. The React SPA loads cleanly, navigation between all 5 main tabs works correctly, and all API requests return 200 OK. No JavaScript errors from the application code. The primary issues found are data quality problems (duplicates in queue, "UNKNOWN" wire) and minor UI/accessibility polish items.

---

## 2. Working Features (Confirmed Functional)

### Overview Tab
- All 4 stat cards load with reasonable numbers: Ingested This Week (468), In Queue (48 at start, declining due to live processing), Raw/Incoming (0), Published (326)
- System Status section shows Avg Quality (35) and Active Sources (4 Wires)
- Recent Activity section shows latest entries with wire badges and timestamps
- ARRAY ONLINE indicator with auto-refresh timer working

### Scans Tab
- 31 prompts configured (12 active, 19 inactive)
- Active prompts correctly show 4 per wire (ai, crypto, oss) with X Search, Perplexity, Web Search, and Perplexity tool types
- Each prompt row displays: Label, Wire, Tool (with icon), Status (ACTIVE badge), Last Run, Next Run, and Actions (RUN/EDIT/DEL)
- "INACTIVE PROMPTS" divider correctly separates active from inactive prompts
- Inactive prompts show OFF status badge and dimmed styling
- PROMPT SCORECARD shows "21-day window 3% overlap"
- Edit Prompt dialog opens correctly with all fields:
  - Schedule section (linked schedule info)
  - Wire and Variant dropdowns
  - Label text field
  - Tool Type dropdown (confirmed: only X Search, Web Search, Perplexity -- NO "Community" option)
  - Intent dropdown (Discovery, Canonical, Signal)
  - Output dropdown (Text (parsed), JSON (structured))
  - Model Override field
  - Prompt Text textarea
  - Response Format textarea
- "+ ADD PROMPT" button visible in top right

### Queue Tab
- Loads entries with correct data (names, descriptions, tags, wire badges, classifications, quality scores)
- Wire filter buttons (ALL, CRYPTO, AI, OSS) work correctly -- selecting CRYPTO shows only CRYPTO entries, etc.
- Type filters present: All, GRANT, EXPIRED, NEWS, NOISE, UNCLASSIFIED
- Advanced filters present: VERTICAL, SIGNAL, TIMELINE dropdowns
- Entry rows show: checkbox, name, description excerpt, entity tags, wire badge, classification badge, quality score, date, source link, action buttons (approve, archive, decline, delete)
- "more" expand links visible on entries with long descriptions
- Quality scores correctly color-coded (green for high, red/orange for low)
- Entries sorted by quality score (descending)
- No community-sourced entries visible (confirmed via text search -- "community" only appears in entry descriptions, not as scan sources)

### Database Tab
- 4 stat cards: Scan Entries (2,318), Published (3,392), Queue Depth (36), Raw/Unprocessed (0)
- Sub-tabs: SCAN ENTRIES, INTAKE RUNS, DISTRIBUTION LOG, PUBLISHED
- Filters: WIRE dropdown, STATUS dropdown, SEARCH text input, FROM/TO date pickers, APPLY button
- CSV export button
- Entries display with: Name, Wire, Status, Quality, Source, Date columns
- Source column correctly shows "telegram" for Telegram-ingested entries

### Settings Tab - Sources
- Wire health cards for UNKNOWN, CRYPTO, AI, OSS showing: ingested count, duplicate %, avg quality, high quality count/%, last scan time
- Quality ratings correctly color-coded (red for Poor, yellow for Marginal)

### Settings Tab - Distribution
- 3 Telegram channels configured (ai, crypto, oss), all ACTIVE
- Each channel shows: Name, Type, Wire, Target ID, Status, Actions (TEST/EDIT/DEL)
- "+ ADD CHANNEL" button present

### Settings Tab - API Providers
- 7 providers configured, all ACTIVE:
  1. Grok (xAI) - DB, model: grok-4.20-beta-0309-non-reasoning
  2. Claude (Anthropic) - DB, model: claude-opus-4-1-20250805
  3. Firecrawl - DB
  4. Perplexity - DB, model: sonar-pro
  5. Resend - DB
  6. Telegram (Distribution) - ENV
  7. Telegram (Intake) - ENV
- API keys properly masked in display
- TEST CONNECTION and EDIT buttons present on each

### Navigation & System Health
- All 5 main tabs (Overview, Scans, Queue, Database, Settings) navigate correctly
- Settings has 7 sub-tabs, all accessible: Sources, Scan Prompts, Distribution, API Providers, Usage, Integrations, Email
- Header shows ARRAY ONLINE with auto-refresh timestamp and LOGOUT button
- No application JavaScript errors in console
- All API network requests return 200 OK

---

## 3. Issues Found

### HIGH: Duplicate Entries in Queue (Dedup Failure)

**Severity**: High
**Steps to Reproduce**:
1. Navigate to Queue tab
2. Set filter to ALL
3. Scroll through entries

**Expected Behavior**: Each unique grant/opportunity should appear only once in the queue.

**Actual Behavior**: Multiple duplicates found:
- "Avalanche Retro9000" appears **3 times** (all CRYPTO, GRANT, score 48, identical descriptions and tags)
- "Maori AI Scholarship" appears **2 times** (one short name, one with description appended to name)
- "RAISE Hackathon" appears **2 times** (one as "RAISE Hackathon", one as "[RAISE Hackathon]" in brackets)
- "Aleph Hackathon" appears **2 times** (both CRYPTO, NEWS, score 28)
- "World Foundation Grants (Worldcoin)" appears **2 times** (both CRYPTO, NEWS, score 28)
- "Core Foundation Grant" appears **2 times** (both CRYPTO, NEWS, score 28)

**Potential Root Cause**: The fuzzy name dedup (`seen_names` table) may not be catching entries with:
1. Nearly identical names from different scan runs (same URL, different name formatting)
2. Bracket-wrapped names from Telegram intake (e.g., "[RAISE Hackathon]" vs "RAISE Hackathon")
3. Names with descriptions appended (e.g., "Maori AI Scholarship -- new scholarship program...")

The dedup system uses token overlap, but bracket punctuation and name-description concatenation may bypass the anchor token matching.

**Impact**: Operator wastes time reviewing the same entry multiple times. Affects editorial efficiency directly.

### MEDIUM: Queue Draining Rapidly During Session (48 to 0)

**Severity**: Medium
**Steps to Reproduce**:
1. Open Queue tab (shows 48 entries)
2. Navigate between tabs for ~15 minutes
3. Return to Queue tab

**Expected Behavior**: Queue count should remain stable unless an operator takes action.

**Actual Behavior**: Queue count decreased from 48 -> 45 -> 43 -> 42 -> 37 -> 33 -> 10 -> 0 over ~15 minutes with no operator action taken. Entries appear to be auto-archived during the session.

**Potential Root Cause**: The `process-raw` background job or classify-backfill process may be running and archiving entries that fail quality thresholds. Alternatively, the Telegram intake bridge may be re-processing entries and changing their status. This needs investigation to determine if the auto-archival is intentional or a bug.

**Impact**: If intentional (quality threshold enforcement), this is working as designed but the operator has no visibility into why entries disappear. If unintentional, entries are being lost.

### MEDIUM: "UNKNOWN" Wire in Settings > Sources

**Severity**: Medium
**Steps to Reproduce**:
1. Navigate to Settings > Sources tab
2. Observe the wire health cards

**Expected Behavior**: Only known wires (crypto, ai, oss) should appear as source cards.

**Actual Behavior**: An "UNKNOWN" wire card appears with significant volume: 192 ingested entries, 27 scans this week, 44% duplicate rate, Avg Quality 44.

**Potential Root Cause**: Entries ingested via Telegram intake or summary-sync bridge without a wire assignment default to some "unknown" value. The `summary-sync.ts` bridge infers wire from content keywords but may fall back to an empty/unknown value when no keywords match.

**Impact**: 192 entries are not properly categorized and won't appear under any wire filter in the Queue tab. These entries are invisible to the operator's normal review workflow.

### LOW: Bracket-Wrapped Entry Names from Telegram Intake

**Severity**: Low
**Steps to Reproduce**:
1. Navigate to Queue tab, scroll to low-score entries
2. Look for entries with names like "[AI Skills Scholarship Program]" and "[RAISE Hackathon]"

**Expected Behavior**: Entry names should be clean text without surrounding brackets.

**Actual Behavior**: Some entries have names wrapped in square brackets, e.g., "[RAISE Hackathon]" and "[AI Skills Scholarship Program]".

**Potential Root Cause**: The Telegram intake parser or the LLM classifier may be wrapping names in brackets when extracting from Telegram message format.

**Impact**: Minor display issue. Also contributes to dedup failures since "[RAISE Hackathon]" and "RAISE Hackathon" are not recognized as duplicates.

### LOW: NOISE-Classified Entry Still in Queue

**Severity**: Low
**Steps to Reproduce**:
1. Navigate to Queue tab
2. Scroll to bottom of entries
3. Find "JSAI Buildathon Hack" (CRYPTO, NOISE, score 18)

**Expected Behavior**: Entries classified as NOISE should be auto-archived and not appear in the queue.

**Actual Behavior**: JSAI Buildathon Hack has NOISE classification but remains in the queued status with score 18.

**Potential Root Cause**: The entry may have been classified after being queued, and the status wasn't updated to "archived" as expected. Or NOISE entries from Telegram intake may bypass the auto-archive logic.

**Impact**: Minor -- operators can manually archive it. But NOISE entries polluting the queue reduce review efficiency.

### LOW: React Accessibility Warning in Edit Dialog

**Severity**: Low
**Steps to Reproduce**:
1. Open any prompt's Edit dialog
2. Check browser console

**Expected Behavior**: No console warnings.

**Actual Behavior**: Two React warnings: "Missing `Description` or `aria-describedby={undefined}` for {DialogContent}."

**Potential Root Cause**: The Dialog component (likely from Radix UI) expects a `DialogDescription` child or an `aria-describedby` prop to be accessible. The Edit Prompt dialog doesn't provide either.

**Impact**: Accessibility concern for screen reader users. No visual or functional impact.

### LOW: Edit Prompt Dialog "Next Run" Format Ambiguous

**Severity**: Low
**Steps to Reproduce**:
1. Click EDIT on any active prompt
2. Look at the SCHEDULE section

**Expected Behavior**: Next run time should be clearly formatted.

**Actual Behavior**: Shows "Next run: 3/16/2026, 11:00:00 AM (1h 2h)" -- the "(1h 2h)" suffix is ambiguous. It's unclear if this means "in 1 hour 2 hours" or some other duration format.

**Impact**: Minor confusion for operators trying to understand when the next scan will run.

---

## 4. Proposed Improvement Tasks

### Task 1: Fix Queue Dedup for Telegram Intake Entries
**Priority**: High
**Type**: Bug fix
**Description**: Improve the dedup system to handle:
1. Bracket-stripped name matching (normalize "[Name]" to "Name" before dedup)
2. Name-with-description matching (detect when a description is appended to a name and split before dedup)
3. Cross-run same-name detection (entries with identical or near-identical names from different scan runs/sources)
**Files**: `src/services/dedup.ts`, `src/services/intake.ts`, `src/services/intake-core.ts`

### Task 2: Investigate and Fix Queue Auto-Drain Behavior
**Priority**: Medium
**Type**: Investigation / Bug fix
**Description**: The queue dropped from 48 to 0 entries in ~15 minutes with no operator action. Investigate:
1. Is a background job (process-raw, classify-backfill) running and archiving entries?
2. Check `scan_entries` status change logs for entries that were queued then archived during the test window
3. If auto-archival is intentional, add visibility (e.g., toast notification "X entries auto-archived due to quality threshold")
**Files**: `src/jobs/process-raw.ts`, `src/jobs/daily-intake.ts`, `src/services/classifier.ts`

### Task 3: Resolve "UNKNOWN" Wire Entries
**Priority**: Medium
**Type**: Data quality fix
**Description**: 192 entries are assigned to an "UNKNOWN" wire and are invisible in the normal queue review flow.
1. Identify the source of entries without wire assignment (likely Telegram intake or summary-sync)
2. Add a default wire fallback (or use "crypto" as default per CLAUDE.md)
3. Backfill existing UNKNOWN entries with appropriate wire assignments
4. Consider hiding "UNKNOWN" from the Sources card if it's not a real wire
**Files**: `src/services/intake-core.ts`, `src/jobs/summary-sync.ts`

### Task 4: Auto-Archive NOISE Entries from Queue
**Priority**: Low
**Type**: Bug fix
**Description**: Entries classified as NOISE (like "JSAI Buildathon Hack" with score 18) should be auto-archived rather than remaining in the queue. Verify that the NOISE -> archived status transition is happening consistently, especially for entries classified after initial queuing.
**Files**: `src/services/classifier.ts`, `src/jobs/daily-intake.ts`

### Task 5: Add DialogDescription to Edit Prompt Modal
**Priority**: Low
**Type**: Accessibility fix
**Description**: Add a `DialogDescription` component (or visually hidden description via `aria-describedby`) to the Edit Prompt dialog to resolve the React console warnings and improve screen reader accessibility.
**Files**: `client/src/components/` (wherever the prompt edit dialog is defined)

### Task 6: Clean Up Next Run Time Format
**Priority**: Low
**Type**: UI polish
**Description**: The "(1h 2h)" suffix on the next run time in the Edit Prompt dialog's Schedule section is ambiguous. Change to a clearer format like "in 1h 2m" or "1 hour, 2 minutes from now".
**Files**: `client/src/components/` (prompt edit dialog / schedule display component)

---

## 5. Recommendations

### Priority Order
1. **Task 1 (Dedup)** -- Directly impacts operator efficiency. Duplicate entries are the highest-friction issue in the current workflow.
2. **Task 2 (Queue Drain)** -- Needs investigation first to determine if it's a bug or feature. If entries are being lost, this is critical.
3. **Task 3 (UNKNOWN Wire)** -- 192 entries are effectively invisible. Quick win if the fix is just adding a default wire fallback.
4. **Tasks 4-6** -- Low priority polish items that can be addressed in a future cleanup pass.

### Positive Observations
- The React SPA dashboard is a massive improvement over the old server-rendered pages (from the Feb 2026 QA report)
- The Scans tab organization (active prompts first, inactive divider, tool type icons) is clean and intuitive
- The Queue filtering system (wire buttons + type filters + advanced filters) is well-designed
- All API calls are returning 200 OK with no network failures
- The Settings tab is comprehensive with good sub-tab organization
- No JavaScript application errors in the console -- only browser extension noise and minor React warnings
