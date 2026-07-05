/**
 * One-shot registry-watch dry run: real selection, real fetches, real hashes,
 * NO intake submission (dryRun forced). Prints per-lane stats.
 * Usage: railway run -- npx ts-node src/scripts/registry-watch-dryrun.ts
 *
 * Note: the enabled gate in runRegistryWatch reads REGISTRY_WATCH_ENABLED at
 * CALL time (not import time — see its comment: "Read at call time ... so
 * tests don't need require-cache gymnastics"), so setting it in main() right
 * before the call is sufficient; it doesn't need to precede the imports.
 */
import { getPool } from '../db';
import { runRegistryWatch } from '../jobs/registry-watch';

async function main(): Promise<void> {
  process.env.REGISTRY_WATCH_ENABLED = 'true';
  const result = await runRegistryWatch(getPool(), { dryRun: true });
  console.log(JSON.stringify(result, null, 2));
}

main().then(() => process.exit(0)).catch(err => { console.error('FAILED:', err.message); process.exit(1); });
