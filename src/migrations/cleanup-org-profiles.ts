/**
 * One-time org_profiles data cleanup migration
 *
 * Fixes known bad data patterns:
 * 1. Removes known-bad org names (entry titles, not real orgs)
 * 2. Strips brackets from names like "[Center for AI Safety]"
 * 3. Strips embedded @handles from names like "Prezenti @prezenti_grants"
 * 4. Updates slugs after name changes
 *
 * Every change is logged to console for audit trail.
 */

import type { Pool } from 'pg';

export interface OrgCleanupResult {
  badOrgsDeleted: number;
  bracketsFixed: number;
  handlesStripped: number;
  slugsUpdated: number;
}

const BAD_ORG_NAMES = [
  'Official Launch',
  'Season 7 Nominations',
  'Thrive Polygon Update',
  'Stacks new grants program live',
  'OPPORTUNITIES FOR YOUTH',
  'Foresight AI Nodes grants',
  'Introducing @PL_Genesis: Frontiers of Collaboration',
  'Webfalainitiat1',
];

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 80);
}

export async function runOrgCleanup(pool: Pool): Promise<OrgCleanupResult> {
  const result: OrgCleanupResult = {
    badOrgsDeleted: 0,
    bracketsFixed: 0,
    handlesStripped: 0,
    slugsUpdated: 0,
  };

  console.log('[OrgCleanup] Starting org_profiles cleanup...');

  // 1. Remove known-bad org names
  for (const badName of BAD_ORG_NAMES) {
    const org = await pool.query(`SELECT id FROM org_profiles WHERE name = $1`, [badName]);
    if (org.rows.length > 0) {
      const orgId = org.rows[0].id;
      // Unlink scan_entries first
      const unlinked = await pool.query(
        `UPDATE scan_entries SET org_id = NULL WHERE org_id = $1 RETURNING id`,
        [orgId]
      );
      await pool.query(`DELETE FROM org_profiles WHERE id = $1`, [orgId]);
      result.badOrgsDeleted++;
      console.log(`[OrgCleanup] Deleted bad org id=${orgId}: "${badName}" (unlinked ${unlinked.rowCount ?? 0} entries)`);
    }
  }

  // 2. Fix bracket-wrapped names like "[Center for AI Safety]" → "Center for AI Safety"
  {
    const res = await pool.query(
      `SELECT id, name FROM org_profiles WHERE name LIKE '[%]'`
    );
    for (const row of res.rows) {
      const cleaned = row.name.replace(/^\[|\]$/g, '').trim();
      if (cleaned && cleaned !== row.name) {
        // Check for name collision
        const existing = await pool.query(`SELECT id FROM org_profiles WHERE name = $1 AND id != $2`, [cleaned, row.id]);
        if (existing.rows.length > 0) {
          // Merge: relink entries to existing org, delete this one
          await pool.query(`UPDATE scan_entries SET org_id = $1 WHERE org_id = $2`, [existing.rows[0].id, row.id]);
          await pool.query(`DELETE FROM org_profiles WHERE id = $1`, [row.id]);
          console.log(`[OrgCleanup] Merged bracket org id=${row.id} "${row.name}" into existing id=${existing.rows[0].id} "${cleaned}"`);
        } else {
          const newSlug = slugify(cleaned);
          await pool.query(
            `UPDATE org_profiles SET name = $1, slug = $2, updated_at = NOW() WHERE id = $3`,
            [cleaned, newSlug, row.id]
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
      `SELECT id, name FROM org_profiles WHERE name ~ '@[a-zA-Z0-9_]+'`
    );
    for (const row of res.rows) {
      const cleaned = row.name.replace(/\s*@[a-zA-Z0-9_]+/g, '').trim();
      if (cleaned && cleaned !== row.name && cleaned.length >= 2) {
        // Check for name collision
        const existing = await pool.query(`SELECT id FROM org_profiles WHERE name = $1 AND id != $2`, [cleaned, row.id]);
        if (existing.rows.length > 0) {
          await pool.query(`UPDATE scan_entries SET org_id = $1 WHERE org_id = $2`, [existing.rows[0].id, row.id]);
          await pool.query(`DELETE FROM org_profiles WHERE id = $1`, [row.id]);
          console.log(`[OrgCleanup] Merged handle-stripped org id=${row.id} "${row.name}" into existing id=${existing.rows[0].id} "${cleaned}"`);
        } else {
          const newSlug = slugify(cleaned);
          await pool.query(
            `UPDATE org_profiles SET name = $1, slug = $2, updated_at = NOW() WHERE id = $3`,
            [cleaned, newSlug, row.id]
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
        // Check for slug collision
        const existing = await pool.query(`SELECT id FROM org_profiles WHERE slug = $1 AND id != $2`, [expectedSlug, row.id]);
        if (existing.rows.length === 0) {
          await pool.query(
            `UPDATE org_profiles SET slug = $1, updated_at = NOW() WHERE id = $2`,
            [expectedSlug, row.id]
          );
          result.slugsUpdated++;
        }
      }
    }
  }

  console.log(`[OrgCleanup] Complete: ${result.badOrgsDeleted} bad orgs deleted, ${result.bracketsFixed} brackets fixed, ${result.handlesStripped} handles stripped, ${result.slugsUpdated} slugs updated`);
  return result;
}
