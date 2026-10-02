-- Manual psql copy of src/db/runtime-grants.ts, for a host without the built image.
-- The release migration command (node dist/scripts/migrate-database.js --apply)
-- applies and verifies these same grants itself after every schema apply.
-- Run as the schema owner after migration, with psql -v runtime_role=<existing-role>.
-- The role must be a login with no elevated attributes, memberships or ownership.
-- Keep this explicit list aligned with application queries when adding tables.
\set ON_ERROR_STOP on
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'runtime_role') \gexec
GRANT USAGE ON SCHEMA public TO :"runtime_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON
  sessions, feeds, schedules, scan_entries, scan_prompts, seen_urls, seen_names,
  intake_runs, distribution_config, distribution_channels, distribution_logs,
  publication_queue, org_profiles, discovered_contacts, programs, watch_surfaces,
  integration_config, app_state, monitored_accounts, api_providers, model_pricing,
  source_runs, opportunity_observations, telegram_intake_receipts, generated_files
TO :"runtime_role";
GRANT SELECT, INSERT ON api_usage_log TO :"runtime_role";
GRANT SELECT ON wro_schema_migrations TO :"runtime_role";
-- Shared importer/archive tables are optional in standalone installations.
SELECT format('GRANT SELECT, INSERT, UPDATE ON public.summaries TO %I', :'runtime_role')
WHERE to_regclass('public.summaries') IS NOT NULL \gexec
SELECT format('GRANT SELECT ON public.%I TO %I', name, :'runtime_role')
FROM unnest(ARRAY['messages', 'categories', 'grant_entries']) AS tables(name)
WHERE to_regclass(format('public.%I', name)) IS NOT NULL \gexec
-- Grant only sequences owned by writable tables above, not every public sequence.
SELECT format('GRANT USAGE ON SEQUENCE %s TO %I',
              pg_get_serial_sequence(format('%I.%I', table_schema, table_name), column_name),
              :'runtime_role')
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'sessions', 'feeds', 'schedules', 'scan_entries', 'scan_prompts', 'seen_urls',
    'seen_names', 'intake_runs', 'distribution_config', 'distribution_channels',
    'distribution_logs', 'publication_queue', 'org_profiles', 'discovered_contacts',
    'programs', 'watch_surfaces', 'integration_config', 'app_state',
    'monitored_accounts', 'api_providers', 'model_pricing', 'source_runs',
    'opportunity_observations', 'telegram_intake_receipts', 'generated_files',
    'summaries', 'api_usage_log'
  )
  AND pg_get_serial_sequence(format('%I.%I', table_schema, table_name), column_name) IS NOT NULL
\gexec
