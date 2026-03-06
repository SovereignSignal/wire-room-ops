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

1. All required env vars configured in host.
2. Privy login tested end-to-end with allowlisted user.
3. Email test alert succeeds (`POST /api/test-alert`).
4. At least one scan prompt per active wire tested (`/api/scan/prompts/:id/test`).
5. Manual scan run validated (`POST /api/scan/run`).
6. At least one enabled schedule validated in production.
7. Daily backup/restore process verified (already present via repo workflows).

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

- Sessions/tokens/job-progress are in-memory and reset on restart.
- Single-instance assumptions are baked into several in-memory components.
- DEV mode auth bypass exists and must remain disabled in production.

## Roadmap for "Hardened" Production

1. Persist sessions/rate-limit state (Redis or DB) for restart resilience.
2. Add structured logging + request IDs for incident debugging.
3. Add automated smoke test workflow against deployed environment.
4. Add dashboard metrics panel for run success rate and queue throughput.
