/**
 * Backfill: replace enriched_summary values that hold model reasoning
 * ("We need to produce a concise opportunity summary...") with a regenerated
 * summary from the guarded auto-summarize path.
 *
 * Dry run (default, read-only session, no LLM calls):
 *   railway run npx ts-node --transpile-only src/scripts/backfill-summary-leaks.ts --dry-run
 *
 * Apply (approved rows first, then other statuses). Same flags as before.
 * Regeneration uses the approve-time chain: Ollama OLLAMA_DEFAULT_MODEL, then
 * OLLAMA_FALLBACK_MODEL. An Ollama key is required; a Grok key is not.
 *   railway run npx ts-node --transpile-only src/scripts/backfill-summary-leaks.ts --apply --limit 50
 *
 * Flags:
 *   --dry-run            Counts, samples and downstream exposure only (default)
 *   --apply              Regenerate and write
 *   --limit N            Apply only: stop after N affected rows (for staged runs)
 *   --status S           Only rows with this status (e.g. approved)
 *   --ids 1,2,3          Only these entry ids
 *   --batch-size N       Rows per batch (default 10)
 *   --delay-ms N         Pause between rows (default 2000)
 *   --batch-pause-ms N   Pause between batches (default 20000)
 *   --max-consecutive-failures N  Stop when the provider keeps failing (default 5)
 *   --samples N          Samples printed in the dry run (default 15)
 *
 * Per affected row (apply):
 *   regenerated  enriched_summary = new text, auto_summarize_failed = false,
 *                summaries.summary patched where it still holds the leaked text.
 *   cleared      no usable summary: enriched_summary = NULL,
 *                auto_summarize_failed = true (shows in the retry list),
 *                summaries.summary falls back to the entry description.
 * Both keep the leaked text in metadata.summary_backfill.previous for audit.
 * Writes are guarded on the leaked text still being present, so a row edited
 * mid-run is skipped rather than overwritten.
 */

import type { PoolClient } from 'pg';
import { config } from '../config';
import { getPool } from '../db';
import { refreshProviderCache, getCachedProvider } from '../services/api-provider';
import { generateValidatedSummary } from '../services/auto-summarize';
import { findSummaryLeak, isLeakedSummary } from '../services/summary-guard';
import { sleep } from '../utils/async';

interface Args {
  apply: boolean;
  limit: number | null;
  status: string | null;
  ids: number[] | null;
  batchSize: number;
  delayMs: number;
  batchPauseMs: number;
  maxConsecutiveFailures: number;
  samples: number;
}

export function parseArgs(argv: string[]): Args {
  const value = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    if (i === -1) return null;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  const int = (flag: string, fallback: number): number => {
    const raw = value(flag);
    if (raw === null) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a non-negative integer`);
    return n;
  };
  const apply = argv.includes('--apply');
  if (apply && argv.includes('--dry-run')) throw new Error('Pass either --dry-run or --apply, not both');
  const idsRaw = value('--ids');
  const ids = idsRaw ? idsRaw.split(',').map(s => Number(s.trim())) : null;
  if (ids && ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('--ids must be positive integers');
  const limitRaw = value('--limit');
  return {
    apply,
    limit: limitRaw === null ? null : int('--limit', 0),
    status: value('--status'),
    ids,
    batchSize: Math.max(1, int('--batch-size', 10)),
    delayMs: int('--delay-ms', 2000),
    batchPauseMs: int('--batch-pause-ms', 20000),
    maxConsecutiveFailures: Math.max(1, int('--max-consecutive-failures', 5)),
    samples: int('--samples', 15),
  };
}

interface AffectedRow {
  id: number;
  status: string;
  wire: string;
  updated_at: Date;
  enriched_summary: string;
  rule: string;
  excerpt: string;
}

function isMissingRelation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '42P01';
}

async function findAffected(db: PoolClient, args: Args): Promise<{ scanned: number; affected: AffectedRow[] }> {
  const affected: AffectedRow[] = [];
  let scanned = 0;
  let lastId = 0;
  for (;;) {
    const { rows } = await db.query(
      `SELECT id, status, wire, updated_at, enriched_summary
       FROM scan_entries
       WHERE id > $1
         AND enriched_summary IS NOT NULL AND btrim(enriched_summary) <> ''
         AND ($2::text IS NULL OR status = $2)
         AND ($3::int[] IS NULL OR id = ANY($3))
       ORDER BY id
       LIMIT 1000`,
      [lastId, args.status, args.ids],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      scanned++;
      const leak = findSummaryLeak(row.enriched_summary);
      if (leak) affected.push({ ...row, rule: leak.rule, excerpt: leak.excerpt });
    }
    lastId = rows[rows.length - 1].id;
  }
  affected.sort((a, b) =>
    Number(b.status === 'approved') - Number(a.status === 'approved')
    || b.updated_at.getTime() - a.updated_at.getTime());
  return { scanned, affected };
}

function tally<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

async function reportExposure(db: PoolClient, affected: AffectedRow[]): Promise<void> {
  const ids = affected.map(row => row.id);
  console.log('\n--- Downstream exposure (rows that copied or were built near the leaked text) ---');

  try {
    const { rows } = await db.query(
      `SELECT id, entities->>'scan_entry_id' AS entry_id, summary
       FROM summaries WHERE entities->>'scan_entry_id' = ANY($1::text[])`,
      [ids.map(String)],
    );
    const leaked = rows.filter(row => isLeakedSummary(row.summary));
    console.log(`summaries (tele-sum table, legacy site/newsletter reader): ${rows.length} linked rows, ${leaked.length} hold leaked text`);
  } catch (err) {
    if (!isMissingRelation(err)) throw err;
    console.log('summaries: table not present in this database');
  }

  const { rows: logs } = await db.query(
    `SELECT entry_id, channel, post_text FROM distribution_logs
     WHERE entry_id = ANY($1::int[]) AND status = 'success'`,
    [ids],
  );
  const postedEntries = new Set(logs.map(row => row.entry_id));
  const leakedPosts = logs.filter(row => isLeakedSummary(row.post_text));
  console.log(`distribution_logs: ${postedEntries.size} affected entries were posted (${logs.length} sends), ${leakedPosts.length} post texts look leaked`);
  console.log('  (posts are generated from description, not enriched_summary; a non-zero leaked count means readers saw it)');

  const { rows: pq } = await db.query(
    `SELECT status, COUNT(*)::int AS n FROM publication_queue WHERE entry_id = ANY($1::int[]) GROUP BY status`,
    [ids],
  );
  console.log(`publication_queue: ${pq.map(row => `${row.status}=${row.n}`).join(', ') || 'none'} (the worker does not read enriched_summary)`);
}

async function applyRow(row: AffectedRow): Promise<'regenerated' | 'cleared' | 'skipped'> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, name, description, amount, deadline, source_url, wire, enriched_summary
     FROM scan_entries WHERE id = $1`,
    [row.id],
  );
  const current = rows[0];
  if (!current || current.enriched_summary !== row.enriched_summary) return 'skipped';

  const result = await generateValidatedSummary({
    entryId: current.id,
    name: current.name,
    description: current.description || '',
    amount: current.amount,
    deadline: current.deadline,
    sourceUrl: current.source_url,
    wire: current.wire,
  });
  const audit = {
    at: new Date().toISOString(),
    rule: row.rule,
    previous: row.enriched_summary,
    outcome: result.summary ? 'regenerated' : 'cleared',
    provider: result.provider,
    model: result.model,
    attempts: result.attempts.map(a => `${a.model}=${a.outcome}`),
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE scan_entries
       SET enriched_summary = $2,
           auto_summarize_failed = $3,
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('summary_backfill', $4::jsonb)
       WHERE id = $1 AND enriched_summary = $5
       RETURNING id`,
      [row.id, result.summary, !result.summary, JSON.stringify(audit), row.enriched_summary],
    );
    if (updated.rowCount !== 1) {
      await client.query('ROLLBACK');
      return 'skipped';
    }
    const replacement = result.summary || current.description || '';
    if (replacement) {
      await client.query('SAVEPOINT summaries_patch');
      try {
        await client.query(
          `UPDATE summaries SET summary = $2
           WHERE entities->>'scan_entry_id' = $1::text AND summary = $3`,
          [String(row.id), replacement, row.enriched_summary],
        );
      } catch (err) {
        if (!isMissingRelation(err)) throw err;
        await client.query('ROLLBACK TO SAVEPOINT summaries_patch');
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return result.summary ? 'regenerated' : 'cleared';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = getPool();
  const db = await pool.connect();
  try {
    if (!args.apply) await db.query('SET SESSION default_transaction_read_only = on');
    console.log(`\n=== Summary leak backfill: ${args.apply ? 'APPLY' : 'DRY RUN (read-only, no LLM calls)'} ===\n`);

    const { scanned, affected } = await findAffected(db, args);
    console.log(`Scanned ${scanned} rows with an enriched_summary; ${affected.length} look like leaked reasoning.`);
    console.log('By status:', tally(affected, row => row.status));
    console.log('By wire:  ', tally(affected, row => row.wire));
    console.log('By rule:  ', tally(affected, row => row.rule));
    if (affected.length > 0) {
      const newest = affected.reduce((a, b) => (a.updated_at > b.updated_at ? a : b));
      console.log(`Most recent affected row: #${newest.id} updated ${newest.updated_at.toISOString()}`);
    }

    if (!args.apply) {
      console.log(`\n--- Samples (approved first, newest first; ${Math.min(args.samples, affected.length)} of ${affected.length}) ---`);
      for (const row of affected.slice(0, args.samples)) {
        console.log(`#${row.id} [${row.status}/${row.wire}] ${row.updated_at.toISOString()} rule=${row.rule}`);
        console.log(`    ${row.enriched_summary.slice(0, 200).replace(/\s+/g, ' ')}`);
      }
      if (affected.length > 0) await reportExposure(db, affected);
      console.log('\nDry run only. Re-run with --apply to regenerate.');
      return;
    }

    await refreshProviderCache();
    const primary = config.apis.ollama.defaultModel;
    const fallback = config.apis.ollama.fallbackModel;
    console.log(`Regenerating with Ollama ${primary}, then ${fallback}.`);
    if (!getCachedProvider('ollama')?.api_key) {
      throw new Error('No Ollama API key configured; refusing to clear summaries without a regenerator');
    }

    const todo = args.limit === null ? affected : affected.slice(0, args.limit);
    const counts = { regenerated: 0, cleared: 0, skipped: 0, errors: 0 };
    let consecutiveFailures = 0;
    for (let i = 0; i < todo.length; i++) {
      const row = todo[i];
      try {
        const outcome = await applyRow(row);
        counts[outcome]++;
        consecutiveFailures = outcome === 'cleared' ? consecutiveFailures + 1 : 0;
        console.log(`[${i + 1}/${todo.length}] #${row.id} [${row.status}] ${outcome}`);
      } catch (err) {
        counts.errors++;
        consecutiveFailures++;
        console.error(`[${i + 1}/${todo.length}] #${row.id} error:`, err instanceof Error ? err.message : err);
      }
      if (consecutiveFailures >= args.maxConsecutiveFailures) {
        console.error(`Stopping: ${consecutiveFailures} consecutive failures. Check the summarize provider before resuming.`);
        break;
      }
      if (i < todo.length - 1) {
        await sleep((i + 1) % args.batchSize === 0 ? args.batchPauseMs : args.delayMs);
      }
    }
    console.log('\nDone:', counts);
  } finally {
    db.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => {
    console.error('Summary leak backfill failed:', err);
    process.exit(1);
  });
}
