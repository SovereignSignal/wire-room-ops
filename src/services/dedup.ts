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
import type { DedupResult, RelatedOpportunityResult, ScanEntry } from '../types/intake';
import { normalizeUrl, normalizeName, extractNameTokens } from './intake';

/**
 * "Semi-generic" tokens: these pass the main stopword filter in intake.ts
 * but are still common enough in grant names to cause false positives when
 * they're the ONLY overlapping tokens. A match must include at least one
 * token that isn't in this set to be considered a true duplicate.
 *
 * These differ from STOP_WORDS: STOP_WORDS are stripped entirely before
 * tokenization. SEMI_GENERIC tokens ARE stored and CAN contribute to
 * overlap score, but alone they're not sufficient to trigger a match.
 */
const SEMI_GENERIC_TOKENS = new Set([
  // Organization types
  'foundation', 'labs', 'lab', 'ventures', 'capital', 'institute',
  'association', 'alliance', 'council', 'committee', 'consortium',
  // Tech/product patterns
  'api', 'sdk', 'cli', 'app', 'tool', 'tools', 'framework',
  'library', 'module', 'plugin', 'extension', 'integration',
  'data', 'analytics', 'security', 'audit', 'testing',
  // Action words that survive stopword filter
  'create', 'improve', 'scale', 'grow', 'expand', 'enable',
  'reward', 'rewards', 'incentive', 'incentives', 'airdrop',
  // Misc common qualifiers
  'core', 'advanced', 'early', 'stage', 'track',
]);

// ============================================================
// Main Dedup Check
// ============================================================

/**
 * Check if a scan entry is a duplicate of something we've already seen.
 * Returns a DedupResult with match details.
 *
 * @param pool - Postgres connection pool
 * @param entry - The entry to check (needs sourceUrl, name, wire at minimum)
 * @param lookbackDays - How far back to check for duplicates (default 180)
 *   Programs run on multi-month cycles and often re-appear under slightly different
 *   names from different sources. 6 months prevents re-ingestion without blocking
 *   legitimately new programs.
 */
export async function checkDuplicate(
  pool: Pool,
  entry: { sourceUrl: string; name: string; wire: string },
  lookbackDays: number = 180
): Promise<DedupResult> {
  // Layer 1: URL exact match (fastest)
  // Pass entry name so we can distinguish aggregate URLs (one tweet listing multiple grants)
  const urlResult = await checkUrlMatch(pool, entry.sourceUrl, entry.wire, entry.name);
  if (urlResult.isDuplicate) {
    return urlResult;
  }

  // Layer 1.5: Exact name match (case-insensitive) against scan_entries.
  // This is the cross-source duplicate vector: the same program arrives from
  // manual intake, web search, and the telegram summary-sync under DIFFERENT
  // URLs (x.com status vs project page), so the URL layer can't see it.
  // Matching scan_entries directly (not seen_names) also covers entries that
  // never went through registerSeen, e.g. historical summary-sync rows.
  const nameResult = await checkExactNameMatch(pool, entry.name, entry.wire, lookbackDays);
  if (nameResult.isDuplicate) {
    return nameResult;
  }

  // Layer 2: Fuzzy name match — DISABLED.
  // Was causing too many false positives (blocking legitimate different programs
  // from the same org). URL exact match is the only dedup gate now.

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
 *
 * When a URL matches but the entry names are significantly different,
 * we DON'T flag as duplicate. This handles aggregate URLs where one
 * tweet/post lists multiple different grants (e.g. @Onoja_Cee listing
 * 4 grants in one tweet — all share the same URL but are distinct entries).
 *
 * @param entryName - Name of the incoming entry, used for name comparison on URL match
 */
async function checkUrlMatch(
  pool: Pool,
  sourceUrl: string,
  wire: string,
  entryName?: string
): Promise<DedupResult> {
  const normalized = normalizeUrl(sourceUrl);

  // Match against active intake states, including raw.
  // Batch classification is async, so a second paste can arrive while the first
  // copy is still raw. Excluding raw lets exact URL duplicates slip through.
  // Only archived (auto-filtered junk) is excluded — those may deserve a second look.
  const result = await pool.query(
    `SELECT su.first_seen_entry_id, se.name, su.url
     FROM seen_urls su
     JOIN scan_entries se ON se.id = su.first_seen_entry_id
     WHERE su.normalized_url = $1 AND su.wire = $2
       AND se.status IN ('raw', 'approved', 'queued', 'declined')
     LIMIT 1`,
    [normalized, wire]
  );

  if (result.rows.length > 0) {
    const row = result.rows[0];
    const entryId = row.first_seen_entry_id;
    const matchedName: string | null = row.name;
    const displayName = matchedName || row.url;

    // Name similarity escape: ONLY for social media aggregate URLs (x.com, twitter.com).
    // One tweet can list multiple distinct grants — different names from same URL is valid.
    // For direct source pages (nlnet.nl, sovereign.tech, etc.), same URL = same thing, period.
    const isSocialUrl = /^https?:\/\/(x\.com|twitter\.com)\//i.test(sourceUrl);
    if (isSocialUrl && entryName && matchedName && !areNamesSimilar(entryName, matchedName)) {
      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM scan_entries
         WHERE source_url = $1 AND wire = $2
           AND status NOT IN ('duplicate', 'archived')`,
        [sourceUrl, wire]
      );
      const existingCount = countResult.rows[0]?.cnt || 0;
      if (existingCount >= 2) {
        return {
          isDuplicate: true,
          matchType: 'url_exact',
          matchedEntryId: entryId,
          matchedEntryName: displayName,
          confidence: 0.8,
          reason: `Aggregate URL cap: ${existingCount} entries already exist from this URL`,
        };
      }

      return {
        isDuplicate: false,
        matchType: null,
        matchedEntryId: null,
        matchedEntryName: null,
        confidence: 0,
        reason: `Social URL matches entry #${entryId} ("${matchedName}") but names differ — treating as distinct entry (${existingCount + 1} of 2 max)`,
      };
    }

    const reason = entryId
      ? `Exact URL match with entry #${entryId}: "${displayName}"`
      : `Exact URL match with existing wire content: "${displayName}"`;

    return {
      isDuplicate: true,
      matchType: 'url_exact',
      matchedEntryId: entryId,
      matchedEntryName: displayName,
      confidence: 1.0,
      reason,
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
// Layer 1.5: Exact Name Match
// ============================================================

/**
 * Check if an entry with the identical (case-insensitive) name already exists
 * on this wire. Deliberately exact-only — the token-overlap fuzzy layer stays
 * disabled because of false positives, but two entries whose names match
 * character-for-character within the lookback window are the same program.
 *
 * Archived copies don't block (auto-filtered junk may deserve a second look),
 * matching the URL layer's status policy. Declined copies DO block: the
 * operator already saw this program and said no.
 */
async function checkExactNameMatch(
  pool: Pool,
  name: string,
  wire: string,
  lookbackDays: number
): Promise<DedupResult> {
  const noMatch: DedupResult = {
    isDuplicate: false,
    matchType: null,
    matchedEntryId: null,
    matchedEntryName: null,
    confidence: 0,
    reason: '',
  };

  const normalized = name.trim().toLowerCase();
  if (!normalized) return noMatch;

  const result = await pool.query(
    `SELECT id, name FROM scan_entries
     WHERE lower(btrim(name)) = $1 AND wire = $2
       AND status IN ('raw', 'queued', 'approved', 'declined')
       AND created_at >= NOW() - INTERVAL '1 day' * $3
     ORDER BY created_at ASC
     LIMIT 1`,
    [normalized, wire, lookbackDays]
  );

  if (result.rows.length > 0) {
    const row = result.rows[0];
    return {
      isDuplicate: true,
      matchType: 'name_exact',
      matchedEntryId: row.id,
      matchedEntryName: row.name,
      confidence: 1.0,
      reason: `Exact name match with entry #${row.id}: "${row.name}"`,
    };
  }

  return noMatch;
}

/**
 * Check if two entry names are similar enough to be considered the same program.
 * Uses token overlap: if >50% of tokens overlap, names are "similar".
 *
 * Examples:
 *   "Optimism Grants" vs "Optimism Grants Program" → similar (high overlap)
 *   "Optimism Grants" vs "Arbitrum Foundation Fellowship" → dissimilar (no overlap)
 *   "DARPA CLARA" vs "NSF Graduate Research Fellowship" → dissimilar
 */
function areNamesSimilar(nameA: string, nameB: string): boolean {
  const tokensA = extractNameTokens(nameA);
  const tokensB = extractNameTokens(nameB);

  // If either has no significant tokens, fall back to conservative (treat as similar)
  if (tokensA.length === 0 || tokensB.length === 0) return true;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  // Use smaller set as denominator (asymmetric Jaccard)
  const minSize = Math.min(setA.size, setB.size);
  const overlap = intersection / minSize;

  // >50% token overlap = same program
  return overlap > 0.5;
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

  // First try exact normalized name match — only against approved/queued entries.
  // Declined/archived entries should not block new submissions.
  const exactResult = await pool.query(
    `SELECT sn.entry_id, se.name
     FROM seen_names sn
     JOIN scan_entries se ON se.id = sn.entry_id
     WHERE sn.name_normalized = $1 AND sn.wire = $2
       AND sn.first_seen >= CURRENT_DATE - INTERVAL '1 day' * $3
       AND se.status IN ('approved', 'queued', 'declined')
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

  // Then try token overlap matching using GIN index — only against approved/queued.
  const tokenResult = await pool.query(
    `SELECT sn.entry_id, sn.name_original, sn.name_tokens
     FROM seen_names sn
     JOIN scan_entries se ON se.id = sn.entry_id
     WHERE sn.wire = $1
       AND sn.first_seen >= CURRENT_DATE - INTERVAL '1 day' * $2
       AND sn.name_tokens && $3::text[]
       AND se.status IN ('approved', 'queued', 'declined')
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

  // Threshold: 0.85 means near-exact name matches only.
  // "Ethereum Foundation PhD Fellowship" vs "Ethereum Foundation Grants" won't match (~0.5).
  // "Gitcoin Grants Round 20" vs "Gitcoin Grants Round 20 Open" will match (~0.9).
  const FUZZY_THRESHOLD = 0.85;

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
 * Requires at least one "anchor" token (not in SEMI_GENERIC_TOKENS)
 * to be shared, preventing matches based solely on common vocabulary.
 *
 * Returns a score from 0 to 1.
 */
function tokenOverlapScore(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  let intersection = 0;
  let anchorIntersection = 0;

  for (const token of setA) {
    if (setB.has(token)) {
      intersection++;
      if (!SEMI_GENERIC_TOKENS.has(token)) {
        anchorIntersection++;
      }
    }
  }

  // Use the smaller set as denominator (asymmetric Jaccard)
  // This handles the case where "DARPA CLARA" matches "DARPA CLARA High-Assurance AI"
  const minSize = Math.min(setA.size, setB.size);

  // Require at least 2 overlapping tokens when both sets have multiple tokens,
  // to avoid false positives like "Optimism Grant" vs "Optimism Governance Update".
  // Allow single-token overlap when one set has only 1 token (specific match).
  if (intersection < 2 && minSize > 1 && setA.size + setB.size > 3) {
    return 0;
  }

  // Require at least one anchor (non-semi-generic) token in the overlap.
  // Without this, matches like "Foundation Labs Rewards" vs "Foundation Labs Incentives"
  // would trigger on purely generic vocabulary.
  if (anchorIntersection === 0 && intersection > 0) {
    return 0;
  }

  return intersection / minSize;
}

const RELATED_NOISE_TOKENS = new Set([
  'application', 'applications', 'apply', 'open', 'opens', 'opened', 'announced',
  'announcement', 'accepting', 'launch', 'launched', 'program', 'grant', 'grants',
]);

function relationNameTokens(name: string): string[] {
  return normalizeName(name)
    .split(' ')
    .filter(token => token.length > 2 && !RELATED_NOISE_TOKENS.has(token));
}

function relationOverlapScore(nameA: string, nameB: string): number {
  const tokensA = relationNameTokens(nameA);
  const tokensB = relationNameTokens(nameB);
  if (tokensA.length < 2 || tokensB.length < 2) return 0;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const token of Array.from(setA)) {
    if (setB.has(token)) intersection++;
  }
  return intersection / Math.min(setA.size, setB.size);
}

// ============================================================
// Registration: Add entries to the seen tables
// ============================================================

/**
 * Register a new entry in both seen_urls and seen_names tables.
 * Call this after an entry passes dedup and gets inserted.
 */
export interface RegisterSeenResult {
  /** True when another entry already owns this URL — the caller lost a
   *  concurrent race and should mark its entry as a duplicate. */
  urlConflict: boolean;
  /** The entry id that owns the URL when urlConflict is true. */
  conflictEntryId: number | null;
}

export async function registerSeen(
  pool: Pool,
  entry: {
    id: number;
    sourceUrl: string;
    name: string;
    wire: string;
    scanDate: string;
  }
): Promise<RegisterSeenResult> {
  const normalized_url = normalizeUrl(entry.sourceUrl);
  const normalized_name = normalizeName(entry.name);
  const tokens = extractNameTokens(entry.name);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Register URL. ON CONFLICT DO NOTHING + RETURNING lets us detect when a
    // concurrent identical submission already claimed this URL — previously
    // both entries sailed through dedup and ended up queued side by side.
    const urlRes = await client.query(
      `INSERT INTO seen_urls (url, normalized_url, first_seen_entry_id, first_seen_date, wire)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (normalized_url, wire) DO NOTHING
       RETURNING id`,
      [entry.sourceUrl, normalized_url, entry.id, entry.scanDate, entry.wire]
    );

    let urlConflict = false;
    let conflictEntryId: number | null = null;
    if (urlRes.rowCount === 0) {
      const existing = await client.query(
        `SELECT first_seen_entry_id FROM seen_urls WHERE normalized_url = $1 AND wire = $2`,
        [normalized_url, entry.wire]
      );
      const ownerId = existing.rows[0]?.first_seen_entry_id ?? null;
      // Re-registering the same entry (e.g. a reprocessed raw row) is not a conflict
      if (ownerId !== null && ownerId !== entry.id) {
        urlConflict = true;
        conflictEntryId = ownerId;
      }
    }

    if (!urlConflict) {
      // Register name (idempotent — retries won't create duplicates)
      await client.query(
        `INSERT INTO seen_names (name_original, name_normalized, name_tokens, entry_id, wire, first_seen)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (entry_id) DO NOTHING`,
        [entry.name, normalized_name, tokens, entry.id, entry.wire, entry.scanDate]
      );
    }

    await client.query('COMMIT');
    return { urlConflict, conflictEntryId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Annotate an entry as a likely alternate source of an existing one.
 * Extracted from daily-intake so the SQL is unit-testable: the operator_notes
 * parameter needs an explicit ::text cast because CONCAT_WS is variadic "any"
 * and PostgreSQL cannot infer the parameter type without it (error 42P18).
 */
export async function annotateAlternateSource(
  pool: Pool,
  entryId: number,
  related: RelatedOpportunityResult
): Promise<void> {
  await pool.query(
    `UPDATE scan_entries
     SET status = 'deduped',
         metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
         operator_notes = CONCAT_WS(E'\n', NULLIF(operator_notes, ''), $2::text)
     WHERE id = $3`,
    [
      JSON.stringify({
        related_source: {
          relation_type: related.relationType,
          matched_entry_id: related.matchedEntryId,
          matched_entry_name: related.matchedEntryName,
          matched_source_url: related.matchedSourceUrl,
          matched_status: related.matchedStatus,
          confidence: related.confidence,
          reason: related.reason,
        },
      }),
      `Possible alternate source: ${related.matchedEntryName} (#${related.matchedEntryId})`,
      entryId,
    ]
  );
}

// ============================================================
// Soft Related Opportunity Detection
// ============================================================

/**
 * Find a likely prior appearance of the same opportunity without blocking the
 * current row. This is the review-intelligence layer: it annotates alternate
 * source links and sibling-ish replays so Sov can make the call in queue.
 */
export async function findRelatedOpportunity(
  pool: Pool,
  entry: { sourceUrl: string; name: string; wire: string },
  lookbackDays: number = 180
): Promise<RelatedOpportunityResult> {
  const tokens = extractNameTokens(entry.name);
  if (tokens.length < 2) {
    return {
      isRelated: false,
      relationType: null,
      matchedEntryId: null,
      matchedEntryName: null,
      matchedSourceUrl: null,
      matchedStatus: null,
      confidence: 0,
      reason: 'No significant tokens in name',
    };
  }

  const result = await pool.query(
    `SELECT sn.entry_id, sn.name_original, sn.name_tokens, se.source_url, se.status
     FROM seen_names sn
     JOIN scan_entries se ON se.id = sn.entry_id
     WHERE sn.wire = $1
       AND sn.first_seen >= CURRENT_DATE - INTERVAL '1 day' * $2
       AND sn.name_tokens && $3::text[]
       AND se.status IN ('approved', 'queued', 'declined')
     ORDER BY sn.first_seen DESC`,
    [entry.wire, lookbackDays, tokens]
  );

  let bestMatch: {
    entryId: number;
    name: string;
    sourceUrl: string | null;
    status: any;
    score: number;
  } | null = null;

  for (const row of result.rows) {
    if (normalizeUrl(row.source_url || '') === normalizeUrl(entry.sourceUrl)) continue;
    const score = Math.max(
      tokenOverlapScore(tokens, row.name_tokens || []),
      relationOverlapScore(entry.name, row.name_original || '')
    );
    if (score > (bestMatch?.score || 0)) {
      bestMatch = {
        entryId: row.entry_id,
        name: row.name_original,
        sourceUrl: row.source_url || null,
        status: row.status || null,
        score,
      };
    }
  }

  const ALTERNATE_SOURCE_THRESHOLD = 0.66;
  if (bestMatch && bestMatch.score >= ALTERNATE_SOURCE_THRESHOLD) {
    return {
      isRelated: true,
      relationType: 'alternate_source',
      matchedEntryId: bestMatch.entryId,
      matchedEntryName: bestMatch.name,
      matchedSourceUrl: bestMatch.sourceUrl,
      matchedStatus: bestMatch.status,
      confidence: bestMatch.score,
      reason: `Likely alternate source for entry #${bestMatch.entryId}: "${bestMatch.name}" (${Math.round(bestMatch.score * 100)}% token overlap)`,
    };
  }

  return {
    isRelated: false,
    relationType: null,
    matchedEntryId: null,
    matchedEntryName: null,
    matchedSourceUrl: null,
    matchedStatus: null,
    confidence: bestMatch?.score || 0,
    reason: bestMatch
      ? `Best related candidate "${bestMatch.name}" scored ${Math.round(bestMatch.score * 100)}% below review threshold`
      : 'No related opportunity candidates found',
  };
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

  const uniqueNames = await pool.query(
    `SELECT COUNT(DISTINCT name_normalized) as count FROM seen_names
     WHERE first_seen BETWEEN $1::date AND $2::date
       ${wire ? 'AND wire = $3' : ''}`,
    params
  );

  return {
    totalEntries: parseInt(total.rows[0].count),
    uniqueUrls: parseInt(uniqueUrls.rows[0].count),
    duplicateUrls: parseInt(dupes.rows[0].count),
    uniqueNames: parseInt(uniqueNames.rows[0].count),
  };
}
