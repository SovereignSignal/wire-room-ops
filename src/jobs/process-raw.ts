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
 * Idempotent: safe to run multiple times. Processes status='raw' entries and
 * recovers abandoned status='deduped' handoffs after a safety window.
 * Processes in batches of 50 to avoid overwhelming the DB.
 */

import type { Pool } from 'pg';
import { finalizeExistingEntryDedup } from '../services/dedup';
// quality-scorer.ts replaced by LLM scoring in classifier.ts
import { classifyEntry } from '../services/classifier';
import { classifySourceLink } from '../services/source-filter';
import { finalizeProgramForEntry, normalizeProgramDeadline } from '../services/program-identity';

const BATCH_SIZE = 50;
const STRANDED_DEDUPED_AGE = '15 minutes';

// Concurrency guard: prevents overlapping runs in single-process Node.js.
// The boolean check-then-set is atomic within a single event loop tick.
// The timeout safety valve handles the edge case where a run hangs indefinitely
// (e.g., a DB query never resolves), which would permanently block future runs.
let isRunning = false;
let runStartedAt = 0;
const MAX_RUN_DURATION_MS = 10 * 60 * 1000; // 10 minutes

/**
 * `deduped` is a temporary handoff state. A process restart or a downstream
 * failure after the atomic URL claim can otherwise leave the row invisible
 * forever because the main worker only consumes `raw` rows. Recover old
 * handoffs to the normal review queue. Keeping the existing classification,
 * score, and distributable flag preserves the originating intake contract.
 * Seed-history URL conflicts also use `deduped`, but they are a terminal park,
 * not a handoff, and must remain excluded from recovery.
 *
 * The age guard stays beyond the worker's maximum normal run time so this
 * recovery cannot race an active daily-intake classification pass.
 */
export async function recoverStrandedDedupedEntries(
  db: Pick<Pool, 'query'>,
): Promise<number> {
  const recovered = await db.query(
    `UPDATE scan_entries
     SET status = 'queued',
         classification = COALESCE(classification, 'UNCHECKED'),
         updated_at = NOW()
     WHERE status = 'deduped'
       AND updated_at < NOW() - $1::interval
       AND duplicate_reason IS DISTINCT FROM 'URL already exists in seed history'
     RETURNING id`,
    [STRANDED_DEDUPED_AGE],
  );
  return recovered.rowCount ?? recovered.rows.length;
}

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
  const sourceClass = classifySourceLink(sourceUrl);
  if (sourceClass === 'missing' || sourceClass === 'placeholder' || sourceClass === 'invalid' || sourceClass === 'shortener') {
    return {
      passes: false,
      reason: sourceClass === 'missing'
        ? 'Missing source URL'
        : sourceClass === 'placeholder'
          ? 'Internal source placeholder'
          : sourceClass === 'shortener'
            ? 'Unresolved shortener URL'
            : 'Invalid source URL',
    };
  }

  return { passes: true };
}

export interface RawClassificationWrite {
  classification: string;
  reason: string;
  qualityScore: number;
  qualityBreakdown: unknown;
  metadata: unknown;
  tags: string[];
  status: 'queued' | 'archived';
  correctedWire: string | null;
}

/** Apply LLM output only while the row is still in the temporary queued state. */
export async function applyClassificationIfQueued(
  db: Pick<Pool, 'query'>,
  entryId: number,
  result: RawClassificationWrite,
): Promise<boolean> {
  const classified = await db.query(
    `UPDATE scan_entries
     SET classification = $1,
         classification_reason = $2,
         quality_score = $3,
         quality_breakdown = $4,
         metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
         tags = $6,
         status = $8,
         wire = COALESCE($9, wire)
     WHERE id = $7 AND status = 'queued'
     RETURNING id`,
    [
      result.classification,
      result.reason,
      result.qualityScore,
      JSON.stringify(result.qualityBreakdown),
      JSON.stringify(result.metadata),
      result.tags,
      entryId,
      result.status,
      result.correctedWire,
    ],
  );
  return classified.rowCount === 1;
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

    // Crash recovery for the raw -> deduped -> queued handoff. This is
    // intentionally fail-open: a recovery probe failure must not stall fresh
    // raw intake, and the same rows will be retried on the next cycle.
    try {
      const recovered = await recoverStrandedDedupedEntries(db);
      if (recovered > 0) {
        stats.processed += recovered;
        stats.queued += recovered;
        console.warn(`[ProcessRaw] Recovered ${recovered} stranded deduped entr${recovered === 1 ? 'y' : 'ies'} to queue`);
      }
    } catch (error) {
      console.error('[ProcessRaw] Stranded deduped recovery failed; continuing with raw intake:', error);
    }

    // Process in batches until no more raw entries. Every fetched row is added
    // to `attempted` and excluded from later batch queries THIS RUN, so a row
    // whose processing throws (and therefore stays status='raw') can't be
    // refetched forever — the loop is guaranteed to make progress past poisoned
    // rows to the healthy ones behind them, and they retry next 5-min cycle.
    // MAX_BATCHES is a belt-and-braces bound on a single run.
    const attempted: number[] = [];
    const MAX_BATCHES = 40;
    let batches = 0;
    while (batches++ < MAX_BATCHES) {
      const batch = await db.query(
        `SELECT se.id, se.name, se.description, se.source_url, se.amount, se.deadline,
                se.deadline_parsed, se.source_published_at,
                se.wire, se.scan_date, se.prompt_id, sp.intent AS prompt_intent
         FROM scan_entries se
         LEFT JOIN scan_prompts sp ON se.prompt_id = sp.id
         WHERE se.status = 'raw'
           AND se.created_at < NOW() - INTERVAL '2 minutes'
           AND NOT (se.id = ANY($2::bigint[]))
         ORDER BY se.created_at ASC
         LIMIT $1`,
        [BATCH_SIZE, attempted]
      );

      if (batch.rows.length === 0) break;

      console.log(`[ProcessRaw] Processing batch of ${batch.rows.length} entries`);

      for (const row of batch.rows) {
        attempted.push(row.id);
        try {
          // Gate 1: Completeness check
          const completeness = isCompletionSufficient({
            name: row.name,
            description: row.description,
            source_url: row.source_url,
          });

          if (!completeness.passes) {
            const markedIncomplete = await db.query(
              `UPDATE scan_entries
               SET status = 'incomplete',
                   classification = 'UNCHECKED'
               WHERE id = $1 AND status = 'raw'
               RETURNING id`,
              [row.id]
            );
            if (markedIncomplete.rowCount !== 1) continue;
            console.log(`[ProcessRaw] Gate 1 fail for entry ${row.id}: ${completeness.reason}`);
            stats.incomplete++;
            stats.processed++;
            continue;
          }

          // Phase 2: repeat the dedup check under the graph lock, claim the URL,
          // and finalize the raw row in one transaction. The program-identity
          // gate (Layer 1.75) runs inside the same atomic check; a same-round
          // program match is demoted with actioned_by='program-gate'.
          const dedupOutcome = await finalizeExistingEntryDedup(db, {
            id: row.id,
            sourceUrl: row.source_url,
            name: row.name,
            wire: row.wire,
            scanDate: row.scan_date,
            expectedStatus: 'raw',
          }, 14, { programGate: true });
          if (dedupOutcome.outcome === 'stale') continue;
          if (dedupOutcome.outcome === 'duplicate' || dedupOutcome.outcome === 'seed-conflict') {
            stats.duplicates++;
            stats.processed++;
            continue;
          }

          // Temporarily queue — Gate 2 below may auto-archive based on classification/score.
          const queued = await db.query(
              `UPDATE scan_entries
               SET quality_score = NULL,
                   status = 'queued',
                   classification = 'UNCHECKED'
               WHERE id = $1 AND status = 'deduped'
               RETURNING id`,
              [row.id]
            );
            if (queued.rowCount !== 1) continue;

            stats.queued++;
            // Gate 2: LLM classification + quality scoring (single Grok call)
            // Non-blocking: failure leaves the entry explicitly unscored.
            try {
              const classResult = await classifyEntry({
                name: row.name,
                description: row.description || '',
                source_url: row.source_url,
                wire: row.wire,
                intent: row.prompt_intent || undefined,
                amount: row.amount ?? null,
                deadlineParsed: row.deadline_parsed ?? null,
                sourcePublishedAt: row.source_published_at ?? null,
              });
              // In-scope items queue for the agent to curate; off-scope items
              // (real opportunities outside crypto/AI/OSS) are archived.
              const classStatus = classResult.inScope ? 'queued' : 'archived';
              const correctedWire = (classResult.inScope && classResult.detectedWire
                && ['crypto', 'ai', 'oss'].includes(classResult.detectedWire) && classResult.detectedWire !== row.wire)
                ? classResult.detectedWire : null;
              const classified = await applyClassificationIfQueued(db, row.id, {
                classification: classResult.classification,
                reason: classResult.reason,
                qualityScore: classResult.qualityScore,
                qualityBreakdown: {
                  scoreReason: classResult.scoreReason,
                  in_scope: classResult.inScope,
                  detected_wire: classResult.detectedWire,
                },
                // operator_route MUST persist into metadata. It is the BD
                // loop's source signal and the queue's route filter.
                metadata: { ...classResult.extracted, operator_route: classResult.operatorRoute || null },
                tags: classResult.tags,
                status: classStatus,
                correctedWire,
              });
              if (!classified) {
                console.log(`[ProcessRaw] Entry ${row.id} changed during classification; preserving operator state`);
              } else if (
                classResult.inScope
                && (classResult.classification === 'GRANT' || classResult.classification === 'EXPIRED')
              ) {
                // Program identity is downstream of the classification CAS:
                // do not create intelligence for stale, off-scope, or news
                // rows. Use the corrected wire and only a validated ISO date.
                const deadlineValue = row.deadline_parsed instanceof Date
                  ? row.deadline_parsed.toISOString().slice(0, 10)
                  : row.deadline_parsed;
                await finalizeProgramForEntry(db, {
                  id: row.id,
                  name: row.name,
                  sourceUrl: row.source_url,
                  wire: correctedWire ?? row.wire,
                  deadline: normalizeProgramDeadline(deadlineValue),
                  description: row.description ?? null,
                }, dedupOutcome.programResolution ?? null);
              }
            } catch (classError) {
              console.error(`[ProcessRaw] Classification failed for entry ${row.id}, leaving as UNCHECKED:`, classError);
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
