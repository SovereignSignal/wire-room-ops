/**
 * Weekly issue — one real run (gathers, synthesizes, emails the draft, stores it).
 * Run: railway run npx ts-node src/scripts/weekly-run-once.ts [--no-email]
 */

import { getPool } from '../db';
import { runWeeklyIssue } from '../jobs/weekly-issue';

async function main() {
  const pool = getPool();
  const noEmail = process.argv.includes('--no-email');
  console.log(`\n=== Weekly issue REAL RUN ${noEmail ? '(test: no email, no store)' : '(emails draft + stores for next week)'} ===\n`);
  const result = await runWeeklyIssue(pool, {
    onProgress: (msg, pct) => console.log(`  [${String(pct).padStart(3)}%] ${msg}`),
    skipEmail: noEmail,
    skipStore: noEmail,
  });
  console.log(`\n--- spine=${result.spineCount} alsoOpen=${result.alsoOpenCount} prior=${result.hadPriorIssue ? 'yes' : 'no'} emailed=${result.emailed} ---\n`);
  console.log('================ DRAFT ================\n');
  console.log(result.markdown);
  console.log('\n======================================\n');
  await pool.end();
}

main().then(() => process.exit(0)).catch(e => { console.error('Weekly run failed:', e); process.exit(1); });
