# AI/OSS Discovery Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise AI/OSS discovery recall (measured 45% / 58%) by fixing the leaky existing feeds and adding own-site funder monitoring, entirely on the existing source-feeds engine.

**Architecture:** All changes are additive registry entries + small handler-free config in `src/services/source-feeds.ts` (the `SOURCE_REGISTRY` array). Sources are fetched by `fetchSource()` (dispatch by `method`), normalized through the existing precision → dedup → decided-recheck → classifier pipeline (`scan_source='feed'`), de-duplicated by a per-source `app_state` watermark + intake-level URL dedup, and run in the existing daily source-feeds pass. No new lane, cron, table, or enum.

**Tech Stack:** TypeScript (strict), Node `fetch`, hand-rolled RSS/Atom parser, Grok LLM extract for `scrape` sources (Firecrawl via `scrapeUrl`), `node:test` + `node:assert/strict` for unit tests, `railway run npx ts-node` for live dry-runs.

## Global Constraints

- Branch: `feat/ai-oss-coverage` (already created; spec committed at `1be591b`).
- All edits in `src/services/source-feeds.ts` and `tests/source-feeds.test.js`. No new files.
- **No enum or CHECK-constraint changes** — `scan_source='feed'` already exists (avoids the known constraint-sync bug class).
- Config-only sources (`graphql`/`scrape`/`rss`) are verified by **live dry-run** (`railway run npx ts-node src/scripts/source-feeds-dryrun.ts <key>`), per the codebase convention; only sources with `extract()` logic get unit tests.
- Precision is unchanged — never add filtering that bypasses the classifier; sources only add candidates.
- Phase 2/2b sources are added `enabled: false` and flipped to `true` ONLY after their dry-run yields ≥1 discrete, dated opportunity with a stable per-item URL. Sources that yield only evergreen catalogs / write-only forms stay `enabled: false` with a `// skip: <reason>` comment (no silent drops).
- Run the full unit suite with `node --test tests/source-feeds.test.js` after each task that touches tests.

---

## Phase 1 — Fix the leaky AI feeds

### Task 1: Grants.gov — widen rows + multi-keyword (factory)

**Files:**
- Modify: `src/services/source-feeds.ts` (replace the single `grants-gov-ai` registry entry, ~line 508-537, with a factory + three keyword sources)
- Test: `tests/source-feeds.test.js`

**Interfaces:**
- Produces: `grantsGovSource(key: string, keyword: string): FeedSource` (module-internal); registry keys `grants-gov-ai`, `grants-gov-ml`, `grants-gov-fm`.

- [ ] **Step 1: Write the failing test** — add to `tests/source-feeds.test.js`:

```js
test('Grants.gov factory: builds per-keyword source, raises rows to 100, shared extract filters off-beat', () => {
  const ai = reg('grants-gov-ai');
  assert.equal(JSON.parse(ai.body).rows, 100);
  assert.equal(JSON.parse(ai.body).keyword, 'artificial intelligence');
  assert.ok(reg('grants-gov-ml'), 'machine-learning keyword source exists');
  // shared extract: keeps an AI research opp, drops a medical one
  const keep = ai.extract({ title: 'NSF Trailblazer Engineering Impact Award', id: '358001', agencyName: 'National Science Foundation', number: 'NSF 26-502', oppStatus: 'posted' });
  assert.equal(keep.url, 'https://www.grants.gov/search-results-detail/358001');
  assert.equal(ai.extract({ title: 'Maternal Cardiovascular Health Study', id: '9', agencyName: 'NIH' }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/source-feeds.test.js`
Expected: FAIL (`grants-gov-ml` undefined / rows is 30).

- [ ] **Step 3: Implement the factory + three sources.** Replace the existing `grants-gov-ai` object (the one at `body: JSON.stringify({ rows: 30, keyword: 'artificial intelligence', ... })`) with this factory defined just above `export const SOURCE_REGISTRY` and three entries inside the AI section:

```ts
// Grants.gov search2 takes ONE keyword per call; we run several and let intake-level
// URL dedup (same oppId → same detail URL) collapse cross-keyword repeats.
function grantsGovSource(key: string, keyword: string): FeedSource {
  return {
    key,
    name: `Grants.gov — ${keyword}`,
    wire: 'ai',
    method: 'rest_json',
    endpoint: 'https://api.grants.gov/v1/api/search2',
    httpMethod: 'POST',
    body: JSON.stringify({ rows: 100, keyword, oppStatuses: 'forecasted|posted' }),
    itemsPath: 'data.oppHits',
    enabled: true,
    extract: (it) => {
      const name = pick(it, 'title', 'opportunityTitle');
      const id = pick(it, 'id', 'number', 'opportunityNumber');
      if (!name || !id) return null;
      const agency = pick(it, 'agencyName', 'agency', 'agencyCode') || '';
      if (GRANTS_GOV_OFFBEAT_TITLE.test(name) || GRANTS_GOV_OFFBEAT_AGENCY.test(agency)) return null;
      const num = pick(it, 'number', 'opportunityNumber') || '';
      const status = pick(it, 'oppStatus') || '';
      return {
        name: name.slice(0, 200),
        description: clip([agency, num && `#${num}`, status && `(${status})`].filter(Boolean).join(' ') || name),
        url: `https://www.grants.gov/search-results-detail/${id}`,
        amount: null,
        deadline: pick(it, 'closeDate', 'responseDate'),
        publishedAt: toIso(pick(it, 'openDate', 'postingDate')),
      };
    },
  };
}
```

Then in the `// =================== AI ===================` section, replace the old single entry with:

```ts
  grantsGovSource('grants-gov-ai', 'artificial intelligence'),
  grantsGovSource('grants-gov-ml', 'machine learning'),
  grantsGovSource('grants-gov-fm', 'foundation models'),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/source-feeds.test.js`
Expected: PASS.

- [ ] **Step 5: Live dry-run (acceptance)**

Run: `railway run npx ts-node src/scripts/source-feeds-dryrun.ts grants-gov-ai` (then `grants-gov-ml`)
Expected: items returned; **DARPA BTO BAA (HR001126S0003)** and/or **NSF Trailblazer (NSF 26-502)** appear in one of the keyword feeds; no medical/agriculture titles. If a known miss is filtered, narrow the specific term in `GRANTS_GOV_OFFBEAT_TITLE` and re-run.

- [ ] **Step 6: Commit**

```bash
git add src/services/source-feeds.ts tests/source-feeds.test.js
git commit -m "feat(feeds): widen Grants.gov AI coverage (rows 100 + keyword variants)"
```

### Task 2: EA Forum tag broadening + LessWrong source

**Files:**
- Modify: `src/services/source-feeds.ts` (replace the single `ea-forum-funding` entry with multiple tag-scoped EA Forum sources + a LessWrong source, ~line 563-587)
- Test: `tests/source-feeds.test.js`

**Interfaces:**
- Produces: a module-internal `forumMagnumSource(key, name, host, tagId)` helper; registry keys `ea-forum-funding`, `ea-forum-opportunities`, `lesswrong-funding`.

- [ ] **Step 1: Resolve tag IDs (one-off lookup, not a code change).** Run this query against each host to get tag `_id`s by slug:

```bash
curl -s https://forum.effectivealtruism.org/graphql -H 'Content-Type: application/json' -H 'User-Agent: Mozilla/5.0' \
  --data '{"query":"query { tags(input:{terms:{view:\"allTagsAlphabetical\",limit:5000}}){ results{ _id name slug } } }"}' \
  | jq -r '.data.tags.results[] | select(.slug|test("funding|opportunit|request-for-proposal";"i")) | "\(.slug)\t\(._id)\t\(.name)"'
```

Record the IDs for `funding-opportunities` (current: `be4pBryMKxLhkmgvE`), `opportunities-to-take-action` (or the closest "opportunities" tag), and `request-for-proposals`. Repeat the curl against `https://www.lesswrong.com/graphql` for a funding/opportunities tag (LessWrong's GraphQL is the same Forum-Magnum shape). If LessWrong has no clean funding tag, note it and rely on the dry-run gate in Step 4 to decide keep/skip.

- [ ] **Step 2: Write the failing test** — add to `tests/source-feeds.test.js`:

```js
test('EA Forum/LessWrong sources: multiple Forum-Magnum graphql feeds wired with itemsPath', () => {
  const ea = reg('ea-forum-funding');
  assert.equal(ea.method, 'graphql');
  assert.equal(ea.itemsPath, 'data.posts.results');
  assert.ok(reg('ea-forum-opportunities'), 'second EA Forum tag source exists');
  const lw = reg('lesswrong-funding');
  assert.ok(lw && lw.endpoint.includes('lesswrong.com'), 'LessWrong source exists');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/source-feeds.test.js`
Expected: FAIL (`ea-forum-opportunities` / `lesswrong-funding` undefined).

- [ ] **Step 4: Implement the helper + sources.** Add the helper above `SOURCE_REGISTRY`, replace the single `ea-forum-funding` entry with three entries (plug in the tag IDs from Step 1):

```ts
function forumMagnumSource(key: string, name: string, host: string, tagId: string): FeedSource {
  return {
    key,
    name,
    wire: 'ai',
    method: 'graphql',
    endpoint: `${host}/graphql`,
    headers: { 'User-Agent': BROWSER_UA },
    body: `query { posts(input:{terms:{view:"tagById",tagId:"${tagId}",sortedBy:"new",limit:30}}){ results{ _id title pageUrl postedAt baseScore contents{ plaintextDescription } } } }`,
    itemsPath: 'data.posts.results',
    enabled: true,
    extract: (it) => {
      const name = pick(it, 'title');
      const url = pick(it, 'pageUrl');
      if (!name || !url) return null;
      return {
        name: name.slice(0, 200),
        description: clip(pick(it, 'contents.plaintextDescription') || name),
        url, amount: null, deadline: null,
        publishedAt: toIso(pick(it, 'postedAt')),
      };
    },
  };
}
```

```ts
  forumMagnumSource('ea-forum-funding', 'EA Forum — Funding Opportunities', 'https://forum.effectivealtruism.org', 'be4pBryMKxLhkmgvE'),
  forumMagnumSource('ea-forum-opportunities', 'EA Forum — Opportunities/RFPs', 'https://forum.effectivealtruism.org', '<OPPORTUNITIES_OR_RFP_TAG_ID>'),
  forumMagnumSource('lesswrong-funding', 'LessWrong — Funding/Opportunities', 'https://www.lesswrong.com', '<LW_TAG_ID>'),
```

- [ ] **Step 5: Run unit test to verify it passes**

Run: `node --test tests/source-feeds.test.js`
Expected: PASS.

- [ ] **Step 6: Live dry-run (acceptance)**

Run: `railway run npx ts-node src/scripts/source-feeds-dryrun.ts ea-forum-opportunities` (then `lesswrong-funding`)
Expected: posts returned; audit misses such as SFF Speculation, Longview Extreme-Power, GovAI US AI Policy, ARENA 9.0, EleutherAI SOAR appear across the EA/LW feeds. If `lesswrong-funding` yields no funding posts, set it `enabled: false` with a `// skip: no clean LW funding tag` comment.

- [ ] **Step 7: Commit**

```bash
git add src/services/source-feeds.ts tests/source-feeds.test.js
git commit -m "feat(feeds): broaden EA Forum tags + add LessWrong funding source"
```

### Task 3: OTF funds scrape source

**Files:**
- Modify: `src/services/source-feeds.ts` (add `otf-funds` in the OSS section, near `otf-news` ~line 609)
- Test: `tests/source-feeds.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('OTF funds scrape source is wired (scrape method, funds endpoint)', () => {
  const s = reg('otf-funds');
  assert.ok(s, 'otf-funds exists');
  assert.equal(s.method, 'scrape');
  assert.ok(s.endpoint.includes('opentech.fund/funds'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/source-feeds.test.js`
Expected: FAIL (`otf-funds` undefined).

- [ ] **Step 3: Implement** — add to the OSS section:

```ts
  {
    key: 'otf-funds',
    name: 'Open Technology Fund — Funds & Open Calls',
    wire: 'oss',
    method: 'scrape',
    endpoint: 'https://www.opentech.fund/funds/',
    urlPrefix: 'https://www.opentech.fund',
    scrapePrompt: "Include each named OTF fund/program currently accepting applications (e.g. Internet Freedom Fund, Rapid Response Fund, FOSS Sustainability Fund). Use each fund's own page URL.",
    enabled: true,
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/source-feeds.test.js`
Expected: PASS.

- [ ] **Step 5: Live dry-run (acceptance)**

Run: `railway run npx ts-node src/scripts/source-feeds-dryrun.ts otf-funds`
Expected: OTF Rapid Response Fund + Internet Freedom Fund (or current open funds) extracted with their own-page URLs.

- [ ] **Step 6: Commit**

```bash
git add src/services/source-feeds.ts tests/source-feeds.test.js
git commit -m "feat(feeds): add OTF funds scrape source (RSS missed fund pages)"
```

### Task 4: Re-enable Manifund via Firecrawl scrape

**Files:**
- Modify: `src/services/source-feeds.ts` (replace the disabled `manifund` rest_json entry, ~line 538-562)
- Test: `tests/source-feeds.test.js` (update the existing assertion that Manifund is disabled)

- [ ] **Step 1: Update the failing test** — change the existing registry test (`'registry: feed sources are wired and Manifund is disabled'`) to assert Manifund is now an enabled scrape source:

```js
test('registry: feed sources wired; Manifund re-enabled via scrape', () => {
  assert.ok(SOURCE_REGISTRY.length >= 10);
  const mf = reg('manifund');
  assert.equal(mf.enabled, true);
  assert.equal(mf.method, 'scrape');
  assert.ok(reg('karma-gap').enabled);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/source-feeds.test.js`
Expected: FAIL (Manifund still `rest_json`, `enabled: false`).

- [ ] **Step 3: Implement** — replace the whole `manifund` object with:

```ts
  {
    // Direct API is Vercel-bot-blocked; Firecrawl renders the page and bypasses it.
    key: 'manifund',
    name: 'Manifund — AI Safety Grants',
    wire: 'ai',
    method: 'scrape',
    endpoint: 'https://manifund.org/causes/ai-safety',
    urlPrefix: 'https://manifund.org',
    scrapePrompt: 'Extract active grant/regranting opportunities and open projects seeking funding on this AI-safety page. Use each project/program URL (manifund.org/projects/<slug> or /about/regranting).',
    enabled: true,
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/source-feeds.test.js`
Expected: PASS.

- [ ] **Step 5: Live dry-run (acceptance)**

Run: `railway run npx ts-node src/scripts/source-feeds-dryrun.ts manifund`
Expected: Manifund AI-safety grants/regranting items extracted. If Firecrawl returns thin content, try `https://manifund.org/about/regranting` as the endpoint.

- [ ] **Step 6: Commit**

```bash
git add src/services/source-feeds.ts tests/source-feeds.test.js
git commit -m "feat(feeds): re-enable Manifund via Firecrawl scrape"
```

---

## Phase 2 — Named-funder own-site monitor

### Task 5: Add candidate funder scrape sources (disabled), then verify-and-enable

**Files:**
- Modify: `src/services/source-feeds.ts` (add a `// =================== OWN-SITE FUNDERS ===================` block)
- Test: `tests/source-feeds.test.js`

**Source template** — add one registry entry per row of the table below, all `enabled: false` initially:

```ts
  {
    key: '<key>', name: '<Funder — Grants>', wire: '<wire>',
    method: 'scrape', endpoint: '<grants page URL>', urlPrefix: '<https origin>',
    scrapePrompt: '<one sentence telling the extractor what to keep + the URL pattern>',
    enabled: false,
  },
```

**Funder table (exact values):**

| key | wire | endpoint | urlPrefix |
|-----|------|----------|-----------|
| `coefficient-giving` | ai | https://coefficientgiving.org/apply-for-funding/ | https://coefficientgiving.org |
| `longview` | ai | https://www.longview.org/funds/ | https://www.longview.org |
| `sff` | ai | https://survivalandflourishing.fund/ | https://survivalandflourishing.fund |
| `ai2050` | ai | https://ai2050.schmidtsciences.org/ | https://ai2050.schmidtsciences.org |
| `cohere-labs` | ai | https://cohere.com/research/grants | https://cohere.com |
| `openai-forms` | ai | https://openai.com/form/ | https://openai.com |
| `sovereign-tech` | oss | https://www.sovereign.tech/programs | https://www.sovereign.tech |
| `futo-grants` | oss | https://futo.org/grants/ | https://futo.org |
| `freebsd-foundation` | oss | https://freebsdfoundation.org/our-work/grants/ | https://freebsdfoundation.org |
| `open-source-collective` | oss | https://oscollective.org/ | https://oscollective.org |
| `github-sponsors` | oss | https://github.com/sponsors/explore | https://github.com |

(scrapePrompt per source: "Extract each currently-open grant/fund/fellowship/RFP a builder can apply to; use the program's own application/details URL.")

- [ ] **Step 1: Write the failing test**

```js
test('own-site funder scrape sources are registered', () => {
  for (const k of ['coefficient-giving','longview','sff','sovereign-tech','futo-grants']) {
    const s = reg(k);
    assert.ok(s, `${k} exists`);
    assert.equal(s.method, 'scrape');
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/source-feeds.test.js`
Expected: FAIL (keys undefined).

- [ ] **Step 3: Implement** — add all 11 entries from the table using the template (all `enabled: false`).

- [ ] **Step 4: Run unit test to verify it passes**

Run: `node --test tests/source-feeds.test.js`
Expected: PASS.

- [ ] **Step 5: Verification gate (per source).** For each key, run:

`railway run npx ts-node src/scripts/source-feeds-dryrun.ts <key>`

Decision rule: if it returns ≥1 discrete opportunity with a stable per-item URL → set that source `enabled: true`. If it returns only an evergreen catalog, a single static page with no per-item URL, or a write-only form → leave `enabled: false` and append `// skip: <reason>`. Record the keep/skip outcome per source in the commit message.

- [ ] **Step 6: Commit**

```bash
git add src/services/source-feeds.ts tests/source-feeds.test.js
git commit -m "feat(feeds): add own-site funder scrape sources (verified-enable)"
```

---

## Phase 2b — Staged sources (boards / EU portal / SAM.gov)

### Task 6: Add staged sources behind the same verification gate

**Files:** Modify `src/services/source-feeds.ts`; Test `tests/source-feeds.test.js`.

Add (all `enabled: false`, then dry-run-verify exactly as Task 5 Step 5):
- `aisafety-funding` (scrape) — https://www.aisafety.com/funding ; wire ai
- `ea-opportunities` (scrape) — https://www.eaopportunities.org/ ; wire ai
- `eu-funding-tenders` (rest_json) — EU Funding & Tenders search API for AI calls (resolve the SEDIA search endpoint + body at implementation via the portal's network calls; `itemsPath` to the results array; `extract()` building the topic URL). wire ai
- `sam-gov` (rest_json) — https://api.sam.gov/opportunities/v2/search (needs a free SAM.gov API key in `headers`; gate on key presence). wire ai

- [ ] **Step 1:** Add the four entries (`enabled: false`) + a registry-wiring test asserting they exist.
- [ ] **Step 2:** Run `node --test tests/source-feeds.test.js` → PASS.
- [ ] **Step 3:** Dry-run each; enable only those that yield discrete dated opps; comment-skip the rest.
- [ ] **Step 4:** Commit `feat(feeds): add staged AI boards + EU/SAM sources (verified-enable)`.

---

## Phase 3 — Ship & measure

### Task 7: Deploy, run a full feed pass, and re-measure recall

- [ ] **Step 1: Open the PR**

```bash
git push -u origin feat/ai-oss-coverage
gh pr create --base main --title "feat(feeds): AI/OSS discovery coverage — fix leaky feeds + own-site monitor" --body "Implements docs/superpowers/specs/2026-06-28-ai-oss-coverage-design.md. Phase 1 leaky-feed fixes + Phase 2 own-site funder scrape sources. Target: AI recall ≥65%, OSS ≥70%."
```

- [ ] **Step 2:** After merge + Railway deploy, trigger one full pass: `POST /api/scan/feeds/run` (internal key) and confirm in logs `[Scheduler] Daily source feeds: N fresh from M sources`.
- [ ] **Step 3:** Wait ~1 week, then re-run the audit harness (corpus pull + ground-truth + matcher + verify from the session scratchpad scripts) on a fresh sample.
- [ ] **Step 4:** Record the new AI/OSS recall in Notion (AI/OSS Recall Audit page) + the priorities memory. Success = AI ≥ 65%, OSS ≥ 70%.

---

## Self-Review

**Spec coverage:** §4.1 EA/LW → Task 2; §4.2 OTF → Task 3; §4.3 Grants.gov → Task 1; §4.4 Manifund → Task 4; §5 own-site monitor + verification gate → Task 5; §6 Phase 2b → Task 6; §9 success metric/rollout → Task 7. All spec sections covered.

**Placeholders:** the only `<...>` tokens are (a) the funder-table values which are given explicitly in the table, and (b) tag IDs / API endpoints that are *resolved by a provided command* at implementation (EA/LW tag IDs via the Step-1 curl; EU/SAM endpoints via the portal's network calls). These are determinate lookups with exact instructions, not open decisions.

**Type consistency:** `grantsGovSource`/`forumMagnumSource` return `FeedSource`; all sources use the existing `FeedItem` shape from `extract()`/`fetchScrape`; helper names (`pick`, `clip`, `toIso`, `BROWSER_UA`, `GRANTS_GOV_OFFBEAT_TITLE/_AGENCY`, `scrapeUrl`) match `source-feeds.ts`. `reg()` test helper matches the existing test file.
