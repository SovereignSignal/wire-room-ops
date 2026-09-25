import { createHash } from 'node:crypto';
import type { QueryPool, TransactionPool } from './program-identity';

// Reuse existing editorial associations. Do not infer organizations from domains,
// fuzzy names, acronyms or program titles, and never overwrite a resolved link.
const CANDIDATES = `
  SELECT p.id AS "programId", p.canonical_name AS "programName",
         o.id AS "orgId", o.name AS "orgName",
         ARRAY(SELECT e.id FROM scan_entries e
               WHERE e.program_id = p.id AND e.org_id = o.id
                 AND e.status = 'approved' AND e.duplicate_of_id IS NULL
               ORDER BY e.id) AS "evidenceEntryIds"
  FROM programs p
  JOIN org_profiles o ON lower(btrim(o.name)) = lower(btrim(p.org_name))
  WHERE p.org_id IS NULL
    AND ($1::int[] IS NULL OR p.id = ANY($1::int[]))
    AND NOT EXISTS (SELECT 1 FROM org_profiles other
                    WHERE other.id <> o.id
                      AND lower(btrim(other.name)) = lower(btrim(o.name)))
    AND EXISTS (SELECT 1 FROM scan_entries e
                WHERE e.program_id = p.id AND e.org_id = o.id
                  AND e.status = 'approved' AND e.duplicate_of_id IS NULL)
    AND NOT EXISTS (SELECT 1 FROM scan_entries e
                    WHERE e.program_id = p.id AND e.org_id IS NOT NULL AND e.org_id <> o.id)
    AND NOT EXISTS (SELECT 1 FROM scan_entries e
                    WHERE e.program_id = p.id
                      AND concat_ws(' ', e.operator_notes, e.action_reason) ~* '\\mhold\\M')
`;

export interface ProgramOrgLink {
  programId: number;
  programName: string;
  orgId: number;
  orgName: string;
  evidenceEntryIds: number[];
}

export async function planProgramOrgLinks(pool: QueryPool, programIds: number[] | null = null) {
  const { rows } = await pool.query<ProgramOrgLink>(`${CANDIDATES} ORDER BY p.id`, [programIds]);
  const planHash = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  return { version: 1 as const, links: rows, planHash };
}

/** Fill missing links only, using current approved-entry evidence. */
export async function fillMissingProgramOrgLinks(pool: QueryPool, programIds: number[]): Promise<number> {
  const ids = [...new Set(programIds.filter(Number.isSafeInteger))];
  if (!ids.length) return 0;
  const result = await pool.query(`
    WITH eligible AS (${CANDIDATES})
    UPDATE programs p SET org_id = e."orgId", updated_at = NOW()
    FROM eligible e WHERE p.id = e."programId" AND p.org_id IS NULL
    RETURNING p.id`, [ids]);
  return result.rows.length;
}

/** Operator repair: dry-run by default; reject any drift from the reviewed plan. */
export async function repairProgramOrgLinks(pool: TransactionPool, expectedPlanHash?: string) {
  const client = await pool.connect();
  try {
    await client.query(expectedPlanHash ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if (expectedPlanHash) {
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query('LOCK TABLE programs, org_profiles, scan_entries IN SHARE ROW EXCLUSIVE MODE');
    }
    const plan = await planProgramOrgLinks(client);
    let applied = 0;
    if (expectedPlanHash) {
      if (plan.planHash !== expectedPlanHash) throw new Error('Program/org link plan changed; review a fresh dry run');
      applied = await fillMissingProgramOrgLinks(client, plan.links.map(r => r.programId));
      if (applied !== plan.links.length) throw new Error('Program/org link repair count mismatch');
      if ((await planProgramOrgLinks(client)).links.length) throw new Error('Program/org link repair left eligible rows');
    }
    await client.query('COMMIT');
    return { mode: expectedPlanHash ? 'apply' : 'dry-run', ...plan, applied };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
