# AGENTS.md - AI Agent Context for Wire Room Ops

> **Canonical reference**: See `CLAUDE.md` for the comprehensive, up-to-date AI context file. This file provides a concise summary for agents that need quick orientation.

## Project Overview

**Wire Room Ops** is a Node.js/TypeScript backend pipeline and admin dashboard for an intelligence-to-distribution system. It discovers entries from multiple sources (X, web, forums, Reddit, HN, Telegram), processes them through an intake pipeline (parse, dedup, LLM classify + score), queues them for operator review, and distributes approved entries across configured channels.

Deployment-agnostic: brand, audience, and content type are env-var driven via `src/config/brand.ts`.

## Two-Repo Architecture

| Repo | Role |
|------|------|
| `wire-room-ops` (this repo) | Backend pipeline + admin dashboard |
| `the-wire-room` | Public-facing Next.js website |

Both share the same PostgreSQL database. This repo writes; the website reads `scan_entries WHERE status = 'approved'`.

## Key Files

| File | Purpose |
|------|---------|
| `src/server.ts` | Express routes (~80+ API endpoints) |
| `src/config/index.ts` | Env vars; only 4 truly required (DATABASE_URL, NOTIFICATION_EMAIL, PRIVY_APP_ID, PRIVY_APP_SECRET) |
| `src/config/brand.ts` | Deployment-agnostic brand config |
| `src/db/index.ts` | All Postgres queries |
| `src/jobs/scan-execution.ts` | Scan orchestrator (routes to Grok/Perplexity per tool_type) |
| `src/jobs/daily-intake.ts` | Intake pipeline (dedup -> classify -> queue) |
| `src/services/classifier.ts` | LLM classifier (GRANT/NEWS/EXPIRED/NOISE + quality score) via Grok |
| `src/services/intake.ts` | 4-strategy parser + sanitizeResult() |
| `src/services/distribution.ts` | Multi-channel distribution orchestrator |
| `src/services/anthropic.ts` | Claude API (summarization, prompt review) |
| `src/services/grok.ts` | Grok API (summaries + scan execution) |
| `src/services/perplexity.ts` | Perplexity API (deep web research scans) |
| `src/services/api-provider.ts` | DB-backed API key management with env var fallback |
| `src/services/operator-signals.ts` | Feedback loop from approve/decline decisions |

## AI Provider Defaults

| Provider | Default Model | Purpose |
|----------|--------------|---------|
| Grok | `grok-4.20-beta-0309-non-reasoning` | Summaries, classification, scan execution |
| Claude | `claude-opus-4-1-20250805` | URL summarization, prompt review |
| Claude Sonnet | `claude-sonnet-4-6-20250627` | Distribution post generation |
| Perplexity | `sonar-pro` | Deep web research scans |

All API keys can be managed via the `api_providers` DB table (Settings > API Providers) with env var fallback.

## Pipeline Flow

```
Sources (X scan, web search, Perplexity, forums, Telegram, manual)
  -> Parse (4 strategies) -> Sanitize -> Insert (status: raw)
  -> Gate 1: Completeness -> Dedup (URL + fuzzy name)
  -> Gate 2: LLM Classify + Score (Grok) -> Queue (score >= 40) or Archive
  -> Operator review -> Approve -> Website + Distribution channels
```

## Distribution Channels

Five channel types: **telegram**, **discord**, **slack**, **x** (Twitter), **newsletter** (markdown).
Distribution is manual trigger (not auto-on-approve). Managed via `distribution_channels` table.

## Schedule Types

Three types: `scan-execution`, `forum-scan`, `daily-digest`.

## Dashboard

- React/Vite/Tailwind SPA in `client/` for authenticated routes
- Server-rendered login/error pages in `src/views/`
- Privy authentication with email allowlist

## For Full Details

See `CLAUDE.md` -- it contains the complete file structure, all API endpoints, database architecture, rate limiting, error handling patterns, and common tasks.
