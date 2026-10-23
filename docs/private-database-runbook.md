# Private database runbook

How to take the two Railway Postgres databases off the public internet, and
how to operate them afterwards. The databases are the wire-room Postgres in
the `wire-room-db` project and grants.watch's Postgres in the
`grants-dot-watch` project. Each has one public TCP proxy: "the wire-room-db
proxy" and "the grants.watch proxy" below.

This repo is public. Hosts, ports, project IDs, login names and values do not
belong in it; commands use `<placeholders>`. Never paste a connection string
or password into a terminal that is logged, an agent shell, an issue, or a
commit.

Related: `docs/read-api.md` (the read API), `docs/railway-deploy.md`
(migrations and the two app logins), `backup/README.md` (backup cron).

## 1. Who connects today

### Through the wire-room-db proxy

| Client | Where it runs | Variable | What it does | Moves to |
|---|---|---|---|---|
| grants.watch web | `grants-dot-watch` project | `WIRE_DATABASE_URL` | Three readers: the Wire handoff change feed (`src/lib/wire-handoff.ts`), the keyed `/api/v1/updates` pager (`src/lib/wire-updates.ts`), and ingest (`src/lib/ingest.ts`) | Read endpoints, follow-up (section 2.4) |
| grant-wire-scout (Claude scout) | `grant-wire-scout` project | `DATABASE_URL` | Reads `scan_entries` in `lib/known_programs.py`, `lib/name_dedup.py`, `lib/skip_if_fed.py`; writes the `scout_runs` ledger (`lib/ledger.py`) and `scout_alerts` (`lib/notify.py`) | `/api/read` for reads, `/api/scout` for the ledger (section 2.2). No `DATABASE_URL` afterwards |
| grant-wire-grok | `grant-wire-scout` project | `DATABASE_URL` | Same code as the Claude scout | Same |
| grant-wire-heartbeat | `grant-wire-scout` project | `DATABASE_URL` | `lib/heartbeat.py` counts plus `scout_runs` reads; `lib/digest.py` queue, backlog, outcomes plus `scout_runs` reads; `scout_alerts` writes | Same |
| Scout score scripts | wherever someone runs them | `DATABASE_URL` | `bin/scoreboard.sh`, `bin/ab-score.sh` (psql) | `/api/read/intake-counts` |
| tele-sum web | `tele-sum` project | `DATABASE_URL` | Writes `summaries`/`messages`, reads `distribution_logs` for its round-trip guard | Recreated inside `wire-room-db` (plan step 5); not an API move |
| Backup workflow | GitHub Actions, `backup-db.yml` | secret `DATABASE_URL` | Nightly `pg_dump` to R2 | `db-backup` cron in `wire-room-db` (`backup/README.md`) |
| Rotation toolkit | Sov's Mac, `~/.railway-rotation/` | the public URL | `ro-role-rotate.sh` runs `ALTER ROLE`; `db-secret-set.sh` updates secret rows in tables such as `api_providers` | SSH tunnel (section 5) |
| Local tooling | Sov's machines | its own URL file | `grant-wire-engine` (code not visible from here); `grant-wire-weekly` was retired on 2026-10-23 and its secret files deleted | Read API, or the operator path for anything it writes |
| Unknown | anywhere | — | Step 0c of the plan finds them | — |

The scouts already use HTTP for URL dedup (`lib/dedup.py`, `GET /api/scan/seen-urls`)
and for submitting (`lib/submit.py`). Their `INTERNAL_API_KEY` variable holds
the scoped `grant-wire-scout` / `grant-wire-grok` key, which already has
`read_queue`. Each key also needs the new `ledger` scope, added after this PR
is deployed (section 2.2).

### Inside `wire-room-db` (not proxy clients, but check their variables)

| Service | Variables | Check |
|---|---|---|
| wire-room-ops | `DATABASE_URL` (runtime login), `MIGRATION_DATABASE_URL` (schema owner, pre-deploy only) | Both must use the private host (section 3) |
| wro-ro-query | `RO_DATABASE_URL`, `QUERY_TOKEN` | `RO_DATABASE_URL` is rewritten as a literal by `ro-role-rotate.sh`; confirm its host is the private one |

wro-ro-query is a raw-SQL HTTP service. Its callers are the ops bot's box
(scan inventory, pre-approval check, cost table) and Sov's local Claude MCP
entry. It does not use the proxy, but it is a public door to SQL. The read
API replaces its routine uses (section 2.1).

### Through the grants.watch proxy

| Client | Where it runs | Variable | Moves to |
|---|---|---|---|
| Backup workflow | GitHub Actions, `backup-db.yml` in this repo | secret `GRANTSWATCH_DATABASE_URL` | `db-backup` cron in `grants-dot-watch` |
| Desk sync | GitHub Actions, `desk-sync.yml` in grants-dot-watch | secret `SYNC_DATABASE_URL` (restricted login) | Railway cron with a repo-scoped PAT (section 6) |
| Rotation toolkit | Sov's Mac | the public URL | SSH tunnel (section 5) |

No Railway service references the grants.watch proxy.

### Not database clients

- The Grok Telegram Batch relay (`.github/workflows/grok-scout-submit.yml`)
  only calls `POST /api/scan/telegram-batch` with the `grok-batch` intake key.
- `test-restore.yml` reads backups from R2 and restores into a throwaway
  Postgres on the runner.

## 2. Moving readers onto the read API

### 2.1 wro-ro-query callers

1. Mint a key for the ops bot's box:
   `npm run curator-key:mint -- --name ops-box --scopes read_queue`. Add the
   hash to `WIRE_ROOM_CURATOR_KEYS` (validate the list with
   `loadCuratorKeys()` first; an invalid list fails closed) and give the
   token to the box in place of its wro-ro-query secret file.
2. Switch the box scripts to the endpoints in the mapping table at the end of
   `docs/read-api.md`: scan inventory to `/intake-counts?days=7` (and
   `by=prompt`), pre-approval check to `/entries?status=queued&include=metadata`
   and `/entries/:id`, cost table to `/usage-daily`.
3. Sov's local MCP: routine questions go to the same endpoints with a
   `read_queue` key. Ad hoc SQL goes through the operator path (section 4.2)
   in a read-only session.
4. When nothing calls wro-ro-query for a week, retire it or remove its public
   domain. Sov decides which.

### 2.2 Scouts (grant-wire-scout repo)

Sov chose option A on 2026-10-23: wire-room-ops owns the scout ledger, and
the three scout services stop using a database login. Reads and ledger writes
both move to HTTP. Each change keeps the module's current best-effort
contract: an HTTP error returns what a DB error returns today, and a failed
ledger write never fails a run.

#### Reads

| File | Today | Read API |
|---|---|---|
| `lib/known_programs.py` | names by producer or decided status | `/api/read/names?wire=W&days=120&limit=400&source=<self>&status=approved,declined,archived,duplicate,deduped` |
| `lib/name_dedup.py` | declined/archived names | `/api/read/names?wire=W&days=180&limit=10000&status=declined,archived` |
| `lib/skip_if_fed.py` | another lane's rows in N hours | `/api/read/intake-counts?hours=N&wire=W&source=<others>&by=wire` |
| `lib/heartbeat.py` (`hb:counts`) | per-wire count for the scout sources | `/api/read/intake-counts?hours=N&source=claude-code,grok-scout&by=wire` |
| `lib/heartbeat.py` (`hb:runs`, `hb:lanes`, `hb:trend`) | `scout_runs` by `run_id LIKE ANY(…)` and window | `/api/read/scout-runs?hours=N&run_id_prefix=claude-code-,grok-build-`; the trend adds `days=30&until=…&status=ok,skipped` and sums per wire and day itself |
| `lib/digest.py` (queue, backlog, outcomes) | rows, queued count, source × status | `/api/read/entries?source=…&hours=N`, `/api/read/backlog?status=queued`, `/api/read/intake-counts?days=7&source=…` |
| `lib/digest.py` (runs, spend, lane runs) | `scout_runs` in N hours, 31 days by model, 7 days | `/api/read/scout-runs` with `hours=N`, `days=31`, `days=7` and the run id prefixes; spend is grouped by the caller |
| `lib/heartbeat.py`, `lib/digest.py` (`hb:funnel`, `digest:funnel`) | `information_schema` check for `found_count` | Drop it: `/scout-runs` always returns `found_count` and `dedup_dropped` |
| `bin/scoreboard.sh` | week × source × wire × variant | `/api/read/intake-counts?days=30&by=week,source,wire,variant&source=claude-code,grok-scout` |
| `bin/ab-score.sh` | one source by variant | `/api/read/intake-counts?days=30&by=variant&source=claude-code` |

Notes:

- The scouts reuse `WIRE_ROOM_API` and their existing key. The heartbeat has
  neither today: give it `WIRE_ROOM_API` and its own key
  (`--name grant-wire-heartbeat --scopes read_queue,ledger`, since it also
  records alerts) so it can be revoked on its own.
- `scoreboard.sh` also lists `grok-build`, which is not a `scan_source` yet.
  The read API returns `400` for unknown sources, so drop it from the list
  until the enum exists.
- The scoreboard counts archived rows as rejections; compute that rate from
  `by_status`. `avg_quality_score` is returned per group.
- One key allows 120 reads per 5 minutes. A scout run makes a handful.

#### Ledger writes

| File | Today | API |
|---|---|---|
| `lib/ledger.py` | upsert into `scout_runs` | `PUT /api/scout/runs/<run_id>` |
| `lib/notify.py` (`_record_alert`) | insert into `scout_alerts` | `POST /api/scout/alerts` with an `Idempotency-Key` |

Contract and validation rules: "Scout ledger writes" in `docs/read-api.md`.
The upsert keeps `ledger.py`'s rules (earliest `started_at` kept, outcome
fields replaced), so SQL writes and API writes can overlap during the switch.
A run belongs to the key that first writes it through the API, and another
key gets `409`.

#### What this PR does to the database

Schema version 14 (`src/db/scout-ledger.ts`), applied by the pre-deploy
migration:

- If `scout_runs` and `scout_alerts` do not exist, it creates them.
- If they exist (the scouts made them by hand), it adopts them in place. It
  adds only the columns it is missing (`found_count`, `dedup_dropped`,
  `recorded_by` on runs; `id`, `recorded_by`, `idempotency_key` on alerts),
  a unique index on `run_id` if there is none, and `created_at` indexes. It
  changes no column type, adds no constraint that existing rows could fail,
  and deletes nothing. Adding `id` rewrites `scout_alerts` once; the table
  is small.
- The runtime login gets `SELECT, INSERT, UPDATE` on `scout_runs` and
  `SELECT, INSERT` on `scout_alerts`.

**Pre-check (Sov).** `ALTER TABLE` and `GRANT` on an existing table need its
owner or a superuser. Through 4.2, read-only:

```sql
SELECT tablename, tableowner FROM pg_tables
WHERE schemaname = 'public' AND tablename IN ('scout_runs', 'scout_alerts');
```

No rows: nothing to check. Both tables owned by the migration login (the one
in `MIGRATION_DATABASE_URL`; `docs/railway-deploy.md` describes it): fine.
If that login is a superuser, any owner is fine. Otherwise, any other owner
makes the pre-deploy migration fail with exit 1, and the previous deployment
stays live. Fix it first, as a superuser through 4.2, with Sov's approval:
`ALTER TABLE scout_runs OWNER TO <migration login>;` and the same for
`scout_alerts`. Then run the migration dry run in 4.5; its plan should list
`scout-ledger` at version 14.

#### Keys

`ledger` is a new scope. An unknown scope makes the whole
`WIRE_ROOM_CURATOR_KEYS` list invalid, so add it only after this PR is live:

- `grant-wire-scout` and `grant-wire-grok`: edit each entry's `scopes` to add
  `ledger`. The token and its hash do not change.
- `grant-wire-heartbeat`: mint it with `read_queue,ledger`.

Validate the edited list with `loadCuratorKeys()` before setting it. Check
each token without writing a row: `PUT /api/scout/runs/scope-check` with the
body `{}` returns `400` (status missing) for a key with `ledger`, and `403`
for one without.

#### Copying existing ledger rows

The scouts' `DATABASE_URL` goes through the wire-room-db proxy, and the same
connection reads `scan_entries`, so the ledger rows are most likely already
in this database. The migration then adopts them and there is nothing to
copy. `src/scripts/copy-scout-ledger.ts` settles it either way: its dry run
compares the scouts' database with this one and reports `to_copy` per table,
which is `0` for both when they are the same database.

Run it after every scout lane writes through the API (so no new rows land in
the old place) and before the scouts' `DATABASE_URL` or the proxy it uses
is removed. It runs inside the wire-room-ops container, so the target is the
app's own `DATABASE_URL`. The source URL goes in on stdin and is never
printed; this pipes it from the scout service's variables without showing it.
In a directory linked to the `grant-wire-scout` project:

```bash
railway run -s grant-wire-scout -- sh -c 'printf %s "$DATABASE_URL"' \
  | (cd ~/ops/wire-room-db && railway ssh -s wire-room-ops -- node dist/scripts/copy-scout-ledger.js)
```

The output is a JSON report per table: `found`, `columns`, `source_rows`,
`already_here`, `to_copy`. If both `to_copy` values are `0`, stop: nothing
to copy. Otherwise, with Sov's approval, run the same command with
`copy-scout-ledger.js --apply`. It inserts the missing rows in one
transaction, never changes a row that is already here (runs match on
`run_id`, alerts on `subject` and `created_at`), and marks copied rows
`recorded_by = 'copy:scout-ledger'`. A rerun copies nothing. The source
connection uses the app's `DB_SSL_REJECT_UNAUTHORIZED` setting.

#### Removing the database login

When the reads and ledger writes are on HTTP and the copy check is done,
remove `DATABASE_URL` from `grant-wire-scout`, `grant-wire-grok` and
`grant-wire-heartbeat`. Check: the next run of each lane appears in
`/api/read/scout-runs` with its own `recorded_by`, and the heartbeat still
reports. If the scouts had a login of their own, drop it (section 9).
The scouts stay in their project; they are not recreated in `wire-room-db`.

### 2.3 tele-sum

tele-sum is a writer of `summaries`, so it is recreated inside `wire-room-db`
(plan step 5) with a private reference, not moved to the API.

### 2.4 grants.watch wire readers (follow-up)

The read API in this PR does not cover grants.watch. Its three readers need
their own endpoints and a client change in grants-dot-watch behind a flag,
with `WIRE_DATABASE_URL` as the fallback until the proxy goes:

| Reader | What an endpoint must keep |
|---|---|
| Wire handoff change feed | `scan_entries` joined to `org_profiles`; cursor on `GREATEST(se.created_at, se.updated_at, op.created_at, op.updated_at)` with microseconds, plus id; no status filter (withdrawals must arrive); a by-id reconcile scan; batches of at most 200 |
| `/api/v1/updates` pager | approved, distributable, undeduplicated rows by id, with a `through_id` snapshot (today `REPEATABLE READ`) |
| Ingest | rows by a status list after a `(created_at, id)` watermark, with the org join and `operator_route` |

Mint a `grants-watch` key (`read_queue`) and store it in grants.watch as
`WIRE_API_TOKEN` next to `WIRE_API_URL`.

## 3. Check before any proxy is deleted

Deleting a proxy breaks anything still using its address, and a new proxy
gets a new address. Confirm these first, without printing values:

1. wire-room-ops `DATABASE_URL` and `MIGRATION_DATABASE_URL` use the private
   host. wire-room-ops was recreated inside `wire-room-db`, so the app and the
   pre-deploy migration can use a reference such as
   `${{Postgres.DATABASE_URL}}`.
2. wro-ro-query `RO_DATABASE_URL` uses the private host.
3. The backup cron's `BACKUP_DATABASE_URL` uses the private host.

This prints each variable's host class and nothing else. The script goes in
on stdin, so the remote shell does not re-split it. Run it in a linked
project directory (section 4.1):

```bash
railway ssh -s wire-room-ops -- node - <<'JS'
for (const k of ["DATABASE_URL", "MIGRATION_DATABASE_URL"]) {
  const v = process.env[k];
  console.log(k, !v ? "unset" : new URL(v).hostname.endsWith(".railway.internal") ? "private" : "NOT PRIVATE");
}
JS
```

Use the same check for `RO_DATABASE_URL` on wro-ro-query if its image has
`node`, or read the variable in the dashboard's raw editor: a reference shows
as `${{…}}`.

To find unknown clients (plan step 0c), group live sessions by login and
application name. `client_addr` can show Railway's proxy rather than the
real client, so do not rely on it alone:

```sql
SELECT usename, application_name, count(*) FROM pg_stat_activity
WHERE backend_type = 'client backend' GROUP BY 1, 2 ORDER BY 3 DESC;
```

Attribution is easier if each known client sets `application_name` in its URL
(`?application_name=grant-wire-heartbeat`); libpq and node-postgres both
read it. Railway's network metrics for the TCP proxy show whether anything
still uses it.

## 4. Operator access with no public proxy

### 4.1 One-time setup

- Install a current Railway CLI. `railway connect --help` must list `--ssh`;
  if it does not, upgrade the CLI.
- `railway login`, then register a key: `railway ssh keys add`.
- Link one directory per project so commands never need a project ID:
  `railway link` in `~/ops/wire-room-db` (project `wire-room-db`,
  environment `production`) and in `~/ops/grants-dot-watch`.
- A local `psql` 18 works against both servers (PG 17 and PG 18).

### 4.2 psql

Shell into the database container and use the local socket. No password
crosses the network and nothing is printed:

```bash
cd ~/ops/wire-room-db          # or ~/ops/grants-dot-watch
railway ssh -s Postgres
# inside the container:
PGOPTIONS='-c default_transaction_read_only=on' psql -U postgres -d railway   # read-only session
psql -U postgres -d railway                                                   # when a write is approved
```

The database name is the Postgres service's `PGDATABASE` (`railway` unless it
was changed). If the socket asks for a password, the image's local auth was
changed; use the tunnel in 4.4.

### 4.3 `railway connect`

Older CLIs read `DATABASE_PUBLIC_URL` and fail once the proxy is gone. Current
CLIs tunnel over SSH when the database has no proxy. While a proxy still
exists, `railway connect` uses it unless you pass `--ssh`, so test the
private path with:

```bash
railway connect Postgres --ssh
```

Do not use `--tunnel-only` in a logged terminal or an agent shell: it prints
the user, password and full connection URL.

### 4.4 Tunnel for local tools

For the rotation toolkit or a GUI client, forward a local port through a
service in the same project. The tunnel is dialed from inside that container,
and Railway only allows the container's loopback and the project's private
network as destinations.

```bash
cd ~/ops/wire-room-db
railway ssh config --service wire-room-ops --alias wro-db-hop      # once; writes an ~/.ssh/config block
ssh -N -L 15432:postgres.railway.internal:5432 wro-db-hop          # keep running while you work

cd ~/ops/grants-dot-watch
railway ssh config --service grants-dot-watch --alias gw-db-hop
ssh -N -L 25432:postgres.railway.internal:5432 gw-db-hop
```

Confirm the private host on each Postgres service (`RAILWAY_PRIVATE_DOMAIN`)
before relying on `postgres.railway.internal`. A service with no domain is
reached by its service instance ID as the SSH user (dashboard, `Cmd+K`, Copy
Service Instance ID). Local clients then connect to `127.0.0.1:15432` or
`127.0.0.1:25432` with `sslmode=require` (`prefer` if the server has TLS
off). Certificate checks pinned to a proxy host name do not apply.

### 4.5 Migrations

Normal releases need no operator access: the pre-deploy command
(`node dist/scripts/migrate-database.js --apply`) runs inside Railway. It
keeps working after the proxy is deleted as long as `MIGRATION_DATABASE_URL`
is private (section 3).

By hand, from the running app container (it has the built `dist/` and both
variables):

```bash
cd ~/ops/wire-room-db
railway ssh -s wire-room-ops -- node dist/scripts/migrate-database.js           # dry run, prints the plan
railway ssh -s wire-room-ops -- node dist/scripts/migrate-database.js --apply   # needs Sov's approval
```

The script logs the login name, never the URL. Run the verification SQL in
`docs/railway-deploy.md` through 4.2.

### 4.6 Bastion fallback

Use a bastion only when 4.2 to 4.4 are not enough.

- **Temporary client box.** A service named `db-bastion` in the same project:
  image `postgres:18-alpine`, start command `sleep infinity`, no domain, no
  proxy, and `DATABASE_URL` set to `${{Postgres.DATABASE_URL}}`. Reach it with
  `railway ssh -s db-bastion` for `psql`, `pg_dump` or `pg_restore`. Delete
  the service when the job is done.
- **Standing route.** Railway's Tailscale Forwarder template
  (`CONNECTION_MAPPING_1=5432:postgres.railway.internal:5432`) lets devices on
  Sov's tailnet reach the database by the forwarder's machine name. It puts a
  reusable `TS_AUTHKEY` in Railway, so tag the key and allow only Sov's
  devices to reach that tag in the tailnet ACL. Add it only if Sov wants a
  permanent route.

## 5. The rotation toolkit

Today `ro-role-rotate.sh` and `db-secret-set.sh` in `~/.railway-rotation/`
open admin connections through each database's public URL. `rw-deploy.sh`
only redeploys services and does not touch a database. The changes belong in
the toolkit, not in this repo:

1. Open the tunnels in 4.4 first. Each script refuses to run when its port is
   not listening (`nc -z 127.0.0.1 15432`).
2. Read the admin URL from the Postgres service's `DATABASE_URL` (private).
   `DATABASE_PUBLIC_URL` stops resolving when the proxy is deleted. Swap the
   host and port in memory and never echo the result:

   ```bash
   tunnel_url() {  # usage: ADMIN_URL="$(SRC_URL="$src" tunnel_url 15432)"
     python3 -c 'import os,sys,urllib.parse as u; p=u.urlsplit(os.environ["SRC_URL"]); print(u.urlunsplit(p._replace(netloc=p.netloc.rpartition("@")[0]+"@127.0.0.1:"+sys.argv[1])))' "$1"
   }
   ```

3. Use `sslmode=require` on the tunnel URL, as in 4.4. The hop off the Mac
   is already inside SSH.
4. When a script rewrites a service variable, keep the host as
   `${{Postgres.RAILWAY_PRIVATE_DOMAIN}}` (or the private literal), never a
   proxy host. Generate passwords with `openssl rand -hex 32` so they need no
   URL encoding.
5. Verify the same two ways as today, minus the public URL: `SELECT 1` as
   the rotated login through the tunnel, and the dependent service's own
   health check after its redeploy (`/ready` on wire-room-ops, the health
   route on wro-ro-query).

Dry-run both scripts against both tunnels before either proxy is deleted.

## 6. grants.watch Desk sync as a Railway cron

Sov's decision: Desk sync runs as a Railway cron in the `grants-dot-watch`
project with a repo-scoped GitHub token. It does not get write endpoints on
the site. This replaces plan step 2. The code lives in grants-dot-watch, so
this section lists what that repo needs.

### What the job does today

`.github/workflows/desk-sync.yml`, daily at 18:30 UTC, 60-minute limit,
`contents: write`:

1. `sync-desk-commits.mjs --confirm-deployment "$SITE"` for rows an earlier
   run deployed.
2. On a local `sync/desk-ledger-<date>-<run>` branch, commit unsynced ledger
   rows (`--dry-run`, then the real run, which writes `sha` and the attempt
   columns through `SYNC_DATABASE_URL`).
3. `close-stale-rounds.mjs --write --json --ledger-paths` with a pinned
   `VALIDATION_NOW`, committed on the same branch.
4. If there are commits: `npm run validate`, `validate:funding`, `npm test`;
   merge `--no-ff` into `main` and push; poll `$SITE/api/v1/deployment` for
   up to 30 minutes; confirm the synced rows.

The only reason it reaches the database through the proxy is that GitHub
runners are outside Railway.

### What grants-dot-watch needs

- **One shared script.** Move the step bodies into a script (for example
  `scripts/desk-sync.sh` with `prepare` and `finish` phases) that the workflow
  and the cron both call, so they cannot drift. `prepare` runs steps 1 to 3,
  validation and the local merge, and records whether there is anything to
  push. `finish` waits for the deploy and confirms. The run id comes from
  `GITHUB_RUN_ID` or `RAILWAY_DEPLOYMENT_ID`. With `DESK_SYNC_DRY_RUN=1`,
  `prepare` runs only the `--dry-run` forms of `sync-desk-commits.mjs`.
- **An image** (`desk-sync/Dockerfile`): Node 22 plus `git`, `jq`, `curl` and
  CA certificates. A Dockerfile rather than the web service's Railpack build,
  so those tools are certain to be there.
- **An entrypoint** that clones `main` fresh each run, keeps the token away
  from `npm ci` and the repo scripts, and uses it only to push. The repo is
  public, so clone and fetch need no token. Sketch:

  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  : "${DESK_SYNC_GITHUB_TOKEN:?}" "${SYNC_DATABASE_URL:?}" "${SITE:?}"
  basic="$(printf 'x-access-token:%s' "$DESK_SYNC_GITHUB_TOKEN" | base64 | tr -d '\n')"
  unset DESK_SYNC_GITHUB_TOKEN
  push() {
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.https://github.com/.extraheader \
      GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $basic" git push --quiet "$@" origin main
  }
  work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
  git clone --quiet https://github.com/SovereignSignal/grants-dot-watch.git "$work/repo"
  cd "$work/repo" && npm ci
  scripts/desk-sync.sh prepare          # writes .desk-sync/merge-sha when there is a merge to push
  if [ -n "${DESK_SYNC_DRY_RUN:-}" ]; then push --dry-run; exit 0; fi
  if [ -s .desk-sync/merge-sha ]; then push && scripts/desk-sync.sh finish; fi
  ```

  Start it as `timeout 3600 desk-sync` so a stuck run ends like the
  workflow's 60-minute limit. No `set -x`, no `GIT_TRACE`.
- **A Railway service** `desk-sync` in `grants-dot-watch`, created in the
  dashboard like research-backfill-runner. `.railway/railway.ts` manages only
  the web service partial; do not add the cron there unless that partial is
  widened on purpose. Set the Dockerfile path, restart policy **Never** and,
  at switch-over, cron `30 18 * * *` in the service settings. Railway stops
  reading Config as Code files on 2026-12-01, so do not rely on one for the
  schedule. Railway skips a cron tick while the previous run is still going.
- **Variables on that service only:**
  - `DESK_SYNC_GITHUB_TOKEN`, sealed.
  - `SYNC_DATABASE_URL`: the restricted sync login with the host
    `${{Postgres.RAILWAY_PRIVATE_DOMAIN}}`, port 5432 and database
    `${{Postgres.PGDATABASE}}`. Copy the current password from the login
    the workflow uses; it is rotated with the rest in phase 5.
  - `SITE=https://grants.watch`.
  - `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`,
    `GIT_COMMITTER_EMAIL`: a desk-sync identity, with the token owner's
    noreply address so commits link to an account.
  - `DESK_SYNC_DRY_RUN=1` for the first runs.
- **README:** the "Ledger operating rules" name the workflow as the sync
  owner. Update them when ownership moves.

### The token

A fine-grained personal access token with access to
`SovereignSignal/grants-dot-watch` only: Contents read and write, Metadata
read, nothing else. No Workflows permission, so it cannot change CI. Set an
expiry and a renewal reminder. The organisation may need to approve
fine-grained tokens.

Risk, stated plainly: the token can push to `main`, and `main` deploys
grants.watch, so a leaked token is deploy access to the site. Seal it, keep
it on the one service, and rotate it with the other Railway secrets. A
GitHub App installation token has the same reach without a person's account
behind it, if Sov prefers that later.

Behaviour changes: a push with this token starts the CI workflow on `main`,
which a `GITHUB_TOKEN` push did not. Keep the in-job validation anyway,
because it has to pass before the push. If `main` has branch protection or a
ruleset that the Actions bot bypasses today, the token's owner needs the same
bypass, or the push is refused.

### Switch-over

1. Merge the grants-dot-watch change that adds the shared script, image and
   entrypoint. The workflow keeps its schedule and calls the shared script.
2. Create the token and the service with `DESK_SYNC_DRY_RUN=1` and no
   schedule. Run it by hand: the clone, the `--dry-run` reads over the
   private host and `git push --dry-run` (which proves the token can push)
   must all pass.
3. In one sitting: remove `schedule:` from `desk-sync.yml` (keep
   `workflow_dispatch` as the manual fallback), unset `DESK_SYNC_DRY_RUN`,
   and set the cron schedule on the service.
4. Watch three daily runs, at least one with real rows, through the confirm
   step.
5. When the grants.watch proxy is deleted, the workflow fallback cannot
   connect. Delete the workflow and its `SYNC_DATABASE_URL` secret then.

Rollback before step 5: clear the service's schedule and put `schedule:` back
in the workflow.

## 7. Backups

`backup/README.md` covers the `db-backup` cron for both projects. Run each
cron side by side with `backup-db.yml` for at least 5 days, check a restore
(`test-restore.yml` or `scripts/verify-sql-restore.py`), then disable the
workflow's schedule. Copy each cron's schedule and restart policy onto the
service settings before 2026-12-01, when Railway stops reading
`backup/railway.toml`.

## 8. Cutover order

Each step lists its check. Steps marked **(Sov)** change production and need
Sov's approval first; the list in section 10 repeats them in order.

### Phase 1: read API live

1. **(Sov)** Before merging: the scout ledger table-owner pre-check
   (section 2.2) and the migration dry run (4.5). The plan should list
   `scout-ledger` at schema version 14.
2. **(Sov)** Merge this PR. Railway deploys `main`, and the pre-deploy
   migration applies schema version 14 (the scout ledger tables). No new
   variable. Check: `/ready` passes; `GET /api/read/backlog` with a
   `read_queue` key returns `200` and a `POST` returns `403`;
   `GET /api/read/scout-runs?days=1` returns the scouts' recent runs if the
   tables were adopted.
3. **(Sov)** Edit `WIRE_ROOM_CURATOR_KEYS`: mint `ops-box` (`read_queue`) and
   `grant-wire-heartbeat` (`read_queue,ledger`), and add `ledger` to the
   `grant-wire-scout` and `grant-wire-grok` entries. Validate with
   `loadCuratorKeys()`, then redeploy. Check: each read token gets `200` from
   `/api/read/intake-counts?days=1`, and each ledger token gets `400` (not
   `403`) from `PUT /api/scout/runs/scope-check` with `{}`.

### Phase 2: clients moved

4. **(Sov)** Switch the box scripts and the local MCP to the read API
   (section 2.1).
5. **(Sov)** Merge the scout change in grant-wire-scout (reads and ledger on
   HTTP; see this PR's description) and give the heartbeat `WIRE_ROOM_API`
   and its key. Check: one run per lane appears in `/api/read/scout-runs`
   with that lane's `recorded_by`, and the heartbeat and digest show the same
   counts as the previous day's SQL output.
6. **(Sov)** Scout ledger copy check (section 2.2): dry run, then `--apply`
   only if a `to_copy` is above `0`.
7. **(Sov)** Remove `DATABASE_URL` from the three scout services. Check: the
   next run of each lane is recorded and the heartbeat still reports.
8. **(Sov)** Recreate tele-sum inside `wire-room-db` (plan step 5).
9. **(Sov)** grants.watch wire readers on the API (follow-up PRs in both
   repos), flag on. Check: grants.watch pages and `/api/v1/updates` match
   before and after.
10. **(Sov)** Backup crons in both projects, side by side for 5 days, then
    disable `backup-db.yml`.
11. **(Sov)** Desk sync cron (section 6).
12. **(Sov)** Confirm section 3: every in-project variable is private.
13. **(Sov)** Retire wro-ro-query or remove its public domain.

### Phase 3: operator path tested

14. **(Sov)** On both projects: `railway ssh -s Postgres` read-only `psql`,
    `railway connect Postgres --ssh`, and both tunnels.
15. **(Sov)** Migration dry run through `railway ssh` on wire-room-ops.
16. **(Sov)** Rotation toolkit dry runs through both tunnels.

### Phase 4: proxies deleted

17. **(Sov)** Delete the wire-room-db proxy after 7 days with no proxied
    connections (section 3 query plus Railway's proxy metrics), a fresh
    backup and a passing `test-restore.yml`. Check: every service healthy
    for 24 hours and the next backup lands.
18. **(Sov)** Delete the grants.watch proxy after steps 10 and 11 and the
    same quiet period.
19. **(Sov)** Remove what pointed at them: the `DATABASE_URL` and
    `GRANTSWATCH_DATABASE_URL` Actions secrets here, `SYNC_DATABASE_URL` and
    the workflow in grants-dot-watch, `WIRE_DATABASE_URL` on grants.watch,
    and the old tele-sum service.

Rollback for 17 and 18: create a new TCP proxy (it gets a new host and port)
and point the one affected client at it. The old address cannot be
recovered, which is why deletion comes after everything else has moved.

### Phase 5: both database passwords rotated

20. **(Sov)** Rotate every login on the wire-room-db Postgres (section 9).
21. **(Sov)** Rotate every login on the grants.watch Postgres.

## 9. Rotating after the proxies are gone

Every login on each database was usable over the internet while its proxy
existed, so rotate all of them, not only the superuser. List them through 4.2:

```sql
SELECT rolname FROM pg_roles WHERE rolcanlogin ORDER BY 1;
```

Drop a login nothing uses any more (for example a login only the scouts used,
after step 7, or grants.watch's wire reader after step 9) instead of
rotating it.

**Superuser.** The Postgres service's `PGPASSWORD`, `DATABASE_URL` and
`DATABASE_PUBLIC_URL` follow `POSTGRES_PASSWORD` by reference, but the image
only applies `POSTGRES_PASSWORD` when the data directory is first created.
Changing the variable alone changes nothing on the server.

1. Generate the value (`openssl rand -hex 32`) into the toolkit's values file,
   not the terminal.
2. `railway ssh -s Postgres`, then `psql -U postgres -d railway` and
   `\password postgres`, pasting the value at the prompt (it is not echoed).
   `\password` sends a hashed value, so the plain text is not in the server
   log or psql history.
3. Set `POSTGRES_PASSWORD` to the same value with **skip deploys**, so the
   database does not restart.
4. Redeploy every service whose variables reference the superuser URL:
   wire-room-ops for `MIGRATION_DATABASE_URL`, the backup cron, and anything
   else that references it. References resolve at deploy time, so a service
   that is not redeployed keeps the old value. Check `/ready`.

Connections opened before step 2 keep working. New connections with the old
password fail until their service redeploys, so do steps 2 to 4 together.

**Other logins.** `\password <login>` the same way. Update the one variable
that holds it, then redeploy the service and check its health route.
`ro-role-rotate.sh` already does this for the read-only query login. Run it
through the tunnel (section 5).

## 10. Production steps for Sov

Nothing in this PR changes Railway, GitHub settings, variables or passwords.
Each step needs Sov's go:

1. Check who owns `scout_runs` and `scout_alerts` (fix the owner if needed), and dry-run the migration.
2. Merge this PR (deploys the read API and the scout ledger endpoints; the pre-deploy migration applies schema version 14).
3. Mint the `ops-box` and `grant-wire-heartbeat` keys and add `ledger` to the two scout keys in `WIRE_ROOM_CURATOR_KEYS`.
4. Move the box scripts and the local MCP to the read API.
5. Merge the scout change (reads and ledger on HTTP) and give the heartbeat its API variables.
6. Run the scout ledger copy dry run; apply only if it finds rows to copy.
7. Remove `DATABASE_URL` from the three scout services.
8. Recreate tele-sum inside `wire-room-db`.
9. Build and switch the grants.watch wire readers to the API (follow-up).
10. Create both backup crons; disable `backup-db.yml` after 5 days.
11. Create the Desk sync token and cron; switch ownership from the workflow.
12. Confirm every in-project database variable uses the private host.
13. Retire wro-ro-query or remove its public domain.
14. Test the operator path on both projects (ssh psql, `railway connect --ssh`, tunnels).
15. Dry-run the migration over `railway ssh`.
16. Update the rotation toolkit and dry-run it through the tunnels.
17. Delete the wire-room-db proxy after 7 quiet days.
18. Delete the grants.watch proxy after Desk sync and backups have moved.
19. Remove the dead secrets, variables, workflows and old services.
20. Rotate every login on the wire-room-db Postgres.
21. Rotate every login on the grants.watch Postgres.
