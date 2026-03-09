# Wire Architecture

> The intelligence-to-distribution pipeline. Config-driven, operator-agnostic, deployable for any domain.

## Design Principles

**The Operator learns the domain. It ships knowing the system.**

When The Operator is deployed into a new instance, it arrives with complete knowledge of the pipeline — the schema, the flow, the routing rules. It does not arrive pre-loaded with domain expertise. That comes from the end user over time.

Every UNSURE routing decision is a training rep. The Operator watches what the user approves and rejects. Quality scoring weights are tunable per deployment. Over time, The Operator develops domain judgment organically — learning "what's a good crypto grant" the same way it would learn "what's a good consulting lead" in a different deployment.

This is intentional. The same Operator can be dropped into any vertical.

**Config drives behavior. Swap config, get a new instance.**

Scan prompts, source lists, scoring weights, distribution destinations, Telegram channel IDs — all stored in the database, not hardcoded. The engine is identical across deployments. The configuration is what makes one instance a grants wire and another a lead intelligence system.

**The system learns in the open.**

User decisions feed back into quality scoring. Nothing is a black box. The Operator explains its reasoning when routing UNSURE items. The end user understands why things are being approved or rejected.

---

## System Flow

```mermaid
flowchart TD
    subgraph SOURCES["Layer 1 — WireOps: Ingestion"]
        X["X / Twitter\nPrompt-driven xAI scans"]
        WEB["Web Search\nTavily / programmatic"]
        FORUMS["Forums\ndiscuss.watch API"]
        MANUAL["Manual Ingest\nEmail / Telegram forward"]
        CONFIG["Config Layer\nScan prompts · sources · vertical mapping\nSwap config → new instance"]
    end

    subgraph REFINERY["Layer 2 — The Refinery: Processing"]
        INGEST["Ingest Table\nRaw data only — URL, summary, source, vertical, timestamp"]
        DEDUP["Deduplication\nExact URL match + fuzzy name match\nRuns against full canonical DB"]
        SCORE["Quality Scoring\n0–100 based on configurable criteria\nBelow threshold → auto-archive"]
        QUEUE["Editorial Queue\nClean, deduplicated, scored entries\nHandoff point to The Operator"]
    end

    subgraph OPERATOR["Layer 3 — The Operator: Routing"]
        OP["The Operator\nSystem-aware agent\nReads queue · makes routing decisions"]
        SURE["SURE\nHigh confidence\nAuto-publish path"]
        UNSURE["UNSURE\nLow confidence\nRoutes to end user for review"]
        FEEDBACK["Feedback Loop\nUser decisions update quality weights\nOperator learns domain over time"]
    end

    subgraph DIST["Layer 4 — Sovereign Signal: Distribution"]
        DB["Canonical DB\nPer-vertical Postgres tables\nSource of truth"]
        WIREROOM["The Wire Room\nthewireroom.xyz\nPublic live feed across all beats"]
        TG["Telegram Channels\nPer-beat, subscribers self-select"]
        XFEED["X Account\nOne unified feed, all verticals tagged"]
        NL["Weekly Newsletter\nCross-vertical synthesis\nSubstack"]
    end

    subgraph OPS["Layer 5 — Consensus Consulting: Revenue"]
        CONSULT["Grant Programs · Operations · BD"]
        FLYWHEEL["Intelligence from operating programs\nfeeds back into Layer 1"]
    end

    X --> INGEST
    WEB --> INGEST
    FORUMS --> INGEST
    MANUAL --> INGEST
    CONFIG -.->|"configures"| X
    CONFIG -.->|"configures"| WEB

    INGEST --> DEDUP
    DEDUP --> SCORE
    SCORE --> QUEUE

    QUEUE --> OP
    OP --> SURE
    OP --> UNSURE
    UNSURE --> FEEDBACK
    FEEDBACK -->|"updates weights"| SCORE

    SURE --> DB
    DB --> WIREROOM
    DB --> TG
    DB --> XFEED
    DB --> NL

    WIREROOM --> OPS
    CONSULT --> FLYWHEEL
    FLYWHEEL -->|"new intelligence"| INGEST
```

---

## Database Schema (Key Tables)

| Table | Purpose |
|-------|---------|
| `scan_entries` | All ingested entries after dedup + scoring. Status: `queued` → `approved` / `archived` |
| `scan_prompts` | Prompt management per wire/vertical. A/B/C variants, effectiveness metrics |
| `seen_urls` + `seen_names` | Dedup indexes. URL exact match + fuzzy name match |
| `distribution_config` | Where to push approved entries. Per wire × channel (telegram, x, newsletter) |
| `distribution_logs` | What was pushed where, success/fail, external ID |
| `review_queue` | UNSURE items flagged by The Operator for user review |
| `intake_runs` | Pipeline run logs. Ingest count, dedup rate, avg quality per run |
| `channel_configs` | Telegram output channel IDs per wire |
| `schedules` | Scan schedule config per wire |
| `feeds` | Wire/vertical definitions (crypto, ai, oss) |

### Entry Status Flow

```
queued → approved → [distributed via distribution_logs]
queued → archived  (low score, expired deadline, duplicate)
queued → review_queue (UNSURE — needs user decision)
```

---

## Multi-Tenant Deployment Model

The pipeline is designed to be deployed as a unit for any domain:

```
Wire Room Stack
├── wire-room-ops/       Backend: scan pipeline, dedup, scoring, distribution
├── the-wire-room/       Frontend: public-facing wire display
├── WireOps Dashboard    Ops: queue management, pipeline health (Lovable)
└── The Operator         Agent: reads queue, routes, learns from feedback
```

**To deploy for a new domain:**
1. Clone the stack
2. Update `feeds` table with new vertical names
3. Write scan prompts for the domain → insert into `scan_prompts`
4. Set distribution destinations → insert into `distribution_config`
5. Drop in The Operator with system context only — no domain pre-loading
6. Let The Operator learn from user feedback over the first 2–4 weeks

---

## The Operator — System Context

When instantiated, The Operator receives:

- Full schema documentation (tables, columns, status flows)
- Pipeline flow (how data moves from ingest to distribution)
- Config access (can read/write scan prompts, scoring weights, distribution config)
- No domain pre-loading — domain judgment is learned from user decisions

The Operator's job:
1. Read `scan_entries` where `status = 'queued'`
2. For each entry: evaluate against current quality context → SURE or UNSURE
3. SURE → update status to `approved`, trigger distribution
4. UNSURE → insert into `review_queue`, notify user
5. Watch user decisions → update quality calibration

---

## Current Deployment (Sov's Grant Wire)

- **Verticals:** crypto, ai, oss
- **Telegram:** @cryptograntwire, @aigrantwire, @ossgrantwire (via @GrantWireBot)
- **X:** @SovGrantWire (unified, all verticals tagged)
- **Newsletter:** Substack (manual publish from generated drafts)
- **Backend:** Railway (wire-room-ops)
- **Frontend:** thewireroom.xyz (the-wire-room, Next.js)
- **Operator:** SovsClaw (OpenClaw agent, reads DB directly)

---

## Next Deployment (Claw Consulting)

Same stack. Different config. The Operator learns what a good consulting lead looks like from Sov + Nick's approval decisions over the first month.
