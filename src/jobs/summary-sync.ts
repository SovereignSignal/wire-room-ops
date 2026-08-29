/**
 * Summary Sync Job
 *
 * Bridge between tele-sum's summaries table and the scan_entries table.
 * Converts successfully processed summaries into queued scan_entries
 * so they appear in The Wire Room review queue.
 *
 * This bridge keeps tele-sum items reviewable while the editorial pipeline
 * migrates fully to wire-room-ops.
 */

import type { Pool } from 'pg';
import { DEFAULT_DEDUPE_WINDOW_DAYS } from '../types/intake';
import { getActiveWires } from '../services/intake-core';
import { checkDuplicate, registerSeenInTransaction } from '../services/dedup';
import { getAppState, setAppState } from '../db';
import { demoteEntryToDuplicateInTransaction, lockDuplicateGraph } from '../services/duplicate-chain';

// High-water mark: created_at of the newest summary we have fully processed.
// Avoids re-scanning the whole 7-day window every 15 minutes.
const WATERMARK_KEY = 'summary-sync:watermark';

// Wire inference keyword lists — loaded from env or built-in defaults
const DEFAULT_AI_KEYWORDS = ['ai ', 'artificial intelligence', 'machine learning', 'llm', 'gpt', 'openai', 'anthropic', 'deepmind', 'neural', 'transformer'];
const DEFAULT_OSS_KEYWORDS = ['open source', 'open-source', 'oss ', 'github', 'linux', 'apache', 'mozilla', 'free software', 'foss'];

function getWireKeywords(wire: string): string[] {
  const envKey = `INTAKE_WIRE_KEYWORDS_${wire.toUpperCase()}`;
  const envVal = process.env[envKey];
  if (envVal) return envVal.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);

  // Built-in defaults for known wires
  if (wire === 'ai') return DEFAULT_AI_KEYWORDS;
  if (wire === 'oss') return DEFAULT_OSS_KEYWORDS;
  return [];
}

async function inferWire(
  title: string,
  summary: string,
  activeWires: string[],
  existingWire?: string | null,
): Promise<string> {
  // If existing wire is valid, keep it
  if (existingWire && activeWires.includes(existingWire)) {
    return existingWire;
  }

  const text = `${title} ${summary}`.toLowerCase();

  // Score each wire by keyword matches
  for (const wire of activeWires) {
    const keywords = getWireKeywords(wire);
    if (keywords.some(kw => text.includes(kw))) return wire;
  }

  // Default to first wire alphabetically
  return activeWires[0] || 'crypto';
}

const DEFAULT_SUMMARY_SYNC_WIRES = ['crypto', 'ai', 'oss'];

function getSummarySyncWires(): string[] {
  const configured = process.env.SUMMARY_SYNC_WIRES;
  if (configured) {
    return configured.split(',').map(w => w.trim()).filter(Boolean);
  }
  return DEFAULT_SUMMARY_SYNC_WIRES;
}

/**
 * Only grant editorial wires should bridge into scan_entries. The feeds table
 * can contain active non-grant digest channels such as repos, models, and claw;
 * those are valid feeds, but they should not pollute the grants review queue.
 * Null wire = legacy rows, allowed through to the existing inference path.
 * Empty string is treated like null (legacy row → inference path).
 */
export function shouldBridgeWire(
  wire: string | null | undefined,
  activeWires: string[],
  summarySyncWires: string[] = getSummarySyncWires()
): boolean {
  if (!wire) return true;
  return activeWires.includes(wire) && summarySyncWires.includes(wire);
}

export interface SyncResult {
  synced: number;
  skipped: number;
  errors: number;
}

/**
 * Build a stable placeholder source_url for summaries that arrived without an
 * extracted URL. Keeps the row queryable and idempotent without pretending we
 * have a real canonical link. Mirrors the convention used by direct Telegram
 * intake when Grok supplies only a via-post placeholder.
 */
function placeholderSourceUrl(summaryId: number, title: string): string {
  const slug = (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'summary';
  return `https://manual/needs-source/summary-${summaryId}-${slug}`;
}

/**
 * Syncs recent tele-sum summaries into scan_entries as queued review candidates
 * (status = 'queued', operator_route = 'source_check'). Summaries without an
 * extracted URL get a placeholder source so they still surface in the queue
 * instead of being silently dropped.
 *
 * Idempotent by both source_url and metadata.summary_id. Skips rows whose wire
 * is set but not in the active feeds list, so digest wires do not leak into the
 * grants queue.
 *
 * @param pool - Postgres pool
 * @param lookbackHours - How far back to look for unsynced summaries (default: 168 = 7 days)
 */
export async function syncSummariesToScanEntries(
  pool: Pool,
  lookbackHours = 168
): Promise<SyncResult> {
  const result: SyncResult = { synced: 0, skipped: 0, errors: 0 };

  // Use the high-water mark when available (with a 1-hour overlap for
  // late-arriving rows); fall back to the full lookback window on first run.
  let watermark: string | null = null;
  try {
    watermark = await getAppState<string>(WATERMARK_KEY);
  } catch {
    // app_state table may not exist yet — fall back to full lookback
  }

  const baseQuery = `
    SELECT
      s.id AS summary_id,
      s.title,
      s.summary AS description,
      s.wire,
      s.entities,
      s.created_at,
      m.extracted_urls
    FROM summaries s
    LEFT JOIN messages m ON s.message_id = m.id
    WHERE s.processing_status = 'SUCCESS'`;

  // Fetch recent successful summaries with their message URLs
  const { rows: summaries } = watermark
    ? await pool.query(
        `${baseQuery}
      AND s.created_at >= ($1::timestamptz - INTERVAL '1 hour')
    ORDER BY s.created_at ASC`,
        [watermark]
      )
    : await pool.query(
        `${baseQuery}
      AND s.created_at >= NOW() - INTERVAL '1 hour' * $1
    ORDER BY s.created_at ASC`,
        [lookbackHours]
      );

  if (summaries.length === 0) {
    return result;
  }

  const activeWires = await getActiveWires();
  const summarySyncWires = getSummarySyncWires();

  for (const row of summaries) {
    try {
      if (!shouldBridgeWire(row.wire, activeWires, summarySyncWires)) {
        result.skipped++;
        continue;
      }

      if (!row.title) {
        result.skipped++;
        continue;
      }

      // Pick the first extracted URL, else fall back to a stable placeholder.
      const urls = row.extracted_urls || [];
      const realUrl = Array.isArray(urls) && urls.length > 0 ? urls[0] : null;
      const sourceUrl = realUrl || placeholderSourceUrl(row.summary_id, row.title);

      const wire = await inferWire(row.title, row.description || '', activeWires, row.wire);

      // Cross-source dedup: the same program often already exists under a
      // DIFFERENT url (x.com status vs project page) from manual intake or a
      // scan — the raw source_url check above can't see those.
      const dedupResult = await checkDuplicate(pool, { sourceUrl, name: row.title, wire }, DEFAULT_DEDUPE_WINDOW_DAYS);
      if (dedupResult.isDuplicate) {
        result.skipped++;
        continue;
      }

      // Parse entities for amount/deadline
      let entities = row.entities || {};
      if (typeof entities === 'string') {
        try { entities = JSON.parse(entities); } catch { entities = {}; }
      }

      const amounts = entities.amounts || [];
      const deadlines = entities.deadlines || [];
      const amount = amounts.length > 0 ? amounts[0] : null;
      const deadline = deadlines.length > 0 ? deadlines[0] : null;

      // Extract org/protocol entity tags from tele-sum's entities
      const orgs = entities.orgs || entities.protocols || [];
      const tags = Array.isArray(orgs) ? orgs.filter((t: unknown): t is string => typeof t === 'string').slice(0, 5) : [];

      const scanDate = new Date(row.created_at).toISOString().split('T')[0];

      // Insert, exact-URL claim, and any conflict demotion share one
      // transaction. A summary-level advisory lock makes concurrent sync runs
      // idempotent and lets retries repair queued rows from older releases that
      // were inserted before their seen_urls claim.
      const client = await pool.connect();
      let transactionOutcome: 'synced' | 'skipped' = 'synced';
      try {
        await client.query('BEGIN');
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtext($1))',
          [`summary-sync:${row.summary_id}`],
        );
        await lockDuplicateGraph(client);

        const existing = await client.query(
          `SELECT id, status, name, source_url, wire, scan_date
           FROM scan_entries
           WHERE source_url = $1
              OR metadata->>'summary_id' = $2
           ORDER BY id
           LIMIT 1
           FOR UPDATE`,
          [sourceUrl, String(row.summary_id)],
        );

        if (existing.rows.length > 0) {
          const existingRow = existing.rows[0];
          // Repair an older queued orphan before treating the summary as done.
          if (existingRow.status === 'queued') {
            const existingClaim = await registerSeenInTransaction(client, {
              id: Number(existingRow.id),
              sourceUrl: String(existingRow.source_url),
              name: String(existingRow.name),
              wire: String(existingRow.wire),
              scanDate: existingRow.scan_date instanceof Date
                ? existingRow.scan_date.toISOString().split('T')[0]
                : String(existingRow.scan_date),
            });
            if (existingClaim.urlConflict) {
              const conflictReason = existingClaim.conflictEntryId === null
                ? 'URL already exists in seed history'
                : 'URL claimed by concurrent submission';
              if (existingClaim.conflictEntryId === null) {
                const repaired = await client.query(
                  `UPDATE scan_entries
                   SET status = 'deduped', duplicate_of_id = NULL,
                       duplicate_reason = $2, distributable = false
                   WHERE id = $1 AND status = 'queued' AND source_url = $3
                   RETURNING id`,
                  [existingRow.id, conflictReason, existingRow.source_url],
                );
                if (repaired.rowCount !== 1) {
                  throw new Error('Existing summary entry changed before seed conflict repair');
                }
              } else {
                const repaired = await demoteEntryToDuplicateInTransaction(client, {
                  targetId: Number(existingRow.id),
                  requestedParentId: existingClaim.conflictEntryId,
                  expectedStatus: 'queued',
                  expectedSourceUrl: String(existingRow.source_url),
                  reason: conflictReason,
                  actor: 'summary-sync',
                });
                if (repaired.outcome === 'unresolvable') {
                  // Permanent: the URL owner can't be a canonical parent. Park
                  // forward instead of throwing — an errored row freezes the
                  // watermark (advances only when result.errors === 0) and would
                  // stall every later summary behind this one poison row.
                  const parked = await client.query(
                    `UPDATE scan_entries
                     SET status = 'deduped', duplicate_of_id = NULL,
                         duplicate_reason = $2, distributable = false
                     WHERE id = $1 AND status = 'queued' AND source_url = $3
                     RETURNING id`,
                    [existingRow.id, `${conflictReason} (unresolvable parent: ${repaired.unresolvableReason})`, existingRow.source_url],
                  );
                  if (parked.rowCount !== 1) {
                    throw new Error('Existing summary entry changed before unresolvable-parent park');
                  }
                } else if (repaired.outcome !== 'linked') {
                  throw new Error('Existing summary entry changed before conflict repair');
                }
              }
            }
          }
          transactionOutcome = 'skipped';
        } else {
          // Insert as an unscored review candidate. Routing lives in metadata;
          // a bridge default must never masquerade as a classifier score.
          const inserted = await client.query(`
            INSERT INTO scan_entries (
              name, description, source_url, amount, deadline,
              wire, prompt_variant, scan_source, scan_date,
              status, quality_score, quality_breakdown, classification,
              metadata, tags, created_at, source_needs_verification
            ) VALUES (
              $1, $2, $3, $4, $5,
              $6, 'N', 'telegram', $7,
              'queued', NULL,
              $8, 'UNCHECKED',
              jsonb_build_object('summary_id', $9::text, 'summary_sync', true, 'operator_route', 'source_check', 'source_needs_verification', $10::boolean),
              $11, $12, $10
            ) RETURNING id
          `, [
            row.title,
            row.description || '',
            sourceUrl,
            amount,
            deadline,
            wire,
            scanDate,
            JSON.stringify({ scoreStatus: 'unscored', source: 'summary-sync' }),
            String(row.summary_id),
            !realUrl,
            tags,
            row.created_at,
          ]);

          const claim = await registerSeenInTransaction(client, {
            id: inserted.rows[0].id,
            sourceUrl,
            name: row.title,
            wire,
            scanDate,
          });

          if (claim.urlConflict) {
            const conflictReason = claim.conflictEntryId === null
              ? 'URL already exists in seed history'
              : 'URL claimed by concurrent submission';
            if (claim.conflictEntryId === null) {
              const demoted = await client.query(
                `UPDATE scan_entries
                 SET status = 'deduped', duplicate_of_id = NULL,
                     duplicate_reason = $2, distributable = false
                 WHERE id = $1 AND status = 'queued' AND source_url = $3
                 RETURNING id`,
                [inserted.rows[0].id, conflictReason, sourceUrl],
              );
              if (demoted.rowCount !== 1) {
                throw new Error('New summary entry changed before seed conflict demotion');
              }
            } else {
              const demoted = await demoteEntryToDuplicateInTransaction(client, {
                targetId: Number(inserted.rows[0].id),
                requestedParentId: claim.conflictEntryId,
                expectedStatus: 'queued',
                expectedSourceUrl: sourceUrl,
                reason: conflictReason,
                actor: 'summary-sync',
              });
              if (demoted.outcome === 'unresolvable') {
                // Permanent: park forward instead of throwing (see the existing-
                // entry branch above) so one poison row can't freeze the watermark.
                const parked = await client.query(
                  `UPDATE scan_entries
                   SET status = 'deduped', duplicate_of_id = NULL,
                       duplicate_reason = $2, distributable = false
                   WHERE id = $1 AND status = 'queued' AND source_url = $3
                   RETURNING id`,
                  [inserted.rows[0].id, `${conflictReason} (unresolvable parent: ${demoted.unresolvableReason})`, sourceUrl],
                );
                if (parked.rowCount !== 1) {
                  throw new Error('New summary entry changed before unresolvable-parent park');
                }
              } else if (demoted.outcome !== 'linked') {
                throw new Error('New summary entry changed before conflict demotion');
              }
            }
            transactionOutcome = 'skipped';
          }
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }

      if (transactionOutcome === 'skipped') {
        result.skipped++;
        continue;
      }

      result.synced++;
    } catch (err) {
      console.error(`[SummarySync] Error syncing summary ${row.summary_id}:`, err);
      result.errors++;
    }
  }

  if (result.synced > 0) {
    console.log(`[SummarySync] Synced ${result.synced} summaries → scan_entries (skipped: ${result.skipped}, errors: ${result.errors})`);
  }

  // Advance the watermark only on clean runs so errored rows get retried.
  // Rows are ordered ASC, so the last row holds the max created_at.
  if (summaries.length > 0 && result.errors === 0) {
    try {
      const newest = summaries[summaries.length - 1].created_at;
      await setAppState(WATERMARK_KEY, new Date(newest).toISOString());
    } catch (err) {
      console.error('[SummarySync] Failed to advance watermark (non-fatal):', err);
    }
  }

  return result;
}

// Timer handle for cleanup
let syncTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic summary sync (every intervalMinutes).
 */
export function startSummarySync(pool: Pool, intervalMinutes = 15): void {
  // Run immediately on startup
  syncSummariesToScanEntries(pool).catch(err => {
    console.error('[SummarySync] Initial sync failed:', err);
  });

  // Then run periodically
  syncTimer = setInterval(() => {
    syncSummariesToScanEntries(pool).catch(err => {
      console.error('[SummarySync] Periodic sync failed:', err);
    });
  }, intervalMinutes * 60 * 1000);
  syncTimer.unref(); // Don't prevent process exit

  console.log(`[SummarySync] Started (every ${intervalMinutes} min)`);
}

/**
 * Stop the periodic summary sync.
 */
export function stopSummarySync(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
    console.log('[SummarySync] Stopped');
  }
}
