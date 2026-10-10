/**
 * Replay explicitly selected, held cohort observations through normal intake.
 * Dry run by default; requires --ids. Review the plan before --apply.
 *
 * npx ts-node --transpile-only src/scripts/reprocess-cohort-observations.ts --ids 1,2
 *
 * Apply locks the observations and atomically inserts raw scan entries plus
 * their observation links. The normal background processor dedupes/classifies
 * them for review. This does not reset the bridge cursor, approve, or publish.
 */
import type { Pool } from 'pg';
import { getPool } from '../db';
import { COHORT_TRACK, mapCohortWire, shouldPromoteRow, toRaw } from '../jobs/cohort-bridge';
import type { CohortScanRow } from '../jobs/cohort-bridge';
import { COHORT_SOURCE_NAME } from '../jobs/cohort-health';
import { runDailyIntake } from '../jobs/daily-intake';
import type { ScanSubmission } from '../types/intake';
import { parseReprocessArgs } from './reprocess-no-source-url';

interface ReplayOptions {
  ids: number[];
  apply: boolean;
}

interface ReplayItem {
  observationId: number;
  runId: string;
  row: CohortScanRow;
}

function validateIds(ids: number[]): void {
  if (!ids.length || ids.length > 100 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('Supply 1-100 explicit positive observation IDs with --ids');
  }
  if (new Set(ids).size !== ids.length) throw new Error('Observation IDs must be unique');
}

export function parseCohortReplayArgs(argv: string[]): ReplayOptions {
  const parsed = parseReprocessArgs(argv);
  if (argv.includes('--limit') || argv.includes('--samples')) {
    throw new Error('Use --ids to specify the entire bounded replay');
  }
  const ids = parsed.ids ?? [];
  validateIds(ids);
  return { ids, apply: parsed.apply };
}

/** Owns its transaction; callers must not pass an already-open transaction. */
export async function reprocessCohortObservations(
  pool: Pool,
  options: ReplayOptions,
  runIntake = runDailyIntake,
  now = new Date(),
) {
  validateIds(options.ids);
  const db = await pool.connect();
  const selected: ReplayItem[] = [];
  const skipped: Array<{ observationId: number; reason: string }> = [];
  const inserted: Array<{ observationId: number; entryId: number }> = [];
  try {
    await db.query(options.apply ? 'BEGIN' : 'BEGIN READ ONLY');
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '30s'");
    const found = await db.query(`
      SELECT id, run_id, source_record_id, title, wire, status, description,
             url, deadline, raw_payload, routing, matched_scan_entry_id
      FROM opportunity_observations
      WHERE id = ANY($1::bigint[]) AND track = $2 AND source_name = $3
      ORDER BY id
      ${options.apply ? 'FOR UPDATE' : ''}
    `, [options.ids, COHORT_TRACK, COHORT_SOURCE_NAME]);
    if (found.rows.length !== options.ids.length) {
      throw new Error('Some requested IDs are missing or are not cohort observations; nothing replayed');
    }
    for (const observation of found.rows) {
      const id = Number(observation.id);
      const raw = observation.raw_payload ?? {};
      const row: CohortScanRow = {
        pageId: raw.notion_page_id || observation.source_record_id || '',
        name: observation.title || '',
        wire: mapCohortWire(observation.wire),
        wireLabel: observation.wire,
        section: raw.section ?? observation.status,
        summary: observation.description || '',
        url: observation.url || '',
        deadline: observation.deadline,
        dateFound: raw.date_found ?? null,
        sourceDate: raw.source_date ?? null,
        createdTime: raw.created_time ?? null,
      };
      let reason: string | null = null;
      if (observation.matched_scan_entry_id != null) reason = 'already linked to scan intake';
      else if (observation.routing !== 'raw_only') reason = 'not a held raw_only observation';
      else if (!row.pageId || !shouldPromoteRow(row)) reason = 'does not pass current cohort intake rules';
      if (!reason) {
        const existing = await db.query(`
          SELECT id FROM scan_entries
          WHERE scan_source = $1
            AND metadata->'cohort_bridge'->>'notion_page_id' = $2
          LIMIT 1
        `, [COHORT_SOURCE_NAME, row.pageId]);
        if (existing.rows.length) reason = `Notion page already submitted as entry ${existing.rows[0].id}`;
      }
      if (reason) skipped.push({ observationId: id, reason });
      else selected.push({ observationId: id, runId: observation.run_id, row });
    }
    if (options.apply && selected.length) {
      const submissions: ScanSubmission[] = selected.map(item => {
        const result = toRaw(item.row, item.runId);
        result.metadata = {
          ...result.metadata,
          cohort_reprocess: { observation_id: item.observationId, at: now.toISOString() },
        };
        return {
          wire: item.row.wire!, promptVariant: 'N', scanDate: now.toISOString().slice(0, 10),
          source: COHORT_SOURCE_NAME, submittedBy: 'cohort-observation-replay', results: [result],
        };
      });
      // Insert-only intake uses query(), so bind it to the locked transaction.
      // Classification and dedup run later in the normal production worker.
      await runIntake(db as unknown as Pool, submissions, { insertOnly: true });
      const entries = await db.query(`
        SELECT id, metadata->'cohort_reprocess'->>'observation_id' AS observation_id
        FROM scan_entries
        WHERE scan_source = $1 AND submitted_by = 'cohort-observation-replay'
          AND metadata->'cohort_reprocess'->>'observation_id' = ANY($2::text[])
      `, [COHORT_SOURCE_NAME, selected.map(item => String(item.observationId))]);
      const byObservation = new Map<number, number>();
      for (const entry of entries.rows) {
        const id = Number(entry.observation_id);
        if (byObservation.has(id)) throw new Error(`Multiple replay entries for observation ${id}`);
        byObservation.set(id, Number(entry.id));
      }
      for (const item of selected) {
        const entryId = byObservation.get(item.observationId);
        if (!entryId) throw new Error(`Missing intake entry for observation ${item.observationId}`);
        const updated = await db.query(`
          UPDATE opportunity_observations
          SET routing = 'wire_queue_candidate', matched_scan_entry_id = $2,
              raw_payload = COALESCE(raw_payload, '{}'::jsonb)
                || jsonb_build_object('cohort_reprocess', $3::jsonb)
          WHERE id = $1 AND routing = 'raw_only' AND matched_scan_entry_id IS NULL
          RETURNING id
        `, [item.observationId, entryId, JSON.stringify({ at: now.toISOString(), entry_id: entryId })]);
        if (updated.rowCount !== 1) throw new Error(`Observation ${item.observationId} changed during replay`);
        inserted.push({ observationId: item.observationId, entryId });
      }
    }
    await db.query(options.apply ? 'COMMIT' : 'ROLLBACK');
    return { mode: options.apply ? 'apply' : 'dry-run', selected, skipped, inserted };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    db.release();
  }
}

async function main(): Promise<void> {
  const options = parseCohortReplayArgs(process.argv.slice(2));
  const pool = getPool();
  try {
    console.log(JSON.stringify(await reprocessCohortObservations(pool, options), null, 2));
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Cohort observation replay failed:', err);
    process.exitCode = 1;
  });
}
