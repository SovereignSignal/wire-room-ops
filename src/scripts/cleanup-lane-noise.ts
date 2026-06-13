/**
 * One-off cleanup: archive already-queued feed entries that the newly-deployed source
 * filters would now exclude (news-heavy RSS announcements + FLI recaps + off-beat
 * Grants.gov). Reversible (status change only). Run:
 *   railway run npx ts-node src/scripts/cleanup-lane-noise.ts          # dry-run (prints)
 *   railway run npx ts-node src/scripts/cleanup-lane-noise.ts --apply  # archive matches
 */

import { getPool } from '../db';

// Mirror the live predicates in src/services/source-feeds.ts.
const nlnetAllow = /apply for funding|open call|call for proposal|request for proposal|grants? (are |is )?open|funding (round|is open|available)/i;
const otfAllow = /request for proposal|\bRFP\b|open call|call for|fellowship|funding (round|opportunit)/i;
const fliBlock = /^\d{4}\s+grants$/i;
const govOffbeatTitle = /\b(clinical|biomedical|medical|health|disease|patient|cancer|glucose|diabet|cardio|neuro(?!morphic)|rehabilitation|assistive|nursing|surg|therap|veterinar|agricultur|crop|farm|wildlife|fisher|nutrition|maternal|opioid|addiction|poverty|housing)\b/i;

function isNoise(submittedBy: string, name: string): boolean {
  switch (submittedBy) {
    case 'feed:nlnet-news': return !nlnetAllow.test(name);
    case 'feed:otf-news': return !otfAllow.test(name);
    case 'feed:fli-grants': return fliBlock.test(name);
    case 'feed:grants-gov-ai': return govOffbeatTitle.test(name);
    default: return false;
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const pool = getPool();

  const { rows } = await pool.query(
    `SELECT id, name, submitted_by, wire, quality_score, classification
     FROM scan_entries WHERE scan_source='feed' AND status='queued' ORDER BY submitted_by, name`);

  const targets = rows.filter(r => isNoise(r.submitted_by, r.name));

  console.log(`\n=== Lane-noise cleanup — ${targets.length} of ${rows.length} queued feed entries flagged ${apply ? '(APPLYING)' : '(dry-run)'} ===\n`);
  for (const r of targets) {
    console.log(`  [${String(r.wire).padEnd(6)}] ${String(r.classification).padEnd(8)} ${String(r.name).slice(0, 64).padEnd(64)} ${r.submitted_by}`);
  }

  if (!targets.length) { console.log('  Nothing to archive.'); await pool.end(); return; }

  if (apply) {
    const ids = targets.map(r => r.id);
    const res = await pool.query(
      `UPDATE scan_entries SET status='archived', actioned_by='system:lane-cleanup',
         action_reason='post-filter noise cleanup (news/recap/off-beat)'
       WHERE id = ANY($1::int[]) AND status='queued'`, [ids]);
    console.log(`\n  Archived ${res.rowCount} entries. (Reversible: status queued→archived.)`);
  } else {
    console.log(`\n  Dry-run only. Re-run with --apply to archive these.`);
  }
  console.log('');
  await pool.end();
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
