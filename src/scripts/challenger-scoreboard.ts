/**
 * Challenger scoreboard: last-N-days intake per scan_source, with queue and
 * approval rates, plus month-to-date Watchtower spend. This is the number that
 * decides cutovers (spec: challenger must beat incumbent 3 consecutive weeks).
 * The manual Grok flow shows up as 'telegram' (summarizer channel bridge);
 * the automated challengers as 'x-list' and 'x-scan'.
 *
 * Usage: npx ts-node src/scripts/challenger-scoreboard.ts [--days 7]
 */
import { getPool } from '../db';
import { checkBudget } from '../services/budget-guard';
import { reviewedApprovalRate } from '../services/approval-rate';

export interface ScoreRow { scan_source: string; total: number; queued: number; approved: number; declined: number }

export function formatScoreboard(rows: ScoreRow[]): string {
  if (!rows.length) return 'Scoreboard: no entries in window.';
  const pct = (approved: number, declined: number) => {
    const rate = reviewedApprovalRate(approved, declined);
    return rate == null ? '-' : `${Math.round(rate * 100)}%`;
  };
  const lines = ['source            total  queued  approved  reviewed'];
  for (const r of rows) {
    lines.push(
      `${r.scan_source.padEnd(17)} ${String(r.total).padStart(5)} ${String(r.queued).padStart(7)} ${String(r.approved).padStart(9)} ${pct(r.approved, r.declined).padStart(10)}`,
    );
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const daysArg = process.argv.indexOf('--days');
  const days = daysArg > -1 ? Number(process.argv[daysArg + 1]) || 7 : 7;
  const pool = getPool();
  const { rows } = await pool.query<ScoreRow>(
    `SELECT scan_source,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status IN ('queued', 'enriched'))::int AS queued,
            COUNT(*) FILTER (WHERE status IN ('approved', 'published'))::int AS approved,
            COUNT(*) FILTER (WHERE status = 'declined')::int AS declined
       FROM scan_entries
      WHERE created_at >= NOW() - ($1 || ' days')::interval
      GROUP BY scan_source
      ORDER BY total DESC`,
    [days],
  );
  console.log(`Challenger scoreboard — last ${days} days\n`);
  console.log(formatScoreboard(rows));
  const budget = await checkBudget(pool);
  console.log(`\nWatchtower spend month-to-date: $${budget.spentUsd} of $${budget.capUsd} cap`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => { console.error('[Scoreboard] FAILED:', err.message); process.exit(1); });
}
