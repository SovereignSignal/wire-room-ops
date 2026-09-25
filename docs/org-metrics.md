# Organization derived metrics

Schema version 2 makes the database responsible for these fields:

- `entry_count`: linked entries with status `queued` or `approved`.
- `avg_quality_score`: their average non-null quality score, rounded to one decimal; null if none.
- `tier`: Tier 1 when count is at least 5 and average at least 60; otherwise Tier 2 when count is at least 2 or average at least 50; otherwise Tier 3.

Repeated profile sightings, digest mentions, duplicates, declined entries and archived entries do not increase these metrics. Other organization metadata keeps its existing behavior. This change neither resolves organization identity nor changes delivery eligibility.

Statement triggers collect affected organizations from inserted, updated or deleted entries. Locks are acquired in organization ID order before aggregation. At the default READ COMMITTED isolation level, a waiting writer aggregates again after the preceding writer commits. A failed metric update rolls back the entry mutation. Explicit transactions touching multiple entry batches can still deadlock and must be retried as a whole by their caller.

A profile trigger also corrects direct writes to the derived fields, including writes from the previous application release during rollout. The normal refresh calls the same database calculation and changes `updated_at` only when a derived value changes.

Only the entry trigger uses `SECURITY DEFINER`, owned by the migration owner. Its search path is fixed to `pg_catalog`, the trusted installation schema, then `pg_temp`. Public execute permission is revoked so callers cannot attach it to their own tables. This lets entry-only maintenance roles trigger the narrowly defined derived update without granting them direct profile writes. The installation schema must remain unwritable by service roles.

## Release

1. Capture and restore-verify a current backup. Rehearse migration against that restore and verify existing table rows are unchanged except the schema-version record.
2. Run `npm run db:migrate -- --apply` with the separate migration-owner connection. Runtime roles cannot install this migration. Installation of the metric functions and triggers is atomic and uses a five-second lock timeout.
3. Deploy schema-version-2 application code promptly. The previously running release can keep processing with the new triggers, but restarting version-1 code after migration fails its version gate.
4. Confirm `/ready`, schema version, scheduler state, derived values and restricted-role behavior. Startup's existing derived refresh repairs any preexisting drift; the migration itself does not backfill rows.

To roll back application logic while retaining the triggers, keep schema-version-2 readiness and the migration contract in the rollback build. Do not deploy an unmodified version-1 build against version 2. Removing triggers requires a separately reviewed migration; do not lower the marker alone.
