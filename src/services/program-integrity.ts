import { programLastDecisionSql } from '../db/program-decisions';
import { createHash } from 'node:crypto';
import { normalizeProgramKey, refreshProgramCounters, programEntryUnheldSql } from './program-identity';
import type { QueryPool, TransactionPool } from './program-identity';

const REPAIR_LOCK_KEY = 'wire-room-ops:program-integrity-repair';
const DUPLICATE_GRAPH_LOCK_KEY = 'wire-room-ops:duplicate-graph';
const TERMINAL_STATUSES = "'approved', 'declined', 'queued', 'archived'";

const EXPECTED_PROGRAM_CTES = `
  expected AS (
    SELECT p.id AS program_id,
           COUNT(se.id)::int AS expected_entry_count,
           COUNT(se.id) FILTER (WHERE se.status = 'approved')::int AS expected_approved_count,
           COUNT(se.id) FILTER (WHERE se.status = 'declined')::int AS expected_declined_count,
           MIN(se.created_at)::date AS expected_first_seen,
           MAX(se.created_at)::date AS expected_last_seen,
           ${programLastDecisionSql('se')} AS expected_last_decision,
           (ARRAY_AGG(se.id ORDER BY
              CASE se.status WHEN 'approved' THEN 0 WHEN 'declined' THEN 1 WHEN 'queued' THEN 2 WHEN 'archived' THEN 3 END,
              se.created_at DESC, se.id DESC
            ) FILTER (WHERE se.status IN (${TERMINAL_STATUSES})
                        AND se.duplicate_of_id IS NULL
                        AND ${programEntryUnheldSql('se')}))[1] AS preferred_canonical_id
    FROM programs p
    LEFT JOIN scan_entries se ON se.program_id = p.id
    GROUP BY p.id
  ), checked AS (
    SELECT p.*,
           e.*,
           EXISTS (
             SELECT 1 FROM scan_entries current_canonical
             WHERE current_canonical.id = p.canonical_entry_id
               AND current_canonical.program_id = p.id
               AND current_canonical.status IN (${TERMINAL_STATUSES})
               AND current_canonical.duplicate_of_id IS NULL
               AND ${programEntryUnheldSql('current_canonical')}
           ) AS current_canonical_valid
    FROM programs p
    JOIN expected e ON e.program_id = p.id
  ), desired AS (
    SELECT checked.*,
           CASE WHEN current_canonical_valid
                THEN canonical_entry_id
                ELSE preferred_canonical_id
           END AS expected_canonical_id
    FROM checked
  )`;

export interface ProgramIntegritySnapshot {
  programsScanned: number;
  counterMismatches: number;
  timelineMismatches: number;
  canonicalMissing: number;
  canonicalInvalid: number;
  orphanDuplicates: number;
  actionableOrphans: number;
  linkedSyntheticEntries: number;
  eligibleUnlinkedClusters: number;
}

export interface ProgramRepairRow {
  programId: number;
  current: {
    entryCount: number;
    approvedCount: number;
    declinedCount: number;
    firstSeen: string | null;
    lastSeen: string | null;
    lastDecision: string | null;
    canonicalEntryId: number | null;
  };
  expected: ProgramRepairRow['current'];
}

export interface OrphanRepairRow {
  orphanId: number;
  programId: number;
  targetId: number;
}

export interface SeenUrlOwnerRepairRow {
  seenUrlId: number;
  orphanId: number;
  targetId: number;
}

export interface ProgramIntegrityPlan {
  version: 1;
  baseline: ProgramIntegritySnapshot;
  planned: {
    programRows: ProgramRepairRow[];
    orphanLinks: OrphanRepairRow[];
    seenUrlOwnerRows: SeenUrlOwnerRepairRow[];
  };
  planHash: string;
}

export interface ProgramIntegrityReceipt {
  script: 'program-integrity-repair';
  version: 1;
  mode: 'dry-run' | 'apply';
  planHash: string;
  baseline: ProgramIntegritySnapshot;
  planned: ProgramIntegrityPlan['planned'];
  applied: {
    programRows: number;
    orphanLinks: number;
    seenUrlOwnerRows: number;
  };
  residual: ProgramIntegritySnapshot | null;
}

const asNumber = (value: unknown): number => Number(value ?? 0);
const asNullableNumber = (value: unknown): number | null => value == null ? null : Number(value);
const asDate = (value: unknown): string | null => {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};

function isSyntheticTestName(name: string): boolean {
  return /^test(?:\s|$)/i.test((name || '').trim());
}

export function countEligibleUnlinkedClusters(rows: Array<{ name: string; status: string }>): number {
  const clusters = new Map<string, Array<{ name: string; status: string }>>();
  for (const row of rows) {
    const key = normalizeProgramKey(row.name);
    if (!key) continue;
    const members = clusters.get(key) ?? [];
    members.push(row);
    clusters.set(key, members);
  }
  const decided = new Set(['approved', 'declined', 'duplicate']);
  return [...clusters.values()].filter(members =>
    !members.every(member => isSyntheticTestName(member.name))
    && (members.length >= 2 || members.some(member => decided.has(member.status))),
  ).length;
}

export async function auditProgramIntegrity(db: QueryPool): Promise<ProgramIntegritySnapshot> {
  const audit = await db.query(
    `WITH ${EXPECTED_PROGRAM_CTES}
     SELECT COUNT(*)::int AS programs_scanned,
            COUNT(*) FILTER (WHERE
              (entry_count, approved_count, declined_count) IS DISTINCT FROM
              (expected_entry_count, expected_approved_count, expected_declined_count)
            )::int AS counter_mismatches,
            COUNT(*) FILTER (WHERE
              (first_seen, last_seen, last_decision) IS DISTINCT FROM
              (expected_first_seen, expected_last_seen, expected_last_decision)
            )::int AS timeline_mismatches,
            COUNT(*) FILTER (WHERE canonical_entry_id IS NULL
                              AND preferred_canonical_id IS NOT NULL)::int AS canonical_missing,
            COUNT(*) FILTER (WHERE canonical_entry_id IS NOT NULL
                              AND NOT current_canonical_valid)::int AS canonical_invalid,
            (SELECT COUNT(*)::int FROM scan_entries
              WHERE status = 'duplicate' AND duplicate_of_id IS NULL) AS orphan_duplicates,
            (SELECT COUNT(*)::int
             FROM scan_entries orphan
             JOIN desired d ON d.program_id = orphan.program_id
             JOIN scan_entries target ON target.id = d.expected_canonical_id
             WHERE orphan.status = 'duplicate'
               AND orphan.duplicate_of_id IS NULL
               AND target.id <> orphan.id
               AND target.program_id = orphan.program_id
               AND target.status IN (${TERMINAL_STATUSES})
               AND target.duplicate_of_id IS NULL) AS actionable_orphans,
            (SELECT COUNT(*)::int FROM scan_entries
              WHERE program_id IS NOT NULL
                AND name ~* '^test([[:space:]]|$)') AS linked_synthetic_entries
     FROM desired`,
  );
  const unlinked = await db.query(
    `SELECT name, status FROM scan_entries
     WHERE program_id IS NULL AND name IS NOT NULL`,
  );
  const row = audit.rows[0] ?? {};
  return {
    programsScanned: asNumber(row.programs_scanned),
    counterMismatches: asNumber(row.counter_mismatches),
    timelineMismatches: asNumber(row.timeline_mismatches),
    canonicalMissing: asNumber(row.canonical_missing),
    canonicalInvalid: asNumber(row.canonical_invalid),
    orphanDuplicates: asNumber(row.orphan_duplicates),
    actionableOrphans: asNumber(row.actionable_orphans),
    linkedSyntheticEntries: asNumber(row.linked_synthetic_entries),
    eligibleUnlinkedClusters: countEligibleUnlinkedClusters(unlinked.rows),
  };
}

async function listProgramRepairs(db: QueryPool): Promise<ProgramRepairRow[]> {
  const result = await db.query(
    `WITH ${EXPECTED_PROGRAM_CTES}
     SELECT program_id,
            entry_count, approved_count, declined_count,
            first_seen, last_seen, last_decision, canonical_entry_id,
            expected_entry_count, expected_approved_count, expected_declined_count,
            expected_first_seen, expected_last_seen, expected_last_decision, expected_canonical_id
     FROM desired
     WHERE (entry_count, approved_count, declined_count,
            first_seen, last_seen, last_decision, canonical_entry_id)
           IS DISTINCT FROM
           (expected_entry_count, expected_approved_count, expected_declined_count,
            expected_first_seen, expected_last_seen, expected_last_decision, expected_canonical_id)
     ORDER BY program_id`,
  );
  return result.rows.map(row => ({
    programId: asNumber(row.program_id),
    current: {
      entryCount: asNumber(row.entry_count),
      approvedCount: asNumber(row.approved_count),
      declinedCount: asNumber(row.declined_count),
      firstSeen: asDate(row.first_seen),
      lastSeen: asDate(row.last_seen),
      lastDecision: row.last_decision == null ? null : String(row.last_decision),
      canonicalEntryId: asNullableNumber(row.canonical_entry_id),
    },
    expected: {
      entryCount: asNumber(row.expected_entry_count),
      approvedCount: asNumber(row.expected_approved_count),
      declinedCount: asNumber(row.expected_declined_count),
      firstSeen: asDate(row.expected_first_seen),
      lastSeen: asDate(row.expected_last_seen),
      lastDecision: row.expected_last_decision == null ? null : String(row.expected_last_decision),
      canonicalEntryId: asNullableNumber(row.expected_canonical_id),
    },
  }));
}

async function listOrphanRepairs(db: QueryPool): Promise<OrphanRepairRow[]> {
  const result = await db.query(
    `WITH ${EXPECTED_PROGRAM_CTES}
     SELECT orphan.id AS orphan_id,
            orphan.program_id,
            d.expected_canonical_id AS target_id
     FROM scan_entries orphan
     JOIN desired d ON d.program_id = orphan.program_id
     JOIN scan_entries target ON target.id = d.expected_canonical_id
     WHERE orphan.status = 'duplicate'
       AND orphan.duplicate_of_id IS NULL
       AND target.id <> orphan.id
       AND target.program_id = orphan.program_id
       AND target.status IN (${TERMINAL_STATUSES})
       AND target.duplicate_of_id IS NULL
     ORDER BY orphan.id`,
  );
  return result.rows.map(row => ({
    orphanId: asNumber(row.orphan_id),
    programId: asNumber(row.program_id),
    targetId: asNumber(row.target_id),
  }));
}

async function listSeenUrlRepairs(db: QueryPool, orphanLinks: OrphanRepairRow[]): Promise<SeenUrlOwnerRepairRow[]> {
  if (orphanLinks.length === 0) return [];
  const targetByOrphan = new Map(orphanLinks.map(row => [row.orphanId, row.targetId]));
  const result = await db.query(
    `SELECT id, first_seen_entry_id FROM seen_urls
     WHERE first_seen_entry_id = ANY($1::int[])
     ORDER BY id`,
    [orphanLinks.map(row => row.orphanId)],
  );
  return result.rows.map(row => ({
    seenUrlId: asNumber(row.id),
    orphanId: asNumber(row.first_seen_entry_id),
    targetId: targetByOrphan.get(asNumber(row.first_seen_entry_id)) as number,
  }));
}

function hashPlan(plan: Omit<ProgramIntegrityPlan, 'planHash'>): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

export async function buildProgramIntegrityPlan(db: QueryPool): Promise<ProgramIntegrityPlan> {
  const baseline = await auditProgramIntegrity(db);
  const programRows = await listProgramRepairs(db);
  const orphanLinks = await listOrphanRepairs(db);
  const seenUrlOwnerRows = await listSeenUrlRepairs(db, orphanLinks);
  const body = {
    version: 1 as const,
    baseline,
    planned: { programRows, orphanLinks, seenUrlOwnerRows },
  };
  return { ...body, planHash: hashPlan(body) };
}

async function applyOrphanLinks(db: QueryPool, rows: OrphanRepairRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const result = await db.query(
    `WITH repair AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb)
         AS r("orphanId" int, "programId" int, "targetId" int)
     )
     UPDATE scan_entries orphan SET
       duplicate_of_id = repair."targetId",
       updated_at = NOW()
     FROM repair
     WHERE orphan.id = repair."orphanId"
       AND orphan.program_id = repair."programId"
       AND orphan.status = 'duplicate'
       AND orphan.duplicate_of_id IS NULL
     RETURNING orphan.id`,
    [JSON.stringify(rows)],
  );
  return result.rows.length;
}

async function applySeenUrlOwners(db: QueryPool, rows: SeenUrlOwnerRepairRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const result = await db.query(
    `WITH repair AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb)
         AS r("seenUrlId" int, "orphanId" int, "targetId" int)
     )
     UPDATE seen_urls seen SET first_seen_entry_id = repair."targetId"
     FROM repair
     WHERE seen.id = repair."seenUrlId"
       AND seen.first_seen_entry_id = repair."orphanId"
     RETURNING seen.id`,
    [JSON.stringify(rows)],
  );
  return result.rows.length;
}

function emptyApplied(): ProgramIntegrityReceipt['applied'] {
  return { programRows: 0, orphanLinks: 0, seenUrlOwnerRows: 0 };
}

export async function runProgramIntegrityRepair(
  pool: TransactionPool,
  options: { apply?: boolean; expectedPlanHash?: string } = {},
): Promise<ProgramIntegrityReceipt> {
  if (!options.apply) {
    const plan = await buildProgramIntegrityPlan(pool);
    return {
      script: 'program-integrity-repair',
      version: 1,
      mode: 'dry-run',
      planHash: plan.planHash,
      baseline: plan.baseline,
      planned: plan.planned,
      applied: emptyApplied(),
      residual: null,
    };
  }
  if (!/^[a-f0-9]{64}$/.test(options.expectedPlanHash ?? '')) {
    throw new Error('Apply requires --expect-plan-hash with the reviewed 64-character SHA-256 hash');
  }

  const client = await pool.connect();
  let began = false;
  try {
    await client.query('BEGIN');
    began = true;
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await client.query(`SET LOCAL statement_timeout = '60s'`);

    const repairLock = await client.query(
      `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked`,
      [REPAIR_LOCK_KEY],
    );
    if (repairLock.rows[0]?.locked !== true) throw new Error('Another program-integrity repair is running');
    const graphLock = await client.query(
      `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked`,
      [DUPLICATE_GRAPH_LOCK_KEY],
    );
    if (graphLock.rows[0]?.locked !== true) throw new Error('The duplicate graph is being modified; retry the dry run later');
    await client.query(`LOCK TABLE scan_entries, programs, seen_urls IN SHARE ROW EXCLUSIVE MODE`);

    const plan = await buildProgramIntegrityPlan(client);
    if (plan.planHash !== options.expectedPlanHash) {
      throw new Error(`Repair plan drifted: expected ${options.expectedPlanHash}, current ${plan.planHash}`);
    }
    if (plan.baseline.linkedSyntheticEntries > 0) {
      throw new Error(`Refusing repair with ${plan.baseline.linkedSyntheticEntries} linked synthetic entries`);
    }

    // This command applies only the fields in its own reviewed plan. Organization
    // links have a separate evidence plan and must not become an implicit repair.
    const programRows = await refreshProgramCounters(
      client, plan.planned.programRows.map(row => row.programId), { linkOrganizations: false },
    );
    if (programRows !== plan.planned.programRows.length) {
      throw new Error(`Program repair count changed: planned ${plan.planned.programRows.length}, updated ${programRows}`);
    }
    const seenUrlOwnerRows = await applySeenUrlOwners(client, plan.planned.seenUrlOwnerRows);
    if (seenUrlOwnerRows !== plan.planned.seenUrlOwnerRows.length) {
      throw new Error(`Seen URL repair count changed: planned ${plan.planned.seenUrlOwnerRows.length}, updated ${seenUrlOwnerRows}`);
    }
    const orphanLinks = await applyOrphanLinks(client, plan.planned.orphanLinks);
    if (orphanLinks !== plan.planned.orphanLinks.length) {
      throw new Error(`Orphan repair count changed: planned ${plan.planned.orphanLinks.length}, updated ${orphanLinks}`);
    }

    const residualPlan = await buildProgramIntegrityPlan(client);
    if (residualPlan.planned.programRows.length > 0
        || residualPlan.planned.orphanLinks.length > 0
        || residualPlan.planned.seenUrlOwnerRows.length > 0) {
      throw new Error('Program integrity postcondition failed; rolling back');
    }
    await client.query('COMMIT');
    return {
      script: 'program-integrity-repair',
      version: 1,
      mode: 'apply',
      planHash: plan.planHash,
      baseline: plan.baseline,
      planned: plan.planned,
      applied: { programRows, orphanLinks, seenUrlOwnerRows },
      residual: residualPlan.baseline,
    };
  } catch (error) {
    if (began) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Keep the original failure. Releasing a broken client lets pg discard it.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}
