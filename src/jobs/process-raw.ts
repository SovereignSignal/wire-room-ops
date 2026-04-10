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
// quality-scorer.ts replaced by LLM scoring in classifier.ts
import { classifyEntry } from '../services/classifier';

const BATCH_SIZE = 50;

// Concurrency guard: prevents overlapping runs in single-process Node.js.
// The boolean check-then-set is atomic within a single event loop tick.
// The timeout safety valve handles the edge case where a run hangs indefinitely
// (e.g., a DB query never resolves), which would permanently block future runs.
let isRunning = false;
let runStartedAt = 0;
const MAX_RUN_DURATION_MS = 10 * 60 * 1000; // 10 minutes

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
    if (Date.now() - runStartedAt > MAX_RUN_DURATION_MS) {
      console.warn('[ProcessRaw] Previous run appears stuck (>' + (MAX_RUN_DURATION_MS / 60000) + 'min), allowing new run');
    } else {
      console.log('[ProcessRaw] Already running, skipping');
      return { processed: 0, incomplete: 0, duplicates: 0, queued: 0, archived: 0 };
    }
  }

  isRunning = true;
  runStartedAt = Date.now();
  const stats = { processed: 0, incomplete: 0, duplicates: 0, queued: 0, archived: 0 };

  try {
    // Use provided pool or get default
    const db = pool || (await import('../db')).getPool();

    // Process in batches until no more raw entries
    while (true) {
      const batch = await db.query(
        `SELECT se.id, se.name, se.description, se.source_url, se.amount, se.deadline,
                se.wire, se.scan_date, se.prompt_id, sp.intent AS prompt_intent
         FROM scan_entries se
         LEFT JOIN scan_prompts sp ON se.prompt_id = sp.id
         WHERE se.status = 'raw'
           AND se.created_at < NOW() - INTERVAL '2 minutes'
         ORDER BY se.created_at ASC
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

            // Temporarily queue — Gate 2 below may auto-archive based on classification/score.
            await db.query(
              `UPDATE scan_entries
               SET quality_score = 0,
                   status = 'queued',
                   classification = 'UNCHECKED'
               WHERE id = $1`,
              [row.id]
            );

            stats.queued++;
            // Gate 2: LLM classification + quality scoring (single Grok call)
            // Non-blocking — failure leaves entry as UNCHECKED with score 0
            try {
              const classResult = await classifyEntry({
                name: row.name,
                description: row.description || '',
                source_url: row.source_url,
                wire: row.wire,
                intent: row.prompt_intent || undefined,
              });
              // Auto-archive: NOISE, low-score NEWS, and anything scoring below 30.
              // Only genuinely promising entries should reach the operator queue.
              const shouldArchive =
                classResult.classification === 'NOISE' ||
                (classResult.classification === 'NEWS' && classResult.qualityScore < 45) ||
                classResult.qualityScore < 30;
              const classStatus = shouldArchive ? 'archived' : 'queued';
              if (shouldArchive) {
                stats.queued--; // was pre-counted as queued above
                stats.archived++;
              }
              await db.query(
                `UPDATE scan_entries
                 SET classification = $1,
                     classification_reason = $2,
                     quality_score = $3,
                     quality_breakdown = $4,
                     metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
                     tags = $6,
                     status = $8
                 WHERE id = $7`,
                [
                  classResult.classification,
                  classResult.reason,
                  classResult.qualityScore,
                  JSON.stringify({ scoreReason: classResult.scoreReason }),
                  JSON.stringify(classResult.extracted),
                  classResult.tags,
                  row.id,
                  classStatus,
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
