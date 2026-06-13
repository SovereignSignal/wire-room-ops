/**
 * Forum lane — one real production run (WRITES to scan_entries via intake).
 *
 * Unlike forum-dryrun.ts, this runs the full pipeline: candidates -> LLM judge ->
 * intake (dedup -> classify -> queue). Entries land in the review queue. Nothing
 * is approved or published — Sov reviews everything.
 *
 * Run:  railway run npx ts-node src/scripts/forum-run-once.ts [wire] [lookbackDays]
 *   e.g. railway run npx ts-node src/scripts/forum-run-once.ts        # all wires, 30d
 */

import { getPool } from '../db';
import { runForumScan } from '../jobs/forum-scan';

async function main() {
  const wire = process.argv[2];
  const lookbackDays = process.argv[3] ? Number(process.argv[3]) : 30;
  const pool = getPool();

  console.log(`\n=== Forum lane REAL RUN — wire=${wire || 'all'}, lookback=${lookbackDays}d ===`);
  console.log('(writes to scan_entries → queue; nothing is approved or published)\n');

  const result = await runForumScan(pool, {
    wire: wire || undefined,
    lookbackDays,
    onProgress: (msg, pct) => console.log(`  [${String(pct).padStart(3)}%] ${msg}`),
  });

  const s = result.intakeSummary;
  console.log('\n--- INTAKE SUMMARY ---');
  console.log(`candidates screened : ${result.candidateCount}`);
  console.log(`opportunities (judge): ${result.opportunityCount}`);
  console.log(`ingested            : ${s.totalIngested}`);
  console.log(`new unique          : ${s.newUnique}`);
  console.log(`duplicates          : ${s.duplicatesFound}`);
  console.log(`high quality (>=60) : ${s.highQualityCount}`);
  console.log(`avg score           : ${s.averageQualityScore}`);
  console.log(`duration            : ${(result.durationMs / 1000).toFixed(1)}s`);

  if (s.topFinds.length > 0) {
    console.log('\n--- TOP FINDS (now in queue) ---');
    for (const f of s.topFinds) {
      console.log(`  [${f.wire}] ${f.qualityScore ?? '—'}  ${f.name}`);
      console.log(`        ${f.sourceUrl}`);
    }
  }

  console.log('\n=== Real run complete. Review in the dashboard queue. ===\n');
  await pool.end();
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Real run failed:', err);
    process.exit(1);
  });
