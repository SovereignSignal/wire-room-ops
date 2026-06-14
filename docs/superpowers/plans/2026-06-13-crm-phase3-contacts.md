# CRM Enrichment Phase 3 — Contacts Discovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development for code tasks (1–5). Task 6 (the discovery backfill) is run by the CONTROLLER via the Workflow tool. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Discover relevant *people* — both the key people behind enriched orgs AND notable individuals named in the content (including org-less independent researchers, pseudonymous builders, and OSS/repo authors) — evidence-gated, and propose them into the Notion **Contacts** database (linked to an org when there is one, flagged for review) — without auto-monitoring anyone until the owner approves.

**Architecture:** Adds the missing INBOUND direction to the people layer. Today `src/jobs/contacts-sync.ts` is outbound only (Notion Contacts = source of truth → `monitored_accounts` = who the X-monitor watches). Phase 3 adds discovery: for each qualifying `org_profiles` row, web-research its key contacts, evidence-gate them, dedup, and create Notion Contacts pages (Status="Needs Review", `Org` relation set, `Source`="Discovered"). A small `contacts-sync` tweak keeps "Needs Review" contacts OUT of monitoring until the owner promotes them. A `discovered_contacts` table gives idempotency. The deep backfill across orgs runs as an adversarially-verified Workflow (like Phase 2).

**Tech Stack:** Node/TypeScript, `pg`, Notion REST `2022-06-28`, Grok web_search (same Responses-API idiom Phase 2 used), `node:test`. The Workflow tool for the backfill.

**Spec:** `docs/superpowers/specs/2026-06-13-crm-org-contact-enrichment-design.md` (Phase 3).

**Repo mechanics:** wire-room-ops git repo; branch `crm-phase3-contacts` off main; commit per task; final task merges+pushes (deploys). Tests: `npm test` / `npm run typecheck`. Shared DB: `cat /tmp/telesum_dburl.txt`. Local prod runs: `DB_SSL_REJECT_UNAUTHORIZED=false DATABASE_URL=<prod>` (+ `GROK_API_KEY` from Railway for discovery). There is unrelated uncommitted work in the tree (source-feeds.ts etc.) — only `git add` the files each task names.

**Verified existing state:**
- `src/jobs/contacts-sync.ts`: `runContactsSync(pool)` reads Notion Contacts (via `getIntegrationConfigs('notion')` + `queryAllNotionPages`), upserts each into `monitored_accounts (handle, wire, kind='person', person_name, role, linked_program, source, enabled)`; **`Status != 'Skip'` → enabled (watched)**, `'Skip'` → disabled; a kind='person' handle no longer in Notion → disabled. Helpers exported: `handleFromXUrl(url)`. Falls back to Contacts DB id `66190528a1194cdc85797763d67c5a71`. Wired in server.ts (30-min timer + 25s-after-startup).
- Notion **Contacts** DB props: `Name`(title), `X`(url), `Source`(select), `Status`(select), `Evidence`(rich_text), `Role`(rich_text), `Program`(rich_text), `Wire`(select), `Org`(relation → Orgs DB `301000c0-d590-81c4-8435-c6db7782db12`).
- Orgs DB id `301000c0-d590-81c4-8435-c6db7782db12`; `org_profiles` (~215 rows) has id/name/website/wires/twitter/description.
- No `contacts` table exists (people live in Notion + `monitored_accounts`).

---

### Task 0: Branch + baseline
- [ ] `cd "/Users/home/Documents/Sovereign Signal/repos/wire-room-ops" && git checkout main && git pull --ff-only && git checkout -b crm-phase3-contacts`
- [ ] `npm run typecheck && npm test 2>&1 | grep -E "ℹ (tests|pass|fail)"` → typecheck clean, fail 0. Record pass count.

---

### Task 1: `discovered_contacts` table + idempotency helper

**Files:** Create `src/services/contact-discovery.ts`; Test `tests/contact-discovery.test.js`.

- [ ] **Step 1: failing test** — `tests/contact-discovery.test.js`:
```js
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureDiscoveredContactsTable, recordDiscoveredContact } = require('../src/services/contact-discovery');

function stubPool() { const calls=[]; return { calls, query: async (sql,params)=>{calls.push({sql,params}); return {rows:[]};} }; }

test('ensureDiscoveredContactsTable creates table with unique (org_id, name_norm)', async () => {
  const pool = stubPool(); await ensureDiscoveredContactsTable(pool);
  assert.match(pool.calls[0].sql, /CREATE TABLE IF NOT EXISTS discovered_contacts/);
  assert.match(pool.calls[0].sql, /UNIQUE\s*\(\s*org_id\s*,\s*name_norm\s*\)/);
});
test('recordDiscoveredContact upserts idempotently', async () => {
  const pool = stubPool(); await recordDiscoveredContact(pool, { orgId:5, name:'Jane Doe', xHandle:'janedoe', notionPageId:'pg1' });
  const { sql, params } = pool.calls[0];
  assert.match(sql, /INSERT INTO discovered_contacts/);
  assert.match(sql, /ON CONFLICT .* DO UPDATE/);
  assert.deepEqual(params, [5, 'jane doe', 'Jane Doe', 'janedoe', 'pg1']);
});
```
- [ ] **Step 2:** `node --test tests/contact-discovery.test.js` → FAIL (module missing).
- [ ] **Step 3: implement** — `src/services/contact-discovery.ts`:
```typescript
import type { Pool } from 'pg';

export function normName(n: string): string { return (n || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

export async function ensureDiscoveredContactsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discovered_contacts (
      id SERIAL PRIMARY KEY,
      org_id INTEGER NOT NULL REFERENCES org_profiles(id) ON DELETE CASCADE,
      name_norm TEXT NOT NULL,
      name TEXT NOT NULL,
      x_handle TEXT,
      notion_page_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (org_id, name_norm)
    )`);
}

export async function recordDiscoveredContact(
  pool: Pool, c: { orgId: number; name: string; xHandle: string | null; notionPageId: string | null },
): Promise<void> {
  await pool.query(
    `INSERT INTO discovered_contacts (org_id, name_norm, name, x_handle, notion_page_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id, name_norm) DO UPDATE SET notion_page_id = COALESCE(EXCLUDED.notion_page_id, discovered_contacts.notion_page_id)`,
    [c.orgId, normName(c.name), c.name, c.xHandle, c.notionPageId],
  );
}
```
- [ ] **Step 4:** `node --test tests/contact-discovery.test.js` → 2 pass. `npm run typecheck` clean.
- [ ] **Step 5: commit** `git add src/services/contact-discovery.ts tests/contact-discovery.test.js && git -c user.name="SovereignSignal" -c user.email="sov@sovereignsignal.com" commit -m "contacts: discovered_contacts table + idempotent record\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`

---

### Task 2: Evidence gate (pure)

**Files:** Modify `src/services/contact-discovery.ts`; Test `tests/contact-discovery.test.js`.

Per owner feedback (2026-06-13 Notion comments): pseudonyms/handles ARE acceptable identities; independent (org-less) individuals ARE valid contacts; "role" means a role at an org OR an independent capacity. The only hard reject is empty/unattributable or pure engagement-farm/bot accounts.

- [ ] **Step 1: failing test** — append:
```js
const { passesContactBar } = require('../src/services/contact-discovery');
test('accepts a named person with role + handle + source', () => {
  assert.equal(passesContactBar({ name:'Jane Doe', role:'Head of Grants', x_handle:'janedoe', profile_url:null, source:'https://org.com/team' }), true);
});
test('accepts a pseudonym/handle as the identity', () => {
  assert.equal(passesContactBar({ name:'orhun', role:'OSS maintainer (ratatui)', x_handle:'orhundev', profile_url:'https://github.com/orhun', source:'https://github.com/orhun' }), true);
});
test('accepts an independent individual with no org affiliation', () => {
  assert.equal(passesContactBar({ name:'Sov', role:'independent researcher / builder', x_handle:'sovsignal', profile_url:null, source:'https://x.com/sovsignal' }), true);
});
test('accepts profile_url with no X handle', () => {
  assert.equal(passesContactBar({ name:'Jane Doe', role:'Founder', x_handle:null, profile_url:'https://linkedin.com/in/janedoe', source:'https://org.com' }), true);
});
test('rejects missing identity / role / source', () => {
  assert.equal(passesContactBar({ name:'Jane Doe', role:'Founder', x_handle:null, profile_url:null, source:'https://o.com' }), false);
  assert.equal(passesContactBar({ name:'Jane Doe', role:'', x_handle:'j', profile_url:null, source:'https://o.com' }), false);
  assert.equal(passesContactBar({ name:'Jane Doe', role:'Founder', x_handle:'j', profile_url:null, source:'' }), false);
  assert.equal(passesContactBar({ name:'', role:'Founder', x_handle:'j', profile_url:null, source:'https://o.com' }), false);
});
test('rejects pure bot / engagement-farm accounts (is_bot flag)', () => {
  assert.equal(passesContactBar({ name:'SashaVolkoff1', role:'crypto', x_handle:'sasha', profile_url:'https://x.com/sasha', source:'https://x.com/sasha', is_bot:true }), false);
});
```
- [ ] **Step 2:** run → new tests FAIL.
- [ ] **Step 3: implement** — append to contact-discovery.ts:
```typescript
export interface ContactCandidate {
  name: string;               // a real name OR a stable pseudonym/handle (both acceptable)
  role: string | null;        // role at an org OR an independent capacity ("independent researcher", "OSS maintainer", …)
  x_handle: string | null;
  profile_url: string | null; // X, GitHub, LinkedIn, personal site/blog, ORCID, Scholar, HuggingFace, Farcaster, Substack/Mirror, or an org/forum bio
  source: string | null;      // a URL backing the descriptor
  is_bot?: boolean;           // set by the researcher/verifier for pure engagement-farm/bot accounts
}
/** People are higher-stakes than orgs, BUT pseudonyms/handles and independent
 *  (org-less) individuals are valid (owner decision). Require: a stable identifier
 *  (real name OR handle), a descriptor (org role OR independent capacity), a
 *  reachable profile (X handle OR a profile URL), and a backing source. Reject only
 *  empty/unidentifiable candidates and pure engagement-farm/bot accounts. */
export function passesContactBar(c: ContactCandidate): boolean {
  const name = (c.name || '').trim();
  if (!name) return false;                                   // some stable identifier (real name or handle)
  if (!c.role || !c.role.trim()) return false;               // what they do (org role OR independent capacity)
  if (!c.source || !/^https?:\/\//.test(c.source)) return false;
  const hasHandle = !!(c.x_handle && c.x_handle.trim());
  const hasProfile = !!(c.profile_url && /^https?:\/\//.test(c.profile_url));
  if (!(hasHandle || hasProfile)) return false;              // a reachable identity/profile
  if (c.is_bot === true) return false;                       // pure engagement-farm/bot account
  return true;
}
```
- [ ] **Step 4:** run → all pass. `npm run typecheck` clean.
- [ ] **Step 5: commit** `git add src/services/contact-discovery.ts tests/contact-discovery.test.js && git -c ... commit -m "contacts: evidence gate (name+role+identity+source)\n\nCo-Authored-By: ..."`

---

### Task 3: Create-in-Notion (dedup + Org relation)

**Files:** Modify `src/services/contact-discovery.ts`; Test `tests/contact-discovery-create.test.js`.

Behavior: `createNotionContact(deps, contact)` — given a verified candidate + its org, (a) skip if a Notion Contacts page with the same Name OR same X handle already exists, or `discovered_contacts` already has it; (b) look up the org's Notion page id in the Orgs DB by org name; (c) create a Contacts page with Name/X/Role/Program/Wire/Evidence/Source="Discovered"/Status="Needs Review"/Org relation; (d) `recordDiscoveredContact`. Inject Notion calls + pool as `deps` so it's unit-testable.

- [ ] **Step 1: failing test** — `tests/contact-discovery-create.test.js`:
```js
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContactProperties } = require('../src/services/contact-discovery');

test('buildContactProperties maps fields incl. Needs Review status + Org relation', () => {
  const p = buildContactProperties(
    { name:'Jane Doe', role:'Head of Grants', x_handle:'janedoe', evidence:'Named on org team page', wire:'crypto', program:'Ecosystem Grants' },
    'org-page-123');
  assert.equal(p['Name'].title[0].text.content, 'Jane Doe');
  assert.equal(p['X'].url, 'https://x.com/janedoe');
  assert.equal(p['Role'].rich_text[0].text.content, 'Head of Grants');
  assert.equal(p['Status'].select.name, 'Needs Review');
  assert.equal(p['Source'].select.name, 'Discovered');
  assert.equal(p['Wire'].select.name, 'crypto');
  assert.deepEqual(p['Org'].relation, [{ id: 'org-page-123' }]);
});
test('buildContactProperties omits X when no handle and omits Org when no page id', () => {
  const p = buildContactProperties({ name:'Jane Doe', role:'Founder', x_handle:null, evidence:'e', wire:null, program:null }, null);
  assert.equal('X' in p, false);
  assert.equal('Org' in p, false);
});
```
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: implement** — append to contact-discovery.ts:
```typescript
export function buildContactProperties(
  c: { name: string; role: string | null; x_handle: string | null; evidence: string | null; wire: string | null; program: string | null },
  orgPageId: string | null,
): Record<string, any> {
  const props: Record<string, any> = {
    Name: { title: [{ text: { content: c.name } }] },
    Status: { select: { name: 'Needs Review' } },
    Source: { select: { name: 'Discovered' } },
  };
  if (c.x_handle) props['X'] = { url: `https://x.com/${c.x_handle.replace(/^@/, '')}` };
  if (c.role) props['Role'] = { rich_text: [{ text: { content: c.role.slice(0, 1900) } }] };
  if (c.program) props['Program'] = { rich_text: [{ text: { content: c.program.slice(0, 1900) } }] };
  if (c.evidence) props['Evidence'] = { rich_text: [{ text: { content: c.evidence.slice(0, 1900) } }] };
  if (c.wire) props['Wire'] = { select: { name: c.wire } };
  if (orgPageId) props['Org'] = { relation: [{ id: orgPageId }] };
  return props;
}
```
Also add (not unit-tested — exercised in Task 6) an async `createNotionContact(deps, candidate, org)` that: queries the Contacts DB for an existing page by Name (and by X handle if present) → skip if found; queries the Orgs DB for the org's page id by org.name; calls `deps.notionCreatePage(contactsDbId, buildContactProperties(...))`; `recordDiscoveredContact(deps.pool, {...})`. Reuse `getIntegrationConfigs`/`queryAllNotionPages`/`notionRequest` from notion-sync.ts and the Notion token from the SimpleCRM integration config.
- [ ] **Step 4:** run → pass. `npm run typecheck` clean.
- [ ] **Step 5: commit** `git add src/services/contact-discovery.ts tests/contact-discovery-create.test.js && git -c ... commit -m "contacts: Notion Contacts property mapping + create-with-dedup\n\nCo-Authored-By: ..."`

---

### Task 4: Keep "Needs Review" contacts OUT of monitoring

**Files:** Modify `src/jobs/contacts-sync.ts`; Test `tests/contacts-sync.test.js` (new).

Today `runContactsSync` enables monitoring for any Status != 'Skip'. Discovered contacts (Status="Needs Review") must NOT be auto-watched until the owner promotes them. Extract the watch decision into a pure, testable function and exclude "Needs Review".

- [ ] **Step 1: failing test** — `tests/contacts-sync.test.js`:
```js
require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldWatchContact } = require('../src/jobs/contacts-sync');
test('watches normal/approved statuses', () => {
  assert.equal(shouldWatchContact('Monitored'), true);
  assert.equal(shouldWatchContact('Approved'), true);
  assert.equal(shouldWatchContact(''), true);
});
test('does NOT watch Skip or Needs Review', () => {
  assert.equal(shouldWatchContact('Skip'), false);
  assert.equal(shouldWatchContact('Needs Review'), false);
});
```
- [ ] **Step 2:** run → FAIL (`shouldWatchContact` not exported).
- [ ] **Step 3: implement** — in `src/jobs/contacts-sync.ts` add and export:
```typescript
/** A Notion contact is watched unless explicitly Skipped or still pending review. */
export function shouldWatchContact(status: string | null | undefined): boolean {
  const s = (status || '').trim().toLowerCase();
  return s !== 'skip' && s !== 'needs review';
}
```
Then replace the inline `Status != 'Skip'` enabled-decision in `runContactsSync` with `shouldWatchContact(status)` (find the line computing `enabled`/watched from Status and route it through this helper). Keep everything else unchanged.
- [ ] **Step 4:** `node --test tests/contacts-sync.test.js` → pass. `npm run typecheck && npm test` → fail 0.
- [ ] **Step 5: commit** `git add src/jobs/contacts-sync.ts tests/contacts-sync.test.js && git -c ... commit -m "contacts-sync: do not auto-watch Needs Review contacts\n\nCo-Authored-By: ..."`

---

### Task 5: Discovery runner + admin trigger + schedule + deploy

**Files:** Modify `src/services/contact-discovery.ts` (add `discoverContactsForOrg`/`runContactDiscovery` driver using Grok web_search — mirror Phase 2's `enrichOrgs` Responses-API+web_search idiom), `src/routes/admin.ts` (POST /discover-contacts), `src/server.ts` (timer).

- [ ] **Step 1:** TWO discovery sources, both feeding `passesContactBar` + `createNotionContact`:
  - (a) **Org-anchored:** `discoverContactsForOrg(org, grokCall)` prompts Grok (web_search) for up to 3 key people at the org (founder/CEO, head of grants/ecosystem, notable lead) as JSON `[{name, role, x_handle, profile_url, source, is_bot}]`.
  - (b) **Content-anchored:** `discoverContactsFromContent(grokCall)` surfaces notable INDIVIDUALS named in recent content regardless of org affiliation — digest item authors/handles, repo authors, paper authors, and people mentioned in grant content (this is the path that catches org-less independent researchers and pseudonymous builders; it also re-homes individuals that were wrongly filed as orgs). Same JSON shape; `role` may be an independent capacity; org may be null.
  Both mirror the exact Grok Responses-API + web_search request shape from `org-enricher.ts`, parse, and `passesContactBar`-filter (which now accepts handles/pseudonyms and is_bot-rejects). Add `runContactDiscovery(pool, {limit})` that: `ensureDiscoveredContactsTable`; runs (a) over qualifying orgs (has website, not already in discovered_contacts, ordered by activity) up to limit, and (b) over recent content; for each surviving candidate `createNotionContact` (org relation set when an org match exists, omitted for independents). Returns `{orgsProcessed, contactsCreated, skipped}`.
- [ ] **Step 2:** Admin endpoint in `src/routes/admin.ts` mirroring the `/enrich-orgs` handler (rate-limited): `POST /discover-contacts` → `runContactDiscovery(getPool(), {limit})`.
- [ ] **Step 3:** Schedule in `src/server.ts` (mirror the enrich/digest timers; every 12h, `limit: 20`): a timer calling `runContactDiscovery(getPool(), {limit:20})`, `.unref()`, cleared on shutdown.
- [ ] **Step 4:** `npm run typecheck && npm test 2>&1 | grep -E "ℹ (pass|fail)"` → fail 0.
- [ ] **Step 5: commit, merge, push (deploys)**; then watch-deploy + health 200.

---

### Task 6: Discovery backfill (CONTROLLER Workflow) + verify

The adversarially-verified fan-out, run by the controller after Task 5 deploys.
- [ ] **Step 1:** work-list = qualifying orgs (`SELECT id,name,website FROM org_profiles WHERE website IS NOT NULL AND id NOT IN (SELECT org_id FROM discovered_contacts) ORDER BY activity DESC`), written to per-batch files.
- [ ] **Step 2:** Workflow over two work-lists — (a) qualifying orgs, (b) individuals named in recent content (independents/pseudonymous builders/authors). Per batch, a researcher agent finds candidate people (web); an independent verifier confirms the identity is real and the descriptor holds — for org-affiliated people that they actually hold that role at that org; for independents that the person/handle genuinely exists with that capacity (drop unconfirmed, flag is_bot on engagement-farm accounts); evidence-gate via `passesContactBar`. Return verified candidates (org id when applicable, else null).
- [ ] **Step 3:** Controller creates the verified contacts in Notion (Status="Needs Review", Org relation, Source="Discovered"), deduped via `discovered_contacts`; back up created page ids to `~/Documents/Claude/`.
- [ ] **Step 4:** Report: orgs processed, contacts proposed, and confirm none are auto-watched (all "Needs Review"). The owner reviews in Notion; promoting a contact (Status→Monitored) lets the existing `contacts-sync` start watching it.

---

## Self-review (done at write time)
- **Spec coverage:** discover people from content/web (T5/T6) · evidence gate, stricter than orgs (T2) · link to org via Org relation (T3) · Needs-Review/triage status, not auto-monitored (T3 + T4) · idempotent/deduped (T1/T3) · adversarial verification backfill (T6). ✓
- **Placeholders:** T3's async `createNotionContact` and T5's discovery driver direct the engineer to mirror named existing idioms (notion-sync helpers, org-enricher Grok shape) rather than guess an API — the pure, testable pieces (table, gate, property mapping, watch decision) are fully specified with tests. ✓
- **Type consistency:** `ContactCandidate`/`passesContactBar`, `buildContactProperties(c, orgPageId)`, `recordDiscoveredContact`, `shouldWatchContact`, `normName` used consistently across tasks; Notion Contacts property names match the live schema (Name/X/Role/Program/Evidence/Wire/Status/Source/Org). ✓

## Out of scope
- Auto-promotion of contacts to Monitored (owner does that in Notion; existing contacts-sync then watches them).
- Contact de-duplication across orgs (same person at two orgs) beyond name+handle match — revisit if it occurs.
