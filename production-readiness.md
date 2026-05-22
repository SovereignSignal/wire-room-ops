# Production Readiness Plan

This document defines what "production ready" means for the current Wire Room Ops service.

## System Mission

Wire Room Ops should reliably:

1. ingest opportunities from scan prompts/forum scans,
2. deduplicate and score entries,
3. keep the queue usable for human review,
4. publish approved entries via `scan_entries.status = 'approved'`.

## Operating Expectations

### Daily Expectations

- At least one successful `scan-execution` run per enabled wire/day.
- Queue review completed once per day.
- Failed runs investigated the same day.

### Quality Expectations

- Duplicate rate should trend stable; sudden spikes indicate prompt drift.
- Queue should be actionable, not flooded with low-signal entries.
- Approval decisions should remain human-in-the-loop.

### Reliability Expectations

- `/health` responds 200.
- `/ready` responds 200 and confirms DB connectivity.
- Scheduler status endpoint reflects real schedule state.
- Build + check pass on every change (`npm run check && npm run build`).

## Hard Requirements Before Going Live

1. All 4 required env vars configured in host (`DATABASE_URL`, `NOTIFICATION_EMAIL`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`). Provider API keys can be configured via env vars or Settings > API Providers.
2. Privy login tested end-to-end with allowlisted user.
3. Email test alert succeeds (`POST /api/test-alert`).
4. At least one scan prompt per active wire tested (`/api/scan/prompts/:id/test`).
5. Manual scan run validated (`POST /api/scan/run`).
6. At least one enabled schedule validated in production.
7. Daily backup/restore process verified (already present via repo workflows).

## Optional Feature Activation

These features are gracefully disabled when their env vars are absent:

| Feature | Required Env Vars | Notes |
|---------|-------------------|-------|
| Telegram channel distribution | `TELEGRAM_BOT_TOKEN` or managed channel credentials | Managed in `distribution_channels`; legacy `distribution_config` is still read for compatibility |
| Telegram intake bot | `TELEGRAM_INTAKE_BOT_TOKEN` | Also set `TELEGRAM_INTAKE_WEBHOOK_SECRET` and `TELEGRAM_INTAKE_ALLOWED_USER_ID` |
| Forum scanning | `FORUM_SCAN_ENABLED=true` | Optionally `DISCUSS_WATCH_API_URL` |
| Perplexity deep web scans | `PERPLEXITY_API_KEY` | For variant P prompts |
| Custom brand/audience | `BRAND_AUDIENCE`, `BRAND_CONTENT_TYPE`, `BRAND_CONTENT_VERB` | Defaults to Wire Room/grants values |
| Quality scoring overrides | `QUALITY_FUNDING_TYPES`, `QUALITY_ACTIONABLE_TYPES` | JSON arrays |
| Forum search term overrides | `FORUM_SEARCH_TERMS` | Comma-separated |
| Per-wire intake keywords | `INTAKE_WIRE_KEYWORDS_{WIRE}` | E.g. `INTAKE_WIRE_KEYWORDS_CRYPTO` |

## Suggested Alerting Thresholds

- `2` consecutive failed scheduled runs for the same schedule -> high-priority alert.
- `0` successful scan-execution runs in last `24h` for enabled wire -> high-priority alert.
- Readiness endpoint returning `503` for >5 minutes -> incident.

## Release Gate (Per Deploy)

Run after deploy:

1. `GET /health` -> 200
2. `GET /ready` -> 200 + `checks.db=true`
3. `GET /api/scheduler-status` -> expected schedules loaded
4. Optional smoke: trigger one scan prompt test

## Known Constraints (Current Architecture)

- Sessions are DB-backed and survive deploys.
- Magic links, download tokens, pending intake selections, rate-limit state, and job progress are in-memory and reset on restart.
- Single-instance assumptions remain in several in-memory components.
- DEV mode auth bypass exists and must remain disabled in production.

## Roadmap for "Hardened" Production

1. Persist rate-limit state, job progress, pending intake selections, and one-time tokens for restart resilience.
2. Add structured logging + request IDs for incident debugging.
3. Add automated smoke test workflow against deployed environment.
4. Add dashboard metrics panel for run success rate and queue throughput.
