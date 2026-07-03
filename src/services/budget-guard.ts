/**
 * Watchtower budget guard. One number, one gate: month-to-date discovery spend
 * vs WATCHTOWER_BUDGET_MONTHLY_USD (Sov's cap: $10-20). Grok spend comes from
 * api_usage_log.estimated_cost_usd; X reads are metered here (pay-per-use has
 * no pricing row) via an app_state monthly counter at $0.005/post read.
 */
import type { Pool } from 'pg';
import { getAppState, setAppState } from '../db';
import { config } from '../config';

export const TWITTER_READ_UNIT_USD = 0.005; // X pay-per-use post read (Feb 2026 pricing)

function monthKey(): string {
  return `watchtower:xreads:${new Date().toISOString().slice(0, 7)}`; // e.g. watchtower:xreads:2026-07
}

export function computeMonthSpend(
  grokCostUsd: number | null | undefined,
  twitterReads: number | null | undefined,
  twitterUnitUsd: number,
): number {
  return Math.round(((grokCostUsd || 0) + (twitterReads || 0) * twitterUnitUsd) * 100) / 100;
}

export async function recordTwitterReads(count: number): Promise<void> {
  const key = monthKey();
  const current = (await getAppState<number>(key)) || 0;
  await setAppState(key, current + count);
}

// Grok purposes that count as Watchtower discovery spend. 'watchtower%' covers
// everything this plan adds. When Tier 2 (x-scan revival) activates, verify the
// purpose string scan-execution passes to logApiUsage and add its pattern here —
// classification/summary Grok spend must NOT count (it predates the Watchtower).
export const WATCHTOWER_GROK_PURPOSE_PATTERNS = ['watchtower%'];

export async function checkBudget(pool: Pool): Promise<{ allowed: boolean; spentUsd: number; capUsd: number }> {
  const capUsd = config.watchtower.budgetMonthlyUsd;
  const { rows } = await pool.query<{ cost: string | null }>(
    `SELECT COALESCE(SUM(estimated_cost_usd), 0) AS cost
       FROM api_usage_log
      WHERE provider = 'grok'
        AND purpose LIKE ANY($1)
        AND created_at >= date_trunc('month', NOW())`,
    [WATCHTOWER_GROK_PURPOSE_PATTERNS],
  );
  const grokCost = Number(rows[0]?.cost || 0);
  const twitterReads = (await getAppState<number>(monthKey())) || 0;
  const spentUsd = computeMonthSpend(grokCost, twitterReads, TWITTER_READ_UNIT_USD);
  return { allowed: spentUsd < capUsd, spentUsd, capUsd };
}
