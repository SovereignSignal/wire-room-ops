# Curator API

Scoped keys for an editorial agent (Hedwig). This is the wire-room-ops door. It is separate from grants.watch `GRANTS_WATCH_CURATOR_KEYS` and from `INTERNAL_API_KEY`.

`INTERNAL_API_KEY` (Stringer) and `INTERNAL_API_KEY_DAILY_SCAN` keep today's behavior during the overlap week: no scope check, no evidence requirement, no idempotency requirement. Agent approvals stay quiet (no distribution) for both kinds of key.

## Auth

Set `WIRE_ROOM_CURATOR_KEYS` to a JSON array. Each object:

| Field | Meaning |
| --- | --- |
| `id` | Stable key id, used in the idempotency storage key |
| `name` | Display name. The principal is `agent:<slug>` (`Hedwig` → `agent:hedwig`) |
| `sha256` | Lowercase hex SHA-256 of the bearer token. The token itself is not stored |
| `scopes` | Any of `read_queue`, `decide`, `propose`, `intake` |
| `expires_at` | UTC ISO timestamp. Expired keys do not match |
| `revoked` | `true` disables the key. A past `revoked_at` does the same |

Mint a token locally. The command prints the bearer once and a JSON object that contains only the hash:

```bash
npm run curator-key:mint -- --name hedwig --scopes read_queue,decide,propose
```

Paste the JSON object into the array. Do not put the bearer in the variable. A present but invalid list fails closed: bearers that are not an internal key get `503 { "error": "curator_unavailable" }`. Unset is not an error.

Send `Authorization: Bearer <token>`. A matched key without the scope for that route gets `403 { "error": "forbidden" }`. A missing or unknown bearer on these routes is `401`.

Dashboard reads need `read_queue`. Dashboard writes need `decide`. Hedwig's existing scopes (`read_queue`, `decide`, `propose`) cover both, so no new scope and no new secret. Evidence and `Idempotency-Key` stay on the editorial decide and curate writes only. They are not required for settings.

The audit identity on queue decisions stays `agent:<name>`. Settings and other token writes are logged as `curator-api` with the old value and the new value. Do not send `actor`. `?force=true` is ignored for every agent, including curator keys.

These stay closed to a curator key: `POST /api/scan/submit-batch`, `POST /api/scan/agent/send-brief`, `POST /api/admin/*`, the manual job triggers (`/api/summary-sync`, `/api/process-raw`, `/api/enrich`, `/api/scan/classify-queue`), login and logout, and the Telegram webhook. `POST /api/scan/telegram-batch` stays `intake` only. `/api/orgs` and `/api/export` are not dashboard controls and stay on the session. The internal master key does not open the dashboard routers.

Monitored accounts, registry watch, and source feeds are dashboard controls. Reads need `read_queue`. Writes need `decide`. Deletes need `confirm=true`. Writes are logged as `curator-api`. This does not turn the account-monitor schedule back on, and it does not send anything to Telegram.

## Scopes

### `read_queue` (GET)

- `/api/scan/queue`
- `/api/scan/entries`
- `/api/scan/entries/:id`
- `/api/scan/seen-urls`
- `/api/scan/agent/approval-patterns`
- `/api/scan/status-counts`
- `/api/scan/deadline-digest`
- Every dashboard GET listed under [Dashboard](#dashboard). `raw_output` is still omitted on queue, list, and single-entry responses.

`raw_output` is omitted on queue, list, and single-entry responses for curator keys. Internal-key responses are unchanged.

### `decide`

- `POST /api/scan/entries/:id/action` — `approve`, `decline`, `reviewlater`, `restore`, `withhold`
- `POST /api/scan/entries/bulk-action` — the same actions, up to 200 ids
- `POST /api/scan/entries/:id/link-duplicate`
- `PATCH /api/scan/entries/:id/wire`
- `PATCH /api/scan/entries/:id/source`
- Every dashboard write listed under [Dashboard](#dashboard)

Editorial decide and curate writes still require evidence and `Idempotency-Key`. A curator approval is still quiet: it does not distribute. Sending is a separate call and needs `confirm=true`.

### `propose`

- `POST /api/scan/entries/:id/curate`
- `POST /api/scan/submit`

Curator submits set `submitted_by` to `agent:<name>` so the digest's silent-producer check can see Hedwig. Internal-key submits do not set that field.

### `intake`

- `POST /api/scan/telegram-batch`

The producer scope, for a batch poster such as the `Grok Telegram Batch` workflow (`.github/workflows/grok-scout-submit.yml`). Rows start `raw` and are classified by the process-raw cycle, the same as an internal-key batch, and `submitted_by` is `agent:<name>`. No evidence or `Idempotency-Key` is required. Grant it on its own: a key with only `intake` cannot read the queue, decide, or propose.

```bash
npm run curator-key:mint -- --name grok-batch --scopes intake
```

## Evidence

Required on curator decide and curate writes. Not required on `/submit`, and not required for internal keys.

- `reason` — non-empty, at most 2000 characters
- `sources` — non-empty array of `https` URLs, or `{ "url", "quote" }` objects
- Approve also needs at least one non-empty `quote` (on a source object or in a top-level `quotes` array of `{ "url", "quote" }`)

The packet is merged into `scan_entries.metadata.curator_evidence` (`reason`, `sources`, `quotes`, `by`, `at`) and copied to `action_reason`. No new table.

`POST /curate` with `route: "decline"` from a curator key declines the entry through the same quiet entry-action path as `action: "decline"`, then writes the stamp. Operators and internal keys still get a stamp only; decline does not change status for them.

## Withhold

`action: "withhold"` keeps an approved entry off the Telegram wires. It is the one decide action that does not change `scan_entries.status`: the entry stays approved, and its `publication_queue` row becomes `withheld`, so the worker never claims it and the outgoing list stops counting it as missing. The manual wire run, the per-entry retry and the newsletter builder skip it too.

It applies to an approved, wire-bound entry that is scheduled, or that was never sent and is not on the queue (the outgoing list's `missing` state). The call is all or nothing. If any id is not approved, was approved for programs only, is sending, is awaiting delivery review, or has nothing left to send, the response is `409` with a `blocked` array of `{ id, reason }` and nothing is written. An entry that is already withheld is not an error; it comes back under `alreadyWithheld`.

`reason` and `sources` are required as on any decide write; no quote is needed. The packet goes to `metadata.withheld` (`reason`, `sources`, `quotes`, `by`, `at`). It does not overwrite `curator_evidence`, `actioned_by` or `action_reason`, which still describe the approval. `dryRun: true` returns what would change and writes nothing.

There is no agent path back onto the stream. An operator restores the entry and approves it again.

```bash
curl -s -X POST "$WIREOPS_SERVER_URL/api/scan/entries/bulk-action" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: hedwig-withhold-stale-2026-10-02" \
  -d '{
    "action": "withhold",
    "ids": [3, 9, 12],
    "reason": "Stale: deadlines passed or programs closed. Missing Telegram Posts QC, 2026-10-02.",
    "sources": ["https://example.org/qc-page"]
  }'
```

Response: `{ "success": true, "action": "withhold", "dryRun": false, "withheld": [3, 9, 12], "alreadyWithheld": [] }`.

## Queue score default

`GET /api/scan/queue` with no `minScore` includes unscored rows (`quality_score` null). Passing `minScore` keeps `quality_score >= n`, which still hides nulls. An unparseable `minScore` is 400. This applies to every caller of `/queue`, including internal keys. The dashboard queue uses `GET /entries` with an explicit score band and is unchanged.

## Idempotency

Curator decide and curate writes require `Idempotency-Key`: 8–128 characters from `A-Z a-z 0-9 . _ : -`.

The stored record is an `app_state` row (`curator:idem:<key id>:<header>`). No migration.

- Same key and same method, path, and body within 24 hours replays the stored response and sets `Idempotent-Replayed: true`
- Same key and a different body is `409`
- A second request while the first is still in progress (15 minutes) is `409`

Evidence is checked before a key is claimed, so a missing `reason` does not consume the key.

## Dashboard

The same bearer the queue uses. Reads are `read_queue`. Writes are `decide`. Validation matches the dashboard handlers. Curator writes share the existing agent rate limit (40 writes, 120 reads per 5 minutes).

Secret fields (`api_key`, tokens, `credentials`, `databaseUrl`, and the same names nested in a body) are write-only. A response replaces them with `****`. A masked value the server already stored (`****…`) can be sent back and is ignored, the same way the dashboard does.

`confirm=true` (query or JSON body) is required for a curator token when the call deletes a row, sends or retries a delivery, or includes a new secret. The session cookie does not send `confirm`. Without it the response is `400 { "error": "confirm_required" }`.

Approving still does not distribute. A token that should publish calls redistribute or the distribution run with `confirm=true`. Those calls use the existing send path. Nothing in this change posts to Telegram on its own.

### Pace and outgoing

```bash
curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/distribution/pace"

curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/distribution/outgoing"

curl -s -X PUT "$WIREOPS_SERVER_URL/api/distribution/pace" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"intervalMinutes":25,"timezone":"America/Los_Angeles","enabled":false,"paused":false}'
```

A bad pace body is `400`. The stored change log records `actor: "curator-api"` and the old and new pace objects. The process log is `[Distribution] Pace settings changed by curator-api … {old} -> {new}` plus `[curator-api] PUT /api/distribution/pace actor=curator-api {old} -> {new}`.

### Distribution

| Method | Path | Confirm |
| --- | --- | --- |
| GET | `/api/distribution/pace` | |
| PUT | `/api/distribution/pace` | |
| GET | `/api/distribution/outgoing` | |
| GET | `/api/distribution/review` | |
| POST | `/api/distribution/queue/:id/retry` | yes |
| POST | `/api/distribution/review/:id/resolve` | yes |
| GET | `/api/distribution/config` | |
| PUT | `/api/distribution/config/:wire/:channel` | when the body has a new secret |
| POST | `/api/distribution/run/:wire` | yes |
| GET | `/api/distribution/newsletter/:wire` | |
| POST | `/api/distribution/newsletter/:wire/confirm` | yes |
| GET | `/api/distribution/status/:wire` | |
| GET | `/api/distribution/channels` | |
| POST | `/api/distribution/channels` | yes (credentials) |
| PUT | `/api/distribution/channels/:id` | when the body has a new secret |
| DELETE | `/api/distribution/channels/:id` | yes |
| POST | `/api/distribution/channels/:id/test` | yes |

```bash
curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/distribution/channels"

curl -s -X PUT "$WIREOPS_SERVER_URL/api/distribution/channels/$CHANNEL_ID" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":false}'

curl -s -X DELETE "$WIREOPS_SERVER_URL/api/distribution/channels/$CHANNEL_ID?confirm=true" \
  -H "Authorization: Bearer $HEDWIG_TOKEN"

curl -s -X POST "$WIREOPS_SERVER_URL/api/distribution/run/crypto?confirm=true" \
  -H "Authorization: Bearer $HEDWIG_TOKEN"

curl -s -X POST "$WIREOPS_SERVER_URL/api/distribution/channels/$CHANNEL_ID/test?confirm=true" \
  -H "Authorization: Bearer $HEDWIG_TOKEN"

curl -s -X POST "$WIREOPS_SERVER_URL/api/distribution/queue/123/retry?confirm=true" \
  -H "Authorization: Bearer $HEDWIG_TOKEN"

curl -s -X POST "$WIREOPS_SERVER_URL/api/distribution/review/9/resolve?confirm=true" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"delivered":false}'

curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/distribution/config"

curl -s -X PUT "$WIREOPS_SERVER_URL/api/distribution/config/crypto/telegram" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true,"config":{}}'

curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/distribution/newsletter/crypto"

curl -s -X POST "$WIREOPS_SERVER_URL/api/distribution/newsletter/crypto/confirm?confirm=true" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entryIds":[123]}'

curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/distribution/status/crypto"

curl -s -X POST "$WIREOPS_SERVER_URL/api/distribution/channels?confirm=true" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"wire":"crypto","channel":"telegram","name":"Crypto","target_id":"-100","enabled":true,"credentials":{"bot_token":"123:abc"}}'
```

`POST /api/scan/entries/:id/redistribute?confirm=true` retries one entry. `GET /api/scan/entries/:id/distribution` is the log. `POST /api/scan/entries/:id/retry-summarize` reruns a thin summary.

```bash
curl -s -X POST "$WIREOPS_SERVER_URL/api/scan/entries/123/redistribute?confirm=true" \
  -H "Authorization: Bearer $HEDWIG_TOKEN"

curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/scan/entries/123/distribution"
```

### Queue, paste, scans

Queue approve, decline, restore, withhold, bulk, wire, source, and curate are unchanged and documented above. Paste:

```bash
curl -s -X POST "$WIREOPS_SERVER_URL/api/scan/manual-intake" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Example Grant — https://example.org/grants","wire":"crypto"}'
```

A token paste is agent intake: the row starts `raw` and the process-raw cycle classifies it. A dashboard session paste stays the unclassified human queue.

```bash
curl -s -X POST "$WIREOPS_SERVER_URL/api/forum/run" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'

curl -s -X POST "$WIREOPS_SERVER_URL/api/scan/run" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"wire":"crypto"}'

curl -s -X POST "$WIREOPS_SERVER_URL/api/feeds/run" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"wire":"crypto"}'

curl -s -X POST "$WIREOPS_SERVER_URL/api/cohort/run" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'

curl -s -N -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/job/$JOB_ID/progress"
```

Prompt CRUD uses the same fields as the scan-prompts screen.

```bash
curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/scan/prompts"

curl -s -X POST "$WIREOPS_SERVER_URL/api/scan/prompts" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"wire":"crypto","label":"Example","promptText":"Find open grants.","toolType":"web_search"}'

curl -s -X PUT "$WIREOPS_SERVER_URL/api/scan/prompts/$PROMPT_ID" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"isActive":false}'

curl -s -X DELETE "$WIREOPS_SERVER_URL/api/scan/prompts/$PROMPT_ID?confirm=true" \
  -H "Authorization: Bearer $HEDWIG_TOKEN"

curl -s -X POST "$WIREOPS_SERVER_URL/api/scan/prompts/$PROMPT_ID/run" \
  -H "Authorization: Bearer $HEDWIG_TOKEN"

curl -s -X POST "$WIREOPS_SERVER_URL/api/scan/prompts/$PROMPT_ID/test" \
  -H "Authorization: Bearer $HEDWIG_TOKEN"

curl -s -X POST "$WIREOPS_SERVER_URL/api/scan/prompts/test" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"wire":"crypto","promptText":"Find open grants.","toolType":"web_search"}'

curl -s -X POST "$WIREOPS_SERVER_URL/api/scan/prompts/review" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"promptText":"Find open grants."}'

curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/scan/prompt-stats?days=21"

curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/scan/cost-stats"

curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/scan/stats"
```

### Schedules, feeds, overview

```bash
curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/schedules"

curl -s -X POST "$WIREOPS_SERVER_URL/api/schedules" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Morning digest","scheduleType":"daily-digest","hour":8,"minute":0,"timezone":"America/Los_Angeles","enabled":true}'

curl -s -X PUT "$WIREOPS_SERVER_URL/api/schedules/$SCHEDULE_ID" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":false}'

curl -s -X DELETE "$WIREOPS_SERVER_URL/api/schedules/$SCHEDULE_ID?confirm=true" \
  -H "Authorization: Bearer $HEDWIG_TOKEN"

curl -s -X POST "$WIREOPS_SERVER_URL/api/digest/send-now?confirm=true" \
  -H "Authorization: Bearer $HEDWIG_TOKEN"

curl -s -X POST "$WIREOPS_SERVER_URL/api/test-alert?confirm=true" \
  -H "Authorization: Bearer $HEDWIG_TOKEN"

curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/scheduler-status"

curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/feeds"

curl -s -X PUT "$WIREOPS_SERVER_URL/api/feeds/crypto" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"displayName":"Crypto"}'

curl -s -X DELETE "$WIREOPS_SERVER_URL/api/feeds/crypto?confirm=true" \
  -H "Authorization: Bearer $HEDWIG_TOKEN"

curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/dashboard/stats"

curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/wires"

curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/models"
```

`DELETE /api/feeds/:key` archives the feed. It does not drop rows.

### Monitored accounts

List, add, enable, and remove X accounts. The account-monitor schedule stays off until someone enables that schedule on its own.

| Method | Path | Confirm |
| --- | --- | --- |
| GET | `/api/accounts/monitored` | |
| POST | `/api/accounts/monitored` | |
| PATCH | `/api/accounts/monitored/:handle` | |
| DELETE | `/api/accounts/monitored/:handle` | yes |

```bash
curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/accounts/monitored"

curl -s -X POST "$WIREOPS_SERVER_URL/api/accounts/monitored" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"handle":"octantapp","wire":"crypto","enabled":true}'

curl -s -X PATCH "$WIREOPS_SERVER_URL/api/accounts/monitored/octantapp" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":false}'

curl -s -X DELETE "$WIREOPS_SERVER_URL/api/accounts/monitored/octantapp?confirm=true" \
  -H "Authorization: Bearer $HEDWIG_TOKEN"
```

`handle` is the X handle without `@`. `wire` is `crypto`, `ai`, or `oss`.

### Registry watch

`GET /api/registry-watch/pending` returns would-submit items from the last dry run that had any: `title`, `url`, `org`, `wire`, `reason`. `recordedAt` is when that list was saved. `lastRunAt` is the newest dry run, and `lastRunItemCount` is how many items that run added. A later quiet run keeps the list and sets `lastRunItemCount` to 0. The list is a review copy. Those URLs are marked seen, so going live does not submit them.

`GET /api/registry-watch/surfaces` lists watched pages. Optional `status=active|paused` and `wire=crypto|ai|oss`.

`PUT /api/registry-watch/surfaces/:id` edits `url`, `surface_type`, `wire`, `tier`, `status` (`active` or `paused`), and `org_name`.

```bash
curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/registry-watch/pending"

curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/registry-watch/surfaces?status=active"

curl -s -X PUT "$WIREOPS_SERVER_URL/api/registry-watch/surfaces/797" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://gitcoin.co/campaigns","surface_type":"grants_page","status":"active"}'
```

Taking the lane live is a Railway variable change, not a curator call. See the README section "How to take registry watch live". Dry run stays the default. This API does not flip `REGISTRY_WATCH_DRY_RUN`.

### Source feeds

The built-in list in `SOURCE_REGISTRY` is the default. This API stores an overlay in `app_state` (`source-feeds:config`) so a feed can be retargeted, disabled, or added without a deploy. Added feeds are `rss` or `scrape` only.

| Method | Path | Confirm |
| --- | --- | --- |
| GET | `/api/source-feeds` | |
| POST | `/api/source-feeds` | |
| PUT | `/api/source-feeds/:key` | |
| DELETE | `/api/source-feeds/:key` | yes |

`DELETE` on a built-in key disables it. `DELETE` on an added key removes it.

```bash
curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/source-feeds"

curl -s -X PUT "$WIREOPS_SERVER_URL/api/source-feeds/longview" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"endpoint":"https://www.longview.org/grantmaking/","enabled":true}'

curl -s -X POST "$WIREOPS_SERVER_URL/api/source-feeds" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"key":"example-feed","name":"Example","wire":"oss","method":"rss","endpoint":"https://example.org/feed"}'
```

### Providers, usage, database, grants, integrations

```bash
curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/providers"

curl -s -X PUT "$WIREOPS_SERVER_URL/api/providers/ollama" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true}'

curl -s -X PUT "$WIREOPS_SERVER_URL/api/providers/ollama?confirm=true" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"api_key":"new-key"}'

curl -s -X POST "$WIREOPS_SERVER_URL/api/providers/ollama/test" \
  -H "Authorization: Bearer $HEDWIG_TOKEN"

curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/usage/summary?days=7"

curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/usage/recent?limit=20"

curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/usage/coverage"

curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/usage/outcomes"

curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/pricing"

curl -s -X PUT "$WIREOPS_SERVER_URL/api/pricing/ollama/example-model" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input_cost_per_1m":0.1,"output_cost_per_1m":0.2}'

curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/database/config"

curl -s -X POST "$WIREOPS_SERVER_URL/api/database/config/test?confirm=true" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"databaseUrl":"postgresql://localhost/wireops"}'

curl -s -X POST "$WIREOPS_SERVER_URL/api/database/config?confirm=true" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"databaseUrl":"postgresql://localhost/wireops"}'

curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/database/stats"

curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/database/scan-entries"

curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/database/export/scan-entries"

curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/grants-intel/summary"

curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/grants-intel/observations"

curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/integrations"

curl -s -X POST "$WIREOPS_SERVER_URL/api/integrations?confirm=true" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"provider":"notion","name":"CRM","enabled":false,"config":{"notion_token":"secret","database_id":"abc"}}'

curl -s -X PUT "$WIREOPS_SERVER_URL/api/integrations/1" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true}'

curl -s -X DELETE "$WIREOPS_SERVER_URL/api/integrations/1?confirm=true" \
  -H "Authorization: Bearer $HEDWIG_TOKEN"

curl -s -X POST "$WIREOPS_SERVER_URL/api/integrations/1/validate" \
  -H "Authorization: Bearer $HEDWIG_TOKEN"

curl -s -X POST "$WIREOPS_SERVER_URL/api/integrations/1/sync" \
  -H "Authorization: Bearer $HEDWIG_TOKEN"
```

`GET /api/database/intake-runs`, `/api/database/distribution-log`, `/api/database/summaries`, `/api/database/schema/:table`, and `/api/database/enums/:type` use the same bearer.

Production still refuses `POST /api/database/config` with `403` even when `confirm=true`. The response never includes the connection string.

## Examples

Read the queue (unscored rows included):

```bash
curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/scan/queue?date=2026-10-01"
```

Approve, with a quote:

```bash
curl -s -X POST "$WIREOPS_SERVER_URL/api/scan/entries/123/action" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: hedwig-approve-123-2026-10-01" \
  -d '{
    "action": "approve",
    "reason": "Official program page is open and matches the queue row.",
    "sources": ["https://example.org/grants"],
    "quotes": [{ "url": "https://example.org/grants", "quote": "Applications are open through 30 November." }]
  }'
```

Decline by curate (curator key — this changes status to declined):

```bash
curl -s -X POST "$WIREOPS_SERVER_URL/api/scan/entries/123/curate" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: hedwig-decline-123-2026-10-01" \
  -d '{
    "route": "decline",
    "confidence": "high",
    "reason": "The thread is a single project pitch, not an open program.",
    "sources": ["https://forum.example.org/t/pitch/1"]
  }'
```
