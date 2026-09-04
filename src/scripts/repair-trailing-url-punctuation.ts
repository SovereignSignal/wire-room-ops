/**
 * Repair source URLs that carry prose punctuation from their sending message —
 * MANUAL, idempotent, dry-run by default.
 *
 *   railway run npx ts-node src/scripts/repair-trailing-url-punctuation.ts
 *   railway run npx ts-node src/scripts/repair-trailing-url-punctuation.ts --apply
 *
 * Bracketed batch lines ("Source: [https://x.com/a/status/1]") let a closing
 * bracket survive into scan_entries.source_url, so every affected link served a
 * 404. The intake fix stops new ones; this repairs the rows already stored.
 *
 * seen_urls is left alone: it stores normalized dedup keys, and rewriting them
 * would let an already-decided entry re-enter the queue under its clean URL.
 */
import { getPool } from '../db';

/**
 * Narrower than the parser's rule on purpose. The parser strips at capture time,
 * where a trailing "." is sentence punctuation. Here the rows are already stored,
 * and a trailing "." is nearly always a truncated URL ("https://forms.example/...")
 * — stripping it yields a bare domain that resolves to the wrong page, which is
 * worse than a link that visibly 404s. Only unwrap brackets, and never touch a
 * URL that was truncated with an ellipsis.
 */
const WRAPPER_PUNCTUATION = /[\])]+$/;
const TRUNCATED = /(\.\.\.|\u2026)/;

export function repairUrl(url: string): string {
  if (TRUNCATED.test(url)) return url;
  return url.replace(WRAPPER_PUNCTUATION, '');
}

interface DamagedRow {
  id: number;
  status: string;
  scan_source: string;
  name: string;
  source_url: string;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const pool = getPool();

  const { rows } = await pool.query<DamagedRow>(
    `SELECT id, status, scan_source, name, source_url
       FROM scan_entries
      WHERE source_url ~ '^https?://'
        AND source_url ~ '[\\])]$'
      ORDER BY id`,
  );

  if (rows.length === 0) {
    console.log('no damaged source URLs found');
    await pool.end();
    return;
  }

  const byStatus = new Map<string, number>();
  for (const row of rows) byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);

  console.log(`${apply ? 'REPAIRING' : 'DRY RUN'} — ${rows.length} rows with trailing punctuation`);
  console.log([...byStatus].map(([status, count]) => `${status}=${count}`).join(' '));
  for (const row of rows.slice(0, 10)) {
    console.log(`  ${row.id} [${row.status}] ${row.source_url} -> ${repairUrl(row.source_url)}`);
  }
  if (rows.length > 10) console.log(`  …${rows.length - 10} more`);

  if (!apply) {
    console.log('no rows written. re-run with --apply to commit.');
    await pool.end();
    return;
  }

  let repaired = 0;
  for (const row of rows) {
    const clean = repairUrl(row.source_url);
    if (!clean || clean === row.source_url) continue;
    await pool.query('UPDATE scan_entries SET source_url = $1 WHERE id = $2', [clean, row.id]);
    repaired++;
  }
  console.log(`repaired ${repaired} rows`);
  await pool.end();
}

if (require.main === module) {
  main().catch(e => { console.error('REPAIR FAILED:', e); process.exit(1); });
}
