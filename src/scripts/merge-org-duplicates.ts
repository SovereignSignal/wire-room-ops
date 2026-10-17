/**
 * Merge reviewed CRM org duplicates (+ optional matching Orgs pages).
 *
 *   npx ts-node --transpile-only src/scripts/merge-org-duplicates.ts --dry-run
 *   npx ts-node --transpile-only src/scripts/merge-org-duplicates.ts
 *
 * Production: railway run npx ts-node --transpile-only src/scripts/merge-org-duplicates.ts --dry-run
 */

import { getPool } from '../db';
import { runKnownOrgMerges } from '../migrations/merge-org-duplicates';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const pool = getPool();
  const result = await runKnownOrgMerges(pool, { dryRun });
  console.log(JSON.stringify(result, null, 2));
  await pool.end();
  if (result.errors.length > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('[merge-org-duplicates] FAILED:', err);
  process.exit(1);
});
