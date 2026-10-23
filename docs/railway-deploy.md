# Railway deploy: schema migration and the runtime role

How a release reaches production, which database logins it uses, and what to
set on the `wire-room-ops` service. Written for the schema v5 rollout
(PR #193, paced distribution) and kept as the standing runbook.

## Two logins, one database

| Login | Variable | Rights | Used by |
|---|---|---|---|
| Runtime role | `DATABASE_URL` | row read/write on the tables in `scripts/database-runtime-grants.sql`, no DDL, read-only on `wro_schema_migrations` | the running app (`node dist/index.js`) |
| Migration owner | `MIGRATION_DATABASE_URL` | schema owner: `ALTER TABLE`, `CREATE INDEX`, writes to `wro_schema_migrations`, `GRANT` | the pre-deploy command only |

The app never reads `MIGRATION_DATABASE_URL`. `src/config/index.ts` reads
`DATABASE_URL` and nothing else, and `tests/migration-connection.test.js`
fails if any other source file mentions the owner variable. The variable is
visible inside the service container because Railway hands every service
variable to both the pre-deploy container and the app container; the app just
has no code path that uses it. Seal it in Railway so it cannot be read back
from the dashboard or the API.

## What the pre-deploy command does

```text
node dist/scripts/migrate-database.js --apply
```

1. Picks the connection: `MIGRATION_DATABASE_URL` if set, else `DATABASE_URL`.
   Logs the source and the login name, never the URL or password.
2. Takes an advisory lock, creates `wro_schema_migrations` if missing, and
   applies only the steps newer than the recorded version. A database already
   at the current version is a no-op. Existing rows are not rewritten
   (`tests/paced-distribution-migration.test.js` and
   `tests/migration-role-db.test.js` pin this).
3. Records the new version in the same run. A failed step throws before the
   version is written, so a retry starts from the old version.
4. Re-applies the runtime grants to the runtime role, then verifies every
   table, sequence and schema privilege with `has_table_privilege`. The
   runtime role is the login in `DATABASE_URL` when it differs from the
   migration login, or `RUNTIME_DATABASE_ROLE` when that is set. A missing
   privilege or a missing role exits 1.
5. Exits 0. Any error exits 1, Railway marks the deployment failed, and the
   previous deployment keeps serving.

Column-only migrations (v5 is one) need no new grant because table grants
cover new columns. The grant step still runs so a new table in a later
version is usable before the app boots, and so a revoked grant is noticed at
deploy time instead of as a runtime 42501.

## One-time setup on Railway (do this before redeploying)

All of this happens in the `wire-room-db` project, which holds both the
Postgres service and `wire-room-ops` (the service was recreated there in
October 2026).

1. **Find the owner login.** It is the superuser/owner login the database was
   created with: the Postgres service's `DATABASE_URL`. If the runtime role
   was created from a different owner, use that owner. The login has to own
   the tables, or be a member of the owning role, or `ALTER TABLE` is
   refused.
2. **Confirm the runtime role name.** It is the username in the
   `wire-room-ops` service's `DATABASE_URL`. The migration derives the role
   from that variable; only set `RUNTIME_DATABASE_ROLE` if the login in
   `DATABASE_URL` is not the role that should hold the grants.
3. **Add the variable** on the `wire-room-ops` service (environment
   `production`): Variables → New Variable → name `MIGRATION_DATABASE_URL`,
   value `${{Postgres.DATABASE_URL}}`. The reference resolves to the private
   host (`*.railway.internal`), so it keeps working after the public TCP
   proxy is deleted, and a superuser rotation reaches it on the next deploy.
   Do not use `DATABASE_PUBLIC_URL`, and do not paste a literal string.
   `docs/private-database-runbook.md` section 3 has a check that prints only
   whether each variable is private.
4. **Deploy the staged change.** Adding a variable stages a change; apply it.
   Railway redeploys the current commit (main, which includes #193 and #194).
   The pre-deploy container now runs the migration as the owner. Watch the
   deploy logs for:

   ```text
   [Schema] Migrating as <owner-login> via MIGRATION_DATABASE_URL
   [Migrations] 1 schema migrations processed
   [Schema] Version 5 ready
   [Schema] Runtime grants verified for role <runtime-role>
   ```

   then the start command and a passing `/ready` healthcheck.

If the pre-deploy step fails, nothing changed for traffic: deployment
`86acb211` (schema v4 code) stays live. Fix the cause and redeploy. Common
causes: the owner login does not own the tables (`must be owner of table`),
the runtime role name differs from the `DATABASE_URL` user (set
`RUNTIME_DATABASE_ROLE`), or the migration owner cannot `GRANT` on a table it
does not own.

## Verify after the deploy

Run the SQL as the owner (Railway → `wire-room-db` → Postgres → Data tab, or
`psql` inside the database container over `railway ssh`, as in
`docs/private-database-runbook.md` section 4.2). Nothing here writes.

```sql
-- 1. Version 5 recorded, once.
SELECT version, applied_at FROM wro_schema_migrations ORDER BY version;

-- 2. The v5 columns and index exist.
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE (table_name, column_name) IN (('publication_queue', 'created_at'), ('distribution_logs', 'sent_at'));
SELECT indexname FROM pg_indexes WHERE indexname = 'idx_publication_queue_due';
SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'publication_queue_status_check';

-- 3. The runtime role can still use the tables it needs.
SELECT has_table_privilege('<runtime-role>', 'publication_queue', 'SELECT, INSERT, UPDATE, DELETE') AS pq,
       has_table_privilege('<runtime-role>', 'distribution_logs', 'SELECT, INSERT, UPDATE, DELETE') AS dl,
       has_table_privilege('<runtime-role>', 'wro_schema_migrations', 'SELECT') AS gate;

-- 4. Pacing is still off. Do not change this key here.
SELECT value FROM app_state WHERE key = 'distribution:pace';
```

Expected: one row with `version = 5`; `created_at` `timestamp with time zone`
NOT NULL with a `now()` default and `sent_at` nullable; the index present; the
constraint listing `withheld`; three `true` values; and either no
`distribution:pace` row or one without `"enabled": true`.

Then from the outside:

- `GET https://<service-domain>/ready` returns `"status": "ready"` with
  `checks.startupMigrations: true`. A v5 build on a v4 database never gets
  here; it exits at boot with `[Schema] Expected schema version 5`.
- Dashboard → Settings → **DISTRIBUTION** shows the outgoing panel with the
  banner **"Pacing off — approvals publish immediately"**. That text is the
  pace-off branch of `GET /api/distribution/outgoing`; if it reads
  "Next post …" the flag is on, which this rollout does not do.
- Approve one low-stakes entry and confirm it posts immediately and gets a
  `distribution_logs` row with `status = 'success'`, `external_id` set and
  `sent_at` populated.

## Before 2026-12-01: copy the run settings onto the service

Railway stops reading `railway.json` (Config as Code) on 2026-12-01. Today the
file overrides the dashboard; after that date only the dashboard values
apply, and the service has no pre-deploy command saved there. Copy these onto
the service before then, in the `wire-room-ops` service → **Settings** →
**Deploy** section:

| Dashboard field | Value |
|---|---|
| Pre-deploy command | `node dist/scripts/migrate-database.js --apply` |
| Pre-deploy timeout | `300` (the field appears only after the command is entered) |
| Custom start command | `node dist/index.js` |
| Healthcheck path | `/ready` |
| Healthcheck timeout | `300` |
| Restart policy | Always |
| Draining time | `15` seconds |

Builder stays Nixpacks. Setting these while `railway.json` is still read is
harmless: the file and the dashboard agree, and when the file stops applying
nothing changes. `tests/railway-config.test.js` keeps the file's values
pinned to the same strings so the two cannot drift before the cutoff.

Do not adopt the `.railway/railway.ts` that `railway config migrate`
generates without editing it: its plan treats anything the file omits as
removed, including the service variables and the GitHub source.

## Running the migration by hand

Against production, from the running app container, which has the built
`dist/` and both variables. No public database address is involved:

```bash
railway ssh -s wire-room-ops -- node dist/scripts/migrate-database.js          # dry run, prints the plan
railway ssh -s wire-room-ops -- node dist/scripts/migrate-database.js --apply
```

Against a non-Railway host, after `npm run build`:

```bash
MIGRATION_DATABASE_URL='<owner url>' DATABASE_URL='<runtime url>' node dist/scripts/migrate-database.js          # dry run, prints the plan
MIGRATION_DATABASE_URL='<owner url>' DATABASE_URL='<runtime url>' node dist/scripts/migrate-database.js --apply
```

Local dev and CI use one owner login for everything, so `DATABASE_URL` alone
is enough and the grant step logs that it was skipped.
`scripts/database-runtime-grants.sql` is the psql copy of the same grants for
a host without the built image; `tests/runtime-grants-lockstep.test.js` keeps
it equal to `src/db/runtime-grants.ts`.
