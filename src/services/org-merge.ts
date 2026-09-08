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
 * Atomically preserve contacts, entries, programs, watched sources, and children;
 * combine wires/aliases and delete the source. Conflicting contact identifiers
 * require resolution before merging. External archival runs after commit.
 */
export async function mergeOrgs(
  sourceId: number,
  targetId: number,
  opts: MergeOptions = {},
): Promise<MergeResult> {
  if (sourceId === targetId) throw new Error('Cannot merge an org into itself');

  const pool = getPool();
  const archiveNotion = opts.archiveNotion ?? true;

  const client = await pool.connect();
  let source;
  let target;
  let entriesRelinked = 0;
  try {
    await client.query('BEGIN');
    // Consistent lock order also serializes merges sharing either organization.
    const { rows } = await client.query(
      `SELECT id, name, wires, aliases, parent_org_id FROM org_profiles
       WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`,
      [[sourceId, targetId]],
    );
    source = rows.find(row => row.id === sourceId);
    target = rows.find(row => row.id === targetId);
    if (!source) throw new Error(`Source org id=${sourceId} not found`);
    if (!target) throw new Error(`Target org id=${targetId} not found`);

    // Contact discovery creates this optional table on first use.
    const contactsTable = await client.query(`SELECT to_regclass('discovered_contacts') AS name`);
    if (contactsTable.rows[0].name) {
      await client.query(
        `SELECT id FROM discovered_contacts WHERE org_id = ANY($1::int[]) ORDER BY id FOR UPDATE`,
        [[sourceId, targetId]],
      );
      const conflicts = await client.query(
        `SELECT s.name FROM discovered_contacts s JOIN discovered_contacts t
           ON t.name_norm = s.name_norm AND t.org_id = $2
         WHERE s.org_id = $1 AND (
           (s.notion_page_id IS NOT NULL AND t.notion_page_id IS NOT NULL AND s.notion_page_id <> t.notion_page_id)
           OR (s.x_handle IS NOT NULL AND t.x_handle IS NOT NULL AND s.x_handle <> t.x_handle))`,
        [sourceId, targetId],
      );
      if (conflicts.rows.length) {
        throw new Error(`Resolve conflicting contact identifiers before merging: ${conflicts.rows.map(row => row.name).join(', ')}`);
      }
      // Combine complementary fields, keeping the target record's identity.
      await client.query(
        `UPDATE discovered_contacts t SET
           x_handle = COALESCE(t.x_handle, s.x_handle),
           notion_page_id = COALESCE(t.notion_page_id, s.notion_page_id),
           created_at = LEAST(t.created_at, s.created_at)
         FROM discovered_contacts s
         WHERE s.org_id = $1 AND t.org_id = $2 AND s.name_norm = t.name_norm`,
        [sourceId, targetId],
      );
      await client.query(
        `DELETE FROM discovered_contacts s USING discovered_contacts t
         WHERE s.org_id = $1 AND t.org_id = $2 AND s.name_norm = t.name_norm`,
        [sourceId, targetId],
      );
      await client.query(`UPDATE discovered_contacts SET org_id = $2 WHERE org_id = $1`, [sourceId, targetId]);
    }

    const relinked = await client.query(
      `UPDATE scan_entries SET org_id = $1 WHERE org_id = $2`, [targetId, sourceId],
    );
    entriesRelinked = relinked.rowCount ?? 0;
    await client.query(
      `UPDATE org_profiles SET wires = $1, aliases = $2,
         entry_count = (SELECT COUNT(*) FROM scan_entries WHERE org_id = $3)::int,
         updated_at = NOW() WHERE id = $3`,
      [[...new Set([...(target.wires || []), ...(source.wires || [])])],
       [...new Set([...(target.aliases || []), source.name, ...(source.aliases || [])])], targetId],
    );
    // A target that was the source's child inherits the source's parent.
    await client.query(
      `UPDATE org_profiles SET parent_org_id = CASE WHEN id = $1 THEN $3 ELSE $1 END
       WHERE parent_org_id = $2`,
      [targetId, sourceId, source.parent_org_id === targetId ? null : source.parent_org_id],
    );
    await client.query(
      `UPDATE programs SET org_id = $1, org_name = $3, updated_at = NOW() WHERE org_id = $2`,
      [targetId, sourceId, target.name],
    );
    await client.query(
      `UPDATE watch_surfaces SET org_id = $1, org_name = $3, updated_at = NOW() WHERE org_id = $2`,
      [targetId, sourceId, target.name],
    );
    await client.query(`DELETE FROM org_profiles WHERE id = $1`, [sourceId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  let notionArchived = 0;
  if (archiveNotion) {
    try {
      const notion = await archiveSimpleCrmOrgPages([source.name]);
      notionArchived = notion.archived;
    } catch (err) {
      console.error(`[OrgMerge] Notion archive of "${source.name}" failed (Postgres merge already committed):`, err);
    }
  }

  console.log(`[OrgMerge] Merged "${source.name}" (id=${sourceId}) into "${target.name}" (id=${targetId}), relinked ${entriesRelinked} entries`);

  return {
    entriesRelinked,
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
