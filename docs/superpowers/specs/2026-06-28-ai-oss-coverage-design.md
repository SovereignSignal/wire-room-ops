# AI/OSS Discovery Coverage — Design Spec

**Date:** 2026-06-28
**Status:** Approved design, pre-implementation
**Origin:** AI/OSS recall audit (2026-06-27). Audit artifacts: session scratchpad (`corpus.json`, `groundtruth.json`, `final-audit.json`). See also memory `grant-wires-next-priorities` (2026-06-27 entry).

## 1. Context & motivation

A recall audit measured how many real, currently-open AI/OSS funding opportunities our pipeline actually ingests:

| Wire | Recall | Approved-yield |
|------|--------|----------------|
| AI | **45%** | 25% |
| OSS | **58%** | 28% |
| Crypto (control) | 71% | 24% |

Method: 149 web-enumerated real opportunities matched against the full `scan_entries` corpus (7,635 rows) with LLM adjudication of ambiguous matches. The crypto control (71% vs a historically-cited ~88%) shows the method is **conservative**, so AI/OSS are lower bounds. **The AI gap did not close** after the source-feeds lane's first ~2 weeks.

Root cause (71 confirmed misses, by announce channel): funders' **own sites (36)**, **EA Forum / LessWrong (11)**, EU Funding & Tenders portal (5), AISafety.com / EA-Opps / 80k boards (6), Grants.gov (2), SAM.gov (2), GitHub/ATS/newsletters (~9). Critically, **several existing AI feeds are leaky, not just sparse** — they run but under-deliver.

## 2. Goals / Non-goals

**Goals**
- Raise AI and OSS recall by (a) fixing leaky existing feeds and (b) adding own-site funder monitoring.
- Do it on the existing engine — no new lane, cron, or infrastructure.
- Preserve queue precision (no increase in operator noise).

**Non-goals**
- No changes to the classifier / precision pass / decided-recheck logic.
- No new schedule type or Claude routine (fold into the existing daily source-feeds pass).
- No auto-approval; everything still lands in the review queue.
- No crypto feed changes (crypto was control-only).
- Nothing on the output/Substack side.

## 3. Architecture

All work is additive registry config + small handler tweaks in `src/services/source-feeds.ts`. Engine recap (unchanged):

- Fetch methods: `rss` | `rest_json` | `graphql` | `github_csv` | `scrape` (Firecrawl + Grok LLM-extract, `fetchScrape()` at source-feeds.ts:327).
- Per-source watermark in `app_state` (`feed:seen:<key>`, net-new by normalized URL, rolling cap 800).
- Each source isolated (per-source try/catch); a source failing never blocks others.
- Every item flows through `runDailyIntake` (`scan_source='feed'`) → precision pass → URL/name dedup → decided-recheck → classifier (GRANT/NEWS/EXPIRED/NOISE + score + wire scope gate) → queue/archive.
- Runs in the existing daily source-feeds pass (folded into `daily-digest`); manual trigger `POST /api/scan/feeds/run`; dry-run (no DB writes) via `src/scripts/source-feeds-dryrun.ts`.

Because all new items pass the existing precision/dedup/classifier gates, adding sources can only **raise recall** (plus some archived noise) — it cannot lower queue quality.

## 4. Phase 1 — Fix the leaky AI feeds

### 4.1 EA Forum tag broadening + LessWrong/Alignment Forum source
- **Current:** `ea-forum-funding` (graphql) queries a single tag `be4pBryMKxLhkmgvE`. This missed 11 EA-Forum/LessWrong-announced opportunities.
- **Change:**
  - (a) Add additional EA Forum tag-scoped sources (distinct `key` per tag for clean watermarks + independent enable/disable). Resolve tag IDs at implementation via the EA Forum GraphQL `tags`/`tagBySlug` query for these named tags: *Funding opportunities* (current), *Opportunities (to take action)*, *Request for proposals*, *Funding diversification*. Keep tag-scoped queries (not broad search) to preserve precision.
  - (b) Add a `lesswrong-funding` source using the same Forum-Magnum GraphQL shape against `https://www.lesswrong.com/graphql` with the relevant funding/opportunity tag (resolve tag ID at implementation). Optionally Alignment Forum (`https://www.alignmentforum.org/graphql`).
- **Mechanism:** `graphql` method already supports this; pure registry additions. Document resolved tag IDs in a registry comment.
- **Acceptance (dry-run):** these audit misses reappear — SFF Speculation Grants, Longview Extreme-Power RFP, Manifund AI-Safety Regranting, GovAI US AI Policy Program, ARENA 9.0, EleutherAI SOAR, Horizon AI Policy Workshop, Better Futures Fellowship, EAIF, Longview Emerging Challenges Fund, Macroscopic Ventures.

### 4.2 OTF funds scrape
- **Current:** `otf-news` reads the blog RSS (`opentech.fund/feed/`); OTF's actual fund calls live on fund pages, not the blog — so Rapid Response + Internet Freedom Fund were missed.
- **Change:** add `otf-funds` (method `scrape`, endpoint `https://www.opentech.fund/funds/`, `scrapePrompt` guiding extraction of open funds). Keep `otf-news` as a complementary signal.
- **Acceptance:** OTF Rapid Response Fund + Internet Freedom Fund extracted in dry-run.

### 4.3 Grants.gov widening
- **Current:** `grants-gov-ai` POSTs search2 with `rows: 30`, single `keyword: 'artificial intelligence'`, `oppStatuses: forecasted|posted`; `extract()` drops off-beat titles/agencies via `GRANTS_GOV_OFFBEAT_TITLE`/`_AGENCY` (source-feeds.ts:417-418). Missed DARPA BTO Office-Wide BAA (HR001126S0003) and NSF Trailblazer (NSF 26-502).
- **Diagnosis first:** the off-beat title regex does **not** contain "biological", so it is **not** dropping DARPA BTO — the misses are a `rows`/`keyword` coverage problem (these opps don't surface for the single "artificial intelligence" keyword within 30 rows).
- **Change:** raise `rows` (30 → 100); issue multiple keyword searches and merge+dedup by opportunity id: `artificial intelligence`, `machine learning`, `foundation models`, `AI safety`. (search2 takes one keyword per call → loop the calls in the source's `extract`/fetch path or add sibling registry entries per keyword.) Re-confirm the off-beat filter does not drop any of the specific misses; only narrow it if a real miss is shown to be filtered.
- **Acceptance:** DARPA BTO BAA + NSF Trailblazer surface in dry-run; medicine/agriculture noise still filtered.

### 4.4 Manifund via Firecrawl
- **Current:** `manifund` (rest_json) disabled — Vercel bot-check 429s the direct API from datacenter IPs. The note "EA Forum covers it" is false in the data (Manifund regranting was a confirmed miss).
- **Change:** re-enable via method `scrape` against a Manifund page that lists AI-safety grants/regrants (e.g. `https://manifund.org/causes/ai-safety`), with a `scrapePrompt`. Firecrawl renders the page and bypasses the bot-check.
- **Acceptance:** Manifund AI-safety regranting items extracted in dry-run.

## 5. Phase 2 — Named-funder own-site monitor

### 5.1 Mechanism
Add `scrape`-method registry entries per high-value funder grants page; per-funder `scrapePrompt`; watermark handles net-new. No new code path (reuses `fetchScrape`).

### 5.2 Candidate funder set (verify before enabling)
- **AI:** Coefficient Giving (apply-for-funding index), Longview (funds/RFPs index), SFF (rolling/speculation), AI2050 / Schmidt Sciences (fellows + open RFPs), Cohere Labs (research grants), OpenAI (forms index — researcher access / cybersecurity grant), JST (funding portal).
- **OSS:** Sovereign Tech (funds / fellowship / resilience / standards), FUTO (grants), FreeBSD Foundation (grants), Open Source Collective (funds), GitHub (Sponsors / Fund), Open Source Pledge, thanks.dev, Tidelift (Lifter), Polar, Drips, Erlang/Perl/Ruby Central foundation grants.

### 5.3 Per-source verification gate (required)
Before enabling each source, run a dry-run scrape and **keep it only if** it yields ≥1 discrete, identifiable opportunity with a stable per-item URL. **Skip** evergreen catalogs, write-only application forms, and single-static "fund" pages with no per-item URL (prior lesson: these create dupes/noise; better served by a future Firecrawl change-monitor). Log each skip with its reason (no silent drops).

### 5.4 Verification is a Workflow
The 5.2 verification is a natural fan-out: one agent per candidate funder (scrape → judge keep/skip + draft `scrapePrompt`). Produces the enable/skip list + per-source config.

## 6. Phase 2b — staged (after Phase 2 lands ≥2 verified sources)
Same `scrape`/API pattern + the 5.3 gate: AISafety.com funding board, EA Opportunities board, 80,000 Hours board; EU Funding & Tenders portal (search API — ERC/EIC/Digital Europe); SAM.gov (ARPA-H). Defer if verification yields low signal/high noise.

## 7. Cadence, cost, precision
- **Cadence:** no new schedule; all sources run in the existing daily source-feeds pass folded into `daily-digest`. First run per source can be kicked manually via `POST /api/scan/feeds/run`.
- **Cost:** ~+15 Firecrawl scrapes + a few Grok extracts per *daily* run; watermark bounds classification to net-new. Estimated < $1/day added; monitor via the digest "API Costs (24h)" recap.
- **Precision:** unchanged — all items pass precision pass → decided-recheck → classifier (+ wire scope gate). Cross-lane dedup already proven (feed items dedup against forum-lane entries).

## 8. Testing
- **Unit:** extend `tests/source-feeds.test.js` for any new `extract()`/parser branches and `titleAllow`/`titleBlock` regexes. (LLM-extract `scrape` sources are validated by dry-run, not unit tests.)
- **Dry-run:** `src/scripts/source-feeds-dryrun.ts` (no DB writes) per new/changed source via `railway run npx ts-node ...`; acceptance criteria per §4/§5.
- **Enum/constraint safety:** `scan_source='feed'` already exists; **no enum or CHECK-constraint changes** (avoids the known constraint-sync bug class).

## 9. Rollout & success metric
- Order: Phase 1 (commit → deploy → dry-run-verify each fix) → Phase 2 (verify-then-enable per source) → Phase 2b.
- **Success metric:** re-run the audit harness on a targeted subset (the 71 misses + a fresh sample) after ~1 week live. **Target: AI recall ≥ 65%, OSS recall ≥ 70%** (from 45% / 58%), measured the same way. The harness (corpus pull + ground-truth + matcher + verify) is reusable from this session's scratchpad scripts.

## 10. Risks & mitigations
- **Own-site scrape noise** → §5.3 verification gate + downstream precision/classifier.
- **Firecrawl failures / cost** → per-source isolation, watermark net-new, cost recap monitoring.
- **EA/LW tag drift** → resolve tags by slug at implementation; record resolved IDs in registry comments.
- **Over-fetching** → `maxItems` cap + watermark.
- **Scope creep on the funder list** → §5.3 gate keeps only sources that demonstrably yield discrete dated opps.
