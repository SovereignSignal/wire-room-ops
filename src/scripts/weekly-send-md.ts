/**
 * Send a weekly issue markdown file as the rendered newsletter email (one-off).
 * Run: railway run npx ts-node src/scripts/weekly-send-md.ts <markdown-path> <runDate>
 */
import { readFileSync } from 'fs';
import { sendWeeklyDraftEmail } from '../services/email';

async function main() {
  const path = process.argv[2];
  const runDate = process.argv[3] || 'preview';
  if (!path) { console.error('usage: weekly-send-md.ts <markdown-path> <runDate>'); process.exit(1); }
  const md = readFileSync(path, 'utf8');
  await sendWeeklyDraftEmail(md, { runDate, spineCount: 0, alsoOpenCount: 0 });
  console.log('sent newsletter email for', runDate);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
