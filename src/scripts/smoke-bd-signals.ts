/**
 * Read-only smoke test for P0 (BD-signal visibility). Runs the exact
 * getSourceBreakdown query the daily digest uses, shows the new `signals`
 * column on live data, and samples recent relationship_signal entries so we
 * can judge the lane's volume AND quality. No writes, no email.
 *   railway run npx ts-node src/scripts/smoke-bd-signals.ts
 */
import { getPool } from '../db';
import { getSourceBreakdown } from '../jobs/daily-digest';

async function main() {
  const pool = getPool();

  console.log('=== Intake by Source (last 24h) — the digest table, now with Signals ===');
  const rows = await getSourceBreakdown(pool);
  if (!rows.length) console.log('(no intake in the last 24h)');
  for (const s of rows) {
    console.log(
      `${s.wire.padEnd(7)} ${s.source.padEnd(16)} in:${String(s.total).padEnd(3)} queued:${String(s.queued).padEnd(3)} approved:${String(s.approved).padEnd(3)} dupes:${String(s.duplicates).padEnd(3)} parked:${String(s.parked).padEnd(3)} signals:${s.signals}`
    );
  }
  console.log(`\nrelationship_signal in last 24h: ${rows.reduce((n, s) => n + s.signals, 0)}`);

  const counts = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS d1,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int  AS d7,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS d30,
      COUNT(*)::int AS all_time
    FROM scan_entries WHERE metadata->>'operator_route' = 'relationship_signal'`);
  console.log('relationship_signal totals (1d / 7d / 30d / all):',
    counts.rows[0].d1, '/', counts.rows[0].d7, '/', counts.rows[0].d30, '/', counts.rows[0].all_time);

  console.log('\n=== Most recent relationship_signal entries (the raw BD lane) ===');
  const sample = await pool.query(`
    SELECT name, wire, scan_source, classification, status, created_at, source_url
    FROM scan_entries
    WHERE metadata->>'operator_route' = 'relationship_signal'
    ORDER BY created_at DESC LIMIT 25`);
  if (!sample.rows.length) console.log('(none found in the DB yet)');
  for (const r of sample.rows) {
    const d = new Date(r.created_at).toISOString().slice(0, 10);
    console.log(`[${d}] ${String(r.wire).padEnd(6)} ${String(r.scan_source).padEnd(12)} ${r.classification}/${r.status}  ${String(r.name || '').slice(0, 80)}`);
  }

  await pool.end();
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
