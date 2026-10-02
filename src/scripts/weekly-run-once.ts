/**
 * Weekly issue — one real run (gathers, synthesizes, lands the draft in the Notion Paste Log, stores it).
 * Run: railway run npx ts-node src/scripts/weekly-run-once.ts [--dry-run]
 */

import { getPool } from '../db';
import { runWeeklyIssue } from '../jobs/weekly-issue';

async function main() {
  // --no-email was the old test flag. Without this guard it would now be ignored and do a real run.
  if (process.argv.includes('--no-email')) throw new Error('--no-email was replaced by --dry-run');
  const pool = getPool();
  const dryRun = process.argv.includes('--dry-run');
  console.log(`\n=== Weekly issue ${dryRun ? 'DRY RUN (no Notion landing, no store)' : 'REAL RUN (lands in Notion + stores for next week)'} ===\n`);
  const result = await runWeeklyIssue(pool, {
    onProgress: (msg, pct) => console.log(`  [${String(pct).padStart(3)}%] ${msg}`),
    skipDelivery: dryRun,
    skipStore: dryRun,
  });
  console.log(`\n--- spine=${result.spineCount} alsoOpen=${result.alsoOpenCount} prior=${result.hadPriorIssue ? 'yes' : 'no'} notionLanded=${result.notionLanded} ---\n`);
  console.log('================ DRAFT ================\n');
  console.log(result.markdown);
  console.log('\n======================================\n');
  await pool.end();
}

main().then(() => process.exit(0)).catch(e => { console.error('Weekly run failed:', e); process.exit(1); });
