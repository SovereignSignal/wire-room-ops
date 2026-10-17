# Feed Reliability + Discovery Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the dead Karma GAP feed and make feed failures self-diagnosing; make the daily digest escalate net-new yield instead of duplicate rate; stop the Parallel scan lane re-processing content it already ingested; and promote the dormant registry-watch lane to Tier 1.

**Architecture:** Four independent PRs against `main`. PR A hardens the feed HTTP layer with byte-accurate truncation detection, abort classification, per-source timeouts, and a transient-only retry. PR B replaces the duplicate-rate anomaly with a zero-net-new-yield anomaly and names stale sources with their day count. PR C adds an injectable `filterSeenUrls` seam to the Parallel scan so already-seen URLs never reach Grok extraction, and tightens the discovery freshness window. PR D adds a tier-scope knob to the registry-watch surface query so the lane can be enabled on Tier 1 only.

**Tech Stack:** TypeScript (strict), Node 26, Express, Postgres (`pg`), `node:test` + `node:assert/strict` with `ts-node/register/transpile-only`.

**Spec:** `docs/superpowers/specs/2026-07-30-feed-reliability-and-discovery-recall-design.md`

## Global Constraints

- TypeScript strict mode. Every new export needs explicit parameter and return types.
- Tests are `node:test`, run with `npm test` (`node --test tests/**/*.test.js`). Test files are **CommonJS `.js`** that `require('ts-node/register/transpile-only')` on line 1, then `require()` the TypeScript module under test.
- Typecheck with `npm run typecheck` (`tsc --noEmit`). **Never pipe `tsc` through `head`/`grep` in an `&&` chain** — it masks the failure exit code. Run it bare, read the exit code.
- Unit tests must not touch the network or a live database. Pure functions and injected seams only, matching the pattern in `src/jobs/registry-watch.ts` (`RegistryWatchDeps`).
- Minimal dependencies — add no npm packages in this plan.
- Do not modify the dedup stack (`src/services/dedup.ts`, `src/services/program-identity.ts`). It is working correctly.
- Do not add any new cron or `schedules` row. All periodic work stays folded into the daily-digest cycle.
- Commit messages end with the two trailers used in this repo:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01SHawQM6oZVdqkf6N4QHNHM
  ```
- Each PR is its own branch off `main`. Do not push or open a PR unless the operator asks.

## Deviation from the spec — read before starting PR A

The spec says *"wrap each source's fetch in the existing `withRetry(fn, 2)` … do not introduce a new retry helper."* This plan deliberately does **not** do that.

`withRetry` (`src/services/processor.ts:~30`) retries **every** error, including permanent ones. One of the five feed methods is `scrape`, which calls Firecrawl — a paid API. Retrying a permanently-failing scrape source doubles that cost every day, forever. This plan instead classifies each failure as transient or permanent and retries only transient ones, via a small named function local to `src/jobs/source-feeds.ts`.

Everything else in the spec is implemented as written. Flag this to the operator at PR A review.

## File Structure

**PR A — feed fetch reliability**
- `src/services/source-feeds.ts` — add `FeedFetchError`, `readJsonBody()`, `classifyFetchError()`, `DEFAULT_TIMEOUT_MS`; add `timeoutMs` to `FeedSource`; thread timeout through `httpGet`, `fetchRestJson`, `fetchGraphql`; set karma-gap to 45s
- `src/jobs/source-feeds.ts` — add `fetchSourceWithTransientRetry()`; record `lastOk` on the per-source result
- `tests/source-feeds.test.js` — extend

**PR B — digest truth**
- `src/jobs/daily-digest.ts` — add `formatStaleSourceAnomalies()`, `getLaneYield()`, `formatYieldAnomalies()`; delete the dupe-rate anomaly block
- `src/services/scheduler.ts` — replace the `N of M sources errored` line with named stale-source anomalies
- `tests/daily-digest.test.js`, `tests/digest-email.test.js` — extend

**PR C — scan lane early dedup**
- `src/db/index.ts` — add `findSeenUrls()`
- `src/services/parallel.ts` — add `filterSeenUrls` option; filter before extraction
- `src/jobs/scan-execution.ts` — wire the seam; change the discovery window 90 → 21
- `src/routes/scan-prompts.ts` — change the discovery window 90 → 21 (second call site)
- `tests/parallel-early-dedup.test.js` — create

**PR D — registry-watch Tier 1**
- `src/config/index.ts` — add `registryTiers`
- `src/services/registry-watchers.ts` — add `tierClause()`; thread a `tiers` arg into `getDueSurfaces()`
- `src/jobs/registry-watch.ts` — pass `config.watchtower.registryTiers`
- `tests/registry-watchers.test.js` — extend

---

# PR A — Feed fetch reliability

Branch: `fix/feed-fetch-reliability`

### Task 1: Byte-accurate JSON body reading

Replaces `await r.json()` so a truncated response reports truncation instead of a confusing `Unexpected end of JSON input`.

**Files:**
- Modify: `src/services/source-feeds.ts` (add exports near the fetch-handlers section, around line 233)
- Test: `tests/source-feeds.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `export class FeedFetchError extends Error { readonly transient: boolean }`
  - `export async function readJsonBody(r: Response): Promise<unknown>`

- [ ] **Step 1: Write the failing tests**

Append to `tests/source-feeds.test.js`:

```js
const { readJsonBody, FeedFetchError } = require('../src/services/source-feeds');

// Minimal Response stand-in: only the two members readJsonBody touches.
function fakeResponse(body, contentLength) {
  return {
    headers: { get: (h) => (h.toLowerCase() === 'content-length' && contentLength != null ? String(contentLength) : null) },
    text: async () => body,
  };
}

test('readJsonBody parses a complete JSON body', async () => {
  const body = JSON.stringify({ programs: [{ name: 'A' }] });
  const out = await readJsonBody(fakeResponse(body, Buffer.byteLength(body, 'utf8')));
  assert.deepEqual(out, { programs: [{ name: 'A' }] });
});

test('readJsonBody reports truncation with byte counts, and marks it transient', async () => {
  const full = JSON.stringify({ programs: [{ name: 'A' }] });
  const cut = full.slice(0, 10);
  await assert.rejects(
    () => readJsonBody(fakeResponse(cut, Buffer.byteLength(full, 'utf8'))),
    (err) => {
      assert.ok(err instanceof FeedFetchError);
      assert.equal(err.transient, true);
      assert.match(err.message, /truncated body: got 10 of \d+ bytes/);
      return true;
    }
  );
});

test('readJsonBody counts BYTES not UTF-16 units — multibyte body is not a false truncation', async () => {
  // "é" is 1 UTF-16 unit but 2 UTF-8 bytes. A naive text.length check would
  // see 20 < 25 and wrongly report truncation on a complete body.
  const body = JSON.stringify({ name: 'Fondation Créé — Zürich' });
  const bytes = Buffer.byteLength(body, 'utf8');
  assert.ok(bytes > body.length, 'fixture must actually contain multibyte characters');
  const out = await readJsonBody(fakeResponse(body, bytes));
  assert.equal(out.name, 'Fondation Créé — Zürich');
});

test('readJsonBody reports invalid JSON when no content-length is present (chunked)', async () => {
  await assert.rejects(
    () => readJsonBody(fakeResponse('{"programs": [', null)),
    (err) => {
      assert.ok(err instanceof FeedFetchError);
      assert.equal(err.transient, true);
      assert.match(err.message, /invalid JSON \(14 bytes received\)/);
      return true;
    }
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="readJsonBody"`
Expected: FAIL — `readJsonBody is not a function`.

- [ ] **Step 3: Implement**

In `src/services/source-feeds.ts`, immediately after `const DEFAULT_MAX_ITEMS = 40;`:

```ts
export const DEFAULT_TIMEOUT_MS = 20000;

/**
 * A feed fetch failure with a retry verdict attached. `transient` means a second
 * attempt could plausibly succeed (timeout, truncation, 5xx); permanent failures
 * (4xx, bad config) must not be retried — one of our methods calls a paid API.
 */
export class FeedFetchError extends Error {
  readonly transient: boolean;
  constructor(message: string, transient: boolean) {
    super(message);
    this.name = 'FeedFetchError';
    this.transient = transient;
  }
}

/**
 * Read a JSON body without letting a truncated response masquerade as bad JSON.
 *
 * Compares BYTES, never UTF-16 code units: content-length is a byte count, and any
 * non-ASCII in the payload makes `text.length` smaller than the byte length on a
 * perfectly complete body. Comparing the two directly would report a false truncation
 * on every feed that mentions "Zürich".
 *
 * Chunked responses carry no content-length; there only the parse guard applies.
 */
export async function readJsonBody(r: Response): Promise<unknown> {
  const text = await r.text();
  const received = Buffer.byteLength(text, 'utf8');
  const header = r.headers.get('content-length');
  const expected = header ? Number(header) : null;
  if (expected && Number.isFinite(expected) && received < expected) {
    throw new FeedFetchError(`truncated body: got ${received} of ${expected} bytes`, true);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new FeedFetchError(`invalid JSON (${received} bytes received)`, true);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="readJsonBody"`
Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit code 0, no output. Check with `echo $?` if unsure.

- [ ] **Step 6: Commit**

```bash
git add src/services/source-feeds.ts tests/source-feeds.test.js
git commit -m "$(cat <<'EOF'
fix(feeds): byte-accurate JSON body reading

A truncated response surfaced as "Unexpected end of JSON input", which is
indistinguishable from a malformed payload. readJsonBody compares received
BYTES against content-length so truncation reports itself, and carries a
transient flag for the retry layer.

Byte comparison is deliberate: content-length is bytes, text.length is
UTF-16 code units, and comparing them directly reports false truncation on
any payload containing non-ASCII.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SHawQM6oZVdqkf6N4QHNHM
EOF
)"
```

---

### Task 2: Error classification + per-source timeouts

Turns an aborted fetch into `timeout after 20s` instead of a parse error, and lets the largest source in the registry have a longer fuse.

**Files:**
- Modify: `src/services/source-feeds.ts` — `classifyFetchError()`, `timeoutMs` on `FeedSource`, `httpGet`/`fetchRestJson`/`fetchGraphql`, karma-gap entry
- Test: `tests/source-feeds.test.js`

**Interfaces:**
- Consumes: `FeedFetchError`, `DEFAULT_TIMEOUT_MS` (Task 1)
- Produces: `export function classifyFetchError(err: unknown, timeoutMs: number): FeedFetchError`

- [ ] **Step 1: Write the failing tests**

Append to `tests/source-feeds.test.js`:

```js
const { classifyFetchError, DEFAULT_TIMEOUT_MS } = require('../src/services/source-feeds');

test('classifyFetchError turns an AbortSignal timeout into a readable transient error', () => {
  // AbortSignal.timeout() rejects with a DOMException named TimeoutError in Node 18+.
  const err = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const out = classifyFetchError(err, 45000);
  assert.equal(out.transient, true);
  assert.equal(out.message, 'timeout after 45s');
});

test('classifyFetchError also handles the AbortError spelling', () => {
  const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
  assert.equal(classifyFetchError(err, 20000).message, 'timeout after 20s');
});

test('classifyFetchError treats 5xx as transient and 4xx as permanent', () => {
  assert.equal(classifyFetchError(new Error('HTTP 503'), 20000).transient, true);
  assert.equal(classifyFetchError(new Error('HTTP 404'), 20000).transient, false);
});

test('classifyFetchError passes a FeedFetchError through unchanged', () => {
  const original = new FeedFetchError('truncated body: got 10 of 900 bytes', true);
  assert.equal(classifyFetchError(original, 20000), original);
});

test('classifyFetchError defaults unknown failures to permanent', () => {
  const out = classifyFetchError(new Error('itemsPath "programs" is not an array'), 20000);
  assert.equal(out.transient, false);
  assert.match(out.message, /itemsPath/);
});

test('karma-gap gets a longer timeout than the registry default', () => {
  assert.equal(reg('karma-gap').timeoutMs, 45000);
  assert.equal(DEFAULT_TIMEOUT_MS, 20000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="classifyFetchError|karma-gap gets"`
Expected: FAIL — `classifyFetchError is not a function`.

- [ ] **Step 3: Implement classifyFetchError**

In `src/services/source-feeds.ts`, directly below `readJsonBody`:

```ts
/**
 * Give a fetch failure a readable message and a retry verdict.
 * Unknown failures default to permanent — retrying something we do not
 * understand is how a bad config turns into doubled API spend.
 */
export function classifyFetchError(err: unknown, timeoutMs: number): FeedFetchError {
  if (err instanceof FeedFetchError) return err;
  const name = (err as { name?: string })?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new FeedFetchError(`timeout after ${Math.round(timeoutMs / 1000)}s`, true);
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/^HTTP 5\d\d/.test(msg)) return new FeedFetchError(msg, true);
  return new FeedFetchError(msg, false);
}
```

- [ ] **Step 4: Add `timeoutMs` to the FeedSource type**

In the `FeedSource` interface, directly below `maxItems?: number;`:

```ts
  timeoutMs?: number;          // per-source fetch fuse; defaults to DEFAULT_TIMEOUT_MS
```

- [ ] **Step 5: Thread the timeout through the fetchers**

Change `httpGet` to accept a timeout:

```ts
async function httpGet(url: string, headers?: Record<string, string>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  return fetch(url, {
    headers: { 'User-Agent': 'wire-room-ops/feeds', Accept: '*/*', ...(headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
}
```

In `fetchRss`, pass the source's timeout:

```ts
  const r = await httpGet(source.endpoint, source.headers, source.timeoutMs ?? DEFAULT_TIMEOUT_MS);
```

In `fetchGithubCsv`, same change to its `httpGet` call.

In `fetchRestJson`, replace the `signal` line and the `r.json()` line:

```ts
    signal: AbortSignal.timeout(source.timeoutMs ?? DEFAULT_TIMEOUT_MS),
```
```ts
  const data = await readJsonBody(r);
```

In `fetchGraphql`, the same two changes:

```ts
    signal: AbortSignal.timeout(source.timeoutMs ?? DEFAULT_TIMEOUT_MS),
```
```ts
  const data = await readJsonBody(r);
```

- [ ] **Step 6: Give karma-gap a longer fuse**

In the `karma-gap` registry entry, directly below `maxItems: 120,`:

```ts
    // 268KB and ~4s of server think-time — by far the largest payload in the
    // registry. The 20s default was firing mid-body and reporting it as bad JSON.
    timeoutMs: 45000,
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="classifyFetchError|karma-gap gets"`
Expected: PASS, 6 tests.

- [ ] **Step 8: Run the whole feed suite for regressions**

Run: `npm test -- --test-name-pattern="parseFeed|Karma GAP|feed"`
Expected: PASS. The pre-existing Karma GAP extractor test must still pass.

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 10: Commit**

```bash
git add src/services/source-feeds.ts tests/source-feeds.test.js
git commit -m "$(cat <<'EOF'
fix(feeds): classify fetch errors, add per-source timeouts

An AbortSignal timeout surfaced as a JSON parse error, so a slow source and a
malformed one were indistinguishable in the digest. classifyFetchError names
the failure and decides whether a retry is worth attempting; unknown failures
default to permanent.

karma-gap gets a 45s fuse: 268KB and ~4s of server think-time made it the one
source the 20s default could plausibly cut off mid-body.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SHawQM6oZVdqkf6N4QHNHM
EOF
)"
```

---

### Task 3: Transient-only retry + record last-success

One hiccup on any of 21 sources currently becomes an incident line. This retries transient failures once, and records each source's last success so PR B can report staleness.

**Files:**
- Modify: `src/jobs/source-feeds.ts` — `fetchSourceWithTransientRetry()`, `lastOk` on the per-source result, the `catch` block
- Test: `tests/source-feeds.test.js`

**Interfaces:**
- Consumes: `classifyFetchError`, `FeedFetchError`, `DEFAULT_TIMEOUT_MS` (Tasks 1–2)
- Produces:
  - `export async function fetchSourceWithTransientRetry(source: FeedSource, fetchImpl?: (s: FeedSource) => Promise<FeedItem[]>, sleepImpl?: (ms: number) => Promise<void>): Promise<FeedItem[]>`
  - `perSource[]` entries gain `lastOk?: string | null` — PR B Task 4 reads this

- [ ] **Step 1: Write the failing tests**

Append to `tests/source-feeds.test.js`:

```js
const { fetchSourceWithTransientRetry } = require('../src/jobs/source-feeds');

const noSleep = async () => {};
const src = { key: 'k', name: 'K', wire: 'crypto', method: 'rest_json', endpoint: 'https://x', enabled: true };

test('transient failure is retried once and can succeed', async () => {
  let calls = 0;
  const items = await fetchSourceWithTransientRetry(src, async () => {
    calls++;
    if (calls === 1) throw new FeedFetchError('truncated body: got 10 of 900 bytes', true);
    return [{ name: 'A', description: '', url: 'https://x/a', amount: null, deadline: null, publishedAt: null }];
  }, noSleep);
  assert.equal(calls, 2);
  assert.equal(items.length, 1);
});

test('permanent failure is NOT retried — a paid scrape must not run twice', async () => {
  let calls = 0;
  await assert.rejects(
    () => fetchSourceWithTransientRetry(src, async () => { calls++; throw new Error('HTTP 404'); }, noSleep),
    (err) => { assert.equal(err.message, 'HTTP 404'); assert.equal(err.transient, false); return true; }
  );
  assert.equal(calls, 1, 'permanent failures must be attempted exactly once');
});

test('a transient failure twice surfaces the second error', async () => {
  let calls = 0;
  await assert.rejects(
    () => fetchSourceWithTransientRetry(src, async () => {
      calls++;
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    }, noSleep),
    (err) => { assert.equal(err.message, 'timeout after 20s'); return true; }
  );
  assert.equal(calls, 2);
});

test('retry honours the per-source timeout in its message', async () => {
  await assert.rejects(
    () => fetchSourceWithTransientRetry({ ...src, timeoutMs: 45000 }, async () => {
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    }, noSleep),
    (err) => { assert.equal(err.message, 'timeout after 45s'); return true; }
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="transient failure|permanent failure|retry honours"`
Expected: FAIL — `fetchSourceWithTransientRetry is not a function`.

- [ ] **Step 3: Implement the retry wrapper**

In `src/jobs/source-feeds.ts`, add to the existing import from `../services/source-feeds`: `classifyFetchError`, `DEFAULT_TIMEOUT_MS`, and the type `FeedSource`. Add `import { sleep } from '../utils/async';`.

Then, above `runSourceFeeds`:

```ts
/**
 * One retry, transient failures only.
 *
 * Deliberately not `withRetry()`: that helper retries every error, and the
 * `scrape` method calls Firecrawl (paid). Retrying a permanently-broken scrape
 * source would double that cost every day, forever.
 *
 * fetchImpl/sleepImpl are injectable seams so this is unit-testable without network.
 */
export async function fetchSourceWithTransientRetry(
  source: FeedSource,
  fetchImpl: (s: FeedSource) => Promise<FeedItem[]> = fetchSource,
  sleepImpl: (ms: number) => Promise<void> = sleep,
): Promise<FeedItem[]> {
  const timeoutMs = source.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    return await fetchImpl(source);
  } catch (err) {
    const first = classifyFetchError(err, timeoutMs);
    if (!first.transient) throw first;
    console.warn(`[Feeds] ${source.key} transient failure (${first.message}) — retrying once`);
    await sleepImpl(2000);
    try {
      return await fetchImpl(source);
    } catch (err2) {
      throw classifyFetchError(err2, timeoutMs);
    }
  }
}
```

- [ ] **Step 4: Use it in the loop and record last-success**

In `runSourceFeeds`, replace `const items = await fetchSource(source);` with:

```ts
      const items = await fetchSourceWithTransientRetry(source);
```

In the same function's `catch` block, record the last known success so the digest can age it. Replace the existing `perSource.push` in the catch with:

```ts
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      perSource.push({
        key: source.key, name: source.name, fetched: 0, fresh: 0, firstRun,
        error: msg,
        lastOk: state?.lastRun ?? null,
      });
      console.warn(`[Feeds] ${source.key} failed: ${msg}`);
    }
```

Add `lastOk?: string | null;` to the `perSource` array type at `src/jobs/source-feeds.ts:32`:

```ts
  perSource: Array<{ key: string; name: string; fetched: number; fresh: number; firstRun: boolean; error?: string; lastOk?: string | null }>;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="transient failure|permanent failure|retry honours"`
Expected: PASS, 4 tests.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. No pre-existing test should break.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 8: Commit**

```bash
git add src/jobs/source-feeds.ts tests/source-feeds.test.js
git commit -m "$(cat <<'EOF'
fix(feeds): retry transient fetch failures once, record last success

A single hiccup on any of 21 sources escalated straight to a production-issue
line in the morning digest. Transient failures (timeout, truncation, 5xx) now
get one retry; permanent ones are attempted exactly once.

Not withRetry(): that retries every error, and the scrape method calls a paid
API. Doubling spend on a permanently-broken source is not an acceptable
default.

Each failed source now carries its last successful fetch time so the digest
can distinguish day 1 from day 3.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SHawQM6oZVdqkf6N4QHNHM
EOF
)"
```

- [ ] **Step 9: Verify against the live endpoint**

Run: `npx ts-node src/scripts/source-feeds-dryrun.ts`
Expected: `karma-gap` fetches successfully and reports a program count near 94. If it still fails, the printed error now names the cause (`timeout after 45s` vs `truncated body: got N of M bytes`) — report which to the operator before proceeding.

---

# PR B — Digest tells the truth

Branch: `fix/digest-yield-reporting`

### Task 4: Name stale sources with their day count

**Files:**
- Modify: `src/jobs/daily-digest.ts` — add `formatStaleSourceAnomalies()`
- Modify: `src/services/scheduler.ts:433` — call it
- Test: `tests/daily-digest.test.js`

**Interfaces:**
- Consumes: `perSource[].lastOk` (PR A Task 3)
- Produces: `export function formatStaleSourceAnomalies(perSource: StaleSourceInput[], now?: number): string[]`
  where `export interface StaleSourceInput { key: string; error?: string; lastOk?: string | null }`

- [ ] **Step 1: Write the failing tests**

Append to `tests/daily-digest.test.js`:

```js
const { formatStaleSourceAnomalies } = require('../src/jobs/daily-digest');

const NOW = Date.parse('2026-07-30T13:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

test('a source failing its first day produces no anomaly', () => {
  const out = formatStaleSourceAnomalies([{ key: 'karma-gap', error: 'timeout after 45s', lastOk: daysAgo(1) }], NOW);
  assert.deepEqual(out, []);
});

test('a source failing 2+ days is named with its day count and last-OK date', () => {
  const out = formatStaleSourceAnomalies([{ key: 'karma-gap', error: 'timeout after 45s', lastOk: daysAgo(3) }], NOW);
  assert.equal(out.length, 1);
  assert.match(out[0], /^Source feeds: karma-gap failing 3 days \(last OK 2026-07-27\)$/);
});

test('healthy sources produce nothing', () => {
  const out = formatStaleSourceAnomalies([{ key: 'nlnet-news', lastOk: daysAgo(0) }], NOW);
  assert.deepEqual(out, []);
});

test('a source that has never succeeded is reported without a date', () => {
  const out = formatStaleSourceAnomalies([{ key: 'new-src', error: 'HTTP 404', lastOk: null }], NOW);
  assert.equal(out.length, 1);
  assert.match(out[0], /^Source feeds: new-src failing \(never succeeded\)$/);
});

test('multiple stale sources each get their own line, worst first', () => {
  const out = formatStaleSourceAnomalies([
    { key: 'a', error: 'x', lastOk: daysAgo(2) },
    { key: 'b', error: 'x', lastOk: daysAgo(5) },
  ], NOW);
  assert.equal(out.length, 2);
  assert.match(out[0], /^Source feeds: b failing 5 days/);
  assert.match(out[1], /^Source feeds: a failing 2 days/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="stale|failing"`
Expected: FAIL — `formatStaleSourceAnomalies is not a function`.

- [ ] **Step 3: Implement**

In `src/jobs/daily-digest.ts`, near `getSourceBreakdown`:

```ts
export interface StaleSourceInput {
  key: string;
  error?: string;
  lastOk?: string | null;
}

/** A source stale >= this many days is a production issue, not a blip. */
const STALE_SOURCE_DAYS = 2;

/**
 * Name each failing source and how long it has been failing.
 *
 * "1 of 21 sources errored" read identically on day 1 and day 30, which is how
 * Karma GAP stayed dark for three days. Day 1 stays a ledger warning; day 2+ is
 * an issue. Derived from the per-source watermark's lastRun — no new state.
 */
export function formatStaleSourceAnomalies(perSource: StaleSourceInput[], now: number = Date.now()): string[] {
  const rows = perSource
    .filter(s => s.error)
    .map(s => {
      const parsed = s.lastOk ? Date.parse(s.lastOk) : NaN;
      if (Number.isNaN(parsed)) return { key: s.key, days: null, date: null };
      return {
        key: s.key,
        days: Math.floor((now - parsed) / 86400000),
        // Format the recorded timestamp itself, never a value recomputed from the
        // floored day count — those disagree whenever the fetch time of day drifts.
        date: new Date(parsed).toISOString().split('T')[0],
      };
    });

  return rows
    .filter(r => r.days === null || r.days >= STALE_SOURCE_DAYS)
    .sort((a, b) => (b.days ?? Infinity) - (a.days ?? Infinity))
    .map(r => r.days === null
      ? `Source feeds: ${r.key} failing (never succeeded)`
      : `Source feeds: ${r.key} failing ${r.days} days (last OK ${r.date})`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="stale|failing"`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire it into the scheduler**

In `src/services/scheduler.ts`, add `formatStaleSourceAnomalies` to the existing import from `../jobs/daily-digest`. Replace line 433:

```ts
          if (failed > 0) anomalies.push(`Source feeds: ${failed} of ${sf.perSource.length} sources errored`);
```

with:

```ts
          anomalies.push(...formatStaleSourceAnomalies(sf.perSource));
```

Leave the `console.log` on the line above unchanged — the ops log still reports the raw `N errored` count.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 7: Commit**

```bash
git add src/jobs/daily-digest.ts src/services/scheduler.ts tests/daily-digest.test.js
git commit -m "$(cat <<'EOF'
feat(digest): name stale feed sources and how long they have been failing

"1 of 21 sources errored" read identically on day 1 and day 30. Karma GAP was
dark for three days behind that line. The digest now names the source and its
day count, escalating at 2+ consecutive days; day 1 stays a ledger warning.

Derived from the existing per-source watermark — no new state.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SHawQM6oZVdqkf6N4QHNHM
EOF
)"
```

---

### Task 5: Net-new yield replaces duplicate rate

**Files:**
- Modify: `src/jobs/daily-digest.ts` — add `getLaneYield()` + `formatYieldAnomalies()`, delete the dupe-rate block at lines ~558-571
- Test: `tests/daily-digest.test.js`, `tests/digest-email.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `export interface LaneYieldRow { source: string; total: number; netNew: number }`
  - `export async function getLaneYield(pool: Pool, days?: number): Promise<LaneYieldRow[]>`
  - `export function formatYieldAnomalies(rows: LaneYieldRow[], days?: number): string[]`

- [ ] **Step 1: Write the failing tests**

Append to `tests/daily-digest.test.js`:

```js
const { formatYieldAnomalies, getLaneYield } = require('../src/jobs/daily-digest');

test('a lane with zero net-new across the window is an issue', () => {
  const out = formatYieldAnomalies([{ source: 'web-search', total: 92, netNew: 0 }], 3);
  assert.equal(out.length, 1);
  assert.match(out[0], /^Lane web-search: 0 net-new in 3 days \(92 fetched\)$/);
});

test('a lane producing anything is not an issue', () => {
  assert.deepEqual(formatYieldAnomalies([{ source: 'web-search', total: 92, netNew: 1 }], 3), []);
});

test('low-volume lanes are ignored — 0 of 3 is not evidence', () => {
  assert.deepEqual(formatYieldAnomalies([{ source: 'forum', total: 3, netNew: 0 }], 3), []);
});

test('human intake lanes never produce a yield anomaly', () => {
  const rows = [
    { source: 'telegram', total: 40, netNew: 0 },
    { source: 'manual-intake', total: 30, netNew: 0 },
    { source: 'telegram-intake', total: 20, netNew: 0 },
  ];
  assert.deepEqual(formatYieldAnomalies(rows, 3), []);
});

test('yield is counted per lane, so a low-volume wire cannot hide', () => {
  // The retired dupe-rate rule had a per-wire total>=10 floor, which is how
  // crypto's 100% duplicate rate stayed out of the Jul 30 email.
  const out = formatYieldAnomalies([{ source: 'x-monitor', total: 7, netNew: 0 }], 3);
  assert.deepEqual(out, [], 'below the volume floor');
  const out2 = formatYieldAnomalies([{ source: 'x-monitor', total: 12, netNew: 0 }], 3);
  assert.equal(out2.length, 1);
});

test('getLaneYield asks for net-new excluding duplicate and deduped', async () => {
  let captured = null;
  const pool = { query: async (sql, params) => { captured = { sql, params }; return { rows: [] }; } };
  await getLaneYield(pool, 3);
  assert.match(captured.sql, /NOT IN \('duplicate',\s*'deduped'\)/);
  assert.deepEqual(captured.params, ['3']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="net-new|yield|lane"`
Expected: FAIL — `formatYieldAnomalies is not a function`.

- [ ] **Step 3: Implement**

In `src/jobs/daily-digest.ts`, next to `getSourceBreakdown`:

```ts
export interface LaneYieldRow {
  source: string;
  total: number;
  netNew: number;
}

/** Below this volume, zero net-new is not evidence of anything. */
const YIELD_MIN_VOLUME = 10;

/** Human and chat intake re-submit known listings by nature; their yield is not lane health. */
const NON_AUTOMATED_SOURCES = new Set(['telegram', 'telegram-intake', 'manual-intake']);

/** Net-new (non-duplicate) entries per ingestion lane over a trailing window. */
export async function getLaneYield(pool: Pool, days: number = 3): Promise<LaneYieldRow[]> {
  const { rows } = await pool.query<{ source: string; total: number; net_new: number }>(`
    SELECT
      COALESCE(scan_source, 'unknown') AS source,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status NOT IN ('duplicate', 'deduped'))::int AS net_new
    FROM scan_entries
    WHERE created_at >= NOW() - ($1 || ' days')::interval
    GROUP BY 1
    ORDER BY total DESC
  `, [String(days)]);
  return rows.map(r => ({ source: r.source, total: r.total, netNew: r.net_new }));
}

/**
 * A lane that fetched real volume and produced nothing new is the signal worth
 * escalating. This replaces the duplicate-rate anomaly, which fired when dedup
 * was WORKING and carried a per-wire volume floor that hid crypto entirely.
 */
export function formatYieldAnomalies(rows: LaneYieldRow[], days: number = 3): string[] {
  return rows
    .filter(r => !NON_AUTOMATED_SOURCES.has(r.source))
    .filter(r => r.total >= YIELD_MIN_VOLUME && r.netNew === 0)
    .map(r => `Lane ${r.source}: 0 net-new in ${days} days (${r.total} fetched)`);
}
```

Add `getLaneYield` to `AssembleDigestDeps` and `defaultAssembleDeps`:

```ts
  yield_: typeof getLaneYield;
```
```ts
  yield_: getLaneYield,
```

- [ ] **Step 4: Delete the dupe-rate anomaly and call the new one**

In `assembleAndSendDailyDigest`, replace the entire `try { const breakdown = await deps.sources(pool); ... }` block (lines ~558-571) with:

```ts
  try {
    const laneYield = await deps.yield_(pool, 3);
    anomalies.push(...formatYieldAnomalies(laneYield, 3));
  } catch (e) {
    console.error('[DailyDigest] Lane yield check failed (non-fatal):', e instanceof Error ? e.message : e);
  }
```

`getSourceBreakdown` stays exported and unchanged — the dashboard still uses it. Only the digest stops deriving an anomaly from it. Leave `sources` in `AssembleDigestDeps` if any other caller uses it; if `npm run typecheck` reports it as unused, remove it from both the interface and `defaultAssembleDeps`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="net-new|yield|lane"`
Expected: PASS, 6 tests.

- [ ] **Step 6: Update the renderer pin**

Run: `npm test -- tests/digest-email.test.js`

If any assertion references a dupe-rate string, update it to the new yield wording. Do **not** delete assertions to make the suite pass — `renderDailyDigest` is deliberately pinned by this file. If the renderer displays anomalies generically, no change is needed; confirm by reading the failure output rather than assuming.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 9: Commit**

```bash
git add src/jobs/daily-digest.ts tests/daily-digest.test.js tests/digest-email.test.js
git commit -m "$(cat <<'EOF'
feat(digest): escalate zero net-new yield, not duplicate rate

A high duplicate rate means dedup is working. On Jul 30 the digest filed two
such lines under PRODUCTION ISSUES while 30 of 31 entries were correct
catches, and the rule's per-wire total>=10 floor hid crypto's 100% entirely.

Replaced with the signal that actually matters: a lane that fetched real
volume and produced nothing new. Counted per lane, so no wire can hide below
a volume floor. Duplicate rate remains available to the dashboard via
getSourceBreakdown.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SHawQM6oZVdqkf6N4QHNHM
EOF
)"
```

---

# PR C — Scan lane early dedup

Branch: `perf/scan-lane-early-dedup`

### Task 6: Filter already-seen URLs before extraction

**Files:**
- Modify: `src/db/index.ts` — add `findSeenUrls()`
- Modify: `src/services/parallel.ts` — add the `filterSeenUrls` option, filter before extraction
- Modify: `src/jobs/scan-execution.ts` — wire the seam
- Test: Create `tests/parallel-early-dedup.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `export async function findSeenUrls(pool: Pool, urls: string[], wire: string): Promise<Set<string>>` — returns the **original** URLs whose normalized form is already in `seen_urls` for that wire

- [ ] **Step 1: Write the failing tests**

Create `tests/parallel-early-dedup.test.js`:

```js
require('ts-node/register/transpile-only');

const test = require('node:test');
const assert = require('node:assert/strict');

const { findSeenUrls } = require('../src/db');

test('findSeenUrls returns the ORIGINAL urls whose normalized form is known', async () => {
  const pool = {
    query: async (_sql, params) => {
      assert.ok(Array.isArray(params[0]), 'first param is the normalized url array');
      assert.equal(params[1], 'ai');
      // Pretend the normalized form of the first url is already seen.
      return { rows: [{ normalized_url: params[0][0] }] };
    },
  };
  const seen = await findSeenUrls(pool, ['https://Example.org/Grant?utm_source=x', 'https://other.org/b'], 'ai');
  assert.ok(seen.has('https://Example.org/Grant?utm_source=x'), 'original casing/query preserved in the returned set');
  assert.equal(seen.has('https://other.org/b'), false);
});

test('findSeenUrls short-circuits on an empty list without querying', async () => {
  let called = false;
  const pool = { query: async () => { called = true; return { rows: [] }; } };
  const seen = await findSeenUrls(pool, [], 'ai');
  assert.equal(seen.size, 0);
  assert.equal(called, false);
});

test('findSeenUrls maps one normalized hit back to every original that shares it', async () => {
  const pool = { query: async (_sql, params) => ({ rows: [{ normalized_url: params[0][0] }] }) };
  // Two urls differing only by tracking params normalize to the same key.
  const seen = await findSeenUrls(pool, ['https://x.org/a?utm_source=1', 'https://x.org/a?utm_source=2'], 'oss');
  assert.equal(seen.size, 2, 'both originals are dropped when their shared normalized form is seen');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/parallel-early-dedup.test.js`
Expected: FAIL — `findSeenUrls is not a function`.

- [ ] **Step 3: Implement findSeenUrls**

In `src/db/index.ts`, add near the other `seen_urls` helpers. Ensure `normalizeUrl` is imported from `../utils/url`:

```ts
/**
 * Which of these URLs has this wire already ingested?
 *
 * Returns the ORIGINAL url strings (not the normalized forms) so callers can
 * filter their own list directly. Several originals can share one normalized
 * form — tracking params, casing — and all of them are returned on a hit.
 */
export async function findSeenUrls(pool: Pool, urls: string[], wire: string): Promise<Set<string>> {
  if (!urls.length) return new Set();
  const byNormalized = new Map<string, string[]>();
  for (const u of urls) {
    const n = normalizeUrl(u);
    const bucket = byNormalized.get(n);
    if (bucket) bucket.push(u);
    else byNormalized.set(n, [u]);
  }
  const { rows } = await pool.query<{ normalized_url: string }>(
    `SELECT DISTINCT normalized_url FROM seen_urls WHERE normalized_url = ANY($1::text[]) AND wire = $2`,
    [[...byNormalized.keys()], wire],
  );
  const out = new Set<string>();
  for (const r of rows) {
    for (const original of byNormalized.get(r.normalized_url) || []) out.add(original);
  }
  return out;
}
```

- [ ] **Step 4: Add the seam to executeParallelScan**

In `src/services/parallel.ts`, extend the options type:

```ts
  options?: { model?: string; responseFormat?: string | null; outputFormat?: 'text' | 'json'; wire?: string; afterDate?: string; usagePurpose?: ScanUsagePurpose; filterSeenUrls?: (urls: string[]) => Promise<Set<string>> }
```

Replace the `const results = searchData.results || [];` block and the empty check with:

```ts
  let results = searchData.results || [];

  // Early dedup: the lane re-searches a rolling window daily, so most results are
  // already ingested. Dropping them here saves the Grok extraction AND the
  // downstream classify — downstream dedup remains the backstop for the rest.
  if (options?.filterSeenUrls && results.length > 0) {
    try {
      const seen = await options.filterSeenUrls(results.map(r => r.url));
      const before = results.length;
      results = results.filter(r => !seen.has(r.url));
      if (before !== results.length) {
        console.log(`[Parallel] early-dedup: ${before - results.length} of ${before} results already seen; ${results.length} to extraction`);
      }
    } catch (err) {
      // Never let the dedup lookup break a scan — fall through with the full set.
      console.warn('[Parallel] early-dedup lookup failed, proceeding unfiltered:', err instanceof Error ? err.message : err);
    }
  }

  if (results.length === 0) {
    return { content: '', model: 'parallel-search' };
  }
```

- [ ] **Step 5: Wire it from scan-execution**

In `src/jobs/scan-execution.ts`, import `findSeenUrls` from `../db`. In the `tool_type === 'parallel'` branch, add to the `executeParallelScan` options:

```ts
              filterSeenUrls: (urls) => findSeenUrls(pool, urls, prompt.wire),
```

`pool` is already in scope — it is the first parameter of `runScanExecution` (`src/jobs/scan-execution.ts:87`) and the parallel branch is inside that function. Do not create a new pool.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- tests/parallel-early-dedup.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 8: Commit**

```bash
git add src/db/index.ts src/services/parallel.ts src/jobs/scan-execution.ts tests/parallel-early-dedup.test.js
git commit -m "$(cat <<'EOF'
perf(scan): drop already-seen URLs before Grok extraction

The Parallel lane re-searches a rolling window every day with no memory, while
dedup remembers far longer — so it paid for retrieval, extraction and classify
on ~30 known items a day to surface ~1 new one.

Filtering search results against the existing seen_urls index before
extraction cuts that at the most expensive point. No new state: it reuses the
canonical normalized-URL index dedup already trusts.

Partial by design — of a representative 30 duplicates, 20 were exact-URL
matches caught here and 10 were program-identity matches that still reach
downstream dedup, which is unchanged and remains the backstop.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SHawQM6oZVdqkf6N4QHNHM
EOF
)"
```

---

### Task 7: Align the discovery window with prompt intent

**Files:**
- Modify: `src/jobs/scan-execution.ts:173`
- Modify: `src/routes/scan-prompts.ts:426`

**Interfaces:**
- Consumes: nothing
- Produces: `export const DISCOVERY_WINDOW_DAYS = 21` in `src/jobs/scan-execution.ts`, imported by `src/routes/scan-prompts.ts`

- [ ] **Step 1: Define the constant once**

In `src/jobs/scan-execution.ts`, near the top-level constants:

```ts
/**
 * Freshness floor for discovery-intent Parallel scans.
 *
 * The Frontier prompts ask for "the last 21 days" in their own text; the floor
 * was 90, over 4x wider than operator intent, which is a large part of why the
 * lane re-found the same canonical programs daily. Canonical/signal prompts
 * still pass no after_date — that would drop long-standing rolling programs.
 */
export const DISCOVERY_WINDOW_DAYS = 21;
```

- [ ] **Step 2: Use it at both call sites**

In `src/jobs/scan-execution.ts:173`, replace `90 * 86400000` with `DISCOVERY_WINDOW_DAYS * 86400000`.

In `src/routes/scan-prompts.ts:426`, import `DISCOVERY_WINDOW_DAYS` from `../jobs/scan-execution` and make the same replacement, so the Prompt Lab test path and the scheduled path cannot drift.

- [ ] **Step 3: Verify no other hardcoded window remains**

Run: `grep -rn "90 \* 86400000" src/`
Expected: no output.

- [ ] **Step 4: Typecheck and test**

Run: `npm run typecheck && npm test`
Expected: exit code 0, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/jobs/scan-execution.ts src/routes/scan-prompts.ts
git commit -m "$(cat <<'EOF'
fix(scan): align discovery freshness floor with prompt intent (90d -> 21d)

The Frontier prompts ask for "the last 21 days" but the after_date floor was
90, so retrieval was permitted to return content four times older than the
operator asked for. One constant, used by both the scheduled path and the
Prompt Lab test path so they cannot drift.

Canonical and signal prompts still send no after_date.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SHawQM6oZVdqkf6N4QHNHM
EOF
)"
```

---

# PR D — Registry-watch Tier 1 promotion

Branch: `feat/registry-watch-tier-scope`

### Task 8: Tier scope knob

**Files:**
- Modify: `src/config/index.ts:43-49` — add `registryTiers`
- Modify: `src/services/registry-watchers.ts:26-39` — add `tierClause()`, thread `tiers` into `getDueSurfaces()`
- Modify: `src/jobs/registry-watch.ts:166,213` — pass the config value
- Test: `tests/registry-watchers.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `export function tierClause(tiers: string): string`
  - `getDueSurfaces(pool, types, limit, tiers?)` — `tiers` defaults to `'1'`

- [ ] **Step 1: Write the failing tests**

Append to `tests/registry-watchers.test.js`:

```js
const { tierClause } = require('../src/services/registry-watchers');

test('tierClause defaults to Tier 1 only', () => {
  const sql = tierClause('1');
  assert.match(sql, /Tier 1%/);
  assert.equal(/Tier 2%/.test(sql), false);
});

test('tierClause can include Tier 2', () => {
  const sql = tierClause('1,2');
  assert.match(sql, /Tier 1%/);
  assert.match(sql, /Tier 2%/);
});

test('tierClause accepts Tier 2 alone', () => {
  const sql = tierClause('2');
  assert.match(sql, /Tier 2%/);
  assert.equal(/Tier 1%/.test(sql), false);
});

test('tierClause falls back to Tier 1 on empty or garbage input', () => {
  for (const input of ['', '   ', 'banana']) {
    const sql = tierClause(input);
    assert.match(sql, /Tier 1%/, `input ${JSON.stringify(input)} must fall back to Tier 1`);
    assert.equal(/Tier 2%/.test(sql), false);
  }
});

test('tierClause keeps the legacy "Official" spelling in the Tier 1 branch', () => {
  assert.match(tierClause('1'), /tier = 'Official'/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="tierClause"`
Expected: FAIL — `tierClause is not a function`.

- [ ] **Step 3: Implement tierClause**

In `src/services/registry-watchers.ts`, above `getDueSurfaces`:

```ts
const TIER_1 = `(tier ILIKE 'Tier 1%' OR tier ILIKE 'Tier1%' OR tier = 'Official')`;
const TIER_2 = `(tier ILIKE 'Tier 2%' OR tier ILIKE 'Tier2%')`;

/**
 * SQL predicate for the requested tiers. Input is a comma list ("1", "1,2", "2").
 * Anything unrecognised falls back to Tier 1 — widening coverage is an operator
 * decision, never the result of a typo in an env var.
 *
 * Built from constants only; no caller input reaches the SQL string.
 */
export function tierClause(tiers: string): string {
  const requested = new Set((tiers || '').split(',').map(s => s.trim()).filter(Boolean));
  const parts: string[] = [];
  if (requested.has('1')) parts.push(TIER_1);
  if (requested.has('2')) parts.push(TIER_2);
  if (parts.length === 0) parts.push(TIER_1);
  return `(${parts.join(' OR ')})`;
}
```

- [ ] **Step 4: Use it in getDueSurfaces**

Replace the hardcoded tier line in `getDueSurfaces` and add the parameter:

```ts
export async function getDueSurfaces(pool: Pool, types: string[], limit: number, tiers: string = '1'): Promise<WatchSurface[]> {
  const { rows } = await pool.query<WatchSurface & { tier: string | null }>(
    `SELECT id, org_name, wire, surface_type, url, tier
       FROM watch_surfaces
      WHERE status = 'active'
        AND surface_type = ANY($1)
        AND ${tierClause(tiers)}
        AND (last_checked_at IS NULL OR last_checked_at < NOW() - INTERVAL '20 hours')
      ORDER BY last_checked_at ASC NULLS FIRST
      LIMIT $2`,
    [types, limit],
  );
  return rows;
}
```

- [ ] **Step 5: Add the config value**

In `src/config/index.ts`, inside the `watchtower` block:

```ts
    registryTiers: process.env.REGISTRY_WATCH_TIERS || '1',   // "1", "1,2", or "2"
```

- [ ] **Step 6: Pass it from the job**

In `src/jobs/registry-watch.ts`, at both call sites:

```ts
  const rssSurfaces = await getDueImpl(pool, ['rss'], rssCap, config.watchtower.registryTiers);
```
```ts
  const diffSurfaces = await getDueImpl(pool, ['grants_page', 'application'], diffCap, config.watchtower.registryTiers);
```

Confirm `config` is imported in that file; if not, add `import { config } from '../config';`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="tierClause"`
Expected: PASS, 5 tests.

- [ ] **Step 8: Run the registry suites**

Run: `npm test -- tests/registry-watch.test.js tests/registry-watchers.test.js`
Expected: PASS. The injected `getDue` seam in `RegistryWatchDeps` means existing tests keep working; if any stub asserts on arity, update it to accept the fourth argument.

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: exit code 0.

- [ ] **Step 10: Update .env.example and docs**

Add to `.env.example`:

```
# Registry watch (Watchtower Phase 1) — which watch_surfaces tiers to poll: "1", "1,2", or "2"
REGISTRY_WATCH_TIERS=1
```

In `CLAUDE.md`, add `REGISTRY_WATCH_TIERS` to the "Key optional vars" list beside `REGISTRY_WATCH_ENABLED`.

- [ ] **Step 11: Commit**

```bash
git add src/config/index.ts src/services/registry-watchers.ts src/jobs/registry-watch.ts tests/registry-watchers.test.js .env.example CLAUDE.md
git commit -m "$(cat <<'EOF'
feat(watchtower): tier scope for registry-watch surface selection

getDueSurfaces selected Tier 1 and Tier 2 together with no way to separate
them, so promoting the lane meant taking all 157 seeded surfaces at once.
REGISTRY_WATCH_TIERS (default "1") scopes it to the 65 Tier 1 surfaces the
lane actually polls: 19 rss + 30 grants_page + 16 application.

Unrecognised values fall back to Tier 1 — widening coverage is an operator
decision, not the result of an env-var typo.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SHawQM6oZVdqkf6N4QHNHM
EOF
)"
```

---

### Task 9: Rollout runbook (operator-gated, no code)

This task changes production configuration. **Do not perform any step without the operator confirming**, and stop at the checkpoint.

**Files:** none — Railway environment variables only.

- [ ] **Step 1: Confirm PR D is deployed**

Confirm the running Railway commit includes the tier-scope change before enabling anything. Merged is not live — production uses staged deploys and merged PRs can sit in `NEEDS_APPROVAL`.

Use the `railway-ops` skill flow. Service `wire-room-ops` is `<RAILWAY_SERVICE_ID>`, project `<RAILWAY_PROJECT_ID>`, env `<RAILWAY_ENV_ID>`.

- [ ] **Step 2: Enable the lane in dry-run**

Set in Railway:

```
REGISTRY_WATCH_ENABLED=true
REGISTRY_WATCH_DRY_RUN=true
REGISTRY_WATCH_TIERS=1
```

`REGISTRY_WATCH_DRY_RUN` defaults to `true`, but set it explicitly so the intent is visible in the variable list.

- [ ] **Step 3: Wait one daily-digest cycle**

The lane runs inside the daily fold — no separate cron. Do not trigger it manually.

- [ ] **Step 4: Read what it would have submitted**

```bash
railway logs --service <RAILWAY_SERVICE_ID> --lines 2000 | grep -i "RegistryWatch"
```

Check: surfaces polled is in the expected range (≤65 minus any not yet due), no Tier 2 org names appear, budget was not blocked, and the items it would submit look like real opportunities.

- [ ] **Step 5: CHECKPOINT — report to the operator**

Report the dry-run findings and **stop**. Going live is the operator's call.

- [ ] **Step 6: Go live (only on explicit approval)**

Set `REGISTRY_WATCH_DRY_RUN=false`.

- [ ] **Step 7: Verify the next day**

```sql
SELECT max(last_checked_at), count(*) FILTER (WHERE last_checked_at >= NOW() - INTERVAL '2 days') AS checked_recently
FROM watch_surfaces;
```

Expected: `last_checked_at` advancing daily, having been frozen at 2026-07-04 before this change. Also confirm the daily digest's new-for-review section shows registry-watch finds, and that monthly spend is within `WATCHTOWER_BUDGET_MONTHLY_USD`.

---

## Verification checklist

Before declaring any PR complete:

- [ ] `npm test` passes in full — not just the new tests
- [ ] `npm run typecheck` exits 0, run bare (never piped through `head`/`grep` in an `&&` chain)
- [ ] No test was deleted or weakened to make the suite green
- [ ] Every claim of "fixed" is backed by output pasted into the PR body

**PR A additionally:** `npx ts-node src/scripts/source-feeds-dryrun.ts` fetches `karma-gap` successfully, or names the precise failure cause.

**PR B additionally:** trigger the digest send-now path from the dashboard and confirm the email contains no dupe-rate line and names any stale source with its day count.

**PR C additionally:** after one scheduled scan run, `railway logs | grep "early-dedup"` shows the filter count.

**PR D additionally:** the dry-run checkpoint was reported and explicitly approved before going live.
