/**
 * One-time copy of scout ledger rows (scout_runs, scout_alerts) from the
 * database grant-wire-scout wrote to, into this one. Needed only if that was
 * not this database; when it was, the dry run reports nothing to copy.
 *
 * Dry run by default. --apply inserts in one transaction. Rows already here
 * win: runs match on run_id, alerts on (created_at, subject). Copied rows get
 * recorded_by = 'copy:scout-ledger'. Safe to rerun.
 *
 * The source URL is read from stdin so it is never in argv, shell history or
 * output. Run inside the wire-room-ops container (target = its DATABASE_URL),
 * piping the URL from the scout service's variables; the exact command is in
 * docs/private-database-runbook.md section 2.2.
 */
import { readFileSync } from 'fs';
import { Pool } from 'pg';
import { closePool, getPool } from '../db';

export const COPIED_BY = 'copy:scout-ledger';

interface TableSpec {
  table: 'scout_runs' | 'scout_alerts';
  wanted: string[];
  required: string[];
  /** SQL for each copied column, reading the source record `s`. */
  value: (column: string) => string;
  alreadyHere: string;
  conflict: string;
}

const TABLES: TableSpec[] = [
  {
    table: 'scout_runs',
    wanted: [
      'run_id', 'wire', 'variant', 'model', 'status', 'opportunity_count', 'found_count', 'dedup_dropped',
      'error_class', 'cost_usd', 'duration_ms', 'started_at', 'finished_at', 'created_at',
    ],
    required: ['run_id', 'status'],
    value: column => (column === 'wire' ? `COALESCE(s.wire, '')` : `s.${column}`),
    alreadyHere: 'EXISTS (SELECT 1 FROM public.scout_runs t WHERE t.run_id = s.run_id)',
    conflict: 'ON CONFLICT (run_id) DO NOTHING',
  },
  {
    table: 'scout_alerts',
    wanted: ['subject', 'body', 'channels_ok', 'created_at'],
    required: ['subject', 'created_at'],
    value: column => `s.${column}`,
    alreadyHere: 'EXISTS (SELECT 1 FROM public.scout_alerts t WHERE t.subject = s.subject AND t.created_at = s.created_at)',
    conflict: '',
  },
];

export interface TableReport {
  table: string;
  found: boolean;
  columns: string[];
  source_rows: number;
  already_here: number;
  to_copy: number;
  copied: number;
}

async function sourceColumns(source: Pool, table: string): Promise<Set<string> | null> {
  const { rows } = await source.query<{ attname: string }>(
    `SELECT attname FROM pg_attribute WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped`,
    [`public.${table}`],
  );
  return rows.length ? new Set(rows.map(row => row.attname)) : null;
}

export async function copyScoutLedger(opts: { source: Pool; target: Pool; apply: boolean }): Promise<TableReport[]> {
  const plans: Array<{ spec: TableSpec; report: TableReport; rows: string }> = [];
  for (const spec of TABLES) {
    const report: TableReport = { table: spec.table, found: false, columns: [], source_rows: 0, already_here: 0, to_copy: 0, copied: 0 };
    const have = await sourceColumns(opts.source, spec.table);
    if (!have) {
      plans.push({ spec, report, rows: '[]' });
      continue;
    }
    const missing = spec.required.filter(column => !have.has(column));
    if (missing.length) throw new Error(`Source ${spec.table} has no ${missing.join(', ')} column`);
    report.found = true;
    report.columns = spec.wanted.filter(column => have.has(column));
    const { rows } = await opts.source.query<{ rows: string }>(
      `SELECT COALESCE(json_agg(row_to_json(t)), '[]')::text AS rows FROM (SELECT ${report.columns.join(', ')} FROM public.${spec.table}) t`,
    );
    const counts = await opts.target.query<{ total: number; present: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE ${spec.alreadyHere})::int AS present
       FROM jsonb_populate_recordset(NULL::public.${spec.table}, $1::jsonb) s`,
      [rows[0].rows],
    );
    report.source_rows = counts.rows[0].total;
    report.already_here = counts.rows[0].present;
    report.to_copy = report.source_rows - report.already_here;
    plans.push({ spec, report, rows: rows[0].rows });
  }
  if (!opts.apply || plans.every(plan => plan.report.to_copy === 0)) return plans.map(plan => plan.report);

  const client = await opts.target.connect();
  try {
    await client.query('BEGIN');
    for (const { spec, report, rows } of plans) {
      if (report.to_copy === 0) continue;
      const result = await client.query(
        `INSERT INTO public.${spec.table} (${report.columns.join(', ')}, recorded_by)
         SELECT ${report.columns.map(spec.value).join(', ')}, $2
         FROM jsonb_populate_recordset(NULL::public.${spec.table}, $1::jsonb) s
         WHERE NOT ${spec.alreadyHere}
         ${spec.conflict}`,
        [rows, COPIED_BY],
      );
      report.copied = result.rowCount ?? 0;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return plans.map(plan => plan.report);
}

function scrubbed(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://****');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.filter(arg => arg !== '--apply');
  if (unknown.length) throw new Error(`Unknown argument: ${unknown.join(' ')}. The only flag is --apply.`);
  const apply = args.includes('--apply');
  const sourceUrl = readFileSync(0, 'utf8').trim();
  if (!/^postgres(?:ql)?:\/\//.test(sourceUrl)) throw new Error('Pipe the source database URL on stdin');

  const source = new Pool({
    connectionString: sourceUrl,
    application_name: 'copy-scout-ledger',
    ssl: sourceUrl.includes('localhost') ? false : { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' },
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
  try {
    const reports = await copyScoutLedger({ source, target: getPool(), apply });
    console.log(JSON.stringify({ apply, tables: reports }, null, 2));
    if (!apply && reports.some(report => report.to_copy > 0)) console.log('Dry run. Rerun with --apply to copy.');
  } finally {
    await source.end().catch(() => {});
    await closePool().catch(() => {});
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[copy-scout-ledger] ${scrubbed(error)}`);
    process.exit(1);
  });
}
