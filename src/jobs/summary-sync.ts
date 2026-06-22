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
import { getActiveWires } from '../services/intake-core';
import { checkDuplicate, registerSeen } from '../services/dedup';
import { getAppState, setAppState } from '../db';

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

      // Idempotency: skip if either the URL or the summary_id bridge key is already present.
      const existing = await pool.query(
        `SELECT id FROM scan_entries
         WHERE source_url = $1
            OR metadata->>'summary_id' = $2
         LIMIT 1`,
        [sourceUrl, String(row.summary_id)]
      );

      if (existing.rows.length > 0) {
        result.skipped++;
        continue;
      }

      const wire = await inferWire(row.title, row.description || '', activeWires, row.wire);

      // Cross-source dedup: the same program often already exists under a
      // DIFFERENT url (x.com status vs project page) from manual intake or a
      // scan — the raw source_url check above can't see those.
      const dedupResult = await checkDuplicate(pool, { sourceUrl, name: row.title, wire }, 180);
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

      // Insert as a queued review candidate. quality_breakdown carries the
      // operator_route so the queue UI shows it as source_check; metadata
      // preserves the summary_id bridge key for future idempotency.
      const inserted = await pool.query(`
        INSERT INTO scan_entries (
          name, description, source_url, amount, deadline,
          wire, prompt_variant, scan_source, scan_date,
          status, quality_score, quality_breakdown, classification,
          metadata, tags, created_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, 'N', 'telegram', $7,
          'queued', 70,
          $8, 'UNCHECKED',
          jsonb_build_object('summary_id', $9::text, 'summary_sync', true, 'operator_route', 'source_check', 'source_needs_verification', $10::boolean),
          $11, $12
        ) RETURNING id
      `, [
        row.title,
        row.description || '',
        sourceUrl,
        amount,
        deadline,
        wire,
        scanDate,
        JSON.stringify({ scoreReason: 'Summary sync bridge (tele-sum → scan_entries)', operatorRoute: 'source_check' }),
        String(row.summary_id),
        !realUrl, // source_needs_verification = true when we used a placeholder
        tags,
        row.created_at, // preserve original timestamp
      ]);

      // Register in seen_urls/seen_names so the intake pipeline's dedup can
      // see telegram-synced entries too (it was blind to them before).
      await registerSeen(pool, {
        id: inserted.rows[0].id,
        sourceUrl,
        name: row.title,
        wire,
        scanDate,
      });

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
