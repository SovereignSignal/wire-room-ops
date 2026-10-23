/**
 * Mark open calls whose deadline has passed as closed (lifecycle 'closed',
 * classification 'EXPIRED'). The daily-digest cycle runs the same pass first
 * when OPEN_CALL_AUTO_CLOSE_ENABLED=true; this is for reviewing the list, or a
 * manual run before a grants.watch Desk sync.
 *
 * Dry run (default), prints what would close:
 *   npx ts-node --transpile-only src/scripts/close-expired-calls.ts
 * Apply:
 *   npx ts-node --transpile-only src/scripts/close-expired-calls.ts --apply
 *
 * Uses DATABASE_URL. Grace period: OPEN_CALL_EXPIRY_GRACE_HOURS (default 6).
 */

import { closePool, getPool } from '../db';
import { closeExpiredOpenCalls } from '../services/open-call-expiry';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const result = await closeExpiredOpenCalls(getPool(), { dryRun: !apply });
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
