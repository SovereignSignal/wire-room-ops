/**
 * Process Raw Entries Job
 *
 * Background job that processes entries with status='raw' through
 * Gate 1 (completeness) → dedup → scoring → queue pipeline.
 *
 * Gate 1 rejects entries with missing/garbage data (status='incomplete').
 * Entries that pass Gate 1 + dedup always go to 'queued' — human reviews everything.
 * Quality score is still calculated for display but does NOT gate queue entry.
 *
 * Idempotent: safe to run multiple times. Only touches status='raw' entries.
 * Processes in batches of 50 to avoid overwhelming the DB.
 */

import type { Pool } from 'pg';
import { checkDuplicate, registerSeen } from '../services/dedup';
import { scoreEntry } from '../services/quality-scorer';
import { classifyEntry } from '../services/classifier';

const BATCH_SIZE = 50;

let isRunning = false;

/**
 * Gate 1: Completeness check.
 * Returns whether the entry has sufficient data to proceed through the pipeline.
 */
export function isCompletionSufficient(entry: {
  name: string | null;
  description: string | null;
  source_url: string | null;
}): { passes: boolean; reason?: string } {
  // Check name
  const name = entry.name?.trim() ?? '';
  if (!name) {
    return { passes: false, reason: 'Missing name' };
  }
  if (/^https?:\/\//i.test(name)) {
    return { passes: false, reason: 'Name is only a URL' };
  }
  if (/^@?[a-zA-Z0-9_]+$/.test(name)) {
    return { passes: false, reason: 'Name is only a handle' };
  }

  // Check description — strip whitespace and emoji before length check
  const description = entry.description?.trim() ?? '';
  if (!description) {
    return { passes: false, reason: 'Missing description' };
  }
  if (/^https?:\/\//i.test(description)) {
    return { passes: false, reason: 'Description is only a URL' };
  }
  // Strip emoji (surrogate pairs + common emoji ranges) and whitespace for length check
  const strippedDescription = description
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}]/gu, '')
    .replace(/\s+/g, '');
  if (strippedDescription.length < 30) {
    return { passes: false, reason: `Description too short (${strippedDescription.length} chars after stripping)` };
  }

  // Check source_url
  const sourceUrl = entry.source_url?.trim() ?? '';
  if (!sourceUrl || sourceUrl.startsWith('scan://')) {
    return { passes: false, reason: sourceUrl ? 'Internal scan:// URL' : 'Missing source URL' };
  }

  return { passes: true };
}

/**
 * Process all raw entries through Gate 1, dedup, and scoring.
 * Returns a summary of what was processed.
 */
export async function processRawEntries(pool?: Pool): Promise<{
  processed: number;
  incomplete: number;
  duplicates: number;
  queued: number;
  archived: number;
}> {
  if (isRunning) {
    console.log('[ProcessRaw] Already running, skipping');
    return { processed: 0, incomplete: 0, duplicates: 0, queued: 0, archived: 0 };
  }

  isRunning = true;
  const stats = { processed: 0, incomplete: 0, duplicates: 0, queued: 0, archived: 0 };

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
          // Gate 1: Completeness check
          const completeness = isCompletionSufficient({
            name: row.name,
            description: row.description,
            source_url: row.source_url,
          });

          if (!completeness.passes) {
            await db.query(
              `UPDATE scan_entries
               SET status = 'incomplete',
                   classification = 'UNCHECKED'
               WHERE id = $1 AND status = 'raw'`,
              [row.id]
            );
            console.log(`[ProcessRaw] Gate 1 fail for entry ${row.id}: ${completeness.reason}`);
            stats.incomplete++;
            stats.processed++;
            continue;
          }

          // Phase 2: Dedup check
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

            // Phase 3: Quality scoring (kept for display, does NOT gate queue entry)
            const breakdown = scoreEntry({
              name: row.name,
              description: row.description,
              amount: row.amount,
              deadline: row.deadline,
              scanDate: row.scan_date instanceof Date
                ? row.scan_date.toISOString().split('T')[0]
                : String(row.scan_date),
            });

            // Always queue — human reviews everything. Score is for display only.
            await db.query(
              `UPDATE scan_entries
               SET quality_score = $1,
                   quality_breakdown = $2,
                   status = 'queued',
                   classification = 'UNCHECKED'
               WHERE id = $3`,
              [breakdown.totalScore, JSON.stringify(breakdown), row.id]
            );

            stats.queued++;
            // Gate 2: LLM classification (non-blocking — failure leaves entry as UNCHECKED)
            try {
              const classResult = await classifyEntry({
                name: row.name,
                description: row.description || '',
                source_url: row.source_url,
                wire: row.wire,
              });
              await db.query(
                `UPDATE scan_entries
                 SET classification = $1,
                     classification_reason = $2,
                     metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
                 WHERE id = $4`,
                [
                  classResult.classification,
                  classResult.reason,
                  JSON.stringify(classResult.extracted),
                  row.id,
                ]
              );
            } catch (classError) {
              console.error(`[ProcessRaw] Classification failed for entry ${row.id}, leaving as UNCHECKED:`, classError);
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
        `${stats.incomplete} incomplete, ${stats.duplicates} dupes, ${stats.queued} queued`
      );
    }

    if (stats.processed > 0) {
      console.log(
        `[ProcessRaw] Done: ${stats.processed} processed, ` +
        `${stats.incomplete} incomplete, ${stats.duplicates} duplicates, ${stats.queued} queued`
      );
    }

    return stats;
  } finally {
    isRunning = false;
  }
}
