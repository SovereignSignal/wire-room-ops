/**
 * Process Raw Entries Job
 *
 * Background job that processes entries with status='raw' through
 * Gate 1 (completeness) → dedup → scoring → queue pipeline.
 *
 * Gate 1 rejects entries with missing/garbage data (status='incomplete').
 * Operator-authored entries that pass Gate 1 + dedup go to 'queued'.
 * x-monitor entries remain hidden until classification settles and only
 * publish/source_check routes enter the operator queue.
 *
 * Idempotent: safe to run multiple times. Processes status='raw' entries and
 * recovers abandoned status='deduped' handoffs after a safety window.
 * Processes in batches of 50 to avoid overwhelming the DB.
 */

import type { Pool } from 'pg';
import { DEFAULT_DEDUPE_WINDOW_DAYS } from '../types/intake';
import { finalizeExistingEntryDedup, settleForthcomingIntake } from '../services/dedup';
// quality-scorer.ts replaced by LLM scoring in classifier.ts
import { applyKnownProgramCycleGuard, classificationMetadata, classifyEntry, shouldFinalizeAfterLifecycleSettle } from '../services/classifier';
import { classifySourceLink } from '../services/source-filter';
import { determinePostClassificationStatus } from '../services/intake-core';
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
 * operator handoffs to the normal review queue, but return x-monitor handoffs
 * to raw so they can never leak into the queue as UNCHECKED.
 * Seed-history URL conflicts also use `deduped`, but they are a terminal park,
 * not a handoff, and must remain excluded from recovery.
 *
 * The age guard stays beyond the worker's maximum normal run time so this
 * recovery cannot race an active daily-intake classification pass.
 */
export async function recoverStrandedDedupedEntries(
  db: Pick<Pool, 'query'>,
): Promise<{ queued: number; retried: number }> {
  const recovered = await db.query(
    `UPDATE scan_entries
     SET status = CASE WHEN scan_source = 'x-monitor' THEN 'raw' ELSE 'queued' END,
         classification = CASE
           WHEN scan_source = 'x-monitor' THEN 'UNCHECKED'
           ELSE COALESCE(classification, 'UNCHECKED')
         END,
         classification_reason = CASE WHEN scan_source = 'x-monitor' THEN NULL ELSE classification_reason END,
         quality_score = CASE WHEN scan_source = 'x-monitor' THEN NULL ELSE quality_score END,
         quality_breakdown = CASE WHEN scan_source = 'x-monitor' THEN NULL ELSE quality_breakdown END,
         tags = CASE WHEN scan_source = 'x-monitor' THEN '{}'::text[] ELSE tags END,
         updated_at = NOW()
     WHERE status = 'deduped'
       AND updated_at < NOW() - $1::interval
       AND duplicate_reason IS DISTINCT FROM 'URL already exists in seed history'
     RETURNING id, status, scan_source`,
    [STRANDED_DEDUPED_AGE],
  );
  return {
    queued: recovered.rows.filter(row => row.status === 'queued').length,
    retried: recovered.rows.filter(row => row.status === 'raw' && row.scan_source === 'x-monitor').length,
  };
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
  if (/^@[a-zA-Z0-9_]+$/.test(name)) {
    return { passes: false, reason: 'Name is only a handle' };
  }
  if (name.length < 2) {
    return { passes: false, reason: 'Name is too short' };
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
  wireArea: string | null;
  lifecycle: string | null;
  openingDate: string | null;
}

export interface RawClassificationSnapshot {
  sourceUrl: string;
  name: string;
  description: string | null;
  wire: string;
  amount: string | null;
  deadlineParsed: string | Date | null;
  sourcePublishedAt: string | Date | null;
}

/** Apply LLM output only while the row is still in its expected handoff state. */
export async function applyClassificationIfQueued(
  db: Pick<Pool, 'query'>,
  entryId: number,
  result: RawClassificationWrite,
  expectedStatus = 'queued',
  expected?: RawClassificationSnapshot,
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
         wire_area = $17,
         lifecycle = $18,
         opening_date = $19::date,
         operator_notes = CASE
           WHEN $18::text = 'forthcoming'
             AND COALESCE(operator_notes, '') NOT LIKE '%Forthcoming call; held from sending until intake is open.%'
           THEN CONCAT_WS(E'\n', NULLIF(operator_notes, ''), 'Forthcoming call; held from sending until intake is open.')
           ELSE operator_notes
         END
     WHERE id = $7 AND status = $9
       AND ($10::text IS NULL OR (
         source_url = $10 AND name = $11
         AND description IS NOT DISTINCT FROM $12
         AND wire = $13
         AND amount IS NOT DISTINCT FROM $14
         AND deadline_parsed IS NOT DISTINCT FROM $15
         AND source_published_at IS NOT DISTINCT FROM $16
       ))
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
      expectedStatus,
      expected?.sourceUrl ?? null,
      expected?.name ?? null,
      expected?.description ?? null,
      expected?.wire ?? null,
      expected?.amount ?? null,
      expected?.deadlineParsed ?? null,
      expected?.sourcePublishedAt ?? null,
      result.wireArea,
      result.lifecycle,
      result.openingDate,
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
      if (recovered.queued > 0) {
        stats.processed += recovered.queued;
        stats.queued += recovered.queued;
        console.warn(`[ProcessRaw] Recovered ${recovered.queued} stranded operator entr${recovered.queued === 1 ? 'y' : 'ies'} to queue`);
      }
      if (recovered.retried > 0) {
        console.warn(`[ProcessRaw] Returned ${recovered.retried} stranded x-monitor entr${recovered.retried === 1 ? 'y' : 'ies'} to raw for classification retry`);
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
                se.wire, se.scan_source, se.scan_date, se.prompt_id, sp.intent AS prompt_intent
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
          // resolver (Layer 1.75) runs inside the same atomic check and returns
          // advisory context only; it cannot authorize a status mutation.
          const dedupOutcome = await finalizeExistingEntryDedup(db, {
            id: row.id,
            sourceUrl: row.source_url,
            name: row.name,
            wire: row.wire,
            scanDate: row.scan_date,
            expectedStatus: 'raw',
            deadline: row.deadline_parsed ?? row.deadline ?? null,
          }, DEFAULT_DEDUPE_WINDOW_DAYS, { programGate: true });
          if (dedupOutcome.outcome === 'stale') continue;
          if (dedupOutcome.outcome === 'forum-update') {
            stats.queued++;
            stats.processed++;
            continue;
          }
          if (dedupOutcome.outcome === 'duplicate' || dedupOutcome.outcome === 'seed-conflict') {
            stats.duplicates++;
            stats.processed++;
            continue;
          }

          const isXMonitor = row.scan_source === 'x-monitor';
          // Operator-authored raw intake remains fail-open and becomes visible
          // before classification. x-monitor stays in its hidden deduped handoff
          // until a settled route decides whether it belongs in the queue.
          if (!isXMonitor) {
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
          }
            // Gate 2: LLM classification + quality scoring (single Grok call)
            // Non-blocking: failure leaves the entry explicitly unscored.
            try {
              const rawClassResult = await classifyEntry({
                name: row.name,
                description: row.description || '',
                source_url: row.source_url,
                wire: row.wire,
                intent: row.prompt_intent || undefined,
                amount: row.amount ?? null,
                deadlineParsed: row.deadline_parsed ?? null,
                sourcePublishedAt: row.source_published_at ?? null,
              });
              const classResult = applyKnownProgramCycleGuard(rawClassResult, {
                name: row.name,
                sourceUrl: row.source_url,
                intakeWire: row.wire,
                priorCycle: dedupOutcome.priorCycle,
              });
              const cycleGuarded = classResult !== rawClassResult;
              // In-scope items queue for the agent to curate; off-scope items
              // (real opportunities outside crypto/AI/OSS) are archived.
              // Known-program new cycles on a first-party apply URL stay in
              // review even when Gate 2 called them off-scope NOISE.
              const classStatus = classResult.inScope
                ? determinePostClassificationStatus(classResult, row.scan_source)
                : 'archived';
              const classified = await applyClassificationIfQueued(db, row.id, {
                classification: classResult.classification,
                reason: classResult.reason,
                qualityScore: classResult.qualityScore,
                qualityBreakdown: {
                  scoreReason: classResult.scoreReason,
                  in_scope: classResult.inScope,
                  detected_wire: classResult.detectedWire,
                  ...(cycleGuarded ? { cycle_guard: 'known_program_new_cycle' } : {}),
                },
                // operator_route MUST persist into metadata. It is the BD
                // loop's source signal and the queue's route filter.
                metadata: classificationMetadata(classResult),
                tags: classResult.tags,
                status: classStatus,
                wireArea: classResult.wireArea,
                lifecycle: classResult.lifecycle ?? null,
                openingDate: classResult.openingDate ?? null,
              }, isXMonitor ? 'deduped' : 'queued', {
                sourceUrl: row.source_url,
                name: row.name,
                description: row.description ?? null,
                wire: row.wire,
                amount: row.amount ?? null,
                deadlineParsed: row.deadline_parsed ?? null,
                sourcePublishedAt: row.source_published_at ?? null,
              });
              if (!classified) {
                console.log(`[ProcessRaw] Entry ${row.id} changed during classification; preserving operator state`);
              } else {
                if (classStatus === 'archived') {
                  stats.archived++;
                  if (!isXMonitor) stats.queued = Math.max(0, stats.queued - 1);
                } else if (isXMonitor) {
                  stats.queued++;
                }
                const settled = await settleForthcomingIntake(db, {
                  sourceId: row.id,
                  lifecycle: classResult.lifecycle,
                  openingDate: classResult.openingDate ?? null,
                  expectedStatus: classStatus,
                  sourceUrl: row.source_url,
                  name: row.name,
                  wire: row.wire,
                  ownerId: dedupOutcome.lifecyclePromotion?.entryId ?? null,
                });
                if (
                  classStatus === 'queued'
                  && shouldFinalizeAfterLifecycleSettle(settled.action, settled.promoted, classResult)
                ) {
                  // Program identity is downstream of the classification CAS:
                  // do not create intelligence for stale, off-scope, or news
                  // rows. Detected Wire remains advisory until an atomic
                  // operator reassignment moves the row and URL registry.
                  const deadlineValue = row.deadline_parsed instanceof Date
                    ? row.deadline_parsed.toISOString().slice(0, 10)
                    : row.deadline_parsed;
                  await finalizeProgramForEntry(db, {
                    id: row.id,
                    name: row.name,
                    sourceUrl: row.source_url,
                    wire: row.wire,
                    deadline: normalizeProgramDeadline(deadlineValue),
                    description: row.description ?? null,
                  }, dedupOutcome.programResolution ?? null);
                }
              }
            } catch (classError) {
              if (row.scan_source === 'x-monitor') {
                // Monitored tweets are not operator-authored intake. Retry a
                // transient classifier failure without leaking UNCHECKED social
                // copy into the review queue.
                const reset = await db.query(
                  `UPDATE scan_entries
                   SET status = 'raw', updated_at = NOW()
                   WHERE id = $1 AND status = 'deduped' AND classification = 'UNCHECKED'
                   RETURNING id`,
                  [row.id],
                );
                if (reset.rowCount === 1) {
                  stats.queued = Math.max(0, stats.queued - 1);
                  console.error(`[ProcessRaw] Classification failed for x-monitor entry ${row.id}; returned to raw for retry:`, classError);
                } else {
                  console.error(`[ProcessRaw] Classification failed for x-monitor entry ${row.id}; row changed before retry reset:`, classError);
                }
              } else {
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
