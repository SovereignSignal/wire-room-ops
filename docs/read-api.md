# Read API

Named, read-only HTTP views of the pipeline tables. They replace raw SQL that
agents and ops scripts ran over the public database proxy: the `wro-ro-query`
service, the scout heartbeat and digest, and the box QC scripts. Code:
`src/routes/read-api.ts`. Tests: `tests/read-api-db.test.js`.

The scout ledger (`scout_runs`, `scout_alerts`) also has two small write
routes under `/api/scout`, so the scouts record runs and alerts without a
database login. See [Scout ledger writes](#scout-ledger-writes). Tests:
`tests/scout-ledger-db.test.js`.

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
- The routes read tables the runtime role can already read. The scout ledger
  tables arrive with schema version 14 (`src/db/scout-ledger.ts`); every other
  route reads tables that existed before.

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

### `GET /api/read/scout-runs`

`scout_runs`, oldest first by default (the order the heartbeat and digest
read it).

Filters: `run_id_prefix` (comma-separated, up to 10, for example
`claude-code-,grok-build-`; a prefix match, not a pattern), `status` (`ok`,
`skipped`, `auth`, `quota`, `empty`, `timeout`, `delivery`, `failed`,
`other`), `wire`, window on `created_at` (default 7 days, max 400 days),
`order=oldest|newest`, `limit` (default 1000, max 5000; `truncated` is true
when more exist).

Each row: `run_id, wire, variant, model, status, opportunity_count,
found_count, dedup_dropped, error_class, cost_usd, duration_ms, started_at,
finished_at, created_at, recorded_by`. Counts are integers and `cost_usd` and
`duration_ms` are numbers, whatever the column type. `found_count` and
`dedup_dropped` are always present (null when not recorded), so a reader no
longer checks `information_schema` for them.

```bash
# Heartbeat: the last 26 hours of both lanes
curl -s -H "Authorization: Bearer $TOKEN" "$WIREOPS_SERVER_URL/api/read/scout-runs?hours=26&run_id_prefix=claude-code-,grok-build-"
# Heartbeat trend: ok and skipped runs from 30 days ago up to the start of that window
curl -s -H "Authorization: Bearer $TOKEN" "$WIREOPS_SERVER_URL/api/read/scout-runs?days=30&until=$CUTOFF&status=ok,skipped&run_id_prefix=claude-code-"
```

### `GET /api/read/scout-alerts`

`scout_alerts`, newest id first, with `body`.

Filters: window on `created_at` (default 7 days), `undelivered=true` (only
alerts whose `channels_ok` is `none` or empty), `recorded_by` (exact, for
example `agent:grant-wire-scout`), `before_id`, `limit` (default 100, max 500).
Paged with `has_more` and `next.before_id`.

## Scout ledger writes

`PUT /api/scout/runs/:runId` and `POST /api/scout/alerts`. Code:
`src/routes/scout-ledger.ts`, `src/services/scout-ledger.ts`.

- Only a curator key with the `ledger` scope reaches them. A dashboard session
  and a key without `ledger` get `403`; the internal master key gets `401`.
  Any other method or path under `/api/scout` is `403`.
- `ledger` opens nothing else. A scout key that also reads its ledger needs
  `read_queue` as well.
- Writes count against the agent write limit (40 per 5 minutes per key).
- Unknown body fields, wrong types, and out-of-range values are `400`, and
  nothing is written.

### `PUT /api/scout/runs/:runId`

Record or update one run. `:runId` is 1-200 characters from `A-Z a-z 0-9 . _
: -`, starting with a letter or digit (`claude-code-2026-10-23T041500Z`,
`grok-build-…-skipped`).

| Field | Rule |
|---|---|
| `status` | Required. `ok`, `skipped`, `auth`, `quota`, `empty`, `timeout`, `delivery`, `failed`, `other` |
| `wire` | `crypto`, `ai`, `oss`, or empty/omitted when unknown |
| `variant` | Up to 32 characters from `A-Z a-z 0-9 . _ -` |
| `model` | Up to 200 printable characters |
| `opportunity_count`, `found_count`, `dedup_dropped` | Whole numbers, 0 to 1,000,000 |
| `error_class` | Up to 100 characters from `A-Z a-z 0-9 . _ : -` |
| `cost_usd` | Number, 0 to 100,000 |
| `duration_ms` | Whole number, 0 to 2,147,483,647 |
| `started_at`, `finished_at` | ISO 8601, no more than 10 minutes in the future, start not after finish |
| `run_id` | Optional; must equal the path |

The upsert matches `lib/ledger.py`. The first write creates the row (`201`). A
later write (`200`) replaces `status`, the three counts, `error_class`,
`cost_usd`, `duration_ms`, and `finished_at` (the server's clock when
omitted). It keeps the earliest `started_at`, and `wire`, `variant`, and
`model` fill in only while the row has none. Send `finished_at` and a retry
of the same body leaves the row exactly as it was.

A run belongs to the key that first wrote it through this route
(`recorded_by`, for example `agent:grant-wire-scout`). Another key gets `409`.
Rows written by direct SQL have no owner, and the first key to write one
takes it over. Rows copied by `copy-scout-ledger` belong to
`copy:scout-ledger` and cannot be changed here.

Response: `{ run, created }`, where `run` has the `/scout-runs` row fields.

```bash
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"ok","wire":"crypto","variant":"A","model":"<model>","opportunity_count":3,"found_count":7,"dedup_dropped":4,"cost_usd":1.2,"duration_ms":900000,"started_at":"2026-10-23T04:15:00Z","finished_at":"2026-10-23T04:30:00Z"}' \
  "$WIREOPS_SERVER_URL/api/scout/runs/claude-code-2026-10-23T041500Z"
```

### `POST /api/scout/alerts`

Record one alert. Body: `subject` (required, up to 500 characters after
trimming), `body` (string, up to 32,000 characters), `channels_ok` (the
channels that delivered it: lowercase names joined by commas, such as
`resend`, `webhook`, or `none`; default `none`). Connection strings in
`subject` or `body` are stored as `postgresql://****`.

Without an `Idempotency-Key` header every POST is a new alert (`201`). With
one (8-128 characters from `A-Z a-z 0-9 . _ : -`), a retry of the same alert
returns the stored row with `200` and `Idempotent-Replayed: true`, and the
same key with a different alert is `409`. Keys are scoped to the calling key.

Response: `{ alert, created }`, where `alert` is `id, subject, channels_ok,
created_at, recorded_by`. The audit log records the subject and channels, not
the body. The runtime role can insert alerts but not change or delete them.

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
| Scout `lib/ledger.py` | upsert into `scout_runs` | `PUT /api/scout/runs/:runId` |
| Scout `lib/notify.py` | insert into `scout_alerts` | `POST /api/scout/alerts` with an `Idempotency-Key` |
| Heartbeat `hb:funnel`, digest `digest:funnel` | `information_schema` check for `found_count` | Not needed: `/scout-runs` always returns the funnel fields |
| Heartbeat `hb:runs`, `hb:lanes` | runs in N hours by `run_id LIKE ANY(…)` | `/scout-runs?hours=N&run_id_prefix=…` |
| Heartbeat `hb:trend` | ok/skipped runs, 30 days up to N hours ago, summed per wire and day | `/scout-runs?days=30&until=…&status=ok,skipped&run_id_prefix=…`, summed by the caller |
| Digest `digest:runs` | runs in N hours | `/scout-runs?hours=N&run_id_prefix=…` |
| Digest `digest:spend` | cost and run counts by model, 31 days | `/scout-runs?days=31&run_id_prefix=…`, grouped by the caller |
| Digest `digest:lane_runs` | runs in 7 days | `/scout-runs?days=7&run_id_prefix=…` |

Not covered: the grants.watch wire readers (`WIRE_DATABASE_URL`), which need
their own contract.
