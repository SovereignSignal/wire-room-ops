# Railway cron backup service

Replaces `.github/workflows/backup-db.yml`. GitHub-hosted runners can only reach the databases
through their public TCP proxies, and Sov's rule is that no database is public-facing. This
service runs inside each Railway project and dumps over private networking
(`*.railway.internal`), so the proxies can be removed.

One image, two Railway services (both cron, 05:00 UTC daily, `restartPolicyType = NEVER`):

| Service (create in project) | Dumps | Target (today) |
|---|---|---|
| `db-backup` in **wire-room-db** | wire-room Postgres (PG 17) | `s3://wire-room-backups/` |
| `db-backup` in **grants-dot-watch** | grants-dot-watch Postgres (PG 18) | `s3://wire-room-backups/grantswatch/` |

The targets keep the bucket layout and `backup-YYYYMMDD-HHMMSS.sql.gz` naming the Action uses, so
existing restores, retention and `scripts/verify-sql-restore.py` keep working. pg_dump 18 is used
for both (it can dump PG 17).

## Setup (per service)
1. New service → GitHub repo `SovereignSignal/wire-room-ops`, branch `main`.
2. Settings → Config-as-code file path: `/backup/railway.toml` (builder, Dockerfile path, cron,
   watch paths). Leave Root Directory empty.
3. Variables:
   - `BACKUP_DATABASE_URL`: a reference to the Postgres service's **private** URL in the same
     project (e.g. `${{Postgres.DATABASE_URL}}`, which uses `postgres.railway.internal`).
     **Not** `DATABASE_PUBLIC_URL`.
   - `BACKUP_TARGET`: `s3://<bucket>/<prefix>/`. This is the storage target; change it to move backups.
   - `BACKUP_S3_ENDPOINT`: `https://<CF account id>.r2.cloudflarestorage.com` (omit for AWS S3).
   - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`: same R2 key the Action uses
     (`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` repo secrets), or a new key scoped to the bucket.
   - Optional: `BACKUP_RETENTION_DAYS` (default 30; 0 disables pruning), `AWS_DEFAULT_REGION`
     (default `auto`), `BACKUP_DRY_RUN=1` (dump only, no upload or prune; use for the first run).
4. Run once manually (Deploy → Run now) with `BACKUP_DRY_RUN=1`, then unset it and run again;
   check the object landed and restores (`scripts/verify-sql-restore.py`).

## Retiring the Action
Run both side by side for at least 5 days. Because both write the same naming scheme, and the
cron runs at the same time, you'll see two objects per day under each prefix during the overlap;
that's expected. Then disable `backup-db.yml` (a follow-up PR deletes it), and only after that
remove the public TCP proxies. The other clients that must move first, and the cutover order, are
in `docs/private-database-runbook.md`.

## Behaviour
Fails (non-zero exit, nothing uploaded) if pg_dump fails, reports `error`/`fatal`/`aborting`, or
the dump is under 100 bytes. Pruning only touches `backup-*.sql.gz` objects directly under the
prefix, because the bucket is shared.
