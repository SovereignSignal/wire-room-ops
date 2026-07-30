import { lockDuplicateGraph } from './duplicate-chain';
import { refreshProgramCounters } from './program-identity';
import type { QueryPool, TransactionPool } from './program-identity';

export interface SourcePurgeResult {
  deleted: number;
  seenNamesRemoved: number;
  seenUrlsRemoved: number;
  distributionLogsRemoved: number;
  orphanPointersCleared: number;
  orphanPointersRepointed: number;
  seenUrlOwnersReassigned: number;
  programsRepaired: number;
}

interface PointerRepair {
  orphanId: number;
  targetId: number;
}

const emptyResult = (): SourcePurgeResult => ({
  deleted: 0,
  seenNamesRemoved: 0,
  seenUrlsRemoved: 0,
  distributionLogsRemoved: 0,
  orphanPointersCleared: 0,
  orphanPointersRepointed: 0,
  seenUrlOwnersReassigned: 0,
  programsRepaired: 0,
});

async function planPointerRepairs(db: QueryPool, ids: number[]): Promise<PointerRepair[]> {
  if (ids.length === 0) return [];
  const result = await db.query(
    `SELECT orphan.id AS orphan_id, p.canonical_entry_id AS target_id
     FROM scan_entries orphan
     JOIN programs p ON p.id = orphan.program_id
     JOIN scan_entries target ON target.id = p.canonical_entry_id
     WHERE orphan.id = ANY($1::int[])
       AND orphan.status = 'duplicate'
       AND orphan.duplicate_of_id IS NULL
       AND target.id <> orphan.id
       AND target.program_id = orphan.program_id
       AND target.status IN ('approved', 'declined', 'queued', 'archived')
       AND target.duplicate_of_id IS NULL
     ORDER BY orphan.id`,
    [ids],
  );
  return result.rows.map(row => ({ orphanId: Number(row.orphan_id), targetId: Number(row.target_id) }));
}

async function applyPointerRepairs(db: QueryPool, repairs: PointerRepair[]): Promise<{ pointers: number; seenUrls: number }> {
  if (repairs.length === 0) return { pointers: 0, seenUrls: 0 };
  const payload = JSON.stringify(repairs);
  const seenUrls = await db.query(
    `WITH repair AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb)
         AS r("orphanId" int, "targetId" int)
     )
     UPDATE seen_urls seen SET first_seen_entry_id = repair."targetId"
     FROM repair
     WHERE seen.first_seen_entry_id = repair."orphanId"
     RETURNING seen.id`,
    [payload],
  );
  const pointers = await db.query(
    `WITH repair AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb)
         AS r("orphanId" int, "targetId" int)
     )
     UPDATE scan_entries orphan SET
       duplicate_of_id = repair."targetId",
       updated_at = NOW()
     FROM repair
     WHERE orphan.id = repair."orphanId"
       AND orphan.status = 'duplicate'
       AND orphan.duplicate_of_id IS NULL
     RETURNING orphan.id`,
    [payload],
  );
  if (pointers.rows.length !== repairs.length) {
    throw new Error(`Pointer repair count changed: planned ${repairs.length}, updated ${pointers.rows.length}`);
  }
  return { pointers: pointers.rows.length, seenUrls: seenUrls.rows.length };
}

/** Delete one source snapshot and repair every affected identity inside one transaction. */
export async function purgeSourceEntries(pool: TransactionPool, source: string): Promise<SourcePurgeResult> {
  const client = await pool.connect();
  let began = false;
  try {
    await client.query('BEGIN');
    began = true;
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await client.query(`SET LOCAL statement_timeout = '60s'`);
    await lockDuplicateGraph(client);

    const victims = await client.query(
      `SELECT id, program_id
       FROM scan_entries
       WHERE scan_source = $1
       ORDER BY id
       FOR UPDATE`,
      [source],
    );
    if (victims.rows.length === 0) {
      await client.query('ROLLBACK');
      began = false;
      return emptyResult();
    }

    const ids = victims.rows.map(row => Number(row.id));
    const referrers = await client.query(
      `SELECT id, program_id
       FROM scan_entries
       WHERE duplicate_of_id = ANY($1::int[])
         AND NOT (id = ANY($1::int[]))
       ORDER BY id
       FOR UPDATE`,
      [ids],
    );
    const referrerIds = referrers.rows.map(row => Number(row.id));
    const programIds = [...new Set(
      [...victims.rows, ...referrers.rows]
        .map(row => row.program_id == null ? null : Number(row.program_id))
        .filter((id): id is number => id !== null && Number.isSafeInteger(id)),
    )];

    const seenNames = await client.query(
      `DELETE FROM seen_names WHERE entry_id = ANY($1::int[]) RETURNING entry_id`,
      [ids],
    );
    const seenUrls = await client.query(
      `DELETE FROM seen_urls WHERE first_seen_entry_id = ANY($1::int[]) RETURNING first_seen_entry_id`,
      [ids],
    );
    const distributionLogs = await client.query(
      `DELETE FROM distribution_logs WHERE entry_id = ANY($1::int[]) RETURNING entry_id`,
      [ids],
    );
    const cleared = await client.query(
      `UPDATE scan_entries SET duplicate_of_id = NULL
       WHERE id = ANY($1::int[])
         AND duplicate_of_id = ANY($2::int[])
       RETURNING id`,
      [referrerIds, ids],
    );
    const deleted = await client.query(
      `DELETE FROM scan_entries WHERE id = ANY($1::int[]) RETURNING id`,
      [ids],
    );
    if (deleted.rows.length !== ids.length) {
      throw new Error(`Source purge count changed: selected ${ids.length}, deleted ${deleted.rows.length}`);
    }

    const programsRepaired = await refreshProgramCounters(client, programIds);
    const pointerPlan = await planPointerRepairs(client, referrerIds);
    const repairedPointers = await applyPointerRepairs(client, pointerPlan);

    await client.query('COMMIT');
    began = false;
    return {
      deleted: deleted.rows.length,
      seenNamesRemoved: seenNames.rows.length,
      seenUrlsRemoved: seenUrls.rows.length,
      distributionLogsRemoved: distributionLogs.rows.length,
      orphanPointersCleared: cleared.rows.length,
      orphanPointersRepointed: repairedPointers.pointers,
      seenUrlOwnersReassigned: repairedPointers.seenUrls,
      programsRepaired,
    };
  } catch (error) {
    if (began) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original error.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}
