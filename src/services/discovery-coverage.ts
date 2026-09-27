import type { Pool } from 'pg';
import { config } from '../config';
import { tierClause } from './registry-watchers';

/** Read-only coverage: catalog membership never proves a successful poll or intake. */
export async function getDiscoveryCoverage(pool: Pool) {
  const registry = (await pool.query(`SELECT count(*)::int AS catalog,
    count(*) FILTER (WHERE status='active')::int AS active,
    count(*) FILTER (WHERE status='active' AND surface_type IN ('rss','grants_page','application') AND ${tierClause(config.watchtower.registryTiers)})::int AS eligible,
    count(*) FILTER (WHERE last_checked_at IS NOT NULL)::int AS checked_ever,
    max(last_checked_at) AS last_check FROM watch_surfaces`)).rows[0];
  const accounts = (await pool.query(`SELECT count(*)::int AS catalog,
    count(*) FILTER (WHERE enabled)::int AS enabled,
    count(*) FILTER (WHERE last_checked_at IS NOT NULL)::int AS checked_ever,
    max(last_checked_at) AS last_check FROM monitored_accounts`)).rows[0];
  const schedules = (await pool.query(`SELECT schedule_type, count(*)::int AS enabled
    FROM schedules WHERE enabled AND schedule_type IN ('account-monitor','daily-digest','source-feeds') GROUP BY schedule_type`)).rows;
  return {
    registry: { ...registry, mode: !config.watchtower.registryWatchEnabled ? 'disabled' : config.watchtower.registryWatchDryRun ? 'dry-run' : 'live', rss_cap: config.watchtower.registryRssCap, page_cap: config.watchtower.registryDiffCap,
      enabled_schedules: schedules.filter(r => r.schedule_type !== 'account-monitor').reduce((n, r) => n + r.enabled, 0) },
    accounts: { ...accounts, enabled_schedules: schedules.find(r => r.schedule_type === 'account-monitor')?.enabled ?? 0 },
  };
}
