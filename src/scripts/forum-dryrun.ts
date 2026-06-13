/**
 * Forum lane dry-run — verification only, NO DB writes.
 *
 * Fetches governance-forum candidates from discuss.watch and runs the LLM judge,
 * then prints a candidate-by-candidate KEPT/DROPPED breakdown so we can confirm the
 * judgment separates funding signal from governance noise before enabling any schedule.
 *
 * Run:  railway run npx ts-node src/scripts/forum-dryrun.ts [wire] [lookbackDays]
 *   e.g. railway run npx ts-node src/scripts/forum-dryrun.ts crypto 30
 *
 * It does NOT call runDailyIntake — nothing reaches scan_entries.
 */

import { fetchGovernanceForumCandidates, judgeForumCandidates } from '../services/forum';
import { normalizeUrl } from '../utils/url';

async function main() {
  const wire = process.argv[2] || 'crypto';
  const lookbackDays = Number(process.argv[3] || 30);
  const since = new Date(Date.now() - lookbackDays * 86400000).toISOString().split('T')[0];

  console.log(`\n=== Forum lane DRY RUN — wire=${wire}, since=${since} (no DB writes) ===\n`);

  const candidates = await fetchGovernanceForumCandidates(wire, since);
  console.log(`\nFetched ${candidates.length} candidates.\n`);
  if (candidates.length === 0) {
    console.log('No candidates — nothing to judge.');
    return;
  }

  const opportunities = await judgeForumCandidates(candidates, wire);
  const keptUrls = new Set(opportunities.map(o => normalizeUrl(o.sourceUrl)));

  console.log(`\n--- RESULT: ${opportunities.length}/${candidates.length} judged as opportunities ---\n`);

  console.log('KEPT (opportunities):');
  for (const o of opportunities) {
    console.log(`  ✅ ${o.name}`);
    console.log(`     ${o.description}`);
    console.log(`     amount=${o.amount ?? '—'}  deadline=${o.deadline ?? '—'}`);
    console.log(`     ${o.sourceUrl}`);
  }

  console.log('\nDROPPED (not opportunities):');
  for (const c of candidates) {
    if (keptUrls.has(normalizeUrl(c.url))) continue;
    console.log(`  ❌ [${c.forumName}] ${c.title}`);
  }

  console.log(`\n=== Dry run complete. Kept ${opportunities.length}, dropped ${candidates.length - opportunities.length}. ===\n`);
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Dry run failed:', err);
    process.exit(1);
  });
