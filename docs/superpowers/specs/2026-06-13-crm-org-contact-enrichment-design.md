# CRM Org & Contact Enrichment — Design Spec

**Status:** approved design (2026-06-13), pending Phase 1 implementation plan
**Home:** wire-room-ops (the existing org/CRM owner)
**Approach:** A — extend the existing org pipeline rather than build new

## Goal

Tie tele-sum's content (grant wires + the new digest wires repos/models/claw) to the operator's Notion CRM (`Orgs` + `Contacts`), and keep those records enriched and current. Delivered as a phased program: **(1) link + revive sync → (2) web-enrich orgs → (3) contacts**, designed as one arc, built phase by phase.

## What already exists (the rails we extend)

- **`org_profiles`** (210 rows) — rich org store: `name, slug, description, website, twitter, wires[], tags[], aliases[], entry_count, total_funding, first_seen, last_seen, org_type, source_type, tier, avg_quality_score, propensity_score, enriched_at, parent_org_id, landscape_status, primary_domain, relationship_context, watch_priority, current_wedge, recommended_action, last_signal, last_landscape_review`. (No `github_url` column yet — Phase 2 adds one.)
- **`scan_entries.org_id`** — grant content is already linked to `org_profiles`. **`org_weekly_snapshots`** — per-org activity time-series.
- **`org-extractor.ts` / `org-enricher.ts` / `org-merge.ts`** — extraction, enrichment, dedup/alias/merge logic; admin endpoints `/api/admin/{enrich-orgs,dedup-orgs,clean-orgs}`.
- **`notion-sync.ts` + `integration_config`** — a configured sync `provider='notion', name='SimpleCRM - Notion', enabled=true`, targeting `database_id=<ORGS_DATABASE_ID>` (`Orgs`) and `contacts_database_id=<CONTACTS_DATABASE_ID>` (`Contacts`), with its own `notion_token`. **Last synced 2026-05-13** — effectively stopped, and grant-only.

**The gaps:** digest content (repos/models/claw) is intentionally excluded from `scan_entries` (the summary-sync guardrail), so its orgs are never extracted, linked, or synced; the CRM sync is stale; enrichment is shallow.

### CRM schemas (sync targets)

- **`Orgs`**: `Name`(title), `Type`(select), `Website`/`Twitter`/`GitHub URL`/`Forum URL`/`Blog URL`/`Grants Program URL`/`Application URL`/`Career Page URL`/`RSS Feed URL`(url), `Relationship`/`Tier`/`Status`(select), `Source Type`/`Tags`/`Wire`(multi_select), `Propensity Score`/`Quality Score`/`Items Sourced`(number), `Last Checked`(date), `Action(s)`(rich_text), `Contacts`(relation), `🔮 Associated Opps`(relation).
- **`Contacts`**: `Name`(title), `X`(url), `Source`/`Status`/`Wire`(select), `Evidence`/`Role`/`Program`(rich_text), `Org`(relation → Orgs).

## Architecture

All logic lives in **wire-room-ops**. tele-sum stays the content producer; it already exposes grant orgs in `summaries.entities.orgs` and digest orgs in `summaries.entities.items[].org`. wire-room-ops already reads `summaries` (via summary-sync), so we add a **digest-org sourcing path** beside the existing grant path, both feeding `org_profiles` → the single **SimpleCRM Notion sync**. One writer to the CRM; no new deployable.

```
tele-sum summaries ─┬─ grant orgs (entities.orgs)  ──► [existing] scan_entries.org_id ─┐
                    └─ digest orgs (items[].org)   ──► [new] digest-org sourcing ───────┤
                                                                                        ▼
                                              org_profiles  ──► [Phase 2] web enrichment
                                                     │                  │
                                                     ▼                  ▼
                                          SimpleCRM Notion sync ──► Orgs + Contacts
```

---

## Phase 1 — Link everything + revive the sync (first build slice)

**1a. Source digest orgs.** A new step reads tele-sum digest summaries (`entities.profile='digest'`, wires repos/models/claw), extracting org mentions from `items[].org`, normalizing and matching against `org_profiles` via the existing dedup/alias logic.

**1b. Quality bar (auto-create).** A mention becomes an `org_profiles` row only if it is a real organization:
- **Reject** bare `owner/repo` handles (`crafter-station/petdex`, `orhun`) — they remain item tags, never CRM orgs.
- **Accept** a named org that clears one of: mentioned in **≥2 distinct content items**, OR has a resolvable site/GitHub derivable from the content.
- Each qualifying org records its `wire` (so the CRM `Wire` field separates AI-lab orgs from grant funders).
- Bar lives in a pure, unit-tested function `qualifiesAsOrg(mention, context)`.

**1c. Link + counts.** New table **`digest_item_orgs`** (`summary_id int`, `item_index int`, `org_id int → org_profiles.id`, unique on `(summary_id, item_index, org_id)`) records which digest item mentions which org — the digest analogue of `scan_entries.org_id`. `org_profiles.entry_count` / `last_seen` / `wires[]` are kept current from both grant and digest links. These drive the CRM's `Items Sourced` and `Last Checked`.

**1d. Revive the sync.** Re-enable `SimpleCRM - Notion`, run it on the scheduler (alongside the existing jobs), and push all orgs (grant + digest) to `Orgs`. Intended `org_profiles → Orgs` mapping (finalized against `notion-sync.ts` in planning):

| org_profiles | Orgs |
|---|---|
| name | Name |
| website / primary_domain | Website |
| twitter | Twitter |
| (Phase 2) github_url | GitHub URL |
| org_type | Type |
| wires[] | Wire |
| tags[] | Tags |
| tier | Tier |
| entry_count | Items Sourced |
| last_seen | Last Checked |
| propensity_score | Propensity Score |
| avg_quality_score | Quality Score |
| landscape_status / recommended_action | Status / Action(s) |
| relationship_context | Action(s) (appended, with provenance) |

**Rollout:** backfill orgs from the already-ingested digest summaries (the 103 backfilled items), revive + schedule the sync, verify orgs appear in `Orgs` with correct Wire / Items Sourced / Last Checked. Idempotent re-runs.

---

## Phase 2 — Web-enrich every qualifying org

For each qualifying `org_profiles` row, enrich via wire-room-ops' existing providers (Grok x_search/web_search, Perplexity, Firecrawl):
- **Identity:** official `website` / `primary_domain`, `twitter`, **`github_url`** (new column — small migration), 1–2 sentence `description`, `org_type`, `tags[]`.
- **Activity profile:** `last_signal` (most recent ship/announcement, from feeds + web); optionally `current_wedge` / `recommended_action` for higher-tier orgs.
- **Provenance & freshness:** stamp `enriched_at`; record the source of web claims in `relationship_context` (nothing unattributed). Re-enrich only when `enriched_at` is stale (>30 days).

**Execution:** a fan-out across ~210+ orgs, run as a **workflow** — one enrichment agent per org/batch (fetch → synthesize → write back), with an adversarial check that each field is sourced (not hallucinated) before it touches `org_profiles`/CRM. Enriched fields reach the CRM through the Phase 1 sync. Cost controlled by the quality bar (only qualifiers), batching, and the staleness gate.

---

## Phase 3 — Contacts (individuals)

Discover people from content + web and tie them to their org:
- **Sources:** grant program leads/contacts named in grant content; founders/authors from model & repo items; leadership surfaced during Phase 2 web enrichment.
- **Bar (stricter than orgs — people are higher-stakes):** create a Contact only with concrete **Evidence** — a real name tied to a role/org, ideally with an X handle or profile URL. Bare GitHub handles are not promoted to people unless a real identity is found.
- **CRM mapping:** create/match in `Contacts` (`Name`, `X`, `Role`, `Program`, `Wire`, `Evidence`), set the **`Org` relation** and the reciprocal `Contacts` relation on the org. New contacts land with `Status` flagged for triage (e.g. "Needs Review") — auto-created but owner-reviewable.
- Web-augment contacts (resolve X handle / current role).

---

## Build order, testing, rollout

1. **Phase 1** first — get the CRM current and complete (link + revive sync).
2. **Phase 2** — web enrichment (fan-out workflow; verify a sample before a full run).
3. **Phase 3** — contacts, most carefully gated.

Each phase: pure-function logic (quality bar, normalization, matching, field mapping) is TDD'd with stubbed web/Notion calls; integration verified against the shared DB + CRM; shipped behind the existing admin-endpoint + scheduler pattern; reviewed (spec + quality) before deploy. One design doc (this); a **Phase 1 implementation plan authored now**, Phase 2/3 plans authored when reached.

## Out of scope (for now)

- The `🔮 Associated Opps` relation (opportunities pipeline) — untouched.
- Bidirectional CRM editing (Notion edits flowing back into `org_profiles`) — Postgres remains source of truth; CRM is downstream.
- Merging/normalizing the existing 210 grant orgs beyond what dedup already does.

## To finalize during Phase 1 planning

- Exact `notion-sync.ts` field-mapping code and whether it already handles `Wire`/`Items Sourced`/`Last Checked` or needs extension.
- The `digest_item_orgs` migration + whether digest orgs should also increment the existing `org_weekly_snapshots`.
- Confirm the `SimpleCRM` `notion_token` is valid/current (the sync hasn't run since 2026-05-13).
