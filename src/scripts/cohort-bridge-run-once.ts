/**
 * Cohort Notion bridge — one real run (WRITES source_runs + observations +
 * net-new scan_entries via intake).
 *
 * Run:  railway run npx ts-node src/scripts/cohort-bridge-run-once.ts [--dry-run]
 *
 * Use this after a missed 05:00 window. A pending replay cursor in
 * app_state['cohort-bridge:health-v1'] forces the run_id to contain
 * "backfill", which clears the digest alert. Nothing is approved or published.
 */

import { getPool } from '../db';
import { runCohortBridge } from '../jobs/cohort-bridge';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const pool = getPool();

  console.log(`\n=== Cohort bridge ${dryRun ? 'DRY RUN' : 'REAL RUN'} ===`);
  if (!dryRun) {
    console.log('(writes source_runs + observations; net-new Verified/Top of Digest rows enter the queue)\n');
  }

  const result = await runCohortBridge(pool, {
    dryRun,
    onProgress: (msg, pct) => console.log(`  [${String(pct).padStart(3)}%] ${msg}`),
  });

  console.log('\n--- RESULT ---');
  console.log(`skipped     : ${result.skipped}${result.reason ? ` (${result.reason})` : ''}`);
  console.log(`ok          : ${result.ok}`);
  console.log(`run id      : ${result.runId || '—'}`);
  console.log(`backfill    : ${result.isBackfill}`);
  console.log(`since       : ${result.since || '—'}`);
  console.log(`fetched     : ${result.fetched}`);
  console.log(`observations: ${result.observations}`);
  console.log(`promoted    : ${result.promoted}`);
  if (result.error) console.log(`error       : ${result.error}`);
  const s = result.intakeSummary;
  console.log(`ingested    : ${s.totalIngested}`);
  console.log(`new unique  : ${s.newUnique}`);
  console.log(`duplicates  : ${s.duplicatesFound}`);
  console.log(`duration    : ${(result.durationMs / 1000).toFixed(1)}s`);

  if (s.topFinds.length > 0) {
    console.log('\n--- TOP FINDS (now in queue) ---');
    for (const f of s.topFinds) {
      console.log(`  [${f.wire}] ${f.qualityScore ?? '—'}  ${f.name}`);
    }
  }

  console.log(dryRun
    ? '\n=== Dry run complete. Re-run without --dry-run to persist. ===\n'
    : '\n=== Real run complete. Review in the dashboard queue. ===\n');
  await pool.end();
  if (!result.ok && !result.skipped) process.exitCode = 1;
}

main().catch(err => { console.error('Cohort bridge failed:', err); process.exit(1); });
