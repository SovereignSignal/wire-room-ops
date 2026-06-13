/**
 * Lane quality report — read-only readout of what the forum + source-feeds lanes
 * have produced. Run: railway run npx ts-node src/scripts/lane-quality-report.ts [days]
 */

import { getPool } from '../db';

const pad = (s: unknown, n: number) => String(s ?? '').padEnd(n);
const lpad = (s: unknown, n: number) => String(s ?? '').padStart(n);

async function main() {
  const days = Number(process.argv[2] || 7);
  const pool = getPool();
  const since = `NOW() - INTERVAL '${days} days'`;

  // 0. Overall queue right now, by source (context)
  const q0 = await pool.query(
    `SELECT scan_source, COUNT(*) FILTER (WHERE status='queued') queued
     FROM scan_entries GROUP BY scan_source HAVING COUNT(*) FILTER (WHERE status='queued') > 0
     ORDER BY queued DESC`);
  console.log(`\n=== CURRENT QUEUE by source (all-time, status=queued) ===`);
  for (const r of q0.rows) console.log(`  ${pad(r.scan_source, 16)} ${lpad(r.queued, 5)}`);

  // 1. Funnel by lane (last N days)
  const q1 = await pool.query(
    `SELECT scan_source, status, COUNT(*) n
     FROM scan_entries
     WHERE scan_source IN ('forum','feed') AND created_at > ${since}
     GROUP BY scan_source, status ORDER BY scan_source, n DESC`);
  console.log(`\n=== FUNNEL — forum + feed, last ${days}d (status distribution) ===`);
  let curSrc = '';
  for (const r of q1.rows) {
    if (r.scan_source !== curSrc) { curSrc = r.scan_source; console.log(`  ${curSrc}:`); }
    console.log(`     ${pad(r.status, 12)} ${lpad(r.n, 4)}`);
  }

  // 2. Classification mix + avg quality by lane
  const q2 = await pool.query(
    `SELECT scan_source, classification, COUNT(*) n, ROUND(AVG(quality_score)) avg_q
     FROM scan_entries
     WHERE scan_source IN ('forum','feed') AND created_at > ${since}
     GROUP BY scan_source, classification ORDER BY scan_source, n DESC`);
  console.log(`\n=== CLASSIFICATION + avg quality, last ${days}d ===`);
  curSrc = '';
  for (const r of q2.rows) {
    if (r.scan_source !== curSrc) { curSrc = r.scan_source; console.log(`  ${curSrc}:`); }
    console.log(`     ${pad(r.classification, 10)} ${lpad(r.n, 4)}   avg_q=${r.avg_q ?? '—'}`);
  }

  // 3. Per source feed (submitted_by) — which sources produce queue vs noise
  const q3 = await pool.query(
    `SELECT submitted_by,
       COUNT(*) total,
       COUNT(*) FILTER (WHERE status='queued') queued,
       COUNT(*) FILTER (WHERE status='approved') approved,
       COUNT(*) FILTER (WHERE status IN ('archived','declined')) dropped,
       COUNT(*) FILTER (WHERE status='duplicate') dupe,
       ROUND(AVG(quality_score)) avg_q
     FROM scan_entries
     WHERE scan_source IN ('forum','feed') AND created_at > ${since}
     GROUP BY submitted_by ORDER BY total DESC`);
  console.log(`\n=== PER SOURCE (submitted_by), last ${days}d ===`);
  console.log(`  ${pad('source', 26)} ${lpad('tot', 4)} ${lpad('queue', 5)} ${lpad('appr', 4)} ${lpad('drop', 4)} ${lpad('dupe', 4)} ${lpad('avgQ', 5)}`);
  for (const r of q3.rows) {
    console.log(`  ${pad(r.submitted_by, 26)} ${lpad(r.total, 4)} ${lpad(r.queued, 5)} ${lpad(r.approved, 4)} ${lpad(r.dropped, 4)} ${lpad(r.dupe, 4)} ${lpad(r.avg_q ?? '—', 5)}`);
  }

  // 4. What's actually queued right now from these lanes
  const q4 = await pool.query(
    `SELECT wire, quality_score, classification, name, submitted_by
     FROM scan_entries
     WHERE scan_source IN ('forum','feed') AND status='queued'
     ORDER BY quality_score DESC NULLS LAST LIMIT 40`);
  console.log(`\n=== QUEUED NOW from forum + feed (${q4.rowCount} shown, top by score) ===`);
  for (const r of q4.rows) {
    console.log(`  [${pad(r.wire, 6)}] ${lpad(r.quality_score, 3)} ${pad(r.classification, 8)} ${String(r.name).slice(0, 60).padEnd(60)} ${r.submitted_by}`);
  }

  console.log('');
  await pool.end();
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
