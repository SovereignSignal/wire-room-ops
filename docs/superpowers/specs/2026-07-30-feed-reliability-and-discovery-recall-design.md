# Feed reliability + discovery recall — design

**Date:** 2026-07-30
**Origin:** The Jul 30 daily digest reported three production issues. Investigation showed one real outage, one reporting defect, and one structural problem in the scan lane.

## Evidence

All figures verified against production Postgres (`wire-room-db`) and Railway runtime logs on 2026-07-30.

### The three reported issues

```
Source feeds: 1 of 21 sources errored
High dupe rate: ai/web-search — 100% of 14
High dupe rate: oss/web-search — 90% of 10
```

### Issue 1 — Karma GAP has been dark since Jul 27

Runtime log: `[Feeds] karma-gap failed: Unexpected end of JSON input`

Per-source watermarks prove this is not a blip. `setAppState` (`src/db/index.ts`) bumps
`updated_at` unconditionally, and the watermark is written only on the success path
(`src/jobs/source-feeds.ts:145`), so a stale watermark means consecutive failed runs:

| source | last successful fetch | days stale |
|---|---|---|
| karma-gap | 2026-07-27 | 3 |
| all 20 others | 2026-07-30 | 0 |

The endpoint itself is healthy: 5/5 manual fetches returned HTTP 200, 268,763 bytes,
valid JSON, 94 programs, in ~4s. The failure is specific to the Railway runtime or to
timing, not to the API being down.

Two competing hypotheses, neither proven:

1. `AbortSignal.timeout(20000)` (`src/services/source-feeds.ts:254`) fires mid-body on the
   largest payload in the registry; undici surfaces the truncated buffer as a JSON parse
   error rather than an `AbortError`.
2. An upstream connection drop truncates the response.

**The current code cannot distinguish these.** That is itself the defect worth fixing.
There is also no retry: the `catch` at `src/jobs/source-feeds.ts:148` records the message
and moves on, so a single transient failure on any of 21 sources escalates directly to an
incident line in the operator's morning email.

### Issues 2 and 3 — the dupe rates are dedup working, not failing

All 31 web-search entries from the last 24h were inspected. Every duplicate is a correct catch:

- 20 by `dedup-worker` — exact URL or exact name match
- 10 by `program-gate` — Layer 1.75 program identity
- 1 genuinely new (*NGI TALER Open Call (2026-02T)*, queued)

The condition is chronic, not new. Ten-day totals for `scan_source='web-search'`:
249 entries, 235 duplicate, 8 archived, 2 approved, 2 declined, 1 queued. Daily dupe rate
ranged 88–100% every single day.

Today only *looked* new because volume crossed the `total >= 10` floor on two wires at once.
Crypto was also 100% duplicate (7 of 7) but sat below the floor, so it is silently absent
from the email. The true cross-wire rate was 30/31 = 97%.

### The actual root cause of 2 and 3

Only three scan prompts are active system-wide — the Parallel Frontier discovery prompts,
one per wire (`tool_type='parallel'`, `intent='discovery'`, `variant='P'`). Every
`web_search` and `perplexity` prompt is disabled.

`after_date` **is** already wired for discovery prompts (`src/jobs/scan-execution.ts:173`)
and is being honored — of 92 entries over 3 days, only 6 had a source date older than the
90-day floor. But the window is 90 days while the prompt text asks for 21.

The structural problem: **the scan lane re-searches a rolling 90-day window every day with
no memory of what it already pulled**, while dedup remembers far longer (180 days for names,
indefinite for the program gate). The lane is mathematically guaranteed to return ~89 days
of already-ingested content on every run.

The feed lane already solved this with per-source watermarks in `app_state`
(`feed:seen:<key>`), which is why feeds ran 6 fetched → 2 duplicates today while the scan
lane ran 31 → 30. Duplicates are caught downstream, after paying for Parallel retrieval,
Grok extraction, and classification on every known item. Cheap in dollars (~$0.22/day) but
it is why the digest cries wolf.

### Dormant asset: registry-watch

`watch_surfaces` holds 157 checkable surfaces that were checked exactly once, on 2026-07-04,
and never since. `REGISTRY_WATCH_ENABLED` is not set in Railway and
`REGISTRY_WATCH_DRY_RUN` defaults to `true` (`src/config/index.ts:43-44`). Commit `217fe3e`
is titled "Watchtower Phase 1 — registry-driven watchers + xAI cost circuit breaker
(gates OFF)": this was a deliberate dark launch that was never promoted, not drift.

`getDueSurfaces` (`src/services/registry-watchers.ts:32`) currently selects Tier 1 **and**
Tier 2 in one hardcoded `WHERE` clause. There is no tier knob.

## Goals

1. Restore Karma GAP, and make the next feed failure self-diagnosing.
2. Make the digest escalate what is actually wrong, and stop escalating what is right.
3. Stop the scan lane re-buying content it already owns.
4. Raise genuine discovery recall by promoting the built-and-tested registry-watch lane.

## Non-goals

- Changing the dedup stack. It is working correctly and today proved it.
- Reactivating the disabled `web_search` / `perplexity` prompts.
- Enabling the X-list lane.
- Adding any new cron. All periodic work stays folded into the daily-digest cycle.

## Delivery

Four independent PRs, ordered by urgency. PR A ships standalone and first.

---

## PR A — Feed fetch reliability

Fixes the Karma GAP outage and makes the next failure diagnose itself.

### Changes

**Text-first body parsing.** The two JSON fetchers — `fetchRestJson` and `fetchGraphql` —
share one new helper that reads the body as text before parsing, so truncation is reported
as truncation. (`fetchGithubCsv` already reads text and does not parse JSON; it gains the
abort classification and retry below, but not this helper.)

```ts
const text = await r.text();
// Compare BYTES, not UTF-16 code units — content-length is bytes, and any
// non-ASCII in the payload would make text.length < content-length on a
// perfectly complete body, producing a false truncation error.
const received = Buffer.byteLength(text, 'utf8');
const expected = Number(r.headers.get('content-length')) || null;
if (expected && received < expected) {
  throw new Error(`truncated body: got ${received} of ${expected} bytes`);
}
try { return JSON.parse(text); }
catch { throw new Error(`invalid JSON (${received} bytes received)`); }
```

Karma GAP's response is `content-length: 268763` with no chunked encoding, so the byte check
is meaningful for this source. Sources that respond with `transfer-encoding: chunked` send no
`content-length`; there `expected` is null and only the JSON parse guard applies.

**Explicit abort classification.** Catch `AbortError` and report `timeout after Ns` instead
of letting it surface as a parse error.

**Per-source timeout.** Add optional `timeoutMs` to the `FeedSource` type, defaulting to the
current 20s. Set karma-gap to 45s — it is by far the largest payload in the registry.

**Retry.** Wrap each source's fetch in the existing `withRetry(fn, 2)` from
`src/services/processor.ts`. Do not introduce a new retry helper.

### Scope

`src/services/source-feeds.ts`, the `FeedSource` type, the karma-gap registry entry.
Tests extend `tests/source-feeds.test.js`.

### Success criteria

- karma-gap's watermark advances on the next daily run
- A simulated truncated response produces `truncated body: got N of M bytes`
- A simulated timeout produces `timeout after Ns`, never a JSON parse error
- A source that fails once then succeeds does not appear in the digest at all

---

## PR B — Digest tells the truth

Two changes. Both use evidence that already exists; no new schema.

### Stale-source escalation

`feed:seen:<key>` already stores `{ urls, lastRun }` (`src/jobs/source-feeds.ts:145`), so
days-since-last-success is directly readable without new state.

Replace `Source feeds: 1 of 21 sources errored` (`src/services/scheduler.ts:433`) with a line
that names the source and its age:

```
Source feeds: karma-gap failing 3 days (last OK Jul 27)
```

Severity: day 1 is a warning glyph in the run ledger. **Two or more consecutive days is a
hard production issue.**

### Net-new yield replaces dupe rate

Delete the `duplicates/total > 0.6` anomaly at `src/jobs/daily-digest.ts:564-568` entirely.

Replace with: **a lane that produced zero net-new items for 3 consecutive days is a
production issue.** Net-new means entries whose status is not `duplicate` or `deduped`,
counted per `scan_source` over the trailing window — derivable from `scan_entries` with no
new state.

Dupe rate survives only as dashboard/ledger context, never as an email issue line.

This removes the per-wire volume floor that hid crypto's 100% dupe rate, because yield is
counted per lane rather than gated on per-wire volume.

### Scope

`src/jobs/daily-digest.ts`, `src/services/scheduler.ts`, the `src/services/email.ts`
renderer. Tests: `tests/daily-digest.test.js`, `tests/digest-email.test.js`. The latter pins
the renderer, so it must be updated deliberately as part of this PR.

### Success criteria

- A source stale ≥2 days is named in the email with its day count
- A source that failed once today produces no issue line
- A lane with zero net-new for 3 days produces an issue line regardless of wire volume
- No dupe-rate line appears in the email under any condition

---

## PR C — Scan lane stops re-buying what it already owns

### Early dedup

Filter Parallel's `/v1/search` results against the existing `seen_urls` index **before** the
Grok extraction call in `executeParallelScan` (`src/services/parallel.ts`).

Chosen over a new per-prompt watermark because it adds no state, reuses the canonical
normalized-URL index that dedup already trusts, and cuts cost at the most expensive point.

**Known limit, accepted:** of today's 30 duplicates, 20 were exact-URL matches and would be
caught here; 10 were program-gate catches on name/program identity and will still reach
downstream dedup. Expect roughly a two-thirds reduction in churn, not elimination.
Downstream dedup is unchanged and remains the backstop.

### Window alignment

Tighten the discovery `after_date` from 90 days to **21** (`src/jobs/scan-execution.ts:173`),
matching what the three Frontier prompts already state in their own text. Canonical and
signal prompts continue to pass no `after_date` — unchanged.

### Telemetry

Log the count of results filtered pre-extraction per run, so the saving is visible and the
PR's effect is measurable.

### Scope

`src/services/parallel.ts`, `src/jobs/scan-execution.ts`. New tests for the filter path.

### Success criteria

- A search result whose normalized URL is in `seen_urls` for that wire never reaches Grok extraction
- Discovery scans request `after_date` at 21 days; canonical/signal scans send none
- The filtered-count log line appears on every parallel scan run
- Measured over one week: web-search duplicate count drops materially from the 235/249 baseline

---

## PR D — Registry-watch promotion

Mostly config. One small code change.

### Tier scope control

Add a tier scope parameter to `getDueSurfaces` (`src/services/registry-watchers.ts:32`),
driven by a new `REGISTRY_WATCH_TIERS` env var defaulting to `1`. This is the only code
change in this PR.

### Rollout sequence

1. Set `REGISTRY_WATCH_ENABLED=true` and `REGISTRY_WATCH_DRY_RUN=true` in Railway
2. Let one daily cycle run; read the logs for what it would submit
3. If sane, set `REGISTRY_WATCH_DRY_RUN=false`

**65 Tier 1 surfaces.** `runRegistryWatch` polls exactly three surface types —
`rss` (`src/jobs/registry-watch.ts:166`) and `grants_page` + `application`
(`src/jobs/registry-watch.ts:213`). Tier 1 holds 19 rss + 30 grants_page + 16 application.
The other Tier 1 surface types (website, x_account, github, blog, forum) are never polled by
this lane and are out of scope.

### Existing safety, verified

The lane is already change-gated (hash-diff; LLM read only when the hash changes and it is
not the surface's first-ever check), budget-gated (`checkBudget`, fails closed on error),
baseline-gated (a surface's first check marks-seen and reports nothing fresh, so enabling
cannot flood the queue), and folded into the daily-digest cycle — no new cron.

### Scope

`src/services/registry-watchers.ts`, `src/config/index.ts`, Railway env vars.
Tests: `tests/registry-watch.test.js`, `tests/registry-watchers.test.js`.

### Success criteria

- With `REGISTRY_WATCH_TIERS=1`, no Tier 2 surface is selected
- Dry-run cycle logs intended submissions and writes no `scan_entries` rows
- After going live, `watch_surfaces.last_checked_at` advances daily for Tier 1 surfaces
- Monthly spend stays under `WATCHTOWER_BUDGET_MONTHLY_USD`

---

## Sequencing and why

**A → (B, C in either order) → D.**

A ships first and alone: it is an active outage and is independent of everything else.

B and C are independent of each other.

D lands last deliberately. Its new volume must arrive *after* the digest can report yield
honestly (PR B), otherwise there is no way to tell whether registry-watch is helping.

## Risks

| Risk | Mitigation |
|---|---|
| PR A's retry masks a genuine persistent failure | Stale-source escalation in PR B surfaces it by day 2 regardless of retries |
| PR C's 21-day window is too tight and drops real finds | Registry-watch (PR D) covers freshness structurally; window is one constant, trivially reverted |
| PR B's 3-day zero-yield rule is too noisy or too quiet | Single constant, tune after one week of observation |
| PR D floods the queue | Dry-run cycle first; baseline gate means first checks report nothing |
| `digest-email.test.js` churn hides a rendering regression | Renderer test updated deliberately in PR B with reviewed expectations |
