/**
 * Source Feeds — one real run (WRITES net-new items to scan_entries via intake).
 * Run: railway run npx ts-node src/scripts/source-feeds-run-once.ts [wire] [sourceKey]
 * Nothing is approved or published — items land in the review queue.
 */

import { getPool } from '../db';
import { runSourceFeeds } from '../jobs/source-feeds';

async function main() {
  const wire = process.argv[2];
  const sourceKey = process.argv[3];
  const pool = getPool();

  console.log(`\n=== Source Feeds REAL RUN — wire=${wire || 'all'}${sourceKey ? `, source=${sourceKey}` : ''} ===`);
  console.log('(writes net-new to scan_entries → queue; nothing approved/published)\n');

  const result = await runSourceFeeds(pool, {
    wire: wire || undefined,
    sourceKeys: sourceKey ? [sourceKey] : undefined,
    onProgress: (msg, pct) => console.log(`  [${String(pct).padStart(3)}%] ${msg}`),
  });

  console.log('\n--- PER SOURCE ---');
  for (const s of result.perSource) {
    console.log(`  ${s.key.padEnd(20)} fetched=${String(s.fetched).padStart(3)} fresh=${String(s.fresh).padStart(3)}${s.firstRun ? ' (first run)' : ''}${s.error ? `  ERROR: ${s.error}` : ''}`);
  }
  const s = result.intakeSummary;
  console.log('\n--- INTAKE SUMMARY ---');
  console.log(`total fresh : ${result.totalFresh}`);
  console.log(`ingested    : ${s.totalIngested}`);
  console.log(`new unique  : ${s.newUnique}`);
  console.log(`duplicates  : ${s.duplicatesFound}`);
  console.log(`high quality: ${s.highQualityCount}`);
  console.log(`duration    : ${(result.durationMs / 1000).toFixed(1)}s`);

  if (s.topFinds.length > 0) {
    console.log('\n--- TOP FINDS (now in queue) ---');
    for (const f of s.topFinds) console.log(`  [${f.wire}] ${f.qualityScore ?? '—'}  ${f.name}`);
  }

  console.log('\n=== Real run complete. Review in the dashboard queue. ===\n');
  await pool.end();
}

main().then(() => process.exit(0)).catch(err => { console.error('Real run failed:', err); process.exit(1); });
