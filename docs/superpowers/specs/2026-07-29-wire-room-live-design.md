# The Wire Room — Live Public View: Design Spec

**Date:** 2026-07-29
**Status:** Design complete. Blocked on owner decisions (see Open Questions).
**Review surface:** a private Notion page in the operator's workspace
**Nothing is built yet.**

---

## Origin

Prompted by [Price Foulger's post](https://x.com/pricefoulger/status/2080851734730342514) — a roofing
contractor mocking up his CRM as an isometric tycoon game with AI staff doing real work. 985k impressions,
2,417 bookmarks, on three AI-generated stills.

The premise: **wire-room-ops is a better candidate for the idea than a roofing company is.** Price has to
invent a world model; a CRM does not natively know what a house is spatially. Wire Room Ops already has one
as normalized rows.

`scan_entries.actioned_by` is the tell. It exists for the audit trail — `agent:stringer`,
`agent:daily-scan`, `program-gate`, `decided-recheck`, `system:dedup-review` — and is already a cast list.
Only the renderer is missing.

| Rally (roofing) | Wire Room Ops equivalent | Status |
|---|---|---|
| Houses on the map | `watch_surfaces` — 1,136 rows, `tier`, `last_checked_at`, `last_changed_at`, `failure_streak`, `items_found_30d` | seeded |
| Pipeline funnel | `scan_entries.status`: raw → deduped → queued → approved → distributed | already a funnel with counts |
| AI Team (Riley/Devi/Wilem) | Stringer, classifier, dedup, program-gate, decided-recheck, org-enricher | `actioned_by`, `action_reason` |
| Company Health / Reputation | run-ledger status band, failure streaks, approve rate | digest computes it |
| `LEVEL 6 · 18/24` | `weekly:week-number`, approvals, orgs enriched, surfaces covered | in `app_state` |

---

## Locked decisions

| # | Decision | Chosen | Rationale |
|---|---|---|---|
| 1 | Primary job | **Public showpiece / BD asset** | Not an operator tool. Shareable artifact for inbound; future public face of grants.watch. |
| 2 | What is public | **Only what already published** | Named items only after a successful Telegram send. Upstream is anonymous motion. |
| 3 | The world | **The Wire Room — one interior** | Smallest art surface; name-native. Beat a Factorio-style refinery and an isometric watch-city. |
| 4 | Art direction | **Night Shift, 32-bit pixel art** | Existing brand as a room: `#05070d` deep space, `#00eaff` cyan glow, one amber lamp at the human desk. *Revised 2026-07-30* — a painted-cinematic pass read as generic concept art; the retro-game aesthetic reads as a **game**, which is the whole reference point, while the palette keeps it clearly not Price's. |
| 5 | Liveness | **Ambient loop + live break-in** | The desk fires a few times a day; strictly-live is a still photograph most of every afternoon. |
| 6 | Image production | **RESOLVED — OpenAI `gpt-image-2`** | Key stored in a local key file outside the repo; a local helper holds models, generate/inpaint patterns, and troubleshooting. Ten renders ≈ $2.50. |
| 7 | The cast | **3 screen-bank stations + 1 human** | *Revised 2026-07-30* — machinery and a conveyor read as a factory, which misrepresents a software system. Now a monitoring room: screen banks as stations, a glowing floor data-channel carrying packets, glass back wall onto a night city, and a multi-monitor desk for the one human. No faces to drift. |
| 8 | Architecture | **One-way snapshot pipe** | Settled by the brain law: one-way pipes into a lane; trust flows from location. |

---

## 1 · System shape

| Piece | Where | What it is |
|---|---|---|
| **Producer** | `wire-room-ops`, new file `src/jobs/public-snapshot.ts` | Runs on the existing 5-minute `process-raw` interval. Six narrow queries → one ~8 KB JSON → bucket. **No new cron** (honours the fold-don't-multiply rule). |
| **Consumer** | New repo `wire-room-live` | Vite + TypeScript, no framework, plain CSS. Fetches the JSON, animates the room. Zero secrets, zero backend. |

**No React**, despite the dashboard using it: one scene, ~20 moving elements, driven by a
`requestAnimationFrame` loop. Virtual-DOM reconciliation buys nothing and fights animation control, and
first-paint speed matters for a link tapped from X. Keeps the repo small enough to open-source.

**Consequence of choosing the snapshot pipe:** a read-only Postgres role is **no longer needed**. The
publisher runs inside wire-room-ops on the connection it already holds; the public tier never touches
Postgres.

---

## 2 · The snapshot contract

The security boundary, and therefore the most important artifact in the project.

```jsonc
{
  "v": 1,
  "generatedAt": "2026-07-29T02:41:00Z",
  "windowHours": 24,

  "desk":     { "wires": ["crypto","ai","oss"], "surfacesWatched": 1136,
                "weekNumber": 30, "uptimeDays": 61 },

  "funnel":   [ { "stage":"scanned",   "count":312 },   // COUNT(*) GROUP BY status
                { "stage":"duplicate", "count":143 },   // no row content, ever
                { "stage":"archived",  "count": 68 },
                { "stage":"review",    "count": 41 },
                { "stage":"published", "count": 18 } ],

  "stations": [ { "id":"stringer",   "state":"idle", "lastRunAt":"…",
                  "itemsTouched":34, "nextRunAt":"…" },
                { "id":"dedup",      "state":"idle", "dropRate":0.46 },
                { "id":"classifier", "state":"running" } ],

  "coverage": { "total":1136,
                "byFreshness": { "fresh":412, "aging":520, "dark":204 },
                "byWire":      { "crypto":611, "ai":298, "oss":227 } },

  "events":   [ { "at":"02:14:05Z", "kind":"run",     "station":"stringer", "n":34 },
                { "at":"02:16:41Z", "kind":"dedup",   "n":6 },
                { "at":"02:19:02Z", "kind":"queue",   "n":4 },
                { "at":"02:33:18Z", "kind":"publish",
                  "item": { "name":"NLnet Commons Fund", "amount":"€50k",
                            "wire":"oss", "url":"https://t.me/…" } },
                { "at":"02:38:55Z", "kind":"archive", "n":3 } ]
}
```

> **The entire data-safety model is one sentence:** only `kind:"publish"` may carry an `item`, and only for
> rows that already have a successful `distribution_logs` Telegram send — i.e. already public.

Enforced three ways:

1. **Explicit construction.** The mapper builds output object literals field by field. **Never spread a DB
   row** — that is the mechanism by which every accidental leak happens.
2. **Exhaustive field allowlist:** `name`, `amount`, `wire`, Telegram permalink.
   Excluded by design: `description`, `quality_score`, `classification`, `metadata.curator`,
   `operator_route`, `actioned_by`, `action_reason`, `org_id`, and anything from `api_usage_log` or
   `discovered_contacts`.
3. **Leak test.** Fixtures seeded with *poisoned* sensitive values (fake contact email, fake
   `operator_read`, fake decline reason); assert none appear anywhere in the serialized snapshot. Runs in CI.

### Why the bar is this high

The shared Postgres holds `discovered_contacts` (real people's names and contact details),
`org_profiles.operator_read` (the BD-lens read on what gap an outsider could serve — the consulting angle,
in a text column), decline reasons, `api_usage_log` costs, and `api_providers` credentials.

Three services already write to that database. A public reader is a fourth consumer at a completely
different trust level, so the boundary cannot be "query carefully with a `WHERE` clause" — one forgotten
`SELECT *` inside a JOIN leaks a person's email.

---

## 3 · The replay engine

```
fetch snapshot ──→ normalise events to a 0..1 timeline ──→ 24h compressed to ~90s loop
      ↑                                                          │
      │ poll 60s                                          spawn item sprites,
      │                                                   drive station states
      └── new events? ── yes ──→ BREAK IN: badge → LIVE, play at real scale, resume
```

**Open honesty call (needs sign-off).** Events are bursty — they cluster around scheduled runs and leave
long dead gaps. Replayed at literal compressed scale you get a three-second flurry then eighty seconds of an
empty room, which defeats the point. So the tape **preserves order, grouping and counts but evens out the
gaps**, and the badge reads "replaying the last 24 hours" rather than implying real time. A timelapse that
skips dead air.

If literal timing is preferred even when that means long stillness: a two-line change now, a rewrite later.

---

## 4 · Failure behaviour

The page must never look broken; a broken showpiece is worse than none.

| Failure | Behaviour |
|---|---|
| Snapshot fetch fails | Keep animating the last good one; badge → `CACHED`. No error UI. |
| Snapshot older than 30 min | Badge shows the real timestamp instead of `LIVE`. |
| Publisher throws in wire-room-ops | Logged and **folded into the digest's existing anomaly derivation** — surfaces in the morning email via the run-ledger machinery already built. |
| Schema version mismatch | The `v` field guards it; client refuses the payload, keeps last good. |
| Art assets missing or slow | **The SVG scene renders instead.** The brainstorm prototype becomes the degraded mode and the dev-mode scene, so the page is never blank while a 2 MB PNG loads. |

---

## 4a · Anchor maps — added 2026-07-30 after prototyping

Overlays are positioned in percentages against **one specific render**. Different backplates need
genuinely different coordinates, so positions are **data, not CSS**: one `ANCHORS` entry per backplate,
holding the two panel boxes (with a skew to match the isometric plane), the floor channel as a
**polyline**, the grate and desk points, station positions and label positions, and the ticker width.

Two things this shape buys:

- **Arc-length parameterisation** along the polyline, so packets move at constant speed through bends.
  A straight-line path was wrong for both plates — one channel descends off the bottom edge entirely.
- **A verification test.** Sample the backplate PNG under each anchor and assert it's still valid:
  panel regions must read dark (mean luma < 40, bright pixels < 5%) or the overlay is sitting on lit
  artwork; every channel point must have strong cyan within ±14px or packets are drifting over bare
  floor. Both plates currently pass 18/18 channel points. Regenerate the room → re-run the check →
  fail if a panel stopped being empty. This is the regression test that keeps art and overlay in sync,
  and it is cheap, deterministic, and needs no browser.

> **Prototype note.** A first pass collapsed all item fates into one branch whose leading condition
> (`p <= cut`, with `cut = 1.0` for publishes) always matched, making the desk-approach unreachable —
> publishes silently rode the channel off the end and never flared. Each fate now owns its exit point
> and target explicitly. Unreachable code of this kind never throws; it surfaces only as "the animation
> looks off", which is an argument for the visual regression check above.

## 5 · Tests

- **Leak test** — poisoned fixtures, assert absence. The one that matters most.
- **Schema validation both sides** — producer asserts before write, client validates after fetch. A
  malformed snapshot never reaches the animator.
- **Column-contract test** in wire-room-ops — fails if a queried column is renamed. Same spirit as
  `tests/enum-lockstep.test.js`, which exists because multi-writer drift crash-looped production 3× in
  June 2026.
- **Replay unit tests** — timeline normalisation, minimum spacing, loop wrap, break-in.
- **Item-fate coverage** — assert every fate in `FATE` reaches its terminal state (grate or desk).
  This is the test that would have caught the unreachable publish branch.
- **Anchor verification** (§4a) — panel darkness and channel-point cyan, sampled from the PNG.
- **Funnel arithmetic** — stage counts reconcile against source aggregates.
- **Layout smoke** — three viewports, assert no horizontal overflow.

---

## 6 · Scope

**In:** the scene; funnel board; three stations + human desk; coverage aggregate; event replay with live
break-in; published items named and linked to Telegram; responsive; SVG fallback.

**Out, deliberately** (all additive later, none blocks shipping): timeline scrubbing; clicking a station for
its run log; wire filters; coverage zoom; levels/streaks/milestones; launch video; grants.watch integration;
**any interactivity at all** — v1 is a thing you watch.

---

## 7 · Art pipeline

Four stacked layers; only the top two ever change.

| Layer | Contents | Cost |
|---|---|---|
| 1 · Painted backplate | Walls, window, city outside, floor, desks, dark monitor shells, lamp, scrap bins, empty frames for board + coverage panel | generated once |
| 2 · Light | Screen bloom, amber lamp pool, window lights. Split out to breathe, dim on idle, flare green on publish | live, pure CSS |
| 3 · Sprite actors | 3 machines + human, ~3 frames each; travelling item in 4 states; bin fill states | generated once |
| 4 · Data | Every number, label, board bar, coverage dot, ticker line. Real DOM text | live, the whole system |

The Monkey Island / Disco Elysium approach: a fixed painted backdrop with a handful of actors on top is why
those look painted rather than modelled.

**What makes it affordable** is one interior with a bolted-down camera — no tileset, no walk cycles (nothing
walks), no second location, no lighting variants. Seven files, not seven hundred.

### The consistency problem

Image models cannot reliably draw a character sheet matching a background they generated separately, and
that mismatch is what makes most AI-assembled games look wrong. So we don't ask them to: **generate the room
with the machines already in it, in one pass**, so lighting and style match by construction. Then cut the
figures out as sprites and repair the holes with a masked edit. Nothing walks, so three subtle frames each
suffices.

### Image model assessment

No image generation is reachable from this machine — no local image tooling, no ImageMagick, no local
Ollama. Only Perplexity, Parallel, Sakana keys are wired.

| Option | Assessment |
|---|---|
| **OpenAI `gpt-image-1`** — first choice | Obeys "leave this rectangle empty" (critical: board + coverage panel must be blank for DOM overlays) and supports **masked inpainting**, which is how sprite-cut holes get repaired. The step that makes the layer trick work. |
| Google Gemini / nano-banana | Best character consistency and instruction-based editing. Right tool if a fourth station is added later without regenerating the room. |
| xAI (key already exists) | Works, costs nothing new, but weakest layout obedience and no masked editing — hole repair becomes manual (~1 extra hour). |
| Higgsfield | Checked on request. Developer API with FLUX text-to-image + image-to-video, SDKs, webhooks; API gated to specific tiers, plans $15/$39/$99 per month on non-rolling credits. **Not recommended for the build** — no masked inpainting, FLUX unreliable at reserving blank regions. **Worth it for the launch video**, which is its actual specialty. |

---

## Open questions

1. **Replay timing** (§3) — approve evening-out the gaps, or insist on literal compressed timing?
2. **Hosting** — recommendation: Cloudflare Pages for the site (free, global CDN, absorbs a viral spike
   without touching operational infrastructure), snapshot to a Railway bucket or R2 with public read.
   Railway can host both, but a static service is not a CDN and this page's job is surviving being shared.
3. **Domain** — subdomain of `sovereignsignal.com`, or is `thewireroom.xyz` still owned? (Its Railway
   service was deleted 2026-07-02; domain status unconfirmed.)
4. **Repo name** — proposed `wire-room-live`. Note `the-wire-room` is taken by the retired front-end.

## Needed from the owner

- ~~Image-gen key~~ — **done.** Stored in a local key file outside the repo, chmod 600. Key was pasted into
  a transcript when handed over, so treat as exposed and rotate when convenient; only the value in
  `key.env` changes.
- **Sovereign Signal mark as SVG** for the wall sign; confirm `#00eaff` + Orbitron is still the identity.
- **Anything else that belongs in the room** — poster, plaque, whiteboard.
- ~~Approval for one test render~~ — **gate passed 2026-07-30.** Backplate **32-BIT B**
  (`room-v5-b.png`) selected. Ten renders, ≈ $2.50.

## Build sequence once approved

1. ~~Commit this spec.~~ / ~~Test render gate.~~ — both done.
2. Write the implementation plan (phased, with checkpoints).
3. Producer in wire-room-ops: projection, leak test, column-contract test.
4. Scaffold `wire-room-live`; port the prototype replay engine; wire it to a real snapshot.
5. Finalise the backplate at full resolution, build the anchor map for it, add the anchor
   verification test.
6. Cut the light layer and any sprite states; composite; ship behind a preview URL.
7. Launch post, optionally with a Higgsfield video.

## Prototype assets (2026-07-30)

Live in the session scratchpad, to be moved into the new repo:

| File | What it is |
|---|---|
| `room-v5-b.png` | **Chosen backplate** — 32-bit pixel art, 1536×1024 |
| `room-v5-a.png`, `room-v4-a.png`, `room-v4-b.png` | Alternates kept for reference |
| `prompt-room-v5.txt` | The winning prompt — reuse for regeneration at higher resolution |
| `demo3.html` | Working replay engine over all four plates, with the `ANCHORS` map |
| `build_demo3.py` | Generator for the above |
