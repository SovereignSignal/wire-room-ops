/**
 * Watchtower budget guard. One number, one gate: month-to-date discovery spend
 * vs WATCHTOWER_BUDGET_MONTHLY_USD. Covered provider spend comes from
 * api_usage_log.estimated_cost_usd; X reads are metered here (pay-per-use has
 * no pricing row) via an app_state monthly counter at TWITTER_READ_UNIT_USD
 * per read — the owned-read price, since these reads are of the account's
 * own X Lists, not third-party posts.
 */
import type { Pool } from 'pg';
import { getAppState, setAppState } from '../db';
import { flushUsageLogs } from './api-usage';
import { config } from '../config';

export const TWITTER_READ_UNIT_USD = 0.001; // owned-read price: reads of the account's own Lists (X pay-per-use, Feb 2026)

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

// 'scan%' = production scans plus Prompt Lab tests. Tests stay out of the
// production run ledger but still count against the discovery budget. 'summarize'
// and classification purposes are deliberately excluded — they predate the Watchtower.
// 'parallel-%' = the Parallel lane's grok planning/extraction inside scan-execution.
export const WATCHTOWER_GROK_PURPOSE_PATTERNS = ['watchtower%', 'scan%', 'parallel-%'];

export async function checkBudget(pool: Pool): Promise<{ allowed: boolean; spentUsd: number; capUsd: number; unpricedCalls: number }> {
  const capUsd = config.watchtower.budgetMonthlyUsd;
  await flushUsageLogs();
  const { rows } = await pool.query<{ cost: string | null; unpriced: number }>(
    `WITH costs AS (
       SELECT COALESCE(u.estimated_cost_usd, p.per_request_cost,
         CASE WHEN u.tokens_in IS NOT NULL OR u.tokens_out IS NOT NULL THEN
           (COALESCE(u.tokens_in,0) * p.input_cost_per_1m + COALESCE(u.tokens_out,0) * p.output_cost_per_1m) / 1000000 END) AS cost
       FROM api_usage_log u LEFT JOIN model_pricing p ON p.provider = u.provider AND p.model = u.model
       WHERE u.provider IN ('grok','perplexity','parallel','anthropic','firecrawl')
         AND u.purpose LIKE ANY($1) AND u.created_at >= date_trunc('month', NOW())
     ) SELECT SUM(cost) AS cost, COUNT(*) FILTER (WHERE cost IS NULL)::int AS unpriced FROM costs`,
    [WATCHTOWER_GROK_PURPOSE_PATTERNS],
  );
  const providerCost = Number(rows[0]?.cost || 0);
  const unpricedCalls = Number(rows[0]?.unpriced || 0);
  const twitterReads = (await getAppState<number>(monthKey())) || 0;
  const spentUsd = computeMonthSpend(providerCost, twitterReads, TWITTER_READ_UNIT_USD);
  return { allowed: unpricedCalls === 0 && spentUsd < capUsd, spentUsd, capUsd, unpricedCalls };
}

/** Serialize paid prompt attempts and settle accounting before admitting another. */
export async function withDiscoveryBudget<T>(pool: Pool, run: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let locked = false;
  try {
    locked = (await client.query(`SELECT pg_try_advisory_lock(hashtext('discovery-budget')) AS locked`)).rows[0].locked;
    if (!locked) throw new Error('Discovery budget busy; another paid attempt is active');
    const budget = await checkBudget(pool);
    if (!budget.allowed) throw new Error(`Discovery budget unavailable: $${budget.spentUsd} of $${budget.capUsd}; ${budget.unpricedCalls} unpriced calls`);
    try { return await run(); }
    finally { await flushUsageLogs(); }
  } finally {
    try { if (locked) await client.query(`SELECT pg_advisory_unlock(hashtext('discovery-budget'))`); }
    finally { client.release(); }
  }
}
