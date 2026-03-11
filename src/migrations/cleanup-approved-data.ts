/**
 * Phase 1D: One-time data cleanup migration
 *
 * Fixes known bad data patterns in scan_entries:
 * 1. EXPIRED-but-approved entries → declined
 * 2. Queued entries with empty URLs → archived (with metadata note)
 * 3. Oversized names on approved entries → truncated at word boundary
 * 4. Junk deadlines (URLs, semicolons, overly long) → nulled out
 *
 * Every change is logged to console for audit trail.
 */

import type { Pool } from 'pg';

export interface CleanupResult {
  expiredDeclined: number;
  emptyUrlsArchived: number;
  namesFixed: number;
  deadlinesFixed: number;
}

/**
 * Truncate a string to maxLen characters at a word boundary.
 * If the string is shorter than maxLen, returns it unchanged.
 */
function truncateAtWordBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;

  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');

  // If there's a space in the first maxLen chars, cut there; otherwise hard-cut
  if (lastSpace > maxLen * 0.5) {
    return truncated.slice(0, lastSpace).trimEnd();
  }
  return truncated.trimEnd();
}

export async function runDataCleanup(pool: Pool): Promise<CleanupResult> {
  const result: CleanupResult = {
    expiredDeclined: 0,
    emptyUrlsArchived: 0,
    namesFixed: 0,
    deadlinesFixed: 0,
  };

  console.log('[Migration] Starting data cleanup migration...');

  // 1. Fix EXPIRED-but-approved entries → declined
  {
    const res = await pool.query(
      `UPDATE scan_entries
       SET status = 'declined', updated_at = NOW()
       WHERE status = 'approved' AND classification = 'EXPIRED'
       RETURNING id, name`
    );
    result.expiredDeclined = res.rowCount ?? 0;
    for (const row of res.rows) {
      console.log(`[Migration] Declined expired-but-approved entry id=${row.id}: ${row.name}`);
    }
  }

  // 2. Fix queued entries with empty URLs → archived with metadata note
  {
    const res = await pool.query(
      `UPDATE scan_entries
       SET status = 'archived',
           metadata = COALESCE(metadata, '{}'::jsonb) || '{"archived_reason": "empty_url_cleanup"}'::jsonb,
           updated_at = NOW()
       WHERE status = 'queued' AND (source_url = '' OR source_url IS NULL)
       RETURNING id, name`
    );
    result.emptyUrlsArchived = res.rowCount ?? 0;
    for (const row of res.rows) {
      console.log(`[Migration] Archived queued entry with empty URL id=${row.id}: ${row.name}`);
    }
  }

  // 3. Fix oversized names on approved entries (> 120 chars)
  {
    const res = await pool.query(
      `SELECT id, name, description FROM scan_entries
       WHERE status = 'approved' AND LENGTH(name) > 120`
    );

    for (const row of res.rows) {
      const originalName: string = row.name;
      const truncatedName = truncateAtWordBoundary(originalName, 120);

      // If description is empty, copy full original name into it
      const descriptionEmpty = !row.description || row.description.trim() === '';
      const newDescription = descriptionEmpty ? originalName : row.description;

      await pool.query(
        `UPDATE scan_entries
         SET name = $1, description = $2, updated_at = NOW()
         WHERE id = $3`,
        [truncatedName, newDescription, row.id]
      );
      result.namesFixed++;
      console.log(`[Migration] Truncated name for entry id=${row.id}: "${originalName.slice(0, 60)}..." → "${truncatedName.slice(0, 60)}..."`);
    }
  }

  // 4. Fix junk deadlines (too long, contains semicolons, or contains URLs)
  {
    const res = await pool.query(
      `UPDATE scan_entries
       SET deadline = NULL, deadline_parsed = NULL, updated_at = NOW()
       WHERE deadline IS NOT NULL
         AND (LENGTH(deadline) > 50 OR deadline LIKE '%;%' OR deadline LIKE '%https://%')
       RETURNING id, name, deadline`
    );
    result.deadlinesFixed = res.rowCount ?? 0;
    for (const row of res.rows) {
      console.log(`[Migration] Cleared junk deadline for entry id=${row.id}: "${row.deadline}"`);
    }
  }

  console.log(`[Migration] Data cleanup complete: ${result.expiredDeclined} expired→declined, ${result.emptyUrlsArchived} empty-url→archived, ${result.namesFixed} names truncated, ${result.deadlinesFixed} junk deadlines cleared`);

  return result;
}
