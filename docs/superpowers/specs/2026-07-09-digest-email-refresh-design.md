# Digest Email Refresh Design

## Goal

Make the daily WireOps email useful as a morning operator brief. It should show high-signal fresh items and production issues only, with a cleaner visual presentation based on the selected Ops Dashboard Lite direction.

## Current Problem

The current email reads like a queue dump. It includes all-time pending review counts, top queued items regardless of freshness, and normal duplicate hygiene as a warning. The visual shell is plain and awkward in email clients, so even useful information feels noisy.

## Product Contract

- The email answers two questions: what should Sov open first, and did anything break.
- Fresh items mean queued entries created in the last 24 hours that are not past deadline.
- Backlog pressure stays out of the subject and body unless it becomes a separate thresholded anomaly later.
- Duplicate-rate warnings remain only when they are operationally abnormal. Routine duplicate suppression is dashboard telemetry.
- The email remains one message in the existing daily-digest cycle. No new schedule.

## Presentation

Use the selected Ops Dashboard Lite direction:

- Compact dark header with date.
- Three small metric cells: Fresh, Issues, Spend.
- `Open first` cards for fresh high-signal items.
- `Production issues` cards only when anomalies exist.
- Quiet state reads cleanly: no fresh high-signal items, no production issues.
- Keep inline styles compatible with common email clients.

## Data Flow

`getTopPendingFinds()` becomes the fresh-items query. It filters queued entries to `created_at >= NOW() - INTERVAL '24 hours'`, excludes past parsed deadlines, and sorts by curator route/confidence first, then quality score, deadline urgency, and recency.

`renderDailyDigest()` uses the count of passed `topFinds` for `Fresh`, not `digest.totalPendingReview`. The subject changes to `WireOps - YYYY-MM-DD | N fresh | M issues`.

## Testing

Update `tests/digest-email.test.js` so it pins:

- Subject uses fresh and issue counts.
- Backlog count does not render when top finds are fresh-only.
- Ops Dashboard Lite layout markers render.
- Quiet day is short and does not mention stale backlog.
- Anomalies render as production issues.

Add a unit test for the fresh query shape by injecting a fake pool and asserting the SQL filters to the last 24 hours and orders by curator signal before fallback ranking.
