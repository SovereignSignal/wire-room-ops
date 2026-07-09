# Digest Email Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh the daily WireOps email so it shows fresh high-signal items and production issues only, with the selected Ops Dashboard Lite presentation.

**Architecture:** Keep the existing daily-digest pipeline. Change the pending-find query to return fresh queued items only, and change the renderer to treat passed `topFinds` as the actionable morning set. Preserve the existing sender and schedule plumbing.

**Tech Stack:** Node.js, TypeScript, Express, Postgres SQL, Resend, `node:test`.

---

## File Structure

- Modify `tests/digest-email.test.js`: pin the new subject, layout, quiet state, anomaly rendering, and no stale backlog copy.
- Create `tests/daily-digest.test.js`: assert `getTopPendingFinds()` uses the fresh-item SQL filter and curator ordering.
- Modify `src/jobs/daily-digest.ts`: filter queued items to last 24 hours and order by curator signal, quality score, deadline, recency.
- Modify `src/services/email.ts`: render the Ops Dashboard Lite shell for daily digest emails.

### Task 1: Pin Fresh Query Behavior

**Files:**
- Create: `tests/daily-digest.test.js`
- Modify: `src/jobs/daily-digest.ts`

- [ ] **Step 1: Write the failing query test**

```javascript
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { getTopPendingFinds } = require('../src/jobs/daily-digest');

test('getTopPendingFinds returns fresh queued items ordered by curator signal first', async () => {
  let captured = null;
  const pool = {
    async connect() {
      return {
        async query(sql, params) {
          captured = { sql, params };
          return { rows: [] };
        },
        release() {},
      };
    },
  };

  await getTopPendingFinds(pool, 7);

  assert.match(captured.sql, /status = 'queued'/);
  assert.match(captured.sql, /created_at >= NOW\(\) - INTERVAL '24 hours'/);
  assert.match(captured.sql, /deadline_parsed IS NULL OR deadline_parsed >= CURRENT_DATE/);
  assert.match(captured.sql, /metadata->'curator'->>'route'/);
  assert.match(captured.sql, /metadata->'curator'->>'confidence'/);
  assert.match(captured.sql, /quality_score DESC NULLS LAST/);
  assert.deepEqual(captured.params, [7]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/daily-digest.test.js`

Expected: fail because the SQL does not contain the fresh `created_at` filter or curator ordering.

- [ ] **Step 3: Implement the query change**

Update `getTopPendingFinds()` to add the 24-hour filter and an `ORDER BY` using curator route, curator confidence, quality score, deadline, and created time.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/daily-digest.test.js`

Expected: pass.

### Task 2: Pin Ops Dashboard Lite Rendering

**Files:**
- Modify: `tests/digest-email.test.js`
- Modify: `src/services/email.ts`

- [ ] **Step 1: Write failing renderer expectations**

Update the digest email tests so they expect:

```javascript
assert.match(r.subject, /2 fresh/);
assert.match(r.subject, /0 issues/);
assert.match(r.html, /Open first/);
assert.match(r.html, /Fresh/);
assert.match(r.html, /Issues/);
assert.ok(!r.html.includes('Needs you (11)'));
```

- [ ] **Step 2: Run the renderer test to verify it fails**

Run: `node --test tests/digest-email.test.js`

Expected: fail because the existing renderer still leads with `Needs you` and subject queue count.

- [ ] **Step 3: Implement the renderer change**

Update `renderDailyDigest()` to:

- compute `freshCount` from `topFinds.length`
- compute `issueCount` from `anomalies.length`
- render a compact metric grid
- rename `Needs you` to `Open first`
- render production issues only when `issueCount > 0`
- set subject to `WireOps - DATE | N fresh | M issues`

- [ ] **Step 4: Run renderer test to verify it passes**

Run: `node --test tests/digest-email.test.js`

Expected: pass.

### Task 3: Verify and Smoke Email

**Files:**
- Modify only if tests reveal an issue.

- [ ] **Step 1: Run focused tests**

Run: `node --test tests/daily-digest.test.js tests/digest-email.test.js`

Expected: pass.

- [ ] **Step 2: Run full test suite**

Run: `npm test`

Expected: pass.

- [ ] **Step 3: Send smoke digest email**

Run an on-demand daily digest send using the existing `sendDailyDigestEmail()` path and the real configured notification recipient.

Expected: Resend call succeeds and the inbox receives the refreshed WireOps digest.
