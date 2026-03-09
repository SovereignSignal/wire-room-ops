/**
 * Process Raw Entries Job
 *
 * Background job that processes entries with status='raw' through
 * the dedup+scoring pipeline. Handles entries from any scan_source
 * (telegram, manual-intake, etc.) that were inserted at raw status
 * but never processed through daily-intake.
 *
 * Idempotent: safe to run multiple times. Only touches status='raw' entries.
 * Processes in batches of 50 to avoid overwhelming the DB.
 */

import type { Pool } from 'pg';
import { checkDuplicate, registerSeen } from '../services/dedup';
import { scoreEntry } from '../services/quality-scorer';

const BATCH_SIZE = 50;
const QUALITY_THRESHOLD = 40;

let isRunning = false;

/**
 * Process all raw entries through dedup and scoring.
 * Returns a summary of what was processed.
 */
export async function processRawEntries(pool?: Pool): Promise<{
  processed: number;
  duplicates: number;
  queued: number;
  archived: number;
}> {
  if (isRunning) {
    console.log('[ProcessRaw] Already running, skipping');
    return { processed: 0, duplicates: 0, queued: 0, archived: 0 };
  }

  isRunning = true;
  const stats = { processed: 0, duplicates: 0, queued: 0, archived: 0 };

  try {
    // Use provided pool or get default
    const db = pool || (await import('../db')).getPool();

    // Process in batches until no more raw entries
    while (true) {
      const batch = await db.query(
        `SELECT id, name, description, source_url, amount, deadline, wire, scan_date
         FROM scan_entries
         WHERE status = 'raw'
           AND created_at < NOW() - INTERVAL '2 minutes'
         ORDER BY created_at ASC
         LIMIT $1`,
        [BATCH_SIZE]
      );

      if (batch.rows.length === 0) break;

      console.log(`[ProcessRaw] Processing batch of ${batch.rows.length} entries`);

      for (const row of batch.rows) {
        try {
          // Phase 1: Dedup check
          const dedupResult = await checkDuplicate(
            db,
            {
              sourceUrl: row.source_url,
              name: row.name,
              wire: row.wire,
            },
            14 // lookback days
          );

          if (dedupResult.isDuplicate) {
            await db.query(
              `UPDATE scan_entries
               SET status = 'duplicate',
                   duplicate_of_id = $1,
                   duplicate_reason = $2
               WHERE id = $3 AND status = 'raw'`,
              [dedupResult.matchedEntryId, dedupResult.reason, row.id]
            );
            stats.duplicates++;
          } else {
            // Mark as deduped
            await db.query(
              `UPDATE scan_entries SET status = 'deduped' WHERE id = $1 AND status = 'raw'`,
              [row.id]
            );

            // Register in seen tables
            await registerSeen(db, {
              id: row.id,
              sourceUrl: row.source_url,
              name: row.name,
              wire: row.wire,
              scanDate: row.scan_date instanceof Date
                ? row.scan_date.toISOString().split('T')[0]
                : String(row.scan_date),
            });

            // Phase 2: Quality scoring
            const breakdown = scoreEntry({
              name: row.name,
              description: row.description,
              amount: row.amount,
              deadline: row.deadline,
              scanDate: row.scan_date instanceof Date
                ? row.scan_date.toISOString().split('T')[0]
                : String(row.scan_date),
            });

            const newStatus = breakdown.totalScore >= QUALITY_THRESHOLD ? 'queued' : 'archived';

            await db.query(
              `UPDATE scan_entries
               SET quality_score = $1,
                   quality_breakdown = $2,
                   status = $3
               WHERE id = $4`,
              [breakdown.totalScore, JSON.stringify(breakdown), newStatus, row.id]
            );

            if (newStatus === 'queued') {
              stats.queued++;
            } else {
              stats.archived++;
            }
          }

          stats.processed++;
        } catch (entryError) {
          console.error(`[ProcessRaw] Error processing entry ${row.id}:`, entryError);
          // Continue with next entry — don't let one bad entry block the batch
        }
      }

      console.log(
        `[ProcessRaw] Batch complete: ${stats.processed} processed, ` +
        `${stats.duplicates} dupes, ${stats.queued} queued, ${stats.archived} archived`
      );
    }

    if (stats.processed > 0) {
      console.log(
        `[ProcessRaw] Done: ${stats.processed} processed, ` +
        `${stats.duplicates} duplicates, ${stats.queued} queued, ${stats.archived} archived`
      );
    }

    return stats;
  } finally {
    isRunning = false;
  }
}
