/**
 * Org Merge & Archive
 *
 * Provides operator tools for deduplicating org_profiles:
 * - mergeOrgs(): Relink entries from source to target, combine metadata, delete source
 * - archiveOrg(): Unlink entries from org, delete the org profile
 */

import { getPool } from '../db';

export interface MergeResult {
  entriesRelinked: number;
  sourceDeleted: boolean;
  targetName: string;
}

/**
 * Merge source org into target org:
 * 1. Relink all scan_entries from source → target
 * 2. Combine wires arrays (deduplicated)
 * 3. Store source name in target's aliases
 * 4. Update entry_count on target
 * 5. Delete source org
 */
export async function mergeOrgs(sourceId: number, targetId: number): Promise<MergeResult> {
  if (sourceId === targetId) throw new Error('Cannot merge an org into itself');

  const pool = getPool();

  // Verify both exist
  const [sourceRes, targetRes] = await Promise.all([
    pool.query(`SELECT id, name, wires, aliases FROM org_profiles WHERE id = $1`, [sourceId]),
    pool.query(`SELECT id, name, wires, aliases FROM org_profiles WHERE id = $1`, [targetId]),
  ]);

  if (sourceRes.rows.length === 0) throw new Error(`Source org id=${sourceId} not found`);
  if (targetRes.rows.length === 0) throw new Error(`Target org id=${targetId} not found`);

  const source = sourceRes.rows[0];
  const target = targetRes.rows[0];

  // 1. Relink entries
  const relinked = await pool.query(
    `UPDATE scan_entries SET org_id = $1 WHERE org_id = $2 RETURNING id`,
    [targetId, sourceId]
  );

  // 2. Combine wires + 3. Store source name as alias on target
  const combinedWires = [...new Set([...(target.wires || []), ...(source.wires || [])])];
  const combinedAliases = [...new Set([...(target.aliases || []), source.name, ...(source.aliases || [])])];

  await pool.query(
    `UPDATE org_profiles SET
      wires = $1,
      aliases = $2,
      entry_count = (SELECT COUNT(*) FROM scan_entries WHERE org_id = $3)::int,
      updated_at = NOW()
    WHERE id = $3`,
    [combinedWires, combinedAliases, targetId]
  );

  // 4. Reparent any orgs that had source as parent
  await pool.query(
    `UPDATE org_profiles SET parent_org_id = $1 WHERE parent_org_id = $2`,
    [targetId, sourceId]
  );

  // 5. Delete source
  await pool.query(`DELETE FROM org_profiles WHERE id = $1`, [sourceId]);

  console.log(`[OrgMerge] Merged "${source.name}" (id=${sourceId}) into "${target.name}" (id=${targetId}), relinked ${relinked.rowCount ?? 0} entries`);

  return {
    entriesRelinked: relinked.rowCount ?? 0,
    sourceDeleted: true,
    targetName: target.name,
  };
}

export interface ArchiveResult {
  entriesUnlinked: number;
  orgDeleted: boolean;
}

/**
 * Archive (delete) an org:
 * 1. Unlink all scan_entries (set org_id = NULL)
 * 2. Reparent children (set parent_org_id = NULL)
 * 3. Delete the org profile
 */
export async function archiveOrg(orgId: number): Promise<ArchiveResult> {
  const pool = getPool();

  const orgRes = await pool.query(`SELECT id, name FROM org_profiles WHERE id = $1`, [orgId]);
  if (orgRes.rows.length === 0) throw new Error(`Org id=${orgId} not found`);

  const orgName = orgRes.rows[0].name;

  // 1. Unlink entries
  const unlinked = await pool.query(
    `UPDATE scan_entries SET org_id = NULL WHERE org_id = $1 RETURNING id`,
    [orgId]
  );

  // 2. Reparent children
  await pool.query(
    `UPDATE org_profiles SET parent_org_id = NULL WHERE parent_org_id = $1`,
    [orgId]
  );

  // 3. Delete org
  await pool.query(`DELETE FROM org_profiles WHERE id = $1`, [orgId]);

  console.log(`[OrgArchive] Deleted "${orgName}" (id=${orgId}), unlinked ${unlinked.rowCount ?? 0} entries`);

  return {
    entriesUnlinked: unlinked.rowCount ?? 0,
    orgDeleted: true,
  };
}
