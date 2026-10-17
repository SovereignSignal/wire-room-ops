/**
 * Archive junk org_profiles (+ matching Notion Orgs pages).
 *
 *   npx ts-node --transpile-only src/scripts/clean-org-profiles.ts --dry-run
 *   npx ts-node --transpile-only src/scripts/clean-org-profiles.ts
 *
 * Production: railway run npx ts-node --transpile-only src/scripts/clean-org-profiles.ts --dry-run
 */

import { getPool } from '../db';
import { runOrgCleanup } from '../migrations/cleanup-org-profiles';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const pool = getPool();
  const result = await runOrgCleanup(pool, { dryRun });
  console.log(JSON.stringify({
    dryRun: result.dryRun,
    wouldArchive: result.archived,
    badOrgsDeleted: result.badOrgsDeleted,
    entriesUnlinked: result.entriesUnlinked,
    notionArchived: result.notionArchived,
    notionMisses: result.notionMisses,
    bracketsFixed: result.bracketsFixed,
    handlesStripped: result.handlesStripped,
    slugsUpdated: result.slugsUpdated,
  }, null, 2));
  await pool.end();
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('[clean-org-profiles] FAILED:', err);
  process.exit(1);
});
