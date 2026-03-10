/**
 * Enrichment Job
 *
 * Finds queued scan_entries with missing or thin descriptions,
 * scrapes their source URL, and generates an enriched summary
 * using the existing processor pipeline (Grok for X URLs, Claude for others).
 */

import { getPool } from '../db';
import { processEntry, withRetry } from '../services/processor';
import type { DatabaseEntry } from '../types';

const BATCH_SIZE = 10;
const INTER_ENTRY_DELAY_MS = 1500; // 1.5s between entries to respect rate limits

export interface EnrichmentResult {
  enriched: number;
  skipped: number;
  errors: number;
  details: { id: number; status: 'enriched' | 'skipped' | 'error'; reason?: string }[];
}

/**
 * Find and enrich queued entries with missing/thin descriptions.
 */
export async function runEnrichment(wire?: string): Promise<EnrichmentResult> {
  const pool = getPool();
  const result: EnrichmentResult = { enriched: 0, skipped: 0, errors: 0, details: [] };

  // Find entries needing enrichment
  const wireClause = wire ? 'AND wire = $1' : '';
  const params: any[] = wire ? [wire] : [];

  const { rows: entries } = await pool.query(
    `SELECT id, name, description, source_url, wire, enriched_summary
     FROM scan_entries
     WHERE status = 'queued'
       AND (description IS NULL OR description = '' OR LENGTH(description) < 50)
       AND (enriched_summary IS NULL OR enriched_summary = '')
       ${wireClause}
     ORDER BY quality_score DESC NULLS LAST
     LIMIT ${BATCH_SIZE}`,
    params
  );

  if (entries.length === 0) {
    console.log('[Enrichment] No entries need enrichment');
    return result;
  }

  console.log(`[Enrichment] Found ${entries.length} entries to enrich`);

  for (const entry of entries) {
    try {
      // Build a DatabaseEntry for the processor
      const dbEntry: DatabaseEntry = {
        id: String(entry.id),
        url: entry.source_url,
        quick_summary: entry.description || entry.name || '',
        category: entry.wire,
        timestamp: new Date(),
        source: 'enrichment',
        wire: entry.wire,
      };

      const processed = await withRetry(() => processEntry(dbEntry), 2);

      if (processed.processingError) {
        console.warn(`[Enrichment] Entry ${entry.id} processing error: ${processed.processingError}`);
        result.errors++;
        result.details.push({ id: entry.id, status: 'error', reason: processed.processingError });
        continue;
      }

      // Update the entry with the enriched summary
      await pool.query(
        `UPDATE scan_entries
         SET enriched_summary = $1, processing_method = $2, updated_at = NOW()
         WHERE id = $3`,
        [processed.enrichedSummary, processed.processingMethod, entry.id]
      );

      result.enriched++;
      result.details.push({ id: entry.id, status: 'enriched' });
      console.log(`[Enrichment] Enriched entry ${entry.id} via ${processed.processingMethod}`);

      // Delay between entries
      if (entries.indexOf(entry) < entries.length - 1) {
        await new Promise(r => setTimeout(r, INTER_ENTRY_DELAY_MS));
      }
    } catch (err) {
      console.error(`[Enrichment] Failed to enrich entry ${entry.id}:`, err);
      result.errors++;
      result.details.push({ id: entry.id, status: 'error', reason: err instanceof Error ? err.message : 'Unknown error' });
    }
  }

  console.log(`[Enrichment] Done: ${result.enriched} enriched, ${result.skipped} skipped, ${result.errors} errors`);
  return result;
}
