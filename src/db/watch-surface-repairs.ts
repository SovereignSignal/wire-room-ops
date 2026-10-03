/**
 * One-time URL repairs for watch_surfaces rows imported while the old
 * addresses still resolved.
 *
 * Gitcoin: grants.gitcoin.co and the other Grants Stack hosts died when
 * Grants Stack shut down in May 2025. Campaigns live at gitcoin.co/campaigns.
 * gov.gitcoin.co stays; the forum lane already covers it.
 *
 * Octant: octant.app returns 403 to servers and is a JavaScript app.
 * The epoch posts are on the Substack RSS feed.
 *
 * Filecoin (fil.org) is not retargeted. The diff lane skips the plain fetch
 * and scrapes once. See skipsPlainFetch.
 */

import type { Pool } from 'pg';
import { getPool } from './index';

export const GITCOIN_CAMPAIGNS_URL = 'https://gitcoin.co/campaigns';
export const OCTANT_FEED_URL = 'https://octant.substack.com/feed';

export interface SurfaceRepairRow {
  id: number;
  url: string;
  surface_type: string;
  status: string;
}

export interface SurfaceRepairPlan {
  updates: Array<{ id: number; url: string; surface_type: string }>;
  pauses: number[];
}

function hostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

export function surfaceNeedsGitcoinRepair(url: string): boolean {
  const host = hostname(url);
  if (!host || host === 'gov.gitcoin.co') return false;
  if (host !== 'gitcoin.co' && !host.endsWith('.gitcoin.co')) return false;
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '') || '/';
    if (host === 'gitcoin.co' && path === '/campaigns') return false;
  } catch {
    return false;
  }
  return true;
}

export function surfaceNeedsOctantRepair(url: string): boolean {
  const host = hostname(url);
  if (!host) return false;
  return host === 'octant.app' || host.endsWith('.octant.app');
}

function pickKeeper(rows: SurfaceRepairRow[]): SurfaceRepairRow {
  const ranked = [...rows].sort((a, b) => {
    const aActive = a.status === 'active' ? 0 : 1;
    const bActive = b.status === 'active' ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return a.id - b.id;
  });
  return ranked[0];
}

function planTarget(
  rows: SurfaceRepairRow[],
  matches: (url: string) => boolean,
  target: { url: string; surface_type: string },
  plan: SurfaceRepairPlan,
): void {
  const already = rows.find(row => row.url === target.url && row.surface_type === target.surface_type);
  const broken = rows.filter(row => matches(row.url) && row.id !== already?.id);
  if (broken.length === 0) return;
  if (already) {
    plan.pauses.push(...broken.map(row => row.id));
    return;
  }
  const keeper = pickKeeper(broken);
  plan.updates.push({ id: keeper.id, url: target.url, surface_type: target.surface_type });
  plan.pauses.push(...broken.filter(row => row.id !== keeper.id).map(row => row.id));
}

export function planSurfaceRepairs(rows: SurfaceRepairRow[]): SurfaceRepairPlan {
  const plan: SurfaceRepairPlan = { updates: [], pauses: [] };
  planTarget(rows, surfaceNeedsGitcoinRepair, { url: GITCOIN_CAMPAIGNS_URL, surface_type: 'grants_page' }, plan);
  planTarget(rows, surfaceNeedsOctantRepair, { url: OCTANT_FEED_URL, surface_type: 'rss' }, plan);
  return plan;
}

export async function ensureWatchSurfaceRepairs(): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<SurfaceRepairRow>(
    `SELECT id, url, surface_type, status FROM watch_surfaces`,
  );
  const plan = planSurfaceRepairs(rows);
  await applySurfaceRepairs(pool, plan);
  if (plan.updates.length || plan.pauses.length) {
    console.log(`[DB] Watch surface repairs: ${plan.updates.length} retargeted, ${plan.pauses.length} paused`);
  }
}

export async function applySurfaceRepairs(pool: Pool, plan: SurfaceRepairPlan): Promise<void> {
  for (const update of plan.updates) {
    await pool.query(
      `UPDATE watch_surfaces
          SET url = $2, surface_type = $3, status = 'active', updated_at = NOW()
        WHERE id = $1`,
      [update.id, update.url, update.surface_type],
    );
  }
  if (plan.pauses.length > 0) {
    await pool.query(
      `UPDATE watch_surfaces
          SET status = 'paused', updated_at = NOW()
        WHERE id = ANY($1::int[]) AND status <> 'paused'`,
      [plan.pauses],
    );
  }
}
