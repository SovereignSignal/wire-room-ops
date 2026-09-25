import { getPool } from '../db';
import { repairProgramOrgLinks } from '../services/program-org-links';

async function main() {
  const apply = process.argv.includes('--apply');
  const hash = process.argv.find(arg => arg.startsWith('--expect-plan-hash='))?.split('=')[1];
  if (apply && !/^[a-f0-9]{64}$/.test(hash || '')) {
    throw new Error('Apply requires --expect-plan-hash=<hash from the reviewed dry run>');
  }
  const pool = getPool();
  try {
    console.log(JSON.stringify(await repairProgramOrgLinks(pool, apply ? hash : undefined), null, 2));
  } finally {
    await pool.end();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
