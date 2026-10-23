# Read API

Named, read-only HTTP views of the pipeline tables. They replace raw SQL that
agents and ops scripts ran over the public database proxy: the `wro-ro-query`
service, the scout heartbeat and digest, and the box QC scripts. Code:
`src/routes/read-api.ts`. Tests: `tests/read-api-db.test.js`.

## Auth

Mounted at `/api/read` behind `requireAuthOrCurator`, the same door the
dashboard routers use.

- A curator key (`WIRE_ROOM_CURATOR_KEYS`) with `read_queue`. Hedwig's key
  already has it. A new reader gets its own key:
  `npm run curator-key:mint -- --name <name> --scopes read_queue`.
- A dashboard session also works.
- The internal master key (`INTERNAL_API_KEY`) does not open these routes.
- `GET` and `HEAD` only. Any other method is `403` for a curator key, before
  a router sees it.

Reads count against the agent read limit (120 per 5 minutes per key).
Responses go through the curator redaction pass, so timestamps are ISO 8601
strings and secret-shaped keys come back as `****`.

## Guarantees

- Every request runs in one `BEGIN READ ONLY` transaction with a 15-second
  statement timeout. A write inside it is refused by Postgres.
- Columns are listed explicitly. `raw_output` is never returned.
  `GET /entries/:id` returns the whole row minus `raw_output`.
- Unknown filter values are `400`, never an unfiltered scan. Status, source,
  classification, wire, delivery status, and channel are checked against the
  same lists the rest of the app uses (`SCAN_STATUSES`, `SCAN_SOURCES`,
  `QUEUE_CLASSIFICATIONS`, `CORE_WIRES`).
- No schema change. The routes read tables the runtime role can already read.

## Common parameters

| Parameter | Meaning |
|---|---|
| `hours` / `days` | Lower bound relative to now. Use one of `hours`, `days`, `since` |
| `since`, `until` | ISO 8601 bounds, `since` inclusive and `until` exclusive |
| `wire` | `crypto`, `ai`, or `oss` |
| `limit` | Page size; each route has its own default and cap |
| `before_id` / `after_id` | Id cursor. Paged responses return `has_more` and `next` with the value to send |

List values (`status`, `source`, and so on) are comma-separated or repeated.

## Endpoints

### `GET /api/read/entries`

Rows from `scan_entries`, newest id first. Queue rows by status, a producer's
recent rows, or any filtered slice.

Filters: `status`, `source` (scan_source), `classification`, `wire`,
`submitted_by`, window on `created_at` (none by default), `before_id`,
`after_id`, `order=newest|oldest`, `limit` (default 100, max 500),
`include=metadata`.

Each row: `id, name, description, enriched_summary, source_url, amount,
deadline, deadline_parsed, wire, scan_source, submitted_by, status,
classification, classification_reason, quality_score, quality_reason`
(`quality_breakdown.scoreReason`)`, operator_route, curator` (the curator
stamp)`, lifecycle, tags, org_id, program_id, duplicate_of_id,
duplicate_reason, operator_notes, distributable, actioned_by, action_reason,
decision_at, created_at, updated_at`, plus `metadata` with `include=metadata`.

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$WIREOPS_SERVER_URL/api/read/entries?status=queued&wire=crypto"
curl -s -H "Authorization: Bearer $TOKEN" "$WIREOPS_SERVER_URL/api/read/entries?source=claude-code,grok-scout&hours=36"
```

### `GET /api/read/entries/:id`

`{ entry, deliveries, publication }`. `entry` is every column except
`raw_output`, with the full `metadata`. `deliveries` is the entry's
`distribution_logs`, oldest first. `publication` is its `publication_queue`
row without the lease fields, or `null`. `404` for an unknown id.

### `GET /api/read/approvals`

Approved entries by recorded decision date (`decision_at`), newest first.
Rows approved before decision dates were recorded (schema version 4) have no
`decision_at` and are not listed.

Filters: window on `decision_at` (default 24 hours, max 90 days), `wire`,
`actioned_by` (exact, for example `user:ops@example.com` or `agent:hedwig`),
`limit` (default 200, max 500; `truncated` is true when more exist).

Each row adds `publication_status`, `publication_available_at`, and
`deliveries` (`channel, wire, status, external_id, sent_at, created_at`).

### `GET /api/read/deliveries`

`distribution_logs`, newest first, with the entry name.

Filters: `status` (`pending`, `success`, `failed`, `skipped`, `acknowledged`),
`channel` (`telegram`, `discord`, `slack`, `x`, `newsletter`), `wire`,
`entry_id`, window on `created_at` (default 7 days; none when `entry_id` is
given), `before_id`, `limit` (default 200, max 1000), `include=post_text`.

### `GET /api/read/seen-urls`

With `url=`: an exact lookup. The URL is matched the way intake dedup matches
it (`urlLookupKeys`: scheme, `www.`, trailing slash, and tracking parameters
ignored). Returns `{ url, normalized_url, seen, matches }`; each match carries
the first entry's `entry_status` and `entry_name`. A bare host such as
`example.org/grants` is read as `https://`. Optional `wire`.

Without `url=`: the registered set by id, for incremental sync. `scope=all`
(default) or `seed` (rows with no owning entry), `wire`, window on
`created_at`, `after_id`, `limit` (default 1000, max 5000).

`GET /api/scan/seen-urls?scope=all` (the scouts' current dedup source) is
unchanged.

### `GET /api/read/intake-counts`

Counts per group with a status split and two rates.

- `by`: any of `source` (default), `wire`, `submitted_by`, `prompt`
  (adds `prompt_id` and `prompt_label`), `variant` (`prompt_variant`),
  `classification`, `route` (`metadata.operator_route`), `day` (UTC date of
  `created_at`), `week` (the Monday that starts the UTC week).
- Filters: `source`, `status`, `wire`, `submitted_by`, window on `created_at`
  (default 7 days, max 400 days).

Each group: the `by` keys, `total`, `by_status`, `first_created_at`,
`last_created_at`, `approval_rate` = approved / (approved + declined) or null,
`dup_rate` = `duplicate` rows / total (`deduped` is in `by_status` but not in
the rate), and `avg_quality_score` over rows that have a score (one decimal,
null when none do). `totals` has the same fields across all groups. A caller
that counts archived rows as rejections (the scout scoreboard does) computes
its own rate from `by_status`.

```bash
# Scan inventory: 7-day rows, approval %, dup % per source
curl -s -H "Authorization: Bearer $TOKEN" "$WIREOPS_SERVER_URL/api/read/intake-counts?days=7"
# Per prompt
curl -s -H "Authorization: Bearer $TOKEN" "$WIREOPS_SERVER_URL/api/read/intake-counts?days=7&by=prompt"
# Did another scout already feed this wire in the last 20 hours?
curl -s -H "Authorization: Bearer $TOKEN" "$WIREOPS_SERVER_URL/api/read/intake-counts?hours=20&wire=ai&source=grok-scout&by=wire"
```

### `GET /api/read/backlog`

Rows still waiting, per wire and status, with `count`, `oldest_created_at`,
and `newest_created_at`. `status` defaults to `raw,queued`. Optional `wire`.
No time window.

### `GET /api/read/names`

Program names a scout should not resubmit, grouped by name.

- `wire` (required), `days` (default 120, max 730), `limit` (default 400,
  max 10000; `truncated` when more exist).
- `status`: rows with these statuses count as `origin: "decided"`.
- `source`: rows from these producers count as `origin: "self"` and sort
  first. At least one of `status` and `source` is required.

Each name: `name`, `origin`, `statuses`, `last_seen`. Names shorter than
3 characters are skipped.

```bash
# known_programs.py
curl -s -H "Authorization: Bearer $TOKEN" "$WIREOPS_SERVER_URL/api/read/names?wire=crypto&days=120&limit=400&source=claude-code&status=approved,declined,archived,duplicate,deduped"
# name_dedup.py
curl -s -H "Authorization: Bearer $TOKEN" "$WIREOPS_SERVER_URL/api/read/names?wire=crypto&days=180&limit=10000&status=declined,archived"
```

### `GET /api/read/usage-daily`

`api_usage_log` per UTC day, provider, model, job, and purpose: `calls`,
`tokens_in`, `tokens_out`, `estimated_cost_usd`, `unpriced_calls`, `errors`.
Window default 7 days, max 90. Filters: `provider`, `job`, `purpose`, `wire`.
`GET /api/usage/summary` and `/api/usage/recent` are unchanged.

## What each old raw query maps to

| Caller | Old SQL | Read API |
|---|---|---|
| Scout `lib/known_programs.py` | names by `scan_source` or decided status, 120 days | `/names?source=<self>&status=approved,declined,archived,duplicate,deduped` |
| Scout `lib/name_dedup.py` | distinct declined/archived names, 180 days | `/names?status=declined,archived&days=180` |
| Scout `lib/skip_if_fed.py` | count for other scout sources in N hours | `/intake-counts?hours=N&wire=W&source=…&by=wire` |
| Heartbeat `hb:counts` | per-wire count for the scout sources in N hours | `/intake-counts?hours=N&source=…&by=wire` |
| Digest `digest:queue` | the scouts' rows in N hours | `/entries?source=…&hours=N` |
| Digest `digest:backlog` | queued count and oldest per wire | `/backlog?status=queued` |
| Digest `digest:outcomes` | 7-day source × status | `/intake-counts?days=7&source=…` |
| Scout `bin/scoreboard.sh` | week × source × wire × variant | `/intake-counts?days=30&by=week,source,wire,variant&source=claude-code,grok-scout` |
| Scout `bin/ab-score.sh` | one source by variant | `/intake-counts?days=30&by=variant&source=claude-code` |
| Box scan inventory | 7-day rows, approval %, dup % | `/intake-counts?days=7` (`by=prompt` per scan prompt) |
| Box pre-approval check | queued rows and their metadata | `/entries?status=queued&include=metadata`, `/entries/:id` |
| Box cost table | `api_usage_log` by day | `/usage-daily` |
| QC: recent approvals | approved rows and delivery state | `/approvals` |
| QC: delivery logs | `distribution_logs` | `/deliveries` |
| QC: seen URLs | `seen_urls` lookup | `/seen-urls?url=` |

Not covered: the scout ledger tables `scout_runs` and `scout_alerts` (no
schema in this repo; see `docs/private-database-runbook.md`), and the
grants.watch wire readers (`WIRE_DATABASE_URL`), which need their own
contract.
