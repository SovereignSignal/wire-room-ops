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

Send `Authorization: Bearer <token>`. A matched key without the scope for that route gets `403 { "error": "forbidden" }`. Anything not listed below is forbidden, including prompt CRUD, scan/forum/feeds/cohort run, monitored-accounts CRUD, redistribute, manual-intake, and submit-batch.

The audit identity is the key. Do not send `actor`. `?force=true` is ignored for every agent, including curator keys.

## Scopes

### `read_queue` (GET)

- `/api/scan/queue`
- `/api/scan/entries`
- `/api/scan/entries/:id`
- `/api/scan/seen-urls`
- `/api/scan/agent/approval-patterns`
- `/api/scan/status-counts`
- `/api/scan/deadline-digest`

`raw_output` is omitted on queue, list, and single-entry responses for curator keys. Internal-key responses are unchanged.

### `decide`

- `POST /api/scan/entries/:id/action` — `approve`, `decline`, `reviewlater`, `restore`
- `POST /api/scan/entries/bulk-action`
- `POST /api/scan/entries/:id/link-duplicate`
- `PATCH /api/scan/entries/:id/wire`
- `PATCH /api/scan/entries/:id/source`

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

## Queue score default

`GET /api/scan/queue` with no `minScore` includes unscored rows (`quality_score` null). Passing `minScore` keeps `quality_score >= n`, which still hides nulls. An unparseable `minScore` is 400. This applies to every caller of `/queue`, including internal keys. The dashboard queue uses `GET /entries` with an explicit score band and is unchanged.

## Idempotency

Curator decide and curate writes require `Idempotency-Key`: 8–128 characters from `A-Z a-z 0-9 . _ : -`.

The stored record is an `app_state` row (`curator:idem:<key id>:<header>`). No migration.

- Same key and same method, path, and body within 24 hours replays the stored response and sets `Idempotent-Replayed: true`
- Same key and a different body is `409`
- A second request while the first is still in progress (15 minutes) is `409`

Evidence is checked before a key is claimed, so a missing `reason` does not consume the key.

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
