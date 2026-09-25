/**
 * Org Merge & Archive
 *
 * Provides operator tools for deduplicating org_profiles:
 * - mergeOrgs(): Relink entries from source to target, combine metadata, delete source
 * - archiveOrg(): Unlink entries from org, delete the org profile
 */

import { getPool } from '../db';
import { archiveSimpleCrmOrgPages } from './notion-sync';

export interface MergeResult {
  entriesRelinked: number;
  sourceDeleted: boolean;
  targetName: string;
  sourceName: string;
  notionArchived: number;
}

export interface MergeOptions {
  archiveNotion?: boolean;
}

/**
 * Merge source org into target org:
 * 1. Relink all scan_entries from source → target
 * 2. Combine wires arrays (deduplicated)
 * 3. Store source name in target's aliases
 * 4. Update entry_count on target
 * 5. Delete source org
 */
export async function mergeOrgs(
  sourceId: number,
  targetId: number,
  opts: MergeOptions = {},
): Promise<MergeResult> {
  if (sourceId === targetId) throw new Error('Cannot merge an org into itself');

  const pool = getPool();
  const archiveNotion = opts.archiveNotion ?? true;

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

  let notionArchived = 0;
  if (archiveNotion) {
    try {
      const notion = await archiveSimpleCrmOrgPages([source.name]);
      notionArchived = notion.archived;
    } catch (err) {
      console.error(`[OrgMerge] Notion archive of "${source.name}" failed (Postgres merge already committed):`, err);
    }
  }

  console.log(`[OrgMerge] Merged "${source.name}" (id=${sourceId}) into "${target.name}" (id=${targetId}), relinked ${relinked.rowCount ?? 0} entries`);

  return {
    entriesRelinked: relinked.rowCount ?? 0,
    sourceDeleted: true,
    targetName: target.name,
    sourceName: source.name,
    notionArchived,
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

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 80);
}

export interface RenameResult {
  orgId: number;
  fromName: string;
  toName: string;
  notionArchived: number;
}

/**
 * Rename an org in place and keep the previous name as an alias.
 */
export async function renameOrg(
  orgId: number,
  newName: string,
  opts: MergeOptions = {},
): Promise<RenameResult> {
  const pool = getPool();
  const archiveNotion = opts.archiveNotion ?? true;
  const { rows } = await pool.query(
    `SELECT id, name, aliases FROM org_profiles WHERE id = $1`,
    [orgId],
  );
  if (rows.length === 0) throw new Error(`Org id=${orgId} not found`);

  const fromName: string = rows[0].name;
  if (fromName === newName) {
    return { orgId, fromName, toName: newName, notionArchived: 0 };
  }

  const slug = slugify(newName);
  const conflict = await pool.query(
    `SELECT id, name FROM org_profiles WHERE (name = $1 OR slug = $2) AND id != $3`,
    [newName, slug, orgId],
  );
  if (conflict.rows.length > 0) {
    throw new Error(
      `Cannot rename "${fromName}" to "${newName}": conflicts with id=${conflict.rows[0].id} (${conflict.rows[0].name})`,
    );
  }

  const aliases = [...new Set([...(rows[0].aliases || []), fromName])];
  await pool.query(
    `UPDATE org_profiles SET name = $1, slug = $2, aliases = $3, updated_at = NOW() WHERE id = $4`,
    [newName, slug, aliases, orgId],
  );

  let notionArchived = 0;
  if (archiveNotion) {
    try {
      const notion = await archiveSimpleCrmOrgPages([fromName]);
      notionArchived = notion.archived;
    } catch (err) {
      console.error(`[OrgMerge] Notion archive of "${fromName}" failed (Postgres rename already committed):`, err);
    }
  }

  console.log(`[OrgMerge] Renamed "${fromName}" (id=${orgId}) to "${newName}"`);
  return { orgId, fromName, toName: newName, notionArchived };
}

/**
 * Add an alias to an existing org if it is not already present.
 */
export async function addOrgAlias(orgId: number, alias: string): Promise<boolean> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, name, aliases FROM org_profiles WHERE id = $1`,
    [orgId],
  );
  if (rows.length === 0) throw new Error(`Org id=${orgId} not found`);
  const aliases: string[] = rows[0].aliases || [];
  if (aliases.includes(alias) || rows[0].name === alias) return false;
  await pool.query(
    `UPDATE org_profiles SET aliases = $1, updated_at = NOW() WHERE id = $2`,
    [[...aliases, alias], orgId],
  );
  return true;
}
