/**
 * Source Feeds dry-run — fetch each registry source live and print items. NO DB writes.
 * Run: railway run npx ts-node src/scripts/source-feeds-dryrun.ts [sourceKey]
 *   (omit sourceKey to test all; pass a key like 'karma-gap' to test one)
 */

import { SOURCE_REGISTRY, fetchSource, classifyFetchError, DEFAULT_TIMEOUT_MS } from '../services/source-feeds';

async function main() {
  const only = process.argv[2];
  const sources = only ? SOURCE_REGISTRY.filter(s => s.key === only) : SOURCE_REGISTRY;
  if (sources.length === 0) { console.log(`No source matching "${only}". Keys: ${SOURCE_REGISTRY.map(s => s.key).join(', ')}`); return; }

  for (const source of sources) {
    process.stdout.write(`\n=== ${source.key} (${source.name}, ${source.method}, ${source.wire}) ===\n`);
    const start = Date.now();
    try {
      const items = await fetchSource(source);
      console.log(`  ${items.length} items in ${Date.now() - start}ms`);
      for (const it of items.slice(0, 5)) {
        console.log(`   • ${it.name}`);
        console.log(`     ${it.url}`);
        console.log(`     amount=${it.amount ?? '—'}  deadline=${it.deadline ?? '—'}  published=${it.publishedAt ?? '—'}`);
        if (it.description && it.description !== it.name) console.log(`     ${it.description.slice(0, 100)}`);
      }
      if (items.length > 5) console.log(`   … +${items.length - 5} more`);
    } catch (err) {
      // Route through the same classifier production uses, so the dry-run shows the
      // same readable message an operator would see in the digest (e.g. "timeout after
      // 45s" instead of "The operation was aborted due to timeout"), not a raw error.
      const classified = classifyFetchError(err, source.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      console.log(`  ❌ ERROR: ${classified.message}`);
    }
  }
  console.log('');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
