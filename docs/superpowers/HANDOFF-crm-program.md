# Handoff: CRM Org & Contact Enrichment Program (wire-room-ops)

> **Audience:** a fresh Claude Code instance running inside the `wire-room-ops` repo, with full codebase access but zero conversation history.
> **Repo:** `wire-room-ops` (Railway, `main` auto-deploys). The upstream producer is the sibling app **tele-sum**.
> **Last updated:** 2026-06-13.

---

## 1. TL;DR — what you're taking over

You own the **CRM Org & Contact Enrichment program**: a pipeline that turns tele-sum's summarized Telegram content into enriched org and contact records in Sov's Notion CRM, kept current automatically. Phases 1 (link + sync) and 2 (web-enrich orgs) are **shipped and live**; Phase 3 (the contacts discovery engine) is **code-complete and shipped**, with a 15-org sample run validated. The org side is fully enriched (215/215). What remains is the **Phase 3 full backfill**.

### Immediate next action

**Run the full Phase 3 contacts backfill — ~200 orgs remaining.** The 15-org sample created **48 Needs-Review contacts, 2 deduped, 0 errors**, and the safeguard was verified (discovered people land disabled in `monitored_accounts`). Run it via `runContactDiscovery` with the `limit` raised to cover the remaining orgs (see §5 Runbook). Everything you create stays `Status='Needs Review'` and is never auto-monitored until Sov promotes it in Notion.

---

## 2. The program

A three-phase arc that extends the existing `org_profiles` pipeline in wire-room-ops to tie tele-sum content (grant + digest wires) to Sov's Notion CRM and keep records enriched.

| Phase | What it does | Status |
|---|---|---|
| **Phase 1 — link + sync** | Source orgs from tele-sum digest content (`repos`/`models`/`claw` wires) into `org_profiles` behind the `qualifiesAsDigestOrg` quality bar; link each digest item to its org via the new `digest_item_orgs` table; revive + schedule the dormant SimpleCRM Notion sync so all orgs (grant + digest) stay current. | **DONE** (2026-06-13) |
| **Phase 2 — web-enrich orgs** | Web-enrich every qualifying `org_profiles` row (identity + activity fields, with provenance) via Grok `web_search`; add `github_url`; gate re-enrichment on a 30-day staleness window; one-time adversarially-verified backfill of existing orgs + CRM sync. | **DONE** (2026-06-13) — 227 enriched, 47 flagged Needs Review at the time |

> **Why the numbers shifted since Phase 2 (227→215 orgs, 47→28 flagged):** expected, not data loss. Org dedup/cleanup ran afterward (`POST /api/admin/dedup-orgs` and `/api/admin/clean-orgs` merged duplicates and removed junk/non-org rows). The current truth is **215 orgs / 28 flagged**.
| **Phase 3 — contacts engine** | Discover key people behind enriched orgs + notable individuals named in content (including org-less / pseudonymous / OSS authors); evidence-gate them; dedup via new `discovered_contacts` table; create Notion Contacts pages (`Status='Needs Review'`, Org relation set, `Source='Discovered'`) **without** auto-monitoring until owner approval. | **Engine SHIPPED; full backfill PENDING** |

### Current data state

**Orgs (`org_profiles`)**
- Total: **215** — Enriched: **215** — Never enriched: **0** — Needs-Review flagged: **28**

**Contacts**
- `discovered_contacts` (org-anchored): **43**
- `monitored_accounts` kind=`person`:
  - Enabled, pre-existing/approved: **29**
  - Disabled, Needs-Review: **36**
- `digest_item_orgs` links: **90**

**Phase 3 sample run** (the validation run already executed)
- Orgs processed: **15** — Contacts created: **48** — Deduped: **2** — Errors: **0**
- All created contacts: `Needs Review`. Safeguard verified: discovered people `enabled=false` in `monitored_accounts`.

**Phase 3 full backfill remaining: ~200 orgs.**

**Channels / extraction profiles (upstream feed health)**

| Wire | Profile | Notes |
|---|---|---|
| crypto | grant | |
| ai | grant/digest | |
| oss | grant | |
| claw | digest | 27 backfilled |
| models | digest | 11 backfilled |
| repos | digest | **ONLY 3 live items, NOT backfilled** (see §8 — tele-sum's lane) |

**CRM Notion targets**
- Orgs DB: `301000c0-d590-81c4-8435-c6db7782db12` ("Sov's Orgs")
- Contacts DB: `66190528-a119-4cdc-8579-7763d67c5a71`
- Integration config row name: `SimpleCRM - Notion` (provider `notion`, in `integration_config`)

---

## 3. Code map

All paths are under `/Users/home/Documents/Sovereign Signal/repos/wire-room-ops/`.

### `src/services/digest-orgs.ts`
Sources + links digest orgs from tele-sum into `org_profiles` / `digest_item_orgs`.

| Function | Purpose |
|---|---|
| `normalizeDigestOrg` | Collapse whitespace and trim a raw org name string. |
| `qualifiesAsDigestOrg` | Quality bar: rejects owner/repo handles; org-shaped names need ≥2 mentions OR a link, bare lowercase names need ≥2 mentions. |
| `ensureDigestItemOrgsTable` | `CREATE TABLE IF NOT EXISTS digest_item_orgs` (idempotency on `summary_id+item_index+org_id`, FK to `org_profiles`). |
| `linkDigestItemToOrg` | `INSERT` a `(summary_id, item_index, org_id)` link row, `ON CONFLICT DO NOTHING`. |
| `aggregateDigestOrgMentions` | Pure roll-up of org mentions across digest summaries keyed by normalized name (mentionCount, hasLink, occurrences). |
| `loadDigestSummaries` | Read recent SUCCESS digest-profile summaries for wires `repos/models/claw` (summaries JOIN messages). |
| `sourceDigestOrgs` | DB runner: aggregate → gate → upsert/match `org_profiles` → link occurrences → update wires+last_seen (**never** `entry_count`). |

### `src/services/org-enricher.ts`
Web-enriches org profiles via Grok.

| Function | Purpose |
|---|---|
| `parseEnrichmentResponse` | Pure parse/validate of Grok JSON into `EnrichedOrg[]` (strips fences, validates enums/URLs, `[]` on error). |
| `enrichOrgs` | Call Grok Responses API (`/v1/responses`, `web_search` tool) to enrich a batch; returns `Map<id, EnrichedOrg>`; logs api_usage. |
| `enrichBatch` | Batch-enrich unenriched/stale rows in chunks of 10 (limit cap 200), drop dead URL fields, `UPDATE org_profiles`. |
| `enrichSingleOrg` | Idempotently enrich one org by id (skips if already enriched); used in approve flow fire-and-forget. |
| `computeDerivedFields` | Bulk `UPDATE org_profiles` setting `entry_count`, `avg_quality_score`, `tier` from linked `scan_entries`. |

### `src/services/url-verify.ts`
Deterministic URL reachability (HTTP only, no DB).

| Function | Purpose |
|---|---|
| `verifyUrl` | Returns `'ok'` (2xx/3xx), `'notfound'` (404/410), `'inconclusive'` (blocked/throttled/timeout); HEAD then GET retry on 405/501. |
| `findDeadUrlFields` | Verify website/github_url/twitter fields; return names of fields that are definitively `notfound`. |

### `src/services/notion-sync.ts`
CRM sync layer + integration config CRUD.

| Function | Purpose |
|---|---|
| `ensureIntegrationConfigTable` | `CREATE TABLE IF NOT EXISTS integration_config` (provider, name, enabled, config JSONB, sync status cols; `UNIQUE(provider,name)`). |
| `getIntegrationConfigs` | Read `integration_config` rows, optionally filtered by provider. |
| `getIntegrationById` | Read a single row by id. |
| `upsertIntegration` | INSERT/UPDATE a row (merges config JSONB) `ON CONFLICT(provider,name)`. |
| `updateIntegration` | Partial UPDATE (enabled and/or merged config). |
| `deleteIntegration` | DELETE a row by id. |
| `notionRequest` | Low-level Notion API fetch wrapper (auth header, Notion-Version, JSON, throws on non-ok). |
| `validateNotionToken` | Validate a token via `GET /users/me`. |
| `validateNotionDatabase` | Validate a DB id via `GET /databases/{id}`. |
| `syncOrgsToNotion` | Sync all `org_profiles` (with **live** `items_sourced`) to a Notion DB, create/update pages by name; updates sync status. |
| `queryAllNotionPages` | Paginate `POST /databases/{id}/query` to return all pages. |
| `buildOrgProperties` | Map an `org_profiles` row to the "Sov's Orgs" Notion page properties. |

### `src/services/contact-discovery.ts`
The Phase 3 engine. `runContactDiscovery` is at line **466**.

| Function | Purpose |
|---|---|
| `normName` | Normalize a name (collapse whitespace, trim, lowercase). |
| `ensureDiscoveredContactsTable` | `CREATE TABLE IF NOT EXISTS discovered_contacts` (org_id FK, name_norm, name, x_handle, notion_page_id; `UNIQUE(org_id,name_norm)`). |
| `recordDiscoveredContact` | `INSERT` a discovered contact, `ON CONFLICT` updating `notion_page_id`. |
| `passesContactBar` | Quality gate for a `ContactCandidate` (requires name, role, http source, X handle or profile URL; rejects bots). |
| `buildContactProperties` | Build a Notion Contacts page properties object (`Status='Needs Review'`, `Source='Discovered'`, optional X/Role/Program/Evidence/Wire/Org relation). |
| `createNotionContact` | Create a Notion Contacts page with dedup (against Notion name/X and local `discovered_contacts`); records the row on success. |
| `grokWebSearch` | Call Grok Responses API (`/v1/responses`, `web_search`) and return extracted output text; logs api_usage `purpose='contact-discovery'`. |
| `parseContactsResponse` | Pure parse of Grok text into `ContactCandidate[]` (strips fences, coerces fields, `[]` on failure). |
| `discoverContactsForOrg` | Discover up to **3** key contacts at one org via Grok web_search; gate-filtered. |
| `discoverContactsFromContent` | Discover up to **5** notable org-less individuals from recent AI/crypto/OSS content; gate-filtered. |
| `runContactDiscovery` | Runner: org-anchored discovery for top-N qualifying orgs + one content-anchored pass; loads Notion pages once for in-memory dedup; creates contacts. |

### `src/jobs/contacts-sync.ts`
Reconciles the Notion Contacts DB into the people-monitor. **Holds the safeguard.**

| Function | Purpose |
|---|---|
| `shouldWatchContact` | Returns `true` unless Status is `'skip'` or `'needs review'` (verified: `s !== 'skip' && s !== 'needs review'`). |
| `handleFromXUrl` | Extract a lowercase X/Twitter handle from a URL, or null. |
| `runContactsSync` | One-way reconcile Notion Contacts DB → `monitored_accounts`: upsert `kind='person'` rows (enabled per Status), disable person rows absent from Notion; **orgs untouched**. |

### Schedules (in-process timers)

| Timer | Interval | Calls |
|---|---|---|
| `contactsSyncTimer` | every 30 min; plus once ~25s after startup | `runContactsSync(getPool())` — Notion Contacts → `monitored_accounts` |
| `digestOrgsSyncTimer` | every 30 min | `sourceDigestOrgs(getPool())` — digest orgs → `org_profiles`/`digest_item_orgs` |
| `crmSyncTimer` | every 60 min (`:15` offset so sourcing runs first) | `syncOrgsToNotion(crm.id)` for enabled `SimpleCRM - Notion` |
| `enrichTimer` | every 6 hours | `enrichBatch({ limit: 40 })` then `computeDerivedFields()` |
| `contactDiscoveryTimer` | every 12 hours | `runContactDiscovery(getPool(), { limit: 20 })` |
| Startup derived-fields | once at startup (fire-and-forget, after `ensureOrgProfilesTable`) | `computeDerivedFields()` |

### Admin endpoints (POST; all rate-limited)

| Method + Path | Purpose | Params | Rate limit |
|---|---|---|---|
| `POST /api/admin/contacts-sync` | Reconcile Notion Contacts → people-monitor (`runContactsSync`). | none | 3/5min |
| `POST /api/admin/clean-orgs` | One-time `org_profiles` cleanup (`runOrgCleanup`). | none | 1/30min |
| `POST /api/admin/dedup-orgs` | LLM-powered org dedup (`runOrgDedup`). | none | 1/30min |
| `POST /api/admin/enrich-orgs` | Batch-enrich + recompute derived fields (`enrichBatch` + `computeDerivedFields`). | `body.limit` (1–200, default 50); `body.force` (boolean `=== true`) | 1/10min |
| `POST /api/admin/source-digest-orgs` | Extract + link digest orgs (`sourceDigestOrgs`). | none | 3/5min |
| `POST /api/admin/sync-crm` | Push `org_profiles` → `SimpleCRM - Notion` (`syncOrgsToNotion`). | none | 3/5min |
| `POST /api/admin/discover-contacts` | Discover contacts via Grok web_search (`runContactDiscovery`). | `body.limit` OR `query.limit` (1–50, default 20) | 1/10min |

> **Note on the admin endpoint cap:** `/api/admin/discover-contacts` clamps `limit` to **1–50** and is rate-limited **1 call / 10 min**. With ~200 orgs remaining, the endpoint route takes **30+ minutes across 4+ spaced calls** — so prefer **Route 1 (the direct runner)** for the backfill. The endpoint dedups, so re-runs are safe either way.

---

## 4. Data & swimlane

### Table ownership

| Table | Owner | Who reads/writes |
|---|---|---|
| `messages` | tele-sum | tele-sum owns; wire-room-ops read-only (JOINed in `loadDigestSummaries` for `m.wire`). |
| `summaries` | tele-sum | tele-sum owns; wire-room-ops read-only (reads `s.entities->'items'`, `entities->>'profile'='digest'`, `processing_status='SUCCESS'`). wire-room-ops/clawbytes write-through inserts approved distribution posts (rows with `message_id IS NULL`); tele-sum's `distribution_guard` skips re-importing those via `distribution_logs`. |
| `channel_configs` | tele-sum | tele-sum only. |
| `notion_pages` | tele-sum | tele-sum only — tele-sum's OWN per-feed Notion sync, separate from the CRM sync. |
| `org_profiles` | **wire-room-ops** | wire-room-ops owns. Created/updated by grant pipeline (`org-extractor.upsertOrgProfile`) and by `digest-orgs.ts` (UPDATEs `wires`+`last_seen` only). tele-sum does NOT touch it. |
| `scan_entries` | **wire-room-ops** | wire-room-ops only — grant-pipeline rows; counted for `items_sourced` and org ranking. |
| `digest_item_orgs` | **wire-room-ops** | wire-room-ops only — created/written by `digest-orgs.ts`. References tele-sum's `summaries` by id, but the table is ours. |
| `discovered_contacts` | **wire-room-ops** | wire-room-ops only — created/written by `contact-discovery.ts`. FK `org_id` → `org_profiles`, `UNIQUE(org_id, name_norm)`. |
| `monitored_accounts` | **wire-room-ops** | wire-room-ops only — `contacts-sync.ts` upserts `kind='person'` rows (Notion is source of truth) and disables absent ones; `kind='org'` untouched. |
| `integration_config` | **wire-room-ops** | wire-room-ops only — holds the `SimpleCRM - Notion` row (token + DB ids in `config` JSONB). |
| `distribution_logs` | **wire-room-ops** | wire-room-ops writes (publishing); tele-sum READS it (`distribution_guard.py`) to skip our own posts. |
| `api_providers` | **wire-room-ops** | wire-room-ops owns (one row per provider, keys/base_url/default_model). tele-sum READS it. |
| `api_usage_log` | **shared** | both apps WRITE one row per AI call (`logApiUsage` here). `wire` column is the cross-app cost-analysis key. |

Other tables touched: `seen_names`, `seen_urls`.

### Producer → consumer contract

**PRODUCER: tele-sum. CONSUMER: wire-room-ops.** The contract surface is the JSON column `summaries.entities` (untyped JSONB in DB; validated on tele-sum's side before storage). wire-room-ops reads it directly via SQL — never via an API.

- **Discriminator:** tele-sum writes a top-level `entities.profile`. Grant rows have **no** `profile` key. Digest rows set `entities.profile = 'digest'`. `digest-orgs.ts` filters on `s.entities->>'profile' = 'digest'`.
- **Digest item shape consumed:** `entities.items[]` where each item has exactly `title`, `url`, `note`, `category`, `tags`, `org`. wire-room-ops reads ONLY `item.org` and `item.url`.
- **⚠️ tele-sum currently surfaces ORGS but NOT PEOPLE.** `DigestItem` has **no** `people`/`person`/`author` field. The only people-bearing channel is the **overloaded `org` field** — the digest prompt instructs the model to emit `'org': 'org/author or null'`, so an item's `org` may actually carry an individual author/handle. `qualifiesAsDigestOrg` is the boundary's defense against author handles being promoted into `org_profiles` as orgs.
- **Consequence:** because tele-sum exposes no person field, **Phase 3 re-derives contacts via Grok web_search** (`contact-discovery.ts`) + the Notion Contacts DB — NOT from `summaries.entities`. The org→contact link runs `org_profiles → discovered_contacts`, with `org_profiles` populated partly by `digest-orgs` from tele-sum's `entities.items[].org`.
- **Idempotency / keys across the boundary:** digest items link back to tele-sum rows by `(summary_id, item_index)` — `digest_item_orgs UNIQUE(summary_id, item_index, org_id)`, where `summary_id = summaries.id` and `item_index` = ordinal position in `entities.items`. **This positional index is part of the implicit contract:** reordering or splitting items in `entities.items` would break the mapping.

---

## 5. Runbook

### A. Run the full Phase 3 backfill (the immediate next action)

The schedule runs `runContactDiscovery(getPool(), { limit: 20 })` every 12h, but for the one-time backfill of ~200 remaining orgs you raise the limit. Two routes:

**Route 1 — direct runner (preferred for the big backfill).** Run `runContactDiscovery(getPool(), { limit: 200 })` from a local script or REPL inside the repo. It is idempotent — `discovered_contacts UNIQUE(org_id, name_norm)` + Notion dedup means re-runs are safe and it picks up where it left off.

> **Expect fewer than 200 `orgsProcessed` — that is correct, not a failure.** Org-anchored discovery (`contact-discovery.ts:501-510`) selects only orgs `WHERE website IS NOT NULL AND id NOT IN (SELECT org_id FROM discovered_contacts)`. So orgs with a NULL website are *never* reached by org-anchored discovery (only by the content-anchored pass), and already-done orgs are skipped. `limit` caps how many qualifying orgs are pulled per call. Re-run until it processes 0 to confirm coverage.

**Route 2 — admin endpoint (capped at 50/call).** `POST /api/admin/discover-contacts` with `body.limit` or `query.limit` (1–50). Call it repeatedly until coverage is complete; dedup makes repeated calls safe.

**Required environment:**
- **Grok key** — `enrich`/`discover` resolve the key from the **`api_providers` DB row first** (`provider?.api_key`), falling back to the **`GROK_API_KEY`** env var (`contact-discovery.ts:254`, `org-enricher.ts:139`); they no-op/throw only if *neither* is set. For a local run against the shared DB the row usually supplies it, but set `GROK_API_KEY` from Railway wire-room-ops vars to be safe.
- **Local TLS (laptop runs only):** to run wire-room-ops DB code from a laptop against the Railway proxy DB (`gondola.proxy.rlwy.net`), set **`DB_SSL_REJECT_UNAUTHORIZED=false` ONLY as a transient env for the local run**. **NEVER set it in Railway** (the deployed app keeps TLS verification on). `NODE_TLS_REJECT_UNAUTHORIZED=0` does **NOT** work (`getPool` sets `ssl` explicitly). The DB URL is cached at `/tmp/telesum_dburl.txt` on the owner's laptop.

Example shape (laptop):
```bash
DB_SSL_REJECT_UNAUTHORIZED=false \
GROK_API_KEY=... \
DATABASE_URL="$(cat /tmp/telesum_dburl.txt)" \
node <run runContactDiscovery with { limit: 200 }>
```

**After the backfill:** the new contacts appear in the Notion Contacts DB as `Status='Needs Review'`. They are NOT monitored until Sov promotes them (see §7). The 30-min `contactsSyncTimer` will reconcile Notion → `monitored_accounts` automatically, keeping promoted ones enabled and Needs-Review ones disabled.

### B. Trigger any admin endpoint

All are `POST`, behind auth, rate-limited (see §3 table). Examples:
- Force an org re-enrich pass: `POST /api/admin/enrich-orgs` with `{"limit": 100}` (add `{"force": true}` to bypass the 30-day staleness window).
- Pull fresh digest orgs now: `POST /api/admin/source-digest-orgs`.
- Push orgs to the CRM now: `POST /api/admin/sync-crm`.
- Reconcile contacts now: `POST /api/admin/contacts-sync`.

### C. How the schedules keep it current (steady state)

1. `digestOrgsSyncTimer` (30 min) pulls new digest orgs into `org_profiles`.
2. `crmSyncTimer` (60 min, `:15` offset) pushes orgs to the CRM with live `items_sourced`.
3. `enrichTimer` (6 h) enriches new/stale orgs.
4. `contactDiscoveryTimer` (12 h, limit 20) discovers contacts for top-N orgs + a content pass.
5. `contactsSyncTimer` (30 min) reconciles Notion Contacts → `monitored_accounts`.

**Deploy:** wire-room-ops is on Railway; `main` branch auto-deploys.

---

## 6. Gotchas (verbatim-faithful)

- **`org_profiles.entry_count` is GRANT-pipeline-owned and contested:** the digest path must **NOT** write it (the grant pipeline recomputes grant-only and clobbers it). CRM "Items Sourced" is computed **LIVE** at sync = `COUNT(scan_entries WHERE org_id) + COUNT(digest_item_orgs WHERE org_id)` in `syncOrgsToNotion`'s query (`items_sourced`) `?? entry_count`.
- **Local-run TLS:** to run wire-room-ops DB code from a laptop against the Railway proxy DB (gondola), set `DB_SSL_REJECT_UNAUTHORIZED=false` **ONLY** as a transient env for the local run. **NEVER** set it in Railway (deployed app keeps TLS verification on). `NODE_TLS_REJECT_UNAUTHORIZED=0` does **NOT** work (`getPool` sets `ssl` explicitly).
- **`enrich`/`discover` need a Grok key** — resolved from the `api_providers` DB row first, then the `GROK_API_KEY` env var (Railway wire-room-ops vars); `enrichOrgs`/contact-discovery no-op/throw only if neither is set.
- **Notion 'Source Type' field on Orgs is `multi_select`** (sending `select` => 400).
- **SAFEGUARD:** discovered contacts land `Status='Needs Review'`; `contacts-sync.shouldWatchContact` treats `'needs review'` like `'skip'`, so they are **NOT** auto-monitored until the owner promotes them in Notion. Verified: discovered people `enabled=false` in `monitored_accounts`.
- **Grok web search uses the xAI Responses API:** `POST /v1/responses` with `tools:[{type:'web_search'}]`.
- **Postgres is shared** (`gondola.proxy.rlwy.net`) between tele-sum and wire-room-ops. DBURL is cached at `/tmp/telesum_dburl.txt` on the owner's laptop.
- **Deploy:** wire-room-ops is on Railway; `main` branch auto-deploys.

---

## 7. The safeguard

**Discovered contacts are never auto-watched.** This is the load-bearing protection against accidentally monitoring people Sov hasn't vetted.

How it works end-to-end:
1. `contact-discovery.ts` → `buildContactProperties` creates every Notion Contacts page with **`Status='Needs Review'`** and `Source='Discovered'`.
2. The 30-min `contactsSyncTimer` runs `runContactsSync`, which one-way reconciles the Notion Contacts DB into `monitored_accounts` as `kind='person'`, `source='notion-contacts'` rows, with the `enabled` flag set per the contact's Notion **Status**.
3. `shouldWatchContact(status)` returns `true` only if Status is **not** `'skip'` and **not** `'needs review'` (verified in code: `return s !== 'skip' && s !== 'needs review'`). So Needs-Review contacts are written **disabled** (`enabled=false`).
4. **Promotion is owner-driven, in Notion:** Sov changes a contact's Status away from `Needs Review` (e.g. to an approved state). On the next `contactsSyncTimer` pass, `shouldWatchContact` returns `true` and the person row flips to `enabled=true` — at which point the people-monitor begins watching them.
5. Reconcile also **disables** person rows absent from Notion. `kind='org'` rows are never touched.

Verified in the sample run: all 48 created contacts were `Needs Review`, and the discovered people were `enabled=false` in `monitored_accounts`.

---

## 8. Where the docs live

All under `/Users/home/Documents/Sovereign Signal/repos/wire-room-ops/docs/superpowers/`.

| Doc | Path | Covers |
|---|---|---|
| **Design spec** | `specs/2026-06-13-crm-org-contact-enrichment-design.md` | The whole CRM org+contact arc, delivered as 3 phases by extending the existing `org_profiles` pipeline. Approved design (2026-06-13). |
| **Phase 1 plan** | `plans/2026-06-13-crm-phase1-link-and-sync.md` | Source digest orgs behind `qualifiesAsDigestOrg`, link items via `digest_item_orgs`, revive + schedule the SimpleCRM Notion sync. Shipped. |
| **Phase 2 plan** | `plans/2026-06-13-crm-phase2-web-enrich.md` | Web-enrich every qualifying org (identity + activity w/ provenance) via Grok, add `github_url`, 30-day staleness gate, adversarially-verified backfill + CRM sync. Shipped. |
| **Phase 3 plan** | `plans/2026-06-13-crm-phase3-contacts.md` | Discover people (key org people + notable individuals, incl. org-less/pseudonymous/OSS authors), evidence-gate, dedup via `discovered_contacts`, create Notion Contacts pages without auto-monitoring; deep backfill via Workflow. Engine shipped; full backfill pending (your task). |

**tele-sum's own remaining work is planned separately.** tele-sum is the **upstream producer**; its gaps (e.g. adding a structured `people[]` field to the digest schema/prompt so it stops overloading `org`, mirroring People into its own per-feed Notion DB, backfilling the `repos` channel) live on **tele-sum's side of the swimlane** and are not wire-room-ops work. Do not implement extraction/CRM logic inside tele-sum. The single highest-leverage upstream enabler is tele-sum adding a `people[]` field to `DigestItem` (`tele-sum/src/schemas/digest.py`) + the digest prompt (`tele-sum/src/services/ai.py`); if/when that lands, wire-room-ops could read `summaries.entities->items[].people` directly instead of paying for the Grok web_search round-trip — but that is a producer change to coordinate, not something you do here.

---

## 9. Future candidates (beyond Phase 3)

From the design spec's out-of-scope list:

- **The `🔮 Associated Opps` relation** (opportunities pipeline) — untouched.
- **Bidirectional CRM editing** (Notion edits flowing back into `org_profiles`) — Postgres remains the source of truth; the CRM is downstream.
- **Merging/normalizing the existing grant orgs** beyond what `dedup` already does.
