# CRM Enrichment Phase 2 — Web-Enrich Every Qualifying Org — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development for the code tasks (1–5). Task 6 (the 222-org backfill) is executed by the CONTROLLER via the Workflow tool, not a plan subagent. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Deeply enrich every qualifying `org_profiles` row (grant + digest) with web-sourced identity + activity fields, write them through to the SimpleCRM Notion DB, and keep new/stale orgs enriched on a schedule.

**Architecture:** Two layers. (1) **Ongoing engine** in wire-room-ops: extend the existing `org-enricher.ts` to be web-augmented (Grok with `web_search`/`x_search` tools), fill the fuller field set with provenance, gate on a 30-day staleness window, and sync the new fields to the CRM. Runs on a schedule for new/stale orgs. (2) **One-time deep backfill** of the existing 222 orgs run by the controller as an adversarially-verified Workflow fan-out (one researcher per org/batch → verify sources → write to `org_profiles`), then a CRM sync.

**Tech Stack:** Node/TypeScript, `pg`, Grok API (web_search/x_search tools — already used for scans), `node:test`. Notion REST. The Workflow tool for the backfill.

**Spec:** `docs/superpowers/specs/2026-06-13-crm-org-contact-enrichment-design.md` (Phase 2 section).

**Repo mechanics:** wire-room-ops git repo; branch `crm-phase2-web-enrich` off main; commit per task; the final task merges + pushes (deploys). Tests: `npm test` / `npm run typecheck`. Shared DB: `cat /tmp/telesum_dburl.txt`. Local prod runs need `DB_SSL_REJECT_UNAUTHORIZED=false DATABASE_URL=<prod>` (transient/local only — never set in Railway). NOTE: another feature ('feed' source / `source-feeds.ts`) has UNCOMMITTED edits in the working tree — do NOT stage or touch those files; only `git add` the specific files each task names.

**Verified existing state:**
- `org-enricher.ts`: `enrichOrgs(orgs)` [Grok LLM, knowledge-only, returns id/org_type/source_type/website/twitter], `enrichBatch({force,limit})` [SELECT WHERE `$1::boolean OR enriched_at IS NULL`; per-org `UPDATE org_profiles SET org_type=COALESCE(...), source_type=COALESCE(...), website=COALESCE(...), twitter=COALESCE(...), enriched_at=NOW(), updated_at=NOW()`], `enrichSingleOrg(orgId)`, `computeDerivedFields()`. `POST /api/admin/enrich-orgs` (force, limit), rate-limited.
- `org_profiles` HAS: `description, tags[], website, twitter, org_type, source_type, last_signal, current_wedge, recommended_action, primary_domain, enriched_at, relationship_context`. MISSING: `github_url`.
- CRM `Orgs` properties include `GitHub URL`(url), `Website`, `Twitter`, `Type`, `Tags`, `Action(s)`(rich_text). NO `Description` property → description/last_signal fold into `Action(s)`.
- `buildOrgProperties` (notion-sync.ts) maps Name/Website/Twitter/Wire/Tags/Items Sourced/Quality Score/Last Checked/Type/Source Type/Tier. MISSING: GitHub URL, Action(s).

---

### Task 0: Branch + baseline

- [ ] **Step 1:** `cd "wire-room-ops" && git checkout main && git pull --ff-only && git checkout -b crm-phase2-web-enrich`
- [ ] **Step 2:** `npm run typecheck && npm test 2>&1 | grep -E "ℹ (tests|pass|fail)"` → typecheck clean, fail 0. Record pass count.

---

### Task 1: `github_url` column + CRM `GitHub URL` mapping

**Files:** Modify `src/services/org-extractor.ts` (the `CREATE TABLE`/ensure path for org_profiles — add the column there or in a dedicated ensure), `src/services/notion-sync.ts` (`buildOrgProperties`); Test `tests/notion-sync-props.test.js`.

- [ ] **Step 1: Failing test** — append to `tests/notion-sync-props.test.js`:

```js
test('GitHub URL is mapped when org.github_url present', () => {
  const props = buildOrgProperties({ name: 'Acme', github_url: 'https://github.com/acme' });
  assert.deepEqual(props['GitHub URL'], { url: 'https://github.com/acme' });
});
test('no GitHub URL key when absent', () => {
  assert.equal('GitHub URL' in buildOrgProperties({ name: 'Acme' }), false);
});
```

- [ ] **Step 2:** `node --test tests/notion-sync-props.test.js` → the GitHub URL test FAILS.

- [ ] **Step 3a: Add the column.** Find where org_profiles is ensured (`grep -n "CREATE TABLE IF NOT EXISTS org_profiles\|ALTER TABLE org_profiles" src/services/org-extractor.ts`). Add an idempotent column-add next to the table ensure (wire-room-ops uses `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` patterns):

```typescript
await pool.query(`ALTER TABLE org_profiles ADD COLUMN IF NOT EXISTS github_url TEXT`);
```
Place it where the other `ADD COLUMN IF NOT EXISTS` statements for org_profiles live (search for `ADD COLUMN IF NOT EXISTS` in that file; if none, add immediately after the `CREATE TABLE IF NOT EXISTS org_profiles (...)` call).

- [ ] **Step 3b: Map it in buildOrgProperties** — add, alongside the Twitter block:

```typescript
  if (org.github_url) {
    props['GitHub URL'] = { url: org.github_url };
  }
```

- [ ] **Step 4:** `node --test tests/notion-sync-props.test.js` → all pass. `npm run typecheck` clean.
- [ ] **Step 5: Commit** `git add src/services/org-extractor.ts src/services/notion-sync.ts tests/notion-sync-props.test.js && git commit -m "enrich: github_url column + CRM GitHub URL mapping\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 2: Web-augmented enrichment with richer fields

**Files:** Modify `src/services/org-enricher.ts`; Test `tests/org-enricher.test.js` (new).

Make `enrichOrgs` (a) use Grok's web search tools, and (b) return the fuller field set: `github_url`, `description` (1–2 sentences), `tags` (3–5), `last_signal` (most recent notable activity), plus the existing org_type/source_type/website/twitter. Provenance: the model must include a `source` URL per org; store it.

- [ ] **Step 1: Failing test** (pure parsing — extract the response-parsing into a testable pure function `parseEnrichmentResponse(text): EnrichedOrg[]`):

Create `tests/org-enricher.test.js`:
```js
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEnrichmentResponse } = require('../src/services/org-enricher');

test('parses full enrichment fields and clamps invalids', () => {
  const raw = JSON.stringify([{
    id: 5, org_type: 'Web2', source_type: 'Foundation', website: 'https://anthropic.com',
    twitter: 'https://x.com/anthropicai', github_url: 'https://github.com/anthropics',
    description: 'AI safety lab.', tags: ['ai','safety','llm'], last_signal: 'Released Fable 5.',
    source: 'https://anthropic.com/about',
  }, {
    id: 6, website: 'notaurl', twitter: null, tags: 'notarray',
  }]);
  const out = parseEnrichmentResponse(raw);
  assert.equal(out[0].github_url, 'https://github.com/anthropics');
  assert.deepEqual(out[0].tags, ['ai','safety','llm']);
  assert.equal(out[0].source, 'https://anthropic.com/about');
  // invalid url dropped to null; non-array tags -> []
  assert.equal(out[1].website, null);
  assert.deepEqual(out[1].tags, []);
});
```

- [ ] **Step 2:** `node --test tests/org-enricher.test.js` → FAIL (`parseEnrichmentResponse` not exported).

- [ ] **Step 3: Implement.** In `org-enricher.ts`:
  - Export an interface `EnrichedOrg { id:number; org_type:string|null; source_type:string|null; website:string|null; twitter:string|null; github_url:string|null; description:string|null; tags:string[]; last_signal:string|null; source:string|null }`.
  - Extract the JSON-parsing/validation from `enrichOrgs` into exported `parseEnrichmentResponse(text:string): EnrichedOrg[]` — parse JSON array; for each: keep url-shaped website/twitter/github_url (must start with `http`) else null; `tags` = array of strings else `[]` (cap 5); `description`/`last_signal`/`source` = string|null; `org_type` clamped to `VALID_ORG_TYPES` else null.
  - Update the Grok request in `enrichOrgs` to enable web search tools (the app already calls Grok with `web_search`/`x_search` for scans — mirror that request shape: add the `tools`/`search_parameters` the scan path uses; `grep -rn "web_search\|x_search\|search_parameters\|tools:" src/services/grok.ts src/services/*.ts` to copy the exact idiom). Update the prompt to ask for the full field set + a `source` URL, returning the JSON array shape above.
  - `enrichOrgs` returns `parseEnrichmentResponse(content)`.

- [ ] **Step 4:** `node --test tests/org-enricher.test.js` → pass. `npm run typecheck` clean.
- [ ] **Step 5: Commit** (`git add src/services/org-enricher.ts tests/org-enricher.test.js && git -c ... commit -m "enrich: web-augmented Grok enrichment + richer fields (github/description/tags/last_signal) with provenance\n\nCo-Authored-By: ..."`)

---

### Task 3: Persist new fields + 30-day staleness + provenance

**Files:** Modify `src/services/org-enricher.ts` (`enrichBatch` SELECT + UPDATE).

- [ ] **Step 1:** Change the `enrichBatch` candidate SELECT predicate from `($1::boolean OR enriched_at IS NULL)` to also re-enrich stale rows:
```sql
WHERE ($1::boolean OR enriched_at IS NULL OR enriched_at < NOW() - INTERVAL '30 days')
```
- [ ] **Step 2:** Extend the per-org UPDATE to persist the new fields. Identity fields keep `COALESCE` (don't overwrite a good value with null); `description`, `tags`, `last_signal` REFRESH (latest wins); append provenance to `relationship_context`:
```sql
UPDATE org_profiles SET
  org_type = COALESCE($1, org_type),
  source_type = COALESCE($2, source_type),
  website = COALESCE($3, website),
  twitter = COALESCE($4, twitter),
  github_url = COALESCE($5, github_url),
  description = COALESCE($6, description),
  tags = CASE WHEN array_length($7::text[],1) IS NULL THEN tags
              ELSE (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tags,'{}') || $7::text[]))) END,
  last_signal = COALESCE($8, last_signal),
  relationship_context = CASE WHEN $9::text IS NULL THEN relationship_context
       ELSE left(COALESCE(relationship_context,'') || E'\n[enriched ' || to_char(NOW(),'YYYY-MM-DD') || '] source: ' || $9, 4000) END,
  enriched_at = NOW(), updated_at = NOW()
WHERE id = $10
```
with params `[data.org_type, data.source_type, data.website, data.twitter, data.github_url, data.description, data.tags, data.last_signal, data.source, orgId]`. (Confirm the exact existing UPDATE text and replace; keep the no-enrichment fallback UPDATE that just bumps enriched_at.)
- [ ] **Step 3:** `npm run typecheck && npm test 2>&1 | grep -E "ℹ (pass|fail)"` → fail 0 (no behavior unit-test here; the SELECT/UPDATE are exercised in the Task 6 backfill against the real DB).
- [ ] **Step 4: Commit** (`git add src/services/org-enricher.ts && git -c ... commit -m "enrich: persist github/description/tags/last_signal, 30-day staleness, provenance in relationship_context\n\nCo-Authored-By: ..."`)

---

### Task 4: Sync enriched activity to the CRM `Action(s)` field

**Files:** Modify `src/services/notion-sync.ts` (`buildOrgProperties`); Test `tests/notion-sync-props.test.js`.

The CRM has no Description property, so surface `description` + `last_signal` in the `Action(s)` rich_text (append, capped). (GitHub URL handled in Task 1.)

- [ ] **Step 1: Failing test** — append:
```js
test('Action(s) carries description and last_signal when present', () => {
  const props = buildOrgProperties({ name: 'Acme', description: 'AI lab.', last_signal: 'Shipped X.' });
  const text = props['Action(s)'].rich_text.map(r => r.text.content).join('');
  assert.ok(text.includes('AI lab.') && text.includes('Shipped X.'));
});
test('no Action(s) when neither description nor last_signal present', () => {
  assert.equal('Action(s)' in buildOrgProperties({ name: 'Acme' }), false);
});
```
- [ ] **Step 2:** `node --test tests/notion-sync-props.test.js` → the Action(s) test FAILS.
- [ ] **Step 3:** In `buildOrgProperties`, add before `return props`:
```typescript
  const actionParts: string[] = [];
  if (org.description) actionParts.push(String(org.description));
  if (org.last_signal) actionParts.push(`Latest: ${org.last_signal}`);
  if (actionParts.length > 0) {
    props['Action(s)'] = { rich_text: [{ text: { content: actionParts.join('\n').slice(0, 1900) } }] };
  }
```
- [ ] **Step 4:** `node --test tests/notion-sync-props.test.js` → pass. `npm run typecheck` clean.
- [ ] **Step 5: Commit** (`git add src/services/notion-sync.ts tests/notion-sync-props.test.js && git -c ... commit -m "enrich: surface description + last_signal in CRM Action(s)\n\nCo-Authored-By: ..."`)

---

### Task 5: Schedule the enrichment + deploy

**Files:** Modify `src/server.ts` (add a recurring enrichment timer mirroring the Task-1-Phase-1 setInterval pattern).

- [ ] **Step 1:** In `src/server.ts`, next to the digest-org/CRM timers, add an enrichment timer (every 6 hours; enrichBatch self-limits via staleness + limit):
```typescript
const enrichTimer = setInterval(async () => {
  try {
    const { enrichBatch, computeDerivedFields } = await import('./services/org-enricher');
    await enrichBatch({ limit: 40 });
    await computeDerivedFields();
  } catch (e) { console.error('[OrgEnrich] scheduled run failed:', e); }
}, 6 * 60 * 60 * 1000);
enrichTimer.unref();
```
Add `clearInterval(enrichTimer)` to the graceful-shutdown block with the other timers.
- [ ] **Step 2:** `npm run typecheck && npm test 2>&1 | grep -E "ℹ (pass|fail)"` → fail 0.
- [ ] **Step 3: Commit, merge, push (deploys)**
```bash
git add src/server.ts && git commit -m "enrich: schedule org enrichment every 6h\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git checkout main && git merge --no-ff crm-phase2-web-enrich -m "CRM Phase 2: web-augmented org enrichment" && git push origin main
```
- [ ] **Step 4: Watch deploy + health** — `watch-deploy.sh 17165452-… 5cc01564-… d0d4c7f4-…` → FINAL=SUCCESS; health 200.

---

### Task 6: Deep backfill of the 222 orgs (CONTROLLER runs a Workflow — not a plan subagent)

This is the spec's adversarially-verified fan-out. The CONTROLLER executes it with the Workflow tool after Task 5 deploys.

- [ ] **Step 1:** Pull the orgs to enrich: `psql "$DBURL" -c "SELECT id, name, array_to_string(wires,',') FROM org_profiles WHERE enriched_at IS NULL OR enriched_at < NOW() - INTERVAL '30 days' ORDER BY (SELECT count(*) FROM scan_entries WHERE org_id=org_profiles.id)+(SELECT count(*) FROM digest_item_orgs WHERE org_id=org_profiles.id) DESC"` — this is the work-list.
- [ ] **Step 2:** Run a Workflow that pipelines the work-list: each org → a researcher agent (web search the org: official site, GitHub, X, recent activity) returning a structured `{website,github_url,twitter,org_type,description,tags,last_signal,source}` via schema → a verifier agent that confirms each non-null field is supported by the cited source (drops unsupported fields) → write the verified fields to `org_profiles` (UPDATE, set enriched_at, append provenance). Use small batches; `budget`-aware loop if a token target is set. Filter nulls.
- [ ] **Step 3:** After the fan-out, trigger one CRM sync (run `syncOrgsToNotion` for the SimpleCRM integration the same way Phase 1 did) and verify a sample: orgs now have website/github/description/tags in `org_profiles` and the CRM rows show GitHub URL + Action(s).
- [ ] **Step 4:** Spot-check provenance: every enriched org has a `source` recorded in `relationship_context`. Report counts (enriched, fields filled, any orgs the verifier left sparse).

---

## Self-review (done at write time)

- **Spec coverage:** web-augmented enrichment (T2) · fields website/github/twitter/description/org_type/tags + last_signal (T1–T3) · provenance via enriched_at + relationship_context (T3) · 30-day staleness (T3) · CRM write-through incl. GitHub URL + activity (T1,T4) · fan-out workflow with adversarial source verification (T6) · scheduled ongoing enrichment (T5). ✓
- **Placeholders:** T2 Step 3 directs grepping `grok.ts` for the exact web-search request idiom (must match the app's real Grok-tools shape — can't be guessed); T3/T2 instruct confirming the exact existing UPDATE/request text before replacing. These are "match the real code" directions, not vague requirements; all added code is fully specified. ✓
- **Type consistency:** `EnrichedOrg`/`parseEnrichmentResponse` shape is used identically in T2 (return), T3 (UPDATE params order: org_type,source_type,website,twitter,github_url,description,tags,last_signal,source,id), and T6 (researcher schema). `buildOrgProperties` keys (GitHub URL, Action(s)) match CRM property names. ✓

## Deferred to Phase 3

- Contacts discovery + the `Contacts` DB sync (evidence-gated).
