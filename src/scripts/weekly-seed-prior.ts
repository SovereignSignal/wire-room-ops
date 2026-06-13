/**
 * Seed the weekly "prior issue" (app_state) so the next scheduled run has a voice
 * exemplar + lookback source. Run:
 *   railway run npx ts-node src/scripts/weekly-seed-prior.ts <date> <path-to-markdown>
 */

import { readFileSync } from 'fs';
import { setAppState, getPool } from '../db';

async function main() {
  const date = process.argv[2];
  const path = process.argv[3];
  if (!date || !path) { console.error('usage: weekly-seed-prior.ts <yyyy-mm-dd> <markdown-path>'); process.exit(1); }
  const markdown = readFileSync(path, 'utf8');
  getPool(); // ensure pool initialized
  await setAppState('weekly:last-issue', { date, markdown });
  console.log(`Seeded weekly:last-issue = { date: ${date}, ${markdown.length} chars }`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
