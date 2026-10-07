/**
 * Return scan_entries archived at intake as no_source_url to the raw queue
 * once their stored URL passes the current usefulness check.
 *
 * Snapshot proposal links (`https://snapshot.org/#/<space>/proposal/<id>`)
 * were archived this way because the fragment was not treated as a path.
 * The URL column already holds the link. This script does not rewrite it.
 *
 * Dry run (default). Read-only session, prints the plan, writes nothing:
 *   npx ts-node --transpile-only src/scripts/reprocess-no-source-url.ts
 *   npx ts-node --transpile-only src/scripts/reprocess-no-source-url.ts --ids 18876
 *
 * Apply. Sets status back to raw, drops archived_reason, and records
 * metadata.reprocessed_no_source_url. The next process-raw cycle (rows are
 * already older than its 2-minute created_at gate) dedupes and classifies
 * them. The first row for a normalized URL can reach the queue; later rows
 * of that same URL become duplicates. This does not approve or distribute.
 *   npx ts-node --transpile-only src/scripts/reprocess-no-source-url.ts --apply
 *   npx ts-node --transpile-only src/scripts/reprocess-no-source-url.ts --apply --limit 10
 *
 * Uses DATABASE_URL. Review a dry run before --apply. Do not point it at
 * production until that plan is the one you mean to release.
 *
 * Flags:
 *   --dry-run     Plan only (default)
 *   --apply       Write the status change
 *   --ids 1,2     Only these entry ids
 *   --limit N     Reprocess at most N eligible rows (oldest id first)
 *   --samples N   Eligible rows printed in the dry run (default 20)
 */

import { getPool } from '../db';
import { hasUsefulSourceUrl } from '../services/intake';

export interface ReprocessArgs {
  apply: boolean;
  ids: number[] | null;
  limit: number | null;
  samples: number;
}

export function parseReprocessArgs(argv: string[]): ReprocessArgs {
  const value = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    if (index === -1) return null;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`);
    return next;
  };
  const apply = argv.includes('--apply');
  if (apply && argv.includes('--dry-run')) {
    throw new Error('Pass either --dry-run or --apply, not both');
  }
  const idsRaw = value('--ids');
  const ids = idsRaw ? idsRaw.split(',').map(part => Number(part.trim())) : null;
  if (ids && ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('--ids must be positive integers');
  }
  const limitRaw = value('--limit');
  let limit: number | null = null;
  if (limitRaw !== null) {
    limit = Number(limitRaw);
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('--limit must be a positive integer');
  }
  const samplesRaw = value('--samples');
  let samples = 20;
  if (samplesRaw !== null) {
    samples = Number(samplesRaw);
    if (!Number.isSafeInteger(samples) || samples < 0) throw new Error('--samples must be a non-negative integer');
  }
  return { apply, ids, limit, samples };
}

export interface ArchivedSourceRow {
  id: number;
  source_url: string;
  wire: string | null;
  name: string | null;
}

export function partitionArchivedNoSourceRows(rows: ArchivedSourceRow[]): {
  reprocess: ArchivedSourceRow[];
  stillInvalid: ArchivedSourceRow[];
} {
  const reprocess: ArchivedSourceRow[] = [];
  const stillInvalid: ArchivedSourceRow[] = [];
  for (const row of rows) {
    if (hasUsefulSourceUrl(row.source_url)) reprocess.push(row);
    else stillInvalid.push(row);
  }
  return { reprocess, stillInvalid };
}

export interface ReprocessResult {
  scanned: number;
  eligible: ArchivedSourceRow[];
  selected: ArchivedSourceRow[];
  stillInvalid: number;
  updatedIds: number[];
}

interface ReprocessDb {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
}

const SELECT_ARCHIVED_NO_SOURCE = `
  SELECT id, source_url, wire, name
  FROM scan_entries
  WHERE status = 'archived'
    AND metadata->>'archived_reason' = 'no_source_url'
    AND source_url IS NOT NULL
    AND btrim(source_url) <> ''
    AND ($1::int[] IS NULL OR id = ANY($1::int[]))
  ORDER BY id
`;

const REQUEUE_ARCHIVED_NO_SOURCE = `
  UPDATE scan_entries AS se
  SET status = 'raw',
      metadata = (COALESCE(se.metadata, '{}'::jsonb) - 'archived_reason')
        || jsonb_build_object(
             'reprocessed_no_source_url',
             jsonb_build_object('at', NOW(), 'previous_reason', 'no_source_url')
           )
  FROM unnest($1::int[], $2::text[]) AS planned(id, source_url)
  WHERE se.id = planned.id
    AND se.status = 'archived'
    AND se.metadata->>'archived_reason' = 'no_source_url'
    AND se.source_url = planned.source_url
  RETURNING se.id
`;

function readRow(row: Record<string, unknown>): ArchivedSourceRow {
  return {
    id: Number(row.id),
    source_url: String(row.source_url ?? ''),
    wire: row.wire == null ? null : String(row.wire),
    name: row.name == null ? null : String(row.name),
  };
}

export async function reprocessArchivedNoSourceUrls(
  db: ReprocessDb,
  args: ReprocessArgs,
): Promise<ReprocessResult> {
  const selectedIds = args.ids && args.ids.length > 0 ? args.ids : null;
  const found = await db.query(SELECT_ARCHIVED_NO_SOURCE, [selectedIds]);
  const rows = found.rows.map(readRow);
  const { reprocess, stillInvalid } = partitionArchivedNoSourceRows(rows);
  const selected = args.limit == null ? reprocess : reprocess.slice(0, args.limit);
  if (!args.apply || selected.length === 0) {
    return {
      scanned: rows.length,
      eligible: reprocess,
      selected,
      stillInvalid: stillInvalid.length,
      updatedIds: [],
    };
  }

  const updated = await db.query(REQUEUE_ARCHIVED_NO_SOURCE, [
    selected.map(row => row.id),
    selected.map(row => row.source_url),
  ]);
  return {
    scanned: rows.length,
    eligible: reprocess,
    selected,
    stillInvalid: stillInvalid.length,
    updatedIds: updated.rows.map(row => Number(row.id)),
  };
}

function printResult(result: ReprocessResult, args: ReprocessArgs): void {
  const mode = args.apply ? 'APPLY' : 'DRY RUN';
  console.log(`\n=== no_source_url reprocess: ${mode} ===\n`);
  console.log(`Scanned ${result.scanned} archived no_source_url rows that still have a URL.`);
  console.log(`Eligible now: ${result.eligible.length}`);
  console.log(`Still not a useful source: ${result.stillInvalid}`);
  if (args.limit != null && result.eligible.length > result.selected.length) {
    console.log(`Limit ${args.limit}: ${result.selected.length} of ${result.eligible.length} eligible rows selected (oldest id first).`);
  }
  const shown = result.selected.slice(0, args.samples);
  if (shown.length > 0) {
    console.log(`\n--- ${args.apply ? 'Selected' : 'Would return to raw'} (${shown.length} of ${result.selected.length}) ---`);
    for (const row of shown) {
      const name = (row.name || '').replace(/\s+/g, ' ').slice(0, 80);
      console.log(`#${row.id} [${row.wire || 'no wire'}] ${name}`);
      console.log(`    ${row.source_url}`);
    }
  }
  if (!args.apply) {
    console.log('\nNo rows written. Re-run with --apply to return the selected rows to raw.');
    console.log('The next process-raw cycle dedupes and classifies them. It does not approve or send.');
    return;
  }
  const skipped = result.selected.length - result.updatedIds.length;
  console.log(`\nUpdated ${result.updatedIds.length} rows to raw.`);
  if (skipped > 0) {
    console.log(`Skipped ${skipped} rows because status, reason, or URL changed before the write.`);
  }
  console.log('The next process-raw cycle dedupes and classifies them. It does not approve or send.');
}

async function main(): Promise<void> {
  const args = parseReprocessArgs(process.argv.slice(2));
  const pool = getPool();
  const db = await pool.connect();
  try {
    if (!args.apply) await db.query('SET SESSION default_transaction_read_only = on');
    const result = await reprocessArchivedNoSourceUrls(db, args);
    printResult(result, args);
  } finally {
    db.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => {
    console.error('no_source_url reprocess failed:', err);
    process.exit(1);
  });
}
