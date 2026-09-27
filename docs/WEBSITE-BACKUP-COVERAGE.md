# Proposed website database backup coverage

Extend the existing daily database backup workflow to include the website's separate PostgreSQL database. The existing 05:00 UTC timing and 30-day retention stay unchanged. The website copy uses a separate `grantswatch/` object prefix and a dedicated read-only credential supplied through `GRANTSWATCH_DATABASE_URL`.

The two backup jobs run independently. A missing credential or failed dump fails the affected job; it cannot upload a partial dump as a success. Retention processes only correctly named backup files within that database's prefix, ignoring directory entries and unrelated objects.

The manual restore workflow offers a database choice. Its default remains Wire Room. Both profiles require exact table inventory and row counts. The website profile additionally requires the four Desk tables and populated proposals/verdicts, preventing an unrelated database from passing as website recovery.

## Activation requirements

This change is prepared for review. Before merging, approve the added recurring database coverage and provision its dedicated read-only login and repository secret. Then run one backup and manually restore each database's new backup. Verify the website's table contents and preserve a fresh role/configuration recovery bundle separately. A logical data dump does not include administrator credentials, GitHub secrets or other external service configuration.

The recovery target is at most one completed daily backup interval of lost database changes, provided the latest job succeeded. This is not point-in-time recovery. Synology copies remain separately verified recovery bundles; this change does not add a Synology schedule or Railway volume-restore test.

## Validation

- Six restore-verifier tests passed, including wrong-database rejection and empty website state tables.
- The website profile matched all 13 tables and 8,811 rows in the existing verified recovery bundle.
- A network-free retention rehearsal preserved recent files, unrelated objects and directory entries, and selected only the expired backup in each database's own prefix.
- Both workflow files parse and retain the existing daily trigger.

No production website role, repository backup secret or additional recurring coverage was enabled during preparation.
