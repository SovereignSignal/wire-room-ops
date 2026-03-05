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

// Wire inference keywords
const AI_KEYWORDS = ['ai ', 'artificial intelligence', 'machine learning', 'llm', 'gpt', 'openai', 'anthropic', 'deepmind', 'neural', 'transformer'];
const OSS_KEYWORDS = ['open source', 'open-source', 'oss ', 'github', 'linux', 'apache', 'mozilla', 'free software', 'foss'];

function inferWire(title: string, summary: string, existingWire?: string | null): string {
  if (existingWire && ['crypto', 'ai', 'oss'].includes(existingWire)) {
    return existingWire;
  }
  const text = `${title} ${summary}`.toLowerCase();
  if (AI_KEYWORDS.some(kw => text.includes(kw))) return 'ai';
  if (OSS_KEYWORDS.some(kw => text.includes(kw))) return 'oss';
  return 'crypto';
}

export interface SyncResult {
  synced: number;
  skipped: number;
  errors: number;
}

/**
 * Syncs recent tele-sum summaries to scan_entries as approved.
 * Idempotent: checks source_url to avoid duplicates.
 *
 * @param pool - Postgres pool
 * @param lookbackHours - How far back to look for unsynced summaries (default: 48)
 */
export async function syncSummariesToScanEntries(
  pool: Pool,
  lookbackHours = 48
): Promise<SyncResult> {
  const result: SyncResult = { synced: 0, skipped: 0, errors: 0 };

  // Fetch recent successful summaries with their message URLs
  const { rows: summaries } = await pool.query(`
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
    WHERE s.processing_status = 'SUCCESS'
      AND s.created_at >= NOW() - INTERVAL '${lookbackHours} hours'
    ORDER BY s.created_at ASC
  `);

  if (summaries.length === 0) {
    return result;
  }

  for (const row of summaries) {
    try {
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

      // Parse entities for amount/deadline
      let entities = row.entities || {};
      if (typeof entities === 'string') {
        try { entities = JSON.parse(entities); } catch { entities = {}; }
      }

      const amounts = entities.amounts || [];
      const deadlines = entities.deadlines || [];
      const amount = amounts.length > 0 ? amounts[0] : null;
      const deadline = deadlines.length > 0 ? deadlines[0] : null;

      const wire = inferWire(row.title, row.description || '', row.wire);

      // Insert as approved scan_entry
      await pool.query(`
        INSERT INTO scan_entries (
          name, description, source_url, amount, deadline,
          wire, prompt_variant, scan_source, scan_date,
          status, quality_score, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'N', 'telegram', $7, 'approved', 85, $8)
      `, [
        row.title,
        row.description || '',
        sourceUrl,
        amount,
        deadline,
        wire,
        new Date(row.created_at).toISOString().split('T')[0], // scan_date
        row.created_at, // preserve original timestamp
      ]);

      result.synced++;
    } catch (err) {
      console.error(`[SummarySync] Error syncing summary ${row.summary_id}:`, err);
      result.errors++;
    }
  }

  if (result.synced > 0) {
    console.log(`[SummarySync] Synced ${result.synced} summaries → scan_entries (skipped: ${result.skipped}, errors: ${result.errors})`);
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
