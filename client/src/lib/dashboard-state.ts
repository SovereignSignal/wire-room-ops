export type DashboardHealth = 'online' | 'degraded' | 'offline';

export const DASHBOARD_TABS = ['overview', 'queue', 'scans', 'grants-intel', 'database', 'settings'] as const;

export function dashboardTabFromPath(pathname: string): string {
  const segment = pathname.replace(/^\/+|\/+$/g, '');
  return (DASHBOARD_TABS as readonly string[]).includes(segment) ? segment : 'overview';
}

export function dashboardPathForTab(tab: string): string {
  return (DASHBOARD_TABS as readonly string[]).includes(tab) ? `/${tab}` : '/overview';
}

export function deriveDashboardHealth(
  results: readonly PromiseSettledResult<unknown>[],
): DashboardHealth {
  const succeeded = results.filter(result => result.status === 'fulfilled').length;
  if (succeeded === 0) return 'offline';
  if (succeeded === results.length) return 'online';
  return 'degraded';
}

export function normalizeQualityScore(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const score = Number(value);
  return Number.isFinite(score) ? score : null;
}

export function isInScoreBand(
  score: number | null,
  min: number | null,
  max: number | null,
): boolean {
  if (min === null && max === null) return true;
  if (score === null) return false;
  if (min !== null && score < min) return false;
  if (max !== null && score > max) return false;
  return true;
}

export function visibleSelection(
  selectedIds: ReadonlySet<string>,
  visibleIds: ReadonlySet<string>,
): Set<string> {
  return new Set([...selectedIds].filter(id => visibleIds.has(id)));
}

export function effectiveOperatorRoute(metadata: {
  curator?: { route?: string };
  operator_route?: string;
} | null | undefined): string {
  return metadata?.curator?.route || metadata?.operator_route || 'none';
}
