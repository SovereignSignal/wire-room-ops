# Paced Telegram distribution

Pacing is implemented and still ships **off**. `distribution:pace.enabled` defaults to `false`, and no migration writes that key. A deploy does not change when posts go out.

What the operator can do from Settings → Distribution, on a phone, with no SQL:

- Turn pacing on or off.
- Set the minutes between posts (1–180; 20 is the recommendation).
- Set quiet hours, or turn them off. The default window is 22:00–08:00 `America/Los_Angeles`. While pacing is on, slot assignment and the drain do not send inside that window. Rows that would have gone out then move to the end of the window and stay spaced by the interval. Windows that cross midnight are supported, including across the Pacific Time daylight-saving change.
- Set a daily cap per chat, or leave it empty. Once a chat has sent its cap, the rest wait for the next day's first open slot (after quiet hours) and stay spaced.
- Pause or resume. Pause sends nothing and leaves the booked slots alone. Approvals still join the queue. Resume sends one post per chat, then pushes the other overdue rows forward by the interval.

`GET` and `PUT /api/distribution/pace` read and store the `distribution:pace` app_state value. PUT is the operator session (the same auth as the rest of Distribution). It rejects a bad time zone, a clock time that is not HH:MM, a cap that is not a positive whole number or empty, and a switch that is not true or false. The interval is clamped to 1–180. Every real change is appended to `distribution:pace:log` (who, when, old value, new value) and written to the process log as `[Distribution] Pace settings changed by …`. The Distribution screen shows the latest line, the current banner, and the next slot per Telegram chat from `GET /api/distribution/outgoing`.

Still design-only: send-now, reorder, resume-at-tail, pull-back, treating a Telegram 429 as retry-wait, and reconciliation enqueue. Withhold shipped separately, as `action: "withhold"` on the entry action doors (`docs/curator-api.md`), not the `/api/distribution/queue/:entryId/withhold` route sketched below. It also accepts a `missing` entry, which that sketch did not, because the first use was 187 stale July approvals that never reached the queue. A withheld row is released with `POST /api/scan/entries/:id/unwithhold` (`docs/curator-api.md`). That call deletes the queue row and does not enqueue or send. The `missing` rule also counts a successful Telegram log with no `channel_id` as sent for its wire: those are March 2026 sends from before managed channels recorded which one they used. The send path does not share that rule yet (`getUndistributedEntries` and `distributeEntry` still match on `channel_id`), so the manual `POST /api/distribution/run/:wire` would repost them.

Curator enqueue shipped as `POST /api/distribution/queue/:id/enqueue`. It is one approved entry, not the bulk reconcile sketched below. A curator token (not the plain internal key) passes `confirm: true`. The route books the next paced slot with `bookPacedQueue` and returns. It does not call `distributeEntry` or `drainPublicationQueue`. The 30-second tick sends the row when that slot is due. Slot math counts queued rows, running rows on the same chat (an in-flight send occupies the chat as of now), and the chat's latest successful send. Two bookings take a share-row-exclusive lock on `publication_queue`, so they cannot both claim the same slot. A running send therefore pushes the next slot a full interval later instead of leaving it due for the next tick. It answers 409 and writes nothing when pacing is off or paused, the entry is not approved, a queue row is already `queued`, `running`, `review`, or `withheld`, no Telegram destination is left unsent, or any wire already has a successful Telegram log for the entry. That last guard is the repost shape: an entry posted once, then given another wire, must not go out again from this route. Without `confirm` the curator token gets `400 confirm_required`. The internal key gets 403.

A curator approve stays quiet, so `distributable` stays false and nothing is booked. `publish: true` on the single and bulk action doors is the exception: it applies only for a curator session, with `confirm: true`, while pacing is on and not paused. Then the approve passes `quiet: false` and books a slot. Pace off or paused refuses the call and does not approve. Missing `confirm` refuses the call. The plain internal key ignores `publish` and stays quiet. `scheduleApproveSideEffects` still wakes the drain after a non-quiet approve; the paced drain only claims a row whose slot is already due.

`GET /api/distribution/outgoing` adds `counts.programsOnly` and `programsOnly`. That list is approved rows with `distributable = false`, not withheld, whose `decision_at` is in the last 7 days. Each item is `{ id, title, approved_at, actioned_by }`. It is read-only. Rows with no recorded `decision_at` stay off the list.

The rest of this document is the investigation and the full design. It does not by itself change Railway config or the production database.

The operator problem: **Approve to Wires** publishes immediately. Approving 20–30 entries in one sitting dumps that many posts into the Telegram channel. Earlier attempts to stream them slowly never became the path the approve button uses, so items were either still blasted out, or they sat on a column nothing wrote. The replacement has to make every approved item visible in Postgres from the moment of approval until Telegram has accepted it.

## Recommendation

Pace the queue that approval already writes (`publication_queue`). Do not revive the retired `drip-distribution` schedule or `distribute_after`.

Keep claim-before-send. Change only **when** a row becomes eligible: on approval, assign each item a future `available_at`, one slot per Telegram chat. The existing 30-second worker sends at most one due item per chat, then pushes any other overdue rows forward so a restart cannot burst.

Ship that behind `app_state` key `distribution:pace` with `enabled: false`. Deploying the code changes nothing until the operator turns pacing on from a screen that already lists what is scheduled, sent, and stuck.

Do not build digest bundling. Spacing is the product that was asked for. A bundle is a different message shape, and it fights the delivery-receipt contract with tele-sum.

---

## 1. What happens today

### Operator and agent doors

| Action | Who | `quiet` | `distributable` | Telegram |
|---|---|---|---|---|
| Approve to Wires | Dashboard operator | `false` | `true` | Queued, then sent as fast as the worker can go |
| Approve to Programs | Dashboard operator | `true` | `false` | Not queued |
| Reject | Dashboard operator | ignored | `false` on restore only; decline does not publish | No |
| `POST /api/scan/entries/:id/action` and `POST /api/scan/entries/bulk-action` | Internal API key (`agent:stringer`, `agent:daily-scan`, curator) | Forced `true` in the route | `false` | Not queued |
| `POST /api/scan/entries/:id/redistribute` | Agent | — | — | `403` |
| `POST /api/distribution/run/:wire` | Operator session | — | — | Sends every undistributed approved entry for that wire, 3 seconds apart. The React app does not call this. It is still a live burst path. |

Dashboard decisions live in `client/src/components/dashboard/queue-decisions.ts`. **Approve to Wires** posts `{ action: "approve", quiet: false }` to the single or bulk action route (`client/src/pages/Index.tsx`). **Approve to Programs** is the same approve with `quiet: true`. Bulk is capped at 200 ids.

Agent force-quiet is in `src/routes/scan-entries.ts` (`isAgent ? true : !!quiet`), not in the service. A human session can still pass `quiet: true`.

### Status transition

`singleEntryAction` / `bulkEntryAction` in `src/services/entry-actions.ts`:

1. Approve is allowed only from `status = 'queued'` (`ACTION_ELIGIBLE_STATUSES`). Validation (`approval-guard`) can block on an empty description or empty `source_url` unless the human passes `force`. Agents cannot force.
2. `applyStatusChange` updates `scan_entries.status`, `distributable`, `actioned_by`, `action_reason`, `updated_at` and, in the **same statement**, inserts `publication_queue` when the new status is `approved` and `distributable` is true.
3. A second approve of an already-approved row matches nothing, so it does not enqueue again and does not re-fire side effects (fixed in #149).
4. Schema version 4 also stamps `decision_at` when a row enters `approved` or `declined`. That timestamp is not a distribution clock.
5. The summaries write-through runs after commit. Failure there is logged and does not roll back the approval.
6. Side effects are still `setImmediate`: drain the publication queue, auto-summarize if the summary is thin, link an org, and (X URLs only) bump `monitored_accounts`. Summarize and org link can fail without affecting the queue row.

Quiet and agent approvals set `distributable = false` and the queue insert's `WHERE` excludes them. Restore sets `status = 'queued'` and `distributable = false`. It does not delete a queue row. The worker only sends a row whose entry is still `approved` and `distributable IS NOT FALSE`, so a restored entry's job completes as `done` without a send.

`ON CONFLICT (entry_id)` resets an existing queue row to `queued`, `attempts = 0`, `available_at = NOW()`. That is the re-queue path after a human resolves an uncertain delivery, not a second approve.

### `publication_queue` — durable, but not paced

Created in `ensureDistributionTables` (`src/db/index.ts`):

| Column | Role today |
|---|---|
| `entry_id` | Primary key, FK to `scan_entries`, cascade delete |
| `status` | `queued`, `running`, `done`, `review` |
| `attempts` | Incremented when claimed |
| `lease_token`, `lease_expires_at` | 20-minute lease, renewed every 60 seconds while the worker holds the row |
| `available_at` | Eligibility time. Approval sets it to `NOW()`. |
| `error_message`, `updated_at` | Last worker note. There is no `created_at`. |

There is no `scheduled` / `sent` / `failed` value on this table. `done` means the worker finished, not that Telegram accepted a message.

`drainPublicationQueue` (`src/services/publication-queue.ts`):

- In-process `running` flag drops overlapping calls. This is single-instance only; the flag is not in Postgres.
- Each call claims up to **10** rows with `FOR UPDATE SKIP LOCKED`: `status = 'queued' AND available_at <= NOW()`, or a `running` row whose lease expired.
- For each claimed row it calls `distributeEntry`, which generates the post and sends to every enabled channel.
- No sleep between those 10 sends. The 3-second gap exists only in `distributeEntries` (the manual wire run).
- Thrown errors retry once (`attempts < 2`), with `available_at = NOW() + 5 minutes`, then `review`.
- A Telegram failure usually does **not** throw. It becomes human review (below), and the queue row goes to `review` immediately.

Who calls the drain:

- `scheduleApproveSideEffects` on every non-quiet approval, via `setImmediate`.
- `src/server.ts` every **30 seconds**, and once at boot, but only when schema verification has succeeded. The timer is `.unref()`'d and cleared on shutdown.

A bulk approve queues every setImmediate before the first drain awaits. The first drain sets `running` and takes up to 10; the rest no-op. The 30-second timer takes the next 10. Thirty approvals therefore leave the channel as about three bursts a minute apart, not as thirty separate publishes spread over a day. One-at-a-time approval is worse for pacing: each click sets `available_at = NOW()` and wakes the drain, so each post goes out as soon as Claude returns.

### `distribution_logs` — the receipt

One row per entry, per wire, per channel, per managed channel id.

| Column | Role |
|---|---|
| `status` | `pending`, `success`, `failed`, `skipped` |
| `external_id` | Telegram `message_id` on success. tele-sum's round-trip guard matches `channel = 'telegram' AND status = 'success'` on `external_id` + `wire`. Dropping either makes tele-sum re-ingest the post. |
| `post_text` | The HTML that was claimed, kept even when the outcome is uncertain |
| `needs_review`, `resolved_by`, `resolved_at` | Human confirmation after an uncertain send |
| `lease_expires_at` | Defaults to 5 minutes after insert |
| `created_at` | Claim time, not a separate sent-at |

Unique partial index `idx_dist_logs_destination` on `(entry_id, wire, channel, channel_id)` **where status is `pending` or `success`**. A second send to the same destination cannot insert another claim while one of those rows exists.

`sendAfterClaim` (`src/services/distribution.ts`):

1. Insert `pending`. Unique violation means already claimed or already sent: return `skipped` and do not call Telegram.
2. Call the channel.
3. If the call throws, or returns not-ok: set `needs_review` and **leave status `pending`**. Do not mark `failed`. Do not delete the claim. Automatic retry cannot take the slot.
4. On a positive receipt, update that same row to `success` and store `external_id`. If that update fails, retry the **update** three times. Never send again. If the update still fails, flag `needs_review` and keep the message id on the row.

`distributeEntry` loads the entry only when `status = 'approved' AND distributable IS NOT FALSE`. It fans out to `wires[]` when present, generates posts per wire (Claude Sonnet, template fallback), and skips destinations that already have `pending` or `success`. Legacy `distribution_config` telegram/x rows are still consulted beside `distribution_channels`.

`getUndistributedEntries` is the backlog query the manual wire run uses. It is not the approve path.

### Telegram rate limits

`sendChannelMessage` (`src/services/telegram-channel.ts`) POSTs `sendMessage` and returns `null` for every failure: HTTP error, `ok: false`, timeout (30s abort), network error. It does not read `error_code` or `parameters.retry_after`.

The intake bot (`telegram-adapter.ts`) treats HTTP 429 as retryable. The **channel poster does not**. A 429, a timeout, and "chat not found" all look the same to the queue: outcome unknown, parked for a human.

Telegram's own guidance ([Bot FAQ](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this)) is roughly one message per second in a single chat, with short bursts tolerated and `429` plus `retry_after` after that. A group also has a coarser per-minute ceiling. Twenty posts in a minute can trip that. The operator complaint is the channel reading as a flood even when the API accepts every message. Editorial pace matters more than the 429, and the 429 still has to be handled as a refusal rather than as "maybe it posted."

A clear Bot API `429` means the update was rejected. A timeout after the request left the process does not. Those two must stay different.

### What the dashboard can see

`GET /api/distribution/review` plus `client/src/components/dashboard/PublicationReview.tsx`, mounted on the Distribution tab. The panel renders only when something needs a human:

- `distribution_logs` in `pending` + `needs_review` (uncertain delivery; Telegram confirm requires a message id)
- `publication_queue` in `review` with no pending log (configuration / no confirmed delivery)

Confirming "not delivered" marks the log `failed`, clears `needs_review`, and re-queues the entry with `available_at = NOW()`, which sends on the next drain. Confirming "delivered" stores the message id as `success` and also re-queues; the worker then sees the success log and does not send again.

There is no list of "scheduled next" or "sent today." An empty review panel is indistinguishable from a healthy stream. Approved entries show distribution pills from the latest log per channel (`getDistributionStatusForEntries`). A row with no log yet just looks approved.

### Other clocks that are not this queue

- node-cron `schedules` does not publish individual entries. The daily-digest fold runs discovery, the Friday weekly, and Wednesday BD leads. It does not drain Telegram.
- Boot deletes leftover `drip-distribution` schedule rows so the old schedule normalizer cannot turn one into a live `scan-execution` cron (`src/db/index.ts`).
- In-memory job progress, magic links, and the `distributionRunning` set reset on deploy. `publication_queue` and `distribution_logs` do not.

```text
Approve to Wires
  scan_entries: queued -> approved, distributable = true
  publication_queue: insert status=queued, available_at=now     (same statement)
  setImmediate + every 30s:
    claim up to 10 rows
      distribution_logs: insert pending          (unique slot)
      Claude post (or template)
      Telegram sendMessage
        success -> log status=success, external_id=message_id, queue done
        anything else -> log stays pending, needs_review, queue review
Approve to Programs / agent approve
  distributable = false, no publication_queue row, no send
```

---

## 2. Why the earlier attempts failed

None of these are a paced approve button that recorded each item. That is why it "never worked" without any single crash.

### March 9, 2026 — approve published the whole backlog

`b2748cb` (`fix/approve-triggers-distribution`) made approve call `distributeEntries(wire)`, which sends **every** approved entry that has no success log. One approval could empty a historical backlog into the channel.

`e2c5cd1` (`fix/single-entry-distribution`), the same day, switched approve to `distributeEntry(entryId)`. That stopped the backlog flood and locked in immediate per-entry publish. A sitting of 20 approvals is 20 immediate sends. The 3-second delay stayed only on the manual "run the wire" path.

### March 27–28, 2026 — the drip job

`b46804a` added `src/jobs/drip-distribution.ts` and schedule type `drip-distribution`. Each cron run took one approved, `distributable` entry per wire with **no `distribution_logs` row at all**, oldest `updated_at` first, and called `distributeEntry`.

That design had four concrete failures:

1. **It was not the approve path.** Approve still published immediately. The drip only did anything if a `schedules` row of type `drip-distribution` existed and was enabled. The button the operator uses never entered it.
2. **The selector was the entire approved corpus.** Any old approved entry that had never been logged was eligible. Quiet approvals were safe only because `distributable` was false. Everything else approved before distribution existed was a candidate. The same day, `d0d6b3f` added a 30-day `created_at` filter and a description-length gate. That was a bandage on a backlog flood, not a queue.
3. **Any log row, including `failed`, meant "done."** A failed send was skipped forever. `4bf081b` (March 28) changed the filter to "no `success` or `pending` log," so failures would be retried. Claim-before-send did not exist yet (#149 is September). A retry after Telegram had accepted the message but the log write had failed would post a second time.
4. **Nothing was visible per item.** Pace was "whatever the cron expression is" plus an in-memory overlap skip (`executingJobs` in the scheduler). No scheduled time, no pause, no reorder, no "this one did not send." Errors were a console line and a scheduler status blob.

`8d48375`, still March 27, tried to stop the backlog selector. It added `scan_entries.distribute_after` and `POST /entries/:id/schedule-distribution` (`scheduleForDistribution`). The drip query then required `distribute_after IS NOT NULL AND distribute_after <= NOW()`. **The approve and bulk-approve paths never set that column.** Only an explicit call to the new endpoint did. The retirement commit records that the column was never set in production. The drip cron, if it was even enabled, selected zero rows, while Approve to Wires kept posting immediately.

`tests/entry-actions.test.js` gained coverage that the schedule helper wrote the timestamp. Nothing tested "approve enqueues a drip."

### July 3, 2026 — retired on purpose

PR [#56](https://github.com/SovereignSignal/wire-room-ops/pull/56) (`2feb0db`) deleted the job, the schedule type, the endpoint, and the helper, per an explicit decision that the lane was unused. Two safety notes from that PR still bind:

- Boot **deletes** `schedules` rows of type `drip-distribution`. Re-adding the type without removing that delete, or leaving a row around, is how a retired drip schedule was at risk of being normalized into a paid scan cron.
- `tests/stringer-ops-contract.test.js` fails if `STRINGER.md` mentions `drip-distribution.ts`. `STRINGER.md` still says the drip path is gone and `distribute_after` must not be set.

`distribute_after` is not in the current schema migrations or any TypeScript. Production databases that booted between March 27 and July 3 may still have the column. A fresh database does not. Do not read it, write it, or build the new queue on it. Same for `experiment_id`: the drip lane was retired in the same change as AutoResearch, and that subsystem stays dormant.

### September 2026 — durable, still immediate

PR [#163](https://github.com/SovereignSignal/wire-room-ops/pull/163) (`07c4b1d`), with recovery behavior pinned by `tests/publication-recovery-db.test.js` and the uncertain-send work tracked through [#160](https://github.com/SovereignSignal/wire-room-ops/pull/160):

- The queue insert is in the approval statement, so a crash cannot approve without a row, and a failed insert rolls the approval back.
- Sends claim a log row first. An expired lease or a null Telegram result becomes `needs_review` instead of a resend.
- Historical approvals were **not** backfilled onto the queue. Turning on a worker does not republish the archive.

That is the right safety model. It does not pace. `available_at` is `NOW()`, and the worker's batch size is 10 with no gap. The review UI only appears after something has already gone wrong.

### What "stuck in opaque automation" means here

| Failure | What the operator sees |
|---|---|
| Drip cron disabled or `distribute_after` never set | Posts still fly out on approve. The drip looks like it did nothing. |
| Drip selected the backlog | Old approvals would have posted one per cron tick with no list to cancel. |
| Failed log treated as done (pre-March 28) | Item never retried, no dashboard row. |
| Ambiguous send today | Review panel, but only if someone opens Distribution. Easy to miss. A 429 is stuck the same way, even though Telegram refused it. |
| Queue row `done` without a success log | No review row if there is also no pending log. Looks finished. |
| Approved + distributable, no queue row and no log | Invisible. The September worker does not go looking for these. |

---

## 3. Design

### Keep one queue, and make time the pace

`publication_queue` is already the durable record, written in the same statement as approval. A second table, a new schedule type, or an in-memory delay would recreate the drip split: approve does one thing, a cron maybe does another, and a missing flag drops items.

Pace is a timestamp on the row, not a cron's memory.

```text
Approve to Wires (pacing enabled)
  same statement as today, plus available_at = next free slot for that chat
  worker, existing 30s timer:
    if paused: do nothing (rows stay)
    for each Telegram chat: claim at most one row with available_at <= now
    send through the existing claim-before-send path
    if several rows are overdue, send one and push the rest forward by the interval
```

Pacing disabled (the shipped default): keep today's drain, including the batch of 10. The outgoing list still works, so the queue is visible before the behavior changes.

### Per chat, not per process

The flood is a channel. Crypto, AI, and OSS are different Telegram chats. A global "one post every N minutes" makes two channels wait behind the third.

At approval, resolve the enabled Telegram `distribution_channels.target_id` values for the entry's wire (and each extra wire in `wires[]`). Assign:

```text
available_at = max over those chats of (next slot for that chat)
next slot    = max(now, latest available_at already booked on that chat,
                   latest successful send to that chat + interval)
```

Booking is the new row's `available_at`. The next approval for a chat that shares that timestamp waits another full interval. An entry that fans out to two chats takes the later of the two slots, and both chats are busy at that time, so each chat still sees one post per interval.

Do this in the approval statement's order. `id = ANY($ids)` does not preserve the order the operator clicked. Use `unnest(ids) WITH ORDINALITY` when assigning slots so bulk approve sends in selection order.

If a wire has no enabled Telegram channel, still insert the queue row. The outgoing list shows "no channel" on that row. Do not drop it, and do not mark it `done`.

Store nothing in the worker process except the lease it already holds. After a deploy, the next tick reads `available_at` and continues. It does not "catch up" by sending the overdue pile: **one send per chat per tick, then rewrite the other overdue `available_at` values** to `now + i * interval` in their existing order. Quiet hours ending, or a process that was down all night, releases one post and leaves the rest spaced. This is the burst the current drain of 10 would cause, and the one a naive `WHERE available_at <= now` would cause.

### Visible state

Do not add a parallel status vocabulary that can disagree with the queue. Derive the label in the API. Add one new queue status, `withheld`, for "I pulled this off the stream." Do not reuse the decided-recheck word `held`; that stamp already has a digest contract (`cross_wire_blocked` / `canonical_parent_blocked` / `duplicate_chain_error`).

| Label | Rule | Operator meaning |
|---|---|---|
| `scheduled` | `publication_queue.status = queued` and `available_at > now` | Will send at `available_at` |
| `due` | `queued` and `available_at <= now` | Next tick should take it. If it stays due across ticks, the list shows why (paused, quiet hours, cap). |
| `sending` | `running` and lease unexpired | Claim held. A lease expiry moves the log to needs-review; it does not resend. |
| `sent` | `done`, and every enabled Telegram destination for that entry has `distribution_logs.status = success` and a non-null `external_id` | Posted. Message id is the receipt. |
| `needs review` | a `pending` log with `needs_review`, or `review` with no pending log | Outcome unknown or nothing confirmed. Same screen as today. No automatic resend. |
| `retry wait` | `queued` after an **explicit** Telegram refusal, `error_message` set, `available_at` in the future | Refused, not lost. Will try again at `available_at`. |
| `withheld` | `withheld` | Operator pulled it. Stays approved. Will not send until resumed. |
| `not on wires` | `approved` and `distributable = false` and no queue row | Approve to Programs, or an agent approval. Correctly absent. |
| `missing` | `approved`, `distributable` true, no queue row in `queued`/`running`/`review`/`withheld`, and at least one enabled destination has neither `success` nor `pending`. A `success` log with no `channel_id` settles every destination on its wire. | Reconciliation finding. Not sent, not scheduled. |

Timestamps:

- `publication_queue.created_at` — when it was approved onto the stream (column does not exist yet).
- `available_at` — next eligible send, already the schedule.
- `distribution_logs.sent_at` — set only when the row becomes `success` (today `created_at` is claim time).
- `external_id` — Telegram message id, already stored. Surface it on `sent` and on needs-review.

`done` without a success log is `missing`, not `sent`. The worker must not set `done` in that case; that is a current hole (`drainPublicationQueue` leaves state `done` when the entry is no longer distributable, which is correct for a restore, and also when `distributeEntry` returns an empty channel map only if a success log exists — otherwise it uses `review`). Reconciliation still checks, because a future bug should show up as a row, not a silent skip.

### Pace settings

One JSON value in `app_state`, key `distribution:pace`, via the existing `getAppState` / `setAppState`. No new schedule type.

```json
{
  "enabled": false,
  "intervalMinutes": 20,
  "timezone": "America/Los_Angeles",
  "quietHours": { "start": "22:00", "end": "08:00" },
  "dailyCap": null,
  "paused": false
}
```

Defaults, and why:

| Setting | Default | Why |
|---|---|---|
| `enabled` | `false` | A deploy must not change the channel. The operator turns it on after the outgoing list looks right. |
| `intervalMinutes` | `20` | 20 approvals span about 6.5 hours on one chat. 15 is also reasonable; 20 is calm without turning the channel into a weekly. Clamp 1–180 in the API. |
| `timezone` | `America/Los_Angeles` | Same default as `schedules.timezone`. |
| Quiet hours | 22:00–08:00 PT | A late approval session waits for morning instead of pinging overnight. The list shows `scheduled` at 08:00, not a blank. If the slot math lands inside the window, push to the window end, then keep spacing. Quiet hours do not apply to send-now. |
| `dailyCap` | `null` (off) | A cap the operator did not ask for is an invisible stuck state. When set, extra rows stay `scheduled` with reason `daily cap` and roll to the next open window. Show the count. Do not drop them. |
| `paused` | `false` | Pause stops claims. It does not delete rows, rewrite `available_at`, or mark anything failed. Resume continues from the booked slots, and the catch-up rule respaces anything that became overdue while paused. |

Changing the interval does not rewrite rows already booked, except the catch-up respace for rows already overdue. Otherwise editing 20 minutes to 30 would shuffle a list the operator is looking at. New approvals use the new interval. A "reflow" control can rebuild future `available_at` values in current order; it is explicit, not a side effect of saving settings.

### Idempotent send

Do not add a second sender. Send-now, the timer, and retry all call the same claim function that exists today.

- The unique partial index remains the lock. A success or a live `pending` claim means do not call `sendMessage`.
- Lease expiry still means **outcome unknown**. `reconcileStaleDeliveries` keeps marking those logs `needs_review`. The worker must not treat an expired lease as permission to post again.
- Restart mid-send: the queue lease expires, the log is needs-review, the outgoing list shows it. The message might be in the channel. A human confirms with the message id, or confirms it is absent, which is the only path back to a send.
- Explicit Telegram refusal is the exception to "never automatic retry." If the HTTP response is JSON `ok: false` with `error_code` 429, or another 4xx that is a definite rejection (400 bad HTML, 403 bot not in chat is **not** a retry — that is `review`, because retrying will not fix it), and there is no `message_id`:
  - 429: set the queue back to `queued`, `available_at = now + max(retry_after, interval)`, leave **no** `pending` log (delete the claim only after the response proves rejection — the body parsed, `ok: false`, no result). Attempts increment. After 5 refusals, `review` with the last description. Surface each wait on the outgoing list.
  - Timeout, connection reset, non-JSON, HTTP 200 with a contradictory body: keep today's needs-review behavior. Do not delete the claim.
- `sendChannelMessage` has to return a discriminated result (`sent`, `refused`, `uncertain`) instead of `null`. The intake adapter already distinguishes 429; the channel poster should not copy the adapter's "retry the HTTP call in a loop," because a paced queue retry belongs on `available_at`, not inside the request.

Skipped logs (no token, no target) must not satisfy "sent." They are `missing` or `review` with the existing error text (`bot_token not set`, `target_id not configured`).

### Failures are a list, not a log line

The worker already `console.error`s. That is not the surface. Every non-success leaves a row:

- `retry wait` — automatic, time visible, attempt count visible.
- `needs review` — human, current Publication Review controls, still required before any resend.
- `missing` — reconciliation, never auto-sent.

No `catch` that sets `done` and swallows the error. The current `catch` in the drain requeues or reviews; keep that, and include the error string on the outgoing API.

### API and dashboard

Operator session only, same rule as redistribute (agent key gets 403). All of these read or move rows. None of them call Telegram except send-now, which goes through the worker.

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/api/distribution/outgoing` | Pace settings, paused flag, next slot per chat, counts, and items in `scheduled` / `due` / `sending` / `retry wait` / `withheld` / `needs review` / `missing`. Optional `?sentSince=` for what went out, joined to `external_id` and `sent_at`. Also `counts.programsOnly` and `programsOnly` (approved, not for the wires, last 7 days). |
| `GET` | `/api/distribution/pace` | Current settings and the change log. Does not send. |
| `PUT` | `/api/distribution/pace` | Validate and store the JSON. Does not send. Logs who changed it. |
| `POST` | `/api/distribution/queue/:entryId/send-now` | Set `available_at = now`, clear `paused` for that row only by claiming it through the worker once. Still one destination claim. Refuses while the row is `sending` or `needs review`. |
| `POST` | `/api/distribution/queue/:entryId/withhold` | Only from `queued`. Status `withheld`. |
| `POST` | `/api/distribution/queue/:entryId/resume` | `withheld` → `queued`, `available_at` at the **tail** of that chat, not `now`. |
| `POST` | `/api/distribution/queue/:entryId/reorder` | Body `{ beforeEntryId }` or `{ toTail: true }`. Only `queued` rows. Swap `available_at` with the neighbor so the gap stays intact. |
| `POST` | `/api/distribution/queue/:entryId/pull-back` | Only if no `pending` or `success` Telegram log. Set the entry back to `queued`, `distributable = false`, delete the publication row. It returns to the editorial queue. If a claim exists, refuse and point at review. |
| `GET` | `/api/distribution/reconcile` | The missing-set query below. Read-only. |
| `POST` | `/api/distribution/reconcile/enqueue` | Insert missing ids at the tail with `available_at` spaced from the last slot. Does not send now. Returns the rows it booked. |

`POST /api/distribution/run/:wire`, while `enabled` is true, returns 409 with a message that the stream is paced and send-now is the per-item override. While pacing is off, leave it as it is. The React client does not call it today; an old script might.

Dashboard: a section above `PublicationReview` on the Distribution tab, always rendered (not `return null` when empty).

- Banner: `Pacing off — approvals publish immediately` or `Next post 14:20 PT · crypto · 12 scheduled · paused`.
- Controls: enable, pause, interval, quiet hours, daily cap. Primary actions inline, not buried in a last column.
- Tables: Scheduled (order, time, wire, name, link to the entry), Sent (time, message id), Attention (needs review, retry wait, missing, withheld).
- Row actions: send now, move up/down, withhold, pull back. Pull back uses that verb. It is not "delete."
- `PublicationReview` stays the confirmation dialog for uncertain deliveries. Do not replace "I verified it was delivered" with a retry button.

The editorial queue's Approve to Wires copy can say "approve onto the stream" once pacing is on. Until then, leave the label. The action is still approve; only the clock changes.

### Reconciliation

A read against Postgres, not a worker-local set. Run it from the daily-digest fold **after** the email is assembled only if it is a one-line anomaly; do not let it delay the mail. Also run it on `GET /api/distribution/reconcile` whenever the outgoing page loads.

```sql
SELECT se.id, se.name, se.wire, se.updated_at
FROM scan_entries se
WHERE se.status = 'approved'
  AND se.distributable IS NOT FALSE
  AND NOT EXISTS (
    SELECT 1 FROM publication_queue q
    WHERE q.entry_id = se.id
      AND q.status IN ('queued', 'running', 'review', 'withheld')
  )
  AND EXISTS (
    SELECT 1
    FROM distribution_channels dc
    WHERE dc.enabled
      AND dc.channel = 'telegram'
      AND (dc.wire = se.wire OR dc.wire = ANY(se.wires))
      AND NOT EXISTS (
        SELECT 1 FROM distribution_logs dl
        WHERE dl.entry_id = se.id
          AND dl.wire = dc.wire
          AND dl.channel = 'telegram'
          AND dl.channel_id IS NOT DISTINCT FROM dc.id
          AND dl.status IN ('pending', 'success')
      )
  );
```

Also flag, as separate lines, not as auto-sends:

- `publication_queue.status = 'done'` and the success-log check fails.
- `success` Telegram logs with a null `external_id`.
- `running` with an expired lease (the existing reconciler already flips the log; the outgoing list should show the queue row if it is still `running`).

The daily digest already has a status band for real production issues. One line belongs there when the count is non-zero: `3 approved items are not sent and not scheduled`. Link to the Distribution tab. Do not add a new email. Do not auto-enqueue inside the digest. Auto-enqueue would republish historical approvals the first morning a channel row exists, which is the March 9 bug again. Enqueue is the POST above, and it books the tail.

Quiet approvals are excluded by `distributable IS NOT FALSE`. They are not findings in `missing`. The last 7 days of them are listed separately as `programsOnly`.

### Digest mode

**Not recommended.**

A bundle (several approvals in one Telegram message) looks like a way to reduce floods. It costs the properties this design is for:

- Telegram HTML is capped at 4096 characters. A handful of grant posts already use most of that. The overflow has to split, and a split bundle is a partial send with a harder receipt.
- Pull-back, reorder, and send-now are per item. A composed bundle makes one item's hold rewrite a message that may already have been claimed.
- tele-sum skips re-import when one `distribution_logs` row has `external_id` = that Telegram message. A bundle of N entries needs N success rows sharing one message id, which the unique index allows (different `entry_id`) but the guard was built for one post per entry. Getting that wrong re-ingests the bundle into `summaries`.
- The channel's unit is one opportunity. The email daily digest and the Friday Substack draft are already the bundles. The Telegram complaint is pace, not "please combine these."

If a digest is ever wanted, it is a separate mode with its own receipt story, after paced single posts have been on for a while. It should not be phase 1 or a flag on this queue.

### What not to build

- A new `schedules.schedule_type`. Boot will delete `drip-distribution`, and the owner rule is to fold periodic work into an existing timer. The 30-second publication timer is that timer.
- `distribute_after`, `scheduleForDistribution`, or a port of `src/jobs/drip-distribution.ts`.
- In-memory delays, `setTimeout` chains, or pace state that dies on redeploy.
- Auto-backfill of every historical approved row.
- Agent send-now, or an immediate send from enqueue. The plain internal key stays quiet and gets 403 on send paths. A curator key can book a paced slot (`POST /api/distribution/queue/:id/enqueue`, or approve with `publish: true`) and cannot post from that call.
- Deleting a Telegram message on pull-back. Pull-back is only before a claim. Unsending is a different operation and not part of this.

---

## 4. Implementation plan

### Phase 1 — smallest safe step

Visible queue, slot math, worker limit, flag default off. No quiet hours, no cap, no reorder yet. Those can land later without another migration if the columns from this phase exist.

Behavior while `enabled` is false: identical drain. The new GET still lists queue rows so a sitting of approvals shows 20 `due`/`sending`/`sent` lines even before pacing is turned on.

Work:

1. Schema version **5** (see migrations). Do not hide new columns inside unversioned `ensureDistributionTables`. Upgrades skip version-1 steps. A column added only there never reaches production.
2. `app_state` `distribution:pace` read with the defaults above when the key is absent. Absence means `enabled: false`, not "invent a schedule."
3. Pure function `nextSlot(existingSlots, lastSentAt, now, interval, quietWindow)` with no I/O. Phase 1 can pass a null quiet window.
4. When `enabled`, the approval insert sets `available_at` from that function in selection order, per chat. When disabled, keep `NOW()`.
5. When `enabled`, `drainPublicationQueue` claims **one** due row per Telegram chat per call, then respaces other overdue rows for that chat. When disabled, keep the loop of 10.
6. `GET /api/distribution/outgoing` and a Distribution-tab list. Read-only is enough for this phase. Include message id and `error_message` for rows that already have them.
7. Tests in the style of `tests/publication-recovery-db.test.js`: mock `generatePosts` and `sendChannelMessage`. No token, no network.

Exit: with the flag off, the publication-recovery tests still pass and a bulk approve still drains. With the flag on in a test, 5 approvals produce 1 send on the first drain and 4 future `available_at` values; a second drain inside the interval sends 0; a simulated restart does not send the row that already has `success`.

Turn the flag on only after looking at the outgoing list during a real approval session. That is an operator action in the dashboard (phase 2's PUT, or a one-off `setAppState` once the PUT exists). Not a Railway env change, and not a default flip in the same deploy as the migration.

### Phase 2 — controls and honest retries

Shipped from this phase: `PUT /api/distribution/pace`, pause/resume, and the Distribution-tab controls (enable, interval, quiet hours, daily cap, pause). Quiet hours and the daily cap shipped with those controls; they are not waiting on a later deploy. The flag still defaults to off.

Not shipped yet:

- Send-now, resume-at-tail, reorder, and pull-back. Withhold is already a separate entry action.
- `sendChannelMessage` returns `sent | refused | uncertain`. Map 429 to `retry wait`. Map timeouts to needs-review.
- `resolvePublication` currently re-queues with `available_at = NOW()` for both answers. Keep that when the human confirms the message **was** delivered (the success log blocks another send). When they confirm it was **not** delivered, book the tail of that chat instead of `NOW()`, so clearing a review item does not jump the stream.
- 409 the manual `POST /api/distribution/run/:wire` while pacing is on.
- Row actions on the Distribution tab. Exercise them in the browser against local Postgres with the Telegram client mocked or with no token (a missing token must show `review` / `missing`, not `sent`).

### Phase 3 — quiet hours, cap, reconciliation

Quiet hours and the daily cap are in `nextSlot`, in approval booking, and in the worker. The worker re-checks, so a row booked into a window that was later declared quiet, or a chat that has already hit its cap, is pushed and the outgoing list shows the new time. A reason of `quiet hours` or `daily cap` is stored on the queue row. `Paused` is shown on due rows while the stream is paused and is not stored, because pause does not rewrite slots.

Still open:

- `GET` and `POST /api/distribution/reconcile`. POST books the tail only.
- One digest status-band line when the missing count is non-zero. Dashboard link. No new mail, no auto-send.
- Update `STRINGER.md` and `CLAUDE.md` in that change so the approve path is described as "onto the stream" when pacing is on, and the contract test does not grow a reference to the deleted drip file.

### Migrations

Phase 1 sets `SCHEMA_VERSION` to 5 and adds one versioned step, `paced-distribution`. Upgrades from version 4 run only that step.

```text
publication_queue
  ADD created_at timestamptz NOT NULL DEFAULT now()
  DROP CHECK status, ADD CHECK status IN ('queued','running','done','review','withheld')

distribution_logs
  ADD sent_at timestamptz
```

`sent_at` stays null on old rows. Do not backfill it from `created_at`; that column is claim time and would lie.

Index for the worker, partial:

```sql
CREATE INDEX IF NOT EXISTS idx_publication_queue_due
  ON publication_queue (available_at)
  WHERE status = 'queued';
```

No new table, so `scripts/database-runtime-grants.sql` does not need a new grant. `publication_queue` and `distribution_logs` are already granted to the runtime role. `app_state` already is too.

Apply with the migration-owner connection: on Railway the pre-deploy command reads it from `MIGRATION_DATABASE_URL` and re-applies the runtime grants itself (see `docs/railway-deploy.md`); by hand it is `npm run db:migrate -- --apply` with the same variables. Server boot only checks the recorded version. Do not run this against production as part of the design work.

`distribute_after`: leave it. Do not drop it in this migration. Dropping an unused column on a shared database is a separate, explicit cleanup.

### How to test without posting

The repo already does this. `tests/publication-recovery-db.test.js` points `sendChannelMessage` at a mock that returns `{ messageId }` and points `generatePosts` at a fixture. New tests should follow that, on `wireops_test`, with `DEV_MODE=false` so the auth-enforcement tests still match CI.

Cases worth pinning:

| Case | Expect |
|---|---|
| Quiet approve, agent approve | No `publication_queue` row, mock send count 0 |
| Five wire-approvals, pacing on, one drain | 1 mock send, 4 `available_at` in the future, ordered by selection |
| Second drain before the interval | 0 sends |
| Five rows already overdue (clock jumped) | 1 send, the other four `available_at` rewritten one interval apart |
| Mock returns a successful id, then the process "restarts" (`running` lease expired, log `success`) | 0 further sends |
| Mock returns 429 `retry_after` | Claim removed, row `queued`, `available_at` delayed, send count stays 1 until that time |
| Mock throws / returns uncertain | Log stays `pending` + `needs_review`, further drains send 0 |
| Pull-back before claim | Entry `queued`, `distributable` false, queue row gone |
| Pull-back after `success` | Refused, message id unchanged |
| Reconcile query with one approved distributable row and no queue row | That id listed; no send |
| Reconcile enqueue | Row at the tail; mock send count unchanged |
| Pacing off | Existing recovery tests, including "one receipt-write failure does not resend" |

Local manual check: `DEV_MODE` dashboard, no `TELEGRAM_BOT_TOKEN`, pacing on, approve two fixtures. Outgoing shows both scheduled or, if a channel row exists with no token, attention rather than sent. Confirm the mock or the log table, not a real chat.

Do not point a test at the production bot token. Do not call `sendTestMessage` against the live `target_id`. A private test chat is optional later, and only after the mock tests pass. The test-channel button in Distribution settings does send a real message; it is not a pacing test.

### Risks

| Risk | What keeps it bounded |
|---|---|
| Deploy changes the channel under a reviewer mid-session | `enabled` defaults false. Slot assignment runs only when it is true. |
| Catch-up after downtime dumps the queue | One send per chat per tick, then rewrite overdue slots. Test the clock-jump case. |
| 429 retry double-posts | Retry only a parsed `ok: false` with no `message_id`. Timeouts stay on the claim. |
| Pull-back after a message exists | Refused when any `pending` or `success` log exists. |
| Manual wire run bypasses the pace | 409 while enabled. |
| Historical approvals get posted | Reconcile lists them. Enqueue is a separate POST and books the tail. The digest does not enqueue. |
| `done` hides a missed send | `sent` requires a success log and message id. Reconciliation lists the rest. |
| Multi-wire entry hits two chats at once | Slot is the max of the two chats, and both chats treat that time as busy. One message per chat, not a burst inside one chat. |
| Post text changes after it was frozen | The draft is written onto `publication_queue` when the row is booked. Send uses that text. A content edit of a queued row regenerates it. The summary is not an input, so auto-summarize finishing later does not change the post. |
| Second Railway instance | The app is single-instance. `SKIP LOCKED` plus the unique log index still prevent two senders from both posting if that assumption breaks. Do not add a second sender. |
| tele-sum duplicate loop | Success rows keep `external_id` and `wire`. Pacing must not invent a log shape that omits them. |
| Quiet hours look like a stuck queue | `scheduled` with a morning timestamp and the reason on the row. Pause says `paused`. Cap says `daily cap`. |
| Schema 5 not applied before the new code boots | Existing `/ready` check refuses to start background work, including the publication timer. |
| Reviving the drip schedule by habit | Do not add the schedule type. Boot deletes that type. The contract test forbids documenting the old file as current. |

---

## Source map

| Piece | Where |
|---|---|
| Approve / bulk approve | `src/services/entry-actions.ts` `applyStatusChange`, `scheduleApproveSideEffects`; `src/routes/scan-entries.ts` |
| Queue worker | `src/services/publication-queue.ts`; timer in `src/server.ts` |
| Send, claim, 3-second batch path | `src/services/distribution.ts` |
| Telegram POST | `src/services/telegram-channel.ts` |
| Tables | `ensureDistributionTables` in `src/db/index.ts` |
| Review UI | `src/routes/distribution.ts`, `client/src/components/dashboard/PublicationReview.tsx` |
| Recovery tests | `tests/publication-recovery-db.test.js` |
| Retired drip | `b46804a`, `d0d6b3f`, `8d48375`, `4bf081b`, deleted in `2feb0db` / PR 56 |
| Immediate approve | `b2748cb`, narrowed in `e2c5cd1` |
| Durable queue | `07c4b1d` / PR 163 |
