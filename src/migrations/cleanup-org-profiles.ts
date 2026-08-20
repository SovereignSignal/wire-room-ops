/**
 * Org-profile CRM cleanup
 *
 * Archives junk/person/event/unenriched-program rows from org_profiles,
 * then archives matching Sov's Orgs Notion pages so the daily sync cannot
 * recreate them. Also keeps the original name-hygiene passes (brackets,
 * embedded @handles, slug repair).
 *
 *   POST /api/admin/clean-orgs           { dryRun?: boolean }
 *   npx ts-node src/scripts/clean-org-profiles.ts [--dry-run]
 */

import type { Pool } from 'pg';
import {
  shouldArchiveOrgProfile,
  classifyOrgName,
} from '../services/org-extractor';
import { getIntegrationConfigs, archiveNotionPagesByTitle } from '../services/notion-sync';

export interface OrgCleanupCandidate {
  id: number;
  name: string;
  kind: ReturnType<typeof classifyOrgName>;
}

export interface OrgCleanupResult {
  dryRun: boolean;
  badOrgsDeleted: number;
  entriesUnlinked: number;
  notionArchived: number;
  notionMisses: number;
  bracketsFixed: number;
  handlesStripped: number;
  slugsUpdated: number;
  archived: OrgCleanupCandidate[];
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 80);
}

export async function runOrgCleanup(
  pool: Pool,
  opts: { dryRun?: boolean; archiveNotion?: boolean } = {},
): Promise<OrgCleanupResult> {
  const dryRun = !!opts.dryRun;
  const archiveNotion = opts.archiveNotion ?? !dryRun;
  const result: OrgCleanupResult = {
    dryRun,
    badOrgsDeleted: 0,
    entriesUnlinked: 0,
    notionArchived: 0,
    notionMisses: 0,
    bracketsFixed: 0,
    handlesStripped: 0,
    slugsUpdated: 0,
    archived: [],
  };

  console.log(`[OrgCleanup] Starting org_profiles cleanup${dryRun ? ' (dry-run)' : ''}...`);

  const { rows: orgs } = await pool.query(
    `SELECT id, name, org_type, website, description FROM org_profiles ORDER BY id`,
  );

  for (const org of orgs) {
    if (!shouldArchiveOrgProfile(org)) continue;
    result.archived.push({ id: org.id, name: org.name, kind: classifyOrgName(org.name) });
  }

  if (!dryRun) {
    for (const candidate of result.archived) {
      const unlinked = await pool.query(
        `UPDATE scan_entries SET org_id = NULL WHERE org_id = $1 RETURNING id`,
        [candidate.id],
      );
      await pool.query(
        `UPDATE org_profiles SET parent_org_id = NULL WHERE parent_org_id = $1`,
        [candidate.id],
      );
      await pool.query(`DELETE FROM org_profiles WHERE id = $1`, [candidate.id]);
      result.badOrgsDeleted++;
      result.entriesUnlinked += unlinked.rowCount ?? 0;
      console.log(`[OrgCleanup] Archived "${candidate.name}" (id=${candidate.id}, kind=${candidate.kind}), unlinked ${unlinked.rowCount ?? 0} entries`);
    }
  }

  if (!dryRun) {
    // 2. Fix bracket-wrapped names like "[Center for AI Safety]" → "Center for AI Safety"
    {
      const res = await pool.query(
        `SELECT id, name FROM org_profiles WHERE name LIKE '[%]'`,
      );
      for (const row of res.rows) {
        const cleaned = row.name.replace(/^\[|\]$/g, '').trim();
        if (cleaned && cleaned !== row.name) {
          const existing = await pool.query(
            `SELECT id FROM org_profiles WHERE name = $1 AND id != $2`,
            [cleaned, row.id],
          );
          if (existing.rows.length > 0) {
            await pool.query(`UPDATE scan_entries SET org_id = $1 WHERE org_id = $2`, [existing.rows[0].id, row.id]);
            await pool.query(`DELETE FROM org_profiles WHERE id = $1`, [row.id]);
            console.log(`[OrgCleanup] Merged bracket org id=${row.id} "${row.name}" into existing id=${existing.rows[0].id} "${cleaned}"`);
          } else {
            const newSlug = slugify(cleaned);
            await pool.query(
              `UPDATE org_profiles SET name = $1, slug = $2, updated_at = NOW() WHERE id = $3`,
              [cleaned, newSlug, row.id],
            );
            console.log(`[OrgCleanup] Fixed brackets: "${row.name}" → "${cleaned}"`);
          }
          result.bracketsFixed++;
        }
      }
    }

    // 3. Strip embedded @handles from names like "Prezenti @prezenti_grants" → "Prezenti"
    {
      const res = await pool.query(
        `SELECT id, name FROM org_profiles WHERE name ~ '@[a-zA-Z0-9_]+'`,
      );
      for (const row of res.rows) {
        const cleaned = row.name.replace(/\s*@[a-zA-Z0-9_]+/g, '').trim();
        if (cleaned && cleaned !== row.name && cleaned.length >= 2) {
          const existing = await pool.query(
            `SELECT id FROM org_profiles WHERE name = $1 AND id != $2`,
            [cleaned, row.id],
          );
          if (existing.rows.length > 0) {
            await pool.query(`UPDATE scan_entries SET org_id = $1 WHERE org_id = $2`, [existing.rows[0].id, row.id]);
            await pool.query(`DELETE FROM org_profiles WHERE id = $1`, [row.id]);
            console.log(`[OrgCleanup] Merged handle-stripped org id=${row.id} "${row.name}" into existing id=${existing.rows[0].id} "${cleaned}"`);
          } else {
            const newSlug = slugify(cleaned);
            await pool.query(
              `UPDATE org_profiles SET name = $1, slug = $2, updated_at = NOW() WHERE id = $3`,
              [cleaned, newSlug, row.id],
            );
            console.log(`[OrgCleanup] Stripped handle: "${row.name}" → "${cleaned}"`);
          }
          result.handlesStripped++;
        }
      }
    }

    // 4. Fix any mismatched slugs (name changed but slug wasn't updated)
    {
      const res = await pool.query(`SELECT id, name, slug FROM org_profiles`);
      for (const row of res.rows) {
        const expectedSlug = slugify(row.name);
        if (row.slug !== expectedSlug) {
          const existing = await pool.query(
            `SELECT id FROM org_profiles WHERE slug = $1 AND id != $2`,
            [expectedSlug, row.id],
          );
          if (existing.rows.length === 0) {
            await pool.query(
              `UPDATE org_profiles SET slug = $1, updated_at = NOW() WHERE id = $2`,
              [expectedSlug, row.id],
            );
            result.slugsUpdated++;
          }
        }
      }
    }
  }

  if (!dryRun && archiveNotion && result.archived.length > 0) {
    try {
      const configs = await getIntegrationConfigs('notion');
      const crm = configs.find(i => i.name === 'SimpleCRM - Notion' && i.enabled)
        || configs.find(i => i.enabled && i.config?.notion_token && i.config?.database_id);
      const token = crm?.config?.notion_token;
      const databaseId = crm?.config?.database_id;
      if (token && databaseId) {
        const notion = await archiveNotionPagesByTitle(
          token,
          databaseId,
          result.archived.map(row => row.name),
        );
        result.notionArchived = notion.archived;
        result.notionMisses = notion.misses;
      } else {
        console.warn('[OrgCleanup] Notion archive skipped: SimpleCRM integration not configured');
      }
    } catch (err) {
      console.error('[OrgCleanup] Notion archive failed (Postgres cleanup already committed):', err);
    }
  }

  console.log(
    `[OrgCleanup] Complete: ${dryRun ? 'would archive' : 'deleted'} ${result.archived.length} orgs`
    + `${dryRun ? '' : `, unlinked ${result.entriesUnlinked} entries, Notion archived ${result.notionArchived}`}`
    + `, ${result.bracketsFixed} brackets fixed, ${result.handlesStripped} handles stripped, ${result.slugsUpdated} slugs updated`,
  );
  return result;
}
