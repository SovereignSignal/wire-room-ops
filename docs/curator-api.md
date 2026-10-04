# Curator API

Scoped keys for an editorial agent (Hedwig). This is the wire-room-ops door. It is separate from grants.watch `GRANTS_WATCH_CURATOR_KEYS` and from `INTERNAL_API_KEY`.

`INTERNAL_API_KEY` (Stringer) and `INTERNAL_API_KEY_DAILY_SCAN` keep today's behavior during the overlap week: no scope check, no evidence requirement, no idempotency requirement. Their approvals stay quiet. A curator approval stays quiet too, unless the body sets `publish: true` with `confirm: true` while pacing is on and not paused. That books a paced slot. It does not post immediately.

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

Dashboard reads need `read_queue`. Dashboard writes need `decide`. Hedwig's existing scopes (`read_queue`, `decide`, `propose`) cover both, so no new scope and no new secret. Evidence stays on the editorial decide and curate writes. `Idempotency-Key` is required on those writes and on acknowledging a failed distribution log. Neither is required for settings.

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
- `PATCH /api/scan/entries/:id/content` — edit post text plus classification, tags, and `metadata.amount`; `confirm=true` required; never sends
- `POST /api/scan/entries/:id/unwithhold` — release a withheld publication back to approved; `confirm=true` required; does not enqueue or send
- Every dashboard write listed under [Dashboard](#dashboard)

Editorial decide and curate writes still require evidence and `Idempotency-Key`. A curator approval is quiet unless `publish` is `true`, `confirm` is `true`, and pacing is enabled and not paused. Then the approve books a paced slot (`quiet: false`) and the drain sends only when that slot is due. Without `confirm`, or with pacing off or paused, the call is refused and the entry stays as it was. `publish` on a plain internal key is ignored and the approval stays quiet. Sending still needs its own call and `confirm=true`.

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

`POST /api/scan/entries/:id/unwithhold` clears the hold. See [Release a withhold](#release-a-withhold). Enqueue still refuses a withheld row, and the release does not enqueue one.

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

## Entry content

`PATCH /api/scan/entries/:id/content` edits the fields a Telegram post is generated from at send time: `name`, `description`, `enriched_summary`, `amount`, `deadline`, `source_url`. The same call also edits record fields that are not post inputs: `classification`, `tags`, and `metadata.amount`. Send any subset. `confirm: true`, `reason`, and `sources` are required for every caller, including a dashboard session. A curator key also sends `Idempotency-Key`. No quote is required.

The write sets `actioned_by` to the caller (`agent:<name>` for a curator key) and `action_reason` to the reason. It appends one object to `metadata.content_edits` (`at`, `actor`, `reason`, `sources`, `previous_actioned_by`, `from`, `to`) and stores the evidence packet on `metadata.curator_evidence`. The `amount` column stays in step with `metadata.amount` unless the call also sets `metadata.amount`. `deadline` stays in step with `metadata.deadline`. `enriched_summary` stays in step with `metadata.summary`, which is the summary the dashboard card shows. A new summary clears `auto_summarize_failed`. No new table. A classification change does not change `status`, `operator_route`, `quality_score`, or `program_id`, and it does not send.

Validation matches the intake and approval checks: name 1–120 characters, description 10–8000, summary 10–8000 and not model reasoning, deadline at most 50 characters with no URL or stray punctuation (`none` / `n/a` clears it), amount is not a bare sum under $100 or a duration, source URL is `http` or `https` and not a shortener, placeholder, or blocked aggregator. A source URL change moves `seen_urls` ownership for that wire. A URL another entry already owns is `409` and nothing is written.

Post text is refused, and nothing is written, when the publication is already out or in flight:

- any `distribution_logs` row for the entry with `channel = 'telegram'` and `status = 'success'`
- a pending Telegram log, or `publication_queue.status` of `running`
- `publication_queue.status` of `review`

`queued` here is the publication row, not `scan_entries.status`. An entry still in the review queue, or approved with no publication row, or withheld, or `done` without a Telegram success, can have its post text edited. A booked (`queued`) row can be edited too. Changing `name`, `description`, `amount`, `deadline`, or `source_url` regenerates `publication_queue.post_text` from those fields and leaves the slot where it is. `enriched_summary` is not a post input, so editing only that field does not rewrite the frozen post. The response is `409` with `error` for a sent, running, or in-review publication. Nothing on this route calls a sender, books a slot, or inserts a queue row.

`classification`, `tags`, and `metadata.amount` may be edited in those same states. The post is built from `name`, `description`, the `amount` column, `deadline`, and `source_url`. It does not read classification, tags, or `metadata.amount`. A sent Telegram message is already delivered. A patch that includes any text field together with these record fields is still refused in full when the publication is sent, running, or in review, and writes nothing.

- `classification` is the entry type: `GRANT` (a funding opportunity), `NEWS`, `EXPIRED`, `NOISE`, or `UNCHECKED`. Case is ignored and the stored value is uppercase. `type` is not a field.
- `tags` replaces the entity labels. At most 5, each 1–60 characters after trimming, no duplicates. `[]` clears them.
- `metadata` accepts only `amount`. `null` removes `metadata.amount` and leaves the `amount` column as it is. Send it as `{ "metadata": { "amount": "$75,000" } }`.

```bash
curl -s -X PATCH "$WIREOPS_SERVER_URL/api/scan/entries/18106/content?confirm=true" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: hedwig-content-18106" \
  -d '{
    "confirm": true,
    "reason": "Official page has the program name and amount.",
    "sources": ["https://example.org/program"],
    "name": "Example Grants Program",
    "description": "Funds independent cryptography teams. Applications stay open through December.",
    "amount": "$50K",
    "deadline": "2026-12-01"
  }'
```

Response includes `changed`, `actioned_by`, `enqueued: false`, and `sent: false`. `dryRun: true` validates and writes nothing.

A record-only correction, including one on an entry that already has a Telegram success:

```bash
curl -s -X PATCH "$WIREOPS_SERVER_URL/api/scan/entries/18106/content?confirm=true" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: hedwig-record-18106" \
  -d '{
    "confirm": true,
    "reason": "Official page is a news item, and the extracted amount was wrong.",
    "sources": ["https://example.org/news"],
    "classification": "NEWS",
    "tags": ["Example Foundation"],
    "metadata": { "amount": "$75,000" }
  }'
```

`changed` lists `classification`, `tags`, and `metadata.amount`. The `amount` column is left as it was.

## Release a withhold

`POST /api/scan/entries/:id/unwithhold` takes an approved withheld entry back off the hold. The entry stays `approved`. The `publication_queue` row is deleted, so the worker has nothing to claim. `distributable` is left as it was. The call does not insert a queued row and does not send.

`confirm: true`, `reason`, and `sources` are required. A curator key also sends `Idempotency-Key`. The write sets `actioned_by` to the caller and appends `metadata.unwithhold` (`at`, `actor`, `reason`, `sources`, `previous_actioned_by`). `metadata.withheld` is left in place. The evidence packet goes to `metadata.curator_evidence`.

`409` and no write when the entry is missing a withheld row, or is not approved. A withheld row that already has a Telegram success can still be released; enqueue will keep refusing it, and this route will not send it.

Putting the entry on the paced queue is a separate call: `POST /api/distribution/queue/:id/enqueue` with its own `confirm: true`.

```bash
curl -s -X POST "$WIREOPS_SERVER_URL/api/scan/entries/18106/unwithhold" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: hedwig-unwithhold-18106" \
  -d '{
    "confirm": true,
    "reason": "Text is corrected. Ready to book a slot.",
    "sources": ["https://example.org/program"]
  }'
```

Response: `{ "success": true, "action": "unwithhold", "entryId": 18106, "status": "approved", "dryRun": false, "actioned_by": "agent:hedwig", "enqueued": false, "sent": false }`.

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

`confirm=true` (query or JSON body) is required for a curator token when the call deletes a row, sends or retries a delivery, books a paced slot, or includes a new secret. The session cookie does not send `confirm` on those calls. Without it the response is `400 { "error": "confirm_required" }`.

`PATCH /api/scan/entries/:id/content` and `POST /api/scan/entries/:id/unwithhold` require `confirm=true` from every caller, including a dashboard session and the internal key. They are not send paths. The internal key is not `403` on them.

Approving does not distribute unless `publish` is `true` under the rule above. Enqueue is how an already-approved programs-only row joins the paced queue. It never sends on its own. Redistribute and the distribution run still send, and a curator token needs `confirm=true` for those. The plain internal key gets 403 on every send path, including enqueue.

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

`GET /api/distribution/outgoing` includes `counts.programsOnly` and `programsOnly`: approved rows with `distributable = false`, not withheld, decided in the last 7 days (`decision_at`). Each item is `{ id, title, approved_at, actioned_by }`. Read-only.

`POST /api/distribution/queue/:id/enqueue` books one of those rows onto the paced queue. Body: `{ "confirm": true, "reason": "...", "sources": ["https://..."] }`. `sources` is optional. `reason` is required. The response is `{ entryId, availableAt, note }`. `availableAt` is the slot `bookPacedQueue` assigned (20-minute spacing, quiet hours, daily cap). `note` is `quiet hours` or `daily cap` when the slot was pushed, otherwise null. The call does not send.

Guards, all `409`, and none of them write:

- pacing is disabled or paused (`pacing must be on and not paused`)
- the entry is not approved
- the queue row is `withheld`, `queued`, `running`, or `review`
- no enabled Telegram destination is left unsent
- any `distribution_logs` row for the entry has `channel = 'telegram'` and `status = 'success'`, on any wire

A withheld row stays withheld. A prior Telegram success stays unsent from this route so a second wire cannot repost it. The internal key is `403`. A curator token without `confirm` is `400 { "error": "confirm_required" }`. A `read_queue` key is `403`.

### Repeat-funder hold

A funder that already has a successful Telegram post on any wire stays off the queue for `REPEAT_FUNDER_WINDOW_DAYS` (default 30). The match is `org_id`, `program_id`, or a normalized funder name taken from the entry name and tags (the leading name, the text before a dash or colon, and each tag). The entry's own posts do not count.

This runs on every enqueue: approve with publish, `POST /api/distribution/queue/:id/enqueue`, a review retry, and a resolve that puts the entry back to send. The call writes nothing and returns `409`:

```json
{
  "error": "repeat_funder",
  "reason": "repeat_funder",
  "message": "This funder already had a successful Telegram post in the last 30 days.",
  "windowDays": 30,
  "holds": [
    {
      "entryId": 42,
      "held": true,
      "windowDays": 30,
      "priors": [
        { "entryId": 10, "name": "Btrust — Builder Grants", "wire": "crypto", "externalId": "9001", "sentAt": "2026-09-20T12:00:00.000Z" }
      ]
    }
  ]
}
```

`GET /api/distribution/entries/:id/repeat-funder` (`read_queue`) returns that same hold object for one entry (`held: false` and `priors: []` when the window is clear). `404` when the entry does not exist.

`override_repeat_funder: true` with a `reason` books the slot anyway. The reason is appended to `metadata.repeat_funder_overrides` (`at`, `actor`, `reason`, `windowDays`, `priors`). Override without a reason is `400 { "error": "reason_required" }`.

```bash
curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/distribution/entries/42/repeat-funder"

curl -s -X POST "$WIREOPS_SERVER_URL/api/distribution/queue/42/enqueue" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "confirm": true,
    "override_repeat_funder": true,
    "reason": "Starter Grants is a distinct round from the three posts already sent.",
    "sources": ["https://example.org/btrust/starter"]
  }'
```

Booking a row freezes the Telegram text on it (`post_text`, `generated_at`, `model`, `check_result`, `verifier_result`). Approve-with-publish and the other enqueue paths do the same. The worker sends that text. It generates a draft only when `post_text` is missing.

`GET /api/distribution/outgoing` includes `postText` on each queued item. `GET /api/distribution/queue/:id` returns one row: `{ entryId, status, availableAt, postText, generatedAt, model, checkResult, verifierResult }`. `read_queue` can call it. `404` when the entry has no publication row.

`POST /api/distribution/queue/:id/regenerate` writes a new draft from the current `name`, `description`, `amount`, `deadline`, and `source_url`. `PATCH /api/distribution/queue/:id/post` stores `postText` as given. Both need `confirm: true`, `reason`, and `sources` for every caller. A curator key also sends `Idempotency-Key`. Neither call sends or moves the slot. Both append `metadata.post_edits` (`at`, `actor`, `reason`, `sources`, `kind`, `from`, `to`) and set `actioned_by` and `action_reason`. The response includes the stored text, `enqueued: false`, and `sent: false`.

`409` when the publication is not `queued`. Override `postText` must be Telegram HTML of at most 4096 characters; invalid HTML is `400` and writes nothing. A `read_queue` key is `403`.

```bash
curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/distribution/queue/18510"

curl -s -X POST "$WIREOPS_SERVER_URL/api/distribution/queue/18510/regenerate" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: hedwig-post-18510" \
  -d '{
    "confirm": true,
    "reason": "The amount on the page was corrected.",
    "sources": ["https://example.org/program"]
  }'

curl -s -X PATCH "$WIREOPS_SERVER_URL/api/distribution/queue/18510/post" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: hedwig-post-override-18510" \
  -d '{
    "confirm": true,
    "reason": "Operator rewrote the headline from the funder page.",
    "sources": ["https://example.org/program"],
    "postText": "<b>Example Foundation is accepting applications — $50K</b>\n\n🔗 <a href=\"https://example.org/program\">Source</a>"
  }'
```

### Distribution

| Method | Path | Confirm |
| --- | --- | --- |
| GET | `/api/distribution/pace` | |
| PUT | `/api/distribution/pace` | |
| GET | `/api/distribution/outgoing` | |
| GET | `/api/distribution/review` | |
| GET | `/api/distribution/entries/:id/repeat-funder` | |
| GET | `/api/distribution/queue/:id` | |
| POST | `/api/distribution/queue/:id/enqueue` | yes |
| POST | `/api/distribution/queue/:id/regenerate` | yes |
| PATCH | `/api/distribution/queue/:id/post` | yes |
| POST | `/api/distribution/queue/:id/retry` | yes |
| POST | `/api/distribution/review/:id/resolve` | yes |
| POST | `/api/distribution/logs/:id/acknowledge` | yes |
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

`POST /api/distribution/logs/:id/acknowledge` closes one `distribution_logs` row whose status is already `failed`. `:id` is the log id. `confirm: true` and a non-empty `reason` (at most 2000 characters) are required for every caller, including a dashboard session. A curator key also sends `Idempotency-Key`. Sources are not required. The log becomes `acknowledged`, with `acknowledged_at`, `acknowledged_by`, and `acknowledged_reason`. `external_id` is left as it was. The call does not send, does not insert a queue row, and does not set a queue row back to `queued`. It is not resolve, not retry, and not withhold. A log that is not `failed` is `409` and is left unchanged, including a `pending` send that still needs review. A missing log is `404`. The response is `{ id, entryId, status, acknowledgedAt, acknowledgedBy, acknowledgedReason, externalId, enqueued: false, sent: false, delivered: false }`. The same key and body replay that response with `Idempotent-Replayed: true`. A `read_queue` key is `403`.

```bash
curl -s -X POST "$WIREOPS_SERVER_URL/api/distribution/logs/9001/acknowledge" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: hedwig-ack-9001" \
  -d '{
    "confirm": true,
    "reason": "Telegram rejected the chat. This send will not be retried."
  }'
```

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

curl -s -X POST "$WIREOPS_SERVER_URL/api/distribution/queue/18510/enqueue" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "confirm": true,
    "reason": "Approved for the wires. Still open on the funder page.",
    "sources": ["https://example.org/program"]
  }'

curl -s -X POST "$WIREOPS_SERVER_URL/api/scan/entries/18510/action" \
  -H "Authorization: Bearer $HEDWIG_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: hedwig-approve-publish-18510" \
  -d '{
    "action": "approve",
    "publish": true,
    "confirm": true,
    "reason": "Open on the funder page.",
    "sources": [{ "url": "https://example.org/program", "quote": "Applications are open." }]
  }'

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

`GET /api/usage/summary` and `GET /api/usage/recent` use this bearer (`read_queue`). Summary rows are grouped by provider, purpose, and `job`, so Firecrawl spend splits without a second endpoint. `created_at` on each recent row is an ISO 8601 string.

Optional `?job=` filters both routes. Firecrawl jobs are `registry-watch`, `source-feed:<feedKey>`, `summary`, `telegram-link`, and `fallback` (any other caller). An unknown `job` is `400 { "error": "Invalid job filter" }`. `GET /api/usage/summary?provider=firecrawl&days=30` is the per-job split. Older rows have `job: null`.

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
  "$WIREOPS_SERVER_URL/api/usage/summary?days=30&provider=firecrawl"

curl -s -H "Authorization: Bearer $HEDWIG_TOKEN" \
  "$WIREOPS_SERVER_URL/api/usage/recent?limit=20&provider=firecrawl&job=summary"

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
