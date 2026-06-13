/**
 * Summary Sync Job
 *
 * Bridge between tele-sum's summaries table and the scan_entries table.
 * Converts successfully processed summaries into approved scan_entries
 * so they appear on The Wire Room website.
 *
 * This is a temporary bridge until the editorial pipeline migrates
 * fully to wire-room-ops' approval queue.
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

/**
 * Only summaries on wires this deployment actually runs (feeds table) may
 * bridge into scan_entries. Tele-sum can carry non-grant wires (digest
 * channels like repos/models) — without this gate their items would be
 * keyword-inferred into the grants queue. Null wire = legacy rows, allowed
 * through to the existing inference path. Empty string is treated like null
 * (legacy row → inference path).
 */
export function shouldBridgeWire(wire: string | null | undefined, activeWires: string[]): boolean {
  return !wire || activeWires.includes(wire);
}

export interface SyncResult {
  synced: number;
  skipped: number;
  errors: number;
}

/**
 * Syncs recent tele-sum summaries to scan_entries as approved.
 * Idempotent: checks source_url to avoid duplicates.
 * Skips rows whose wire is set but not in the active feeds list (digest wires).
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

  for (const row of summaries) {
    try {
      if (!shouldBridgeWire(row.wire, activeWires)) {
        result.skipped++;
        continue;
      }

      // Extract source URL
      const urls = row.extracted_urls || [];
      const sourceUrl = Array.isArray(urls) && urls.length > 0 ? urls[0] : null;

      if (!sourceUrl) {
        result.skipped++;
        continue;
      }

      if (!row.title) {
        result.skipped++;
        continue;
      }

      // Check if this URL already exists in scan_entries
      const existing = await pool.query(
        `SELECT id FROM scan_entries WHERE source_url = $1 LIMIT 1`,
        [sourceUrl]
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

      // Insert as approved scan_entry
      const inserted = await pool.query(`
        INSERT INTO scan_entries (
          name, description, source_url, amount, deadline,
          wire, prompt_variant, scan_source, scan_date,
          status, quality_score, tags, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'N', 'telegram', $7, 'approved', 85, $8, $9)
        RETURNING id
      `, [
        row.title,
        row.description || '',
        sourceUrl,
        amount,
        deadline,
        wire,
        scanDate,
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
