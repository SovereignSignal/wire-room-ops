/**
 * Deduplication Service
 *
 * Two-layer dedup strategy:
 * 1. URL exact match (fast, catches ~70% of duplicates)
 * 2. Fuzzy name matching (catches same program from different sources)
 *
 * Uses the seen_urls and seen_names tables for efficient lookups.
 * All matching is scoped by wire (crypto/ai/oss) so the same program
 * name in different verticals won't false-positive.
 */

import type { Pool } from 'pg';
import type { DedupResult, ScanEntry } from '../types/intake';
import { normalizeUrl, normalizeName, extractNameTokens } from './intake';

// ============================================================
// Main Dedup Check
// ============================================================

/**
 * Check if a scan entry is a duplicate of something we've already seen.
 * Returns a DedupResult with match details.
 *
 * @param pool - Postgres connection pool
 * @param entry - The entry to check (needs sourceUrl, name, wire at minimum)
 * @param lookbackDays - How far back to check for duplicates (default 14)
 */
export async function checkDuplicate(
  pool: Pool,
  entry: { sourceUrl: string; name: string; wire: string },
  lookbackDays: number = 14
): Promise<DedupResult> {
  // Layer 1: URL exact match (fastest)
  const urlResult = await checkUrlMatch(pool, entry.sourceUrl, entry.wire);
  if (urlResult.isDuplicate) {
    return urlResult;
  }

  // Layer 2: Fuzzy name match
  const nameResult = await checkNameMatch(
    pool,
    entry.name,
    entry.wire,
    lookbackDays
  );
  if (nameResult.isDuplicate) {
    return nameResult;
  }

  // No match found
  return {
    isDuplicate: false,
    matchType: null,
    matchedEntryId: null,
    matchedEntryName: null,
    confidence: 0,
    reason: 'No duplicate found',
  };
}

// ============================================================
// Layer 1: URL Exact Match
// ============================================================

/**
 * Check if this URL (normalized) has been seen before for this wire.
 */
async function checkUrlMatch(
  pool: Pool,
  sourceUrl: string,
  wire: string
): Promise<DedupResult> {
  const normalized = normalizeUrl(sourceUrl);

  const result = await pool.query(
    `SELECT su.first_seen_entry_id, se.name
     FROM seen_urls su
     JOIN scan_entries se ON se.id = su.first_seen_entry_id
     WHERE su.normalized_url = $1 AND su.wire = $2
     LIMIT 1`,
    [normalized, wire]
  );

  if (result.rows.length > 0) {
    return {
      isDuplicate: true,
      matchType: 'url_exact',
      matchedEntryId: result.rows[0].first_seen_entry_id,
      matchedEntryName: result.rows[0].name,
      confidence: 1.0,
      reason: `Exact URL match with entry #${result.rows[0].first_seen_entry_id}: "${result.rows[0].name}"`,
    };
  }

  return {
    isDuplicate: false,
    matchType: null,
    matchedEntryId: null,
    matchedEntryName: null,
    confidence: 0,
    reason: '',
  };
}

// ============================================================
// Layer 2: Fuzzy Name Matching
// ============================================================

/**
 * Check if a similar program name has been seen for this wire.
 * Uses token overlap scoring with a configurable threshold.
 */
async function checkNameMatch(
  pool: Pool,
  name: string,
  wire: string,
  lookbackDays: number
): Promise<DedupResult> {
  const normalized = normalizeName(name);
  const tokens = extractNameTokens(name);

  if (tokens.length === 0) {
    return {
      isDuplicate: false,
      matchType: null,
      matchedEntryId: null,
      matchedEntryName: null,
      confidence: 0,
      reason: 'No significant tokens in name',
    };
  }

  // First try exact normalized name match
  const exactResult = await pool.query(
    `SELECT sn.entry_id, se.name
     FROM seen_names sn
     JOIN scan_entries se ON se.id = sn.entry_id
     WHERE sn.name_normalized = $1 AND sn.wire = $2
       AND sn.first_seen >= CURRENT_DATE - INTERVAL '1 day' * $3
     ORDER BY sn.first_seen ASC
     LIMIT 1`,
    [normalized, wire, lookbackDays]
  );

  if (exactResult.rows.length > 0) {
    return {
      isDuplicate: true,
      matchType: 'name_fuzzy',
      matchedEntryId: exactResult.rows[0].entry_id,
      matchedEntryName: exactResult.rows[0].name,
      confidence: 0.95,
      reason: `Exact normalized name match with entry #${exactResult.rows[0].entry_id}: "${exactResult.rows[0].name}"`,
    };
  }

  // Then try token overlap matching using GIN index
  // Find entries that share at least 2 tokens with this name
  const tokenResult = await pool.query(
    `SELECT sn.entry_id, sn.name_original, sn.name_tokens
     FROM seen_names sn
     WHERE sn.wire = $1
       AND sn.first_seen >= CURRENT_DATE - INTERVAL '1 day' * $2
       AND sn.name_tokens && $3::text[]
     ORDER BY sn.first_seen ASC`,
    [wire, lookbackDays, tokens]
  );

  // Score each candidate by token overlap
  let bestMatch: {
    entryId: number;
    name: string;
    score: number;
  } | null = null;

  for (const row of tokenResult.rows) {
    const candidateTokens: string[] = row.name_tokens;
    const score = tokenOverlapScore(tokens, candidateTokens);

    if (score > (bestMatch?.score || 0)) {
      bestMatch = {
        entryId: row.entry_id,
        name: row.name_original,
        score,
      };
    }
  }

  // Threshold: 0.6 means at least 60% of tokens overlap
  const FUZZY_THRESHOLD = 0.6;

  if (bestMatch && bestMatch.score >= FUZZY_THRESHOLD) {
    return {
      isDuplicate: true,
      matchType: 'name_fuzzy',
      matchedEntryId: bestMatch.entryId,
      matchedEntryName: bestMatch.name,
      confidence: bestMatch.score,
      reason: `Fuzzy name match (${Math.round(bestMatch.score * 100)}% token overlap) with entry #${bestMatch.entryId}: "${bestMatch.name}"`,
    };
  }

  return {
    isDuplicate: false,
    matchType: null,
    matchedEntryId: null,
    matchedEntryName: null,
    confidence: bestMatch?.score || 0,
    reason:
      bestMatch
        ? `Best candidate "${bestMatch.name}" scored ${Math.round(bestMatch.score * 100)}% (below ${FUZZY_THRESHOLD * 100}% threshold)`
        : 'No token overlap candidates found',
  };
}

// ============================================================
// Token Overlap Scoring
// ============================================================

/**
 * Calculate the Jaccard-like overlap between two token sets.
 * Weighted to favor matching rare/significant tokens.
 *
 * Returns a score from 0 to 1.
 */
function tokenOverlapScore(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  // Use the smaller set as denominator (asymmetric Jaccard)
  // This handles the case where "DARPA CLARA" matches "DARPA CLARA High-Assurance AI"
  const minSize = Math.min(setA.size, setB.size);

  return intersection / minSize;
}

// ============================================================
// Registration: Add entries to the seen tables
// ============================================================

/**
 * Register a new entry in both seen_urls and seen_names tables.
 * Call this after an entry passes dedup and gets inserted.
 */
export async function registerSeen(
  pool: Pool,
  entry: {
    id: number;
    sourceUrl: string;
    name: string;
    wire: string;
    scanDate: string;
  }
): Promise<void> {
  const normalized_url = normalizeUrl(entry.sourceUrl);
  const normalized_name = normalizeName(entry.name);
  const tokens = extractNameTokens(entry.name);

  // Register URL (upsert, ignore conflict on normalized_url + wire)
  await pool.query(
    `INSERT INTO seen_urls (url, normalized_url, first_seen_entry_id, first_seen_date, wire)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (normalized_url, wire) DO NOTHING`,
    [entry.sourceUrl, normalized_url, entry.id, entry.scanDate, entry.wire]
  );

  // Register name
  await pool.query(
    `INSERT INTO seen_names (name_original, name_normalized, name_tokens, entry_id, wire, first_seen)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [entry.name, normalized_name, tokens, entry.id, entry.wire, entry.scanDate]
  );
}

// ============================================================
// Bulk Dedup Stats
// ============================================================

/**
 * Get dedup statistics for a date range and wire.
 */
export async function getDedupStats(
  pool: Pool,
  wire: string | null,
  startDate: string,
  endDate: string
): Promise<{
  totalEntries: number;
  uniqueUrls: number;
  duplicateUrls: number;
  uniqueNames: number;
}> {
  const wireClause = wire ? 'AND wire = $3' : '';
  const params: any[] = [startDate, endDate];
  if (wire) params.push(wire);

  const total = await pool.query(
    `SELECT COUNT(*) as count FROM scan_entries
     WHERE scan_date BETWEEN $1 AND $2 ${wireClause}`,
    params
  );

  const dupes = await pool.query(
    `SELECT COUNT(*) as count FROM scan_entries
     WHERE scan_date BETWEEN $1 AND $2 ${wireClause}
       AND status = 'duplicate'`,
    params
  );

  const uniqueUrls = await pool.query(
    `SELECT COUNT(DISTINCT normalized_url) as count FROM seen_urls
     WHERE first_seen_date BETWEEN $1 AND $2
       ${wire ? 'AND wire = $3' : ''}`,
    params
  );

  return {
    totalEntries: parseInt(total.rows[0].count),
    uniqueUrls: parseInt(uniqueUrls.rows[0].count),
    duplicateUrls: parseInt(dupes.rows[0].count),
    uniqueNames: 0, // TODO: implement
  };
}
