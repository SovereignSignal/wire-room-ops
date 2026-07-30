/**
 * Deterministic program-state repair.
 *
 * Default mode is read-only and emits the exact mutation plan plus its hash:
 *   railway run npx ts-node src/scripts/program-integrity-repair.ts
 *
 * Apply only the reviewed, unchanged plan:
 *   railway run npx ts-node src/scripts/program-integrity-repair.ts \
 *     --apply --expect-plan-hash <sha256>
 */
import { closePool, getPool } from '../db';
import { runProgramIntegrityRepair } from '../services/program-integrity';

export interface ProgramRepairCliOptions {
  apply: boolean;
  expectedPlanHash?: string;
}

export function parseProgramRepairArgs(argv: string[]): ProgramRepairCliOptions {
  let apply = false;
  let dryRun = false;
  let expectedPlanHash: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--expect-plan-hash') {
      expectedPlanHash = argv[++i];
      if (!expectedPlanHash) throw new Error('--expect-plan-hash requires a value');
    } else if (arg.startsWith('--expect-plan-hash=')) {
      expectedPlanHash = arg.slice('--expect-plan-hash='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (apply && dryRun) throw new Error('--apply and --dry-run cannot be combined');
  if (!apply && expectedPlanHash) throw new Error('--expect-plan-hash is only valid with --apply');
  if (apply && !/^[a-f0-9]{64}$/.test(expectedPlanHash ?? '')) {
    throw new Error('--apply requires --expect-plan-hash with the reviewed 64-character SHA-256 hash');
  }
  return { apply, expectedPlanHash };
}

async function main(): Promise<void> {
  const options = parseProgramRepairArgs(process.argv.slice(2));
  try {
    const receipt = await runProgramIntegrityRepair(getPool(), options);
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('PROGRAM INTEGRITY REPAIR FAILED:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
