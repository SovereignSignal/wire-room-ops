/**
 * Deduplication Service
 *
 * Two-layer dedup strategy:
 * 1. URL exact match (fast, catches ~70% of duplicates). New numbered or
 *    seasonal cutoffs on a stable official page are not silent duplicates;
 *    they stay visible and cite the prior cycle. Same-cycle resubmits and
 *    generic telegram reprints still die.
 * 2. Fuzzy name matching (catches same program from different sources)
 *
 * Uses the seen_urls and seen_names tables for efficient lookups.
 * All matching is scoped by wire (crypto/ai/oss) so the same program
 * name in different verticals won't false-positive.
 */

import type { Pool } from 'pg';
import type { DedupResult, RelatedOpportunityResult, ScanEntry } from '../types/intake';
import { normalizeUrl, normalizeName, extractNameTokens } from './intake';
import { demoteEntryToDuplicateInTransaction, lockDuplicateGraph } from './duplicate-chain';
import { resolveProgram, assessRound, historyLine, ProgramResolutionStamp } from './program-identity';

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

function isSocialAggregateUrl(sourceUrl: string): boolean {
  try {
    const host = new URL(sourceUrl).hostname
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(/\.+$/, '');
    return host === 'x.com' || host === 'twitter.com';
  } catch {
    return false;
  }
}

// ============================================================
// Cycle identity on a stable official URL
// ============================================================
// Official program pages often keep one URL across numbered/seasonal
// cutoffs (Wikimedia Rapid, R Consortium ISC, FreeCAD, Stellar SCF,
// Rocket Pool GMC). URL-exact must still kill telegram reprints and
// same-cycle resubmits, but a new cutoff on that URL has to reach review.

type CycleKind =
  | 'cycle' | 'round' | 'season' | 'batch' | 'wave'
  | 'fund' | 'hash' | 'quarter' | 'half' | 'call';

const CYCLE_KIND_PRIORITY: CycleKind[] = [
  'cycle', 'round', 'season', 'batch', 'wave', 'fund', 'hash', 'quarter', 'half', 'call',
];

const NUMBERED_CYCLE_PATTERNS: Array<[RegExp, CycleKind]> = [
  [/\bcycles?\s*#?\s*(\d+)\b/gi, 'cycle'],
  [/\brounds?\s*#?\s*(\d+)\b/gi, 'round'],
  [/\bseasons?\s*#?\s*(\d+)\b/gi, 'season'],
  [/\bbatch(?:es)?\s*#?\s*(\d+)\b/gi, 'batch'],
  [/\bwaves?\s*#?\s*(\d+)\b/gi, 'wave'],
  [/\bfunds?\s*#?\s*(\d+)\b/gi, 'fund'],
  [/\bfund(\d+)\b/gi, 'fund'],
  [/#\s*(\d+)\b/g, 'hash'],
  [/\bq([1-4])\b/gi, 'quarter'],
  [/\bh([12])\b/gi, 'half'],
  [/\b(20\d\d)\s*[-/.]\s*([1-9]\d?)\b/g, 'call'],
];

export interface CycleMarkers {
  numbered: Array<{ kind: CycleKind; value: string }>;
  years: number[];
  fiscal: string | null;
}

export function extractCycleMarkers(name: string): CycleMarkers {
  const text = name || '';
  const numbered: CycleMarkers['numbered'] = [];
  const seen = new Set<string>();

  for (const [pattern, kind] of NUMBERED_CYCLE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = kind === 'call'
        ? `${match[1]}-${match[2]}`
        : String(Number(match[1]));
      if (!Number.isFinite(Number(kind === 'call' ? match[2] : match[1]))) continue;
      const key = `${kind}:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      numbered.push({ kind, value });
    }
  }

  const fiscalMatch = text.match(/\bfy\s*(20\d\d)(?:\s*[-/]\s*(\d{2,4}))?/i);
  const fiscal = fiscalMatch
    ? (fiscalMatch[2] ? `fy${fiscalMatch[1]}-${fiscalMatch[2]}` : `fy${fiscalMatch[1]}`).toLowerCase()
    : null;

  const years = [...new Set(
    (text.match(/\b20\d\d\b/g) || []).map(year => Number(year))
  )];

  return { numbered, years, fiscal };
}

function primaryNumberedMarker(markers: CycleMarkers): { kind: CycleKind; value: string } | null {
  for (const kind of CYCLE_KIND_PRIORITY) {
    const hit = markers.numbered.find(marker => marker.kind === kind);
    if (hit) return hit;
  }
  return null;
}

function parseDeadlineMs(value: string | Date | null | undefined): number | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  // Date.parse('Oct 17') is 2001-10-17 in V8: a yearless deadline is unknown, not past.
  if (!/\b(?:19|20)\d\d\b/.test(String(value))) return null;
  const ms = Date.parse(String(value));
  return Number.isNaN(ms) ? null : ms;
}

/**
 * True when `incomingName` (and optional deadline) is a new numbered or
 * seasonal cutoff relative to an already-seen official-page entry.
 * Incoming names with no cycle signal stay "the program exists" — telegram
 * reprints and generic resubmits must still URL-dedup.
 */
export function isNewProgramCycle(
  incomingName: string,
  existingName: string,
  incomingDeadline?: string | Date | null,
  existingDeadline?: string | Date | null,
): boolean {
  const incoming = extractCycleMarkers(incomingName);
  const existing = extractCycleMarkers(existingName);
  const incomingPrimary = primaryNumberedMarker(incoming);
  const existingPrimary = primaryNumberedMarker(existing);

  if (incomingPrimary && existingPrimary) {
    return incomingPrimary.kind !== existingPrimary.kind
      || incomingPrimary.value !== existingPrimary.value;
  }
  if (incomingPrimary && !existingPrimary) return true;
  if (!incomingPrimary && existingPrimary) return false;

  if (incoming.fiscal) {
    if (existing.fiscal) return incoming.fiscal !== existing.fiscal;
    const fyYear = Number((incoming.fiscal.match(/20\d\d/) || [])[0]);
    if (fyYear && existing.years.includes(fyYear)) return false;
    if (existing.years.length === 0) return true;
  }

  if (incoming.years.length > 0 && existing.years.length > 0) {
    return Math.max(...incoming.years) !== Math.max(...existing.years);
  }

  const incomingMs = parseDeadlineMs(incomingDeadline);
  const existingMs = parseDeadlineMs(existingDeadline);
  return incomingMs !== null && existingMs !== null && incomingMs > existingMs;
}

export function isSameProgramCycle(
  incomingName: string,
  existingName: string,
  incomingDeadline?: string | Date | null,
  existingDeadline?: string | Date | null,
): boolean {
  return !isNewProgramCycle(incomingName, existingName, incomingDeadline, existingDeadline)
    && !isNewProgramCycle(existingName, incomingName, existingDeadline, incomingDeadline);
}

function priorCycleReason(entryId: number, name: string, closedPrior?: string | null): string {
  return `New cycle of #${entryId}: "${name}"${closedPrior ? ` (prior ${closedPrior})` : ''}`;
}

// ============================================================
// Reopened rounds behind a closed prior entry
// ============================================================
// Programs reuse one URL for every round (NumFOCUS SDG: #18508 "2026 Round 2"
// was killed as a duplicate of declined #14294). A prior entry that was
// declined or whose deadline has passed is not the round being announced, so
// it must not hold the URL against a submission that carries its own round
// signal. Approved/queued rows that are still open keep URL dedup strict.

export interface RoundCandidate {
  name: string;
  deadline?: string | Date | null;
  deadlineParsed?: string | Date | null;
  status?: string | null;
}

const DAY_MS = 86_400_000;

function candidateDeadlineMs(candidate: RoundCandidate): number | null {
  return parseDeadlineMs(candidate.deadlineParsed) ?? parseDeadlineMs(candidate.deadline);
}

/** Why a prior entry no longer holds its round open, or null when it still does. */
export function closedPriorRound(prior: RoundCandidate, now: number = Date.now()): string | null {
  if (prior.status === 'declined' || prior.status === 'archived') return prior.status;
  const ms = candidateDeadlineMs(prior);
  if (ms !== null && ms < Math.floor(now / DAY_MS) * DAY_MS) {
    return `deadline ${new Date(ms).toISOString().slice(0, 10)} passed`;
  }
  return null;
}

function markerKey(markers: CycleMarkers): string {
  const numbered = markers.numbered.map(m => `${m.kind}:${m.value}`).sort().join(',');
  return `${numbered}|${[...markers.years].sort().join(',')}|${markers.fiscal ?? ''}`;
}

/**
 * The incoming entry names a different round than the prior one: a different
 * deadline when both are known, otherwise its own round/year/FY marker that
 * the prior name does not share. A generic name with no marker never qualifies.
 */
export function hasNewRoundSignal(incoming: RoundCandidate, prior: RoundCandidate): boolean {
  const incomingMs = candidateDeadlineMs(incoming);
  const priorMs = candidateDeadlineMs(prior);
  if (incomingMs !== null && priorMs !== null) {
    return Math.floor(incomingMs / DAY_MS) !== Math.floor(priorMs / DAY_MS);
  }
  const incomingMarkers = extractCycleMarkers(incoming.name);
  const hasMarker = incomingMarkers.numbered.length > 0 || incomingMarkers.years.length > 0 || !!incomingMarkers.fiscal;
  return hasMarker && markerKey(incomingMarkers) !== markerKey(extractCycleMarkers(prior.name));
}

/** Returns the closed-prior note when `incoming` is a new round behind a closed prior entry. */
export function reopenedRoundNote(incoming: RoundCandidate, prior: RoundCandidate, now?: number): string | null {
  const closed = closedPriorRound(prior, now);
  return closed && hasNewRoundSignal(incoming, prior) ? closed : null;
}

interface UrlCycleSibling {
  id: number;
  name: string;
  deadline: string | Date | null;
  deadline_parsed?: string | Date | null;
  status: string;
}

/** A sibling on the same URL blocks only when it is this round and still holds it. */
function blocksAsSameRound(incoming: RoundCandidate, sibling: UrlCycleSibling): boolean {
  const siblingDeadline = sibling.deadline_parsed ?? sibling.deadline;
  if (!isSameProgramCycle(incoming.name, sibling.name, incoming.deadline, siblingDeadline)) return false;
  return reopenedRoundNote(incoming, {
    name: sibling.name,
    deadline: sibling.deadline,
    deadlineParsed: sibling.deadline_parsed,
    status: sibling.status,
  }) === null;
}

function isEstablishedUrlSibling(row: UrlCycleSibling, excludeEntryId?: number): boolean {
  if (row.status === 'raw') {
    return excludeEntryId != null && row.id < excludeEntryId;
  }
  return true;
}

async function findUrlCycleSiblings(
  pool: Pick<Pool, 'query'>,
  args: { sourceUrl: string; seenUrl?: string | null; wire: string; excludeEntryId?: number },
): Promise<UrlCycleSibling[]> {
  const result = await pool.query(
    `SELECT id, name, deadline, deadline_parsed, status
     FROM scan_entries
     WHERE wire = $1
       AND status IN ('raw', 'deduped', 'queued', 'approved', 'declined')
       AND ($2::int IS NULL OR id != $2)
       AND source_url IS NOT NULL
       AND (source_url = $3 OR source_url = $4)`,
    [args.wire, args.excludeEntryId ?? null, args.sourceUrl, args.seenUrl || args.sourceUrl],
  );
  return result.rows;
}

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
  entry: {
    sourceUrl: string;
    name: string;
    wire: string;
    /** The entry's own scan_entries id, for callers that insert BEFORE
     *  dedup-checking (daily-intake, process-raw). Without it, the name
     *  layer matches the entry against its own freshly inserted raw row
     *  and marks it a duplicate of itself. */
    excludeEntryId?: number;
    deadline?: string | Date | null;
  },
  lookbackDays: number = 180,
  options?: { urlOnly?: boolean; programGate?: boolean }
): Promise<DedupResult> {
  // Layer 1: URL exact match (fastest)
  // Pass entry name so we can distinguish aggregate URLs (one tweet listing multiple grants)
  const urlResult = await checkUrlMatch(
    pool,
    entry.sourceUrl,
    entry.wire,
    entry.name,
    entry.excludeEntryId,
    entry.deadline,
  );
  if (urlResult.isDuplicate) {
    return urlResult;
  }
  // A new numbered/seasonal cutoff on a known official URL is not a
  // duplicate. Skip the exact-name layer: same-name reopenings (later
  // deadline, new FY) would otherwise be killed after the URL escape.
  if (urlResult.priorCycle) {
    return urlResult;
  }

  // Layer 1.5: Exact name match (case-insensitive) against scan_entries.
  // This is the cross-source duplicate vector: the same program arrives from
  // manual intake, web search, and the telegram summary-sync under DIFFERENT
  // URLs (x.com status vs project page), so the URL layer can't see it.
  // Matching scan_entries directly (not seen_names) also covers entries that
  // never went through registerSeen, e.g. historical summary-sync rows.
  //
  // Skipped when urlOnly is set: the dumb-pipe Telegram/manual intake dedups on
  // link identity ONLY, because names can be AI-generated and two distinct
  // programs may collide on an identical name (a false positive that would
  // silently drop a real grant). "Same program, different link" is the
  // downstream filter's job, not the pipe's.
  let programResolution: DedupResult['programResolution'] = null;
  if (!options?.urlOnly) {
    const nameResult = await checkExactNameMatch(pool, entry.name, entry.wire, lookbackDays, entry.excludeEntryId);
    if (nameResult.isDuplicate) {
      return nameResult;
    }
  }

  // Layer 1.75: program identity (opt-in; advisory only).
  // The program registry supplies review context, but it no longer authorizes
  // a status mutation. A 53-link audit found that broad program identities
  // collapsed distinct proposals, rounds, calls, and cross-wire events. Exact
  // URL and exact-name layers remain the automatic duplicate gates.
  if (options?.programGate && !options?.urlOnly) {
    try {
      const match = await resolveProgram(pool, { name: entry.name, sourceUrl: entry.sourceUrl, wire: entry.wire });
      if (match) {
        const round = assessRound(match.program, { name: entry.name });
        const history = historyLine(match.program);
        programResolution = {
          programId: match.program.id,
          confidence: match.confidence,
          verdict: round.verdict,
          roundLabel: round.roundLabel,
          historyLine: history,
        };
      }
    } catch (err) {
      console.error('[Dedup] Program gate failed (fail-open):', err instanceof Error ? err.message : err);
    }
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
    programResolution,
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
  entryName?: string,
  excludeEntryId?: number,
  deadline?: string | Date | null,
): Promise<DedupResult> {
  const normalized = normalizeUrl(sourceUrl);

  // Match against active intake states, including raw.
  // Batch classification is async, so a second paste can arrive while the first
  // copy is still raw. Excluding raw lets exact URL duplicates slip through.
  // Only archived (auto-filtered junk) is excluded — those may deserve a second look.
  const result = await pool.query(
    `SELECT su.first_seen_entry_id, se.name, su.url, se.deadline, se.deadline_parsed, se.status
     FROM seen_urls su
     JOIN scan_entries se ON se.id = su.first_seen_entry_id
     WHERE su.normalized_url = $1 AND su.wire = $2
       AND se.status IN ('raw', 'approved', 'queued', 'declined')
       AND ($3::int IS NULL OR su.first_seen_entry_id != $3)
     LIMIT 1`,
    [normalized, wire, excludeEntryId ?? null]
  );

  if (result.rows.length > 0) {
    const row = result.rows[0];
    const entryId = row.first_seen_entry_id;
    const matchedName: string | null = row.name;
    const displayName = matchedName || row.url;

    // Name similarity escape: ONLY for social media aggregate URLs (x.com, twitter.com).
    // One tweet can list multiple distinct grants — different names from same URL is valid.
    // For direct source pages (nlnet.nl, sovereign.tech, etc.), same URL = same thing, period.
    const isSocialUrl = isSocialAggregateUrl(sourceUrl);
    if (isSocialUrl && entryName && matchedName && !areNamesSimilar(entryName, matchedName)) {
      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM scan_entries
         WHERE source_url = $1 AND wire = $2
           AND status NOT IN ('duplicate', 'archived')
           AND ($3::int IS NULL OR id != $3)`,
        [sourceUrl, wire, excludeEntryId ?? null]
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

    // Official pages keep one URL across numbered/seasonal cutoffs. A new
    // cycle of the same program must reach review; the same cycle must not.
    // A closed prior entry (declined / past deadline) yields to a new round too.
    const incoming: RoundCandidate = { name: entryName || '', deadline };
    const newCycle = !!entryName && !!matchedName
      && isNewProgramCycle(entryName, matchedName, deadline, row.deadline_parsed ?? row.deadline);
    const closedPrior = !newCycle && entryName && matchedName
      ? reopenedRoundNote(incoming, {
        name: matchedName, deadline: row.deadline, deadlineParsed: row.deadline_parsed, status: row.status,
      })
      : null;
    if (newCycle || closedPrior) {
      const siblings = await findUrlCycleSiblings(pool, {
        sourceUrl,
        seenUrl: row.url,
        wire,
        excludeEntryId,
      });
      const sameCycle = siblings.find(sibling =>
        isEstablishedUrlSibling(sibling, excludeEntryId)
        && blocksAsSameRound(incoming, sibling)
      );
      if (sameCycle) {
        return {
          isDuplicate: true,
          matchType: 'url_exact',
          matchedEntryId: sameCycle.id,
          matchedEntryName: sameCycle.name,
          confidence: 1.0,
          reason: `Exact URL match with entry #${sameCycle.id}: "${sameCycle.name}"`,
        };
      }

      return {
        isDuplicate: false,
        matchType: null,
        matchedEntryId: entryId,
        matchedEntryName: displayName,
        confidence: 0,
        reason: priorCycleReason(entryId, displayName, closedPrior),
        priorCycle: { entryId, name: displayName },
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
  lookbackDays: number,
  excludeEntryId?: number
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
       AND ($4::int IS NULL OR id != $4)
     ORDER BY created_at ASC
     LIMIT 1`,
    [normalized, wire, lookbackDays, excludeEntryId ?? null]
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

  // First try an exact normalized name match against queued or reviewed entries.
  // Both approval paths and reviewed rejections block a replay; archived rows do not.
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
  /** True when another entry or a seed-only history row already owns this URL. */
  urlConflict: boolean;
  /** The owning entry id, or null when the conflict is a seed-only history row. */
  conflictEntryId: number | null;
}

interface SeenEntry {
  id: number;
  sourceUrl: string;
  name: string;
  wire: string;
  scanDate: string;
  deadline?: string | Date | null;
}

type Queryable = Pick<Pool, 'query'>;

/** Register URL and name ownership inside an existing transaction. */
export async function registerSeenInTransaction(
  db: Queryable,
  entry: SeenEntry,
): Promise<RegisterSeenResult> {
  const normalized_url = normalizeUrl(entry.sourceUrl);
  const normalized_name = normalizeName(entry.name);
  const tokens = extractNameTokens(entry.name);

  // ON CONFLICT DO NOTHING + RETURNING makes the exact-URL claim atomic.
  const urlRes = await db.query(
    `INSERT INTO seen_urls (url, normalized_url, first_seen_entry_id, first_seen_date, wire)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (normalized_url, wire) DO NOTHING
     RETURNING id`,
    [entry.sourceUrl, normalized_url, entry.id, entry.scanDate, entry.wire],
  );

  let urlConflict = false;
  let conflictEntryId: number | null = null;
  if (urlRes.rowCount === 0) {
    const existing = await db.query(
      `SELECT su.first_seen_entry_id, se.name, se.status, se.deadline, se.deadline_parsed
       FROM seen_urls su
       LEFT JOIN scan_entries se ON se.id = su.first_seen_entry_id
       WHERE su.normalized_url = $1 AND su.wire = $2
       FOR UPDATE OF su`,
      [normalized_url, entry.wire],
    );
    if (existing.rows.length === 0) {
      throw new Error('Exact URL claim conflicted but the registry row was not found');
    }
    const ownerId = existing.rows[0].first_seen_entry_id as number | null;
    // Re-registering the same entry (e.g. a reprocessed raw row) is idempotent.
    // A null owner is a seed-only historical URL and must remain a conflict.
    if (ownerId !== entry.id) {
      const ownerName = existing.rows[0].name as string | null;
      const ownerStatus = existing.rows[0].status as string | null;
      const ownerDeadline = existing.rows[0].deadline as string | Date | null;
      const ownerDeadlineParsed = existing.rows[0].deadline_parsed as string | Date | null | undefined;
      if (ownerId !== null && ownerStatus === 'archived') {
        // URL precheck deliberately ignores archived owners so a later signal
        // can be reconsidered. Preserve that policy at the atomic claim stage:
        // transfer the locked registry row instead of demoting the fresh entry
        // to an archived parent and consuming its account-monitor watermark.
        const transferred = await db.query(
          `UPDATE seen_urls
           SET url = $1, first_seen_entry_id = $2, first_seen_date = $3
           WHERE normalized_url = $4 AND wire = $5 AND first_seen_entry_id = $6
           RETURNING id`,
          [entry.sourceUrl, entry.id, entry.scanDate, normalized_url, entry.wire, ownerId],
        );
        if (transferred.rowCount !== 1) {
          throw new Error('Archived exact URL owner changed during ownership transfer');
        }
      } else {
        let allowSharedSocialSource = false;
        if (ownerId !== null
            && ownerName
            && isSocialAggregateUrl(entry.sourceUrl)
            && !areNamesSimilar(entry.name, ownerName)) {
          // The seen_urls row lock serializes concurrent claimants for this
          // normalized URL. Count active rows after acquiring it so at most two
          // distinct opportunities can share one aggregate social post.
          const activeSocial = await db.query(
            `SELECT id, source_url
             FROM scan_entries
             WHERE wire = $1
               AND id != $2
               AND source_url IS NOT NULL
               AND source_url ~* '^https?://(www\\.)?(x|twitter)\\.com\\.?/'
               AND status NOT IN ('duplicate', 'archived')`,
            [entry.wire, entry.id],
          );
          const existingCount = activeSocial.rows.filter(
            row => normalizeUrl(String(row.source_url)) === normalized_url,
          ).length;
          allowSharedSocialSource = existingCount < 2;
        }

        if (!allowSharedSocialSource) {
          const incoming: RoundCandidate = { name: entry.name, deadline: entry.deadline };
          const allowSharedNewCycle = Boolean(
            ownerName
            && (isNewProgramCycle(entry.name, ownerName, entry.deadline, ownerDeadlineParsed ?? ownerDeadline)
              || reopenedRoundNote(incoming, {
                name: ownerName, deadline: ownerDeadline, deadlineParsed: ownerDeadlineParsed, status: ownerStatus,
              }))
          );
          if (allowSharedNewCycle) {
            const siblings = await findUrlCycleSiblings(db, {
              sourceUrl: entry.sourceUrl,
              seenUrl: entry.sourceUrl,
              wire: entry.wire,
              excludeEntryId: entry.id,
            });
            const sameCycle = siblings.find(sibling =>
              isEstablishedUrlSibling(sibling, entry.id)
              && blocksAsSameRound(incoming, sibling)
            );
            if (sameCycle) {
              urlConflict = true;
              conflictEntryId = sameCycle.id;
            }
          } else {
            urlConflict = true;
            conflictEntryId = ownerId;
          }
        }
      }
    }
  }

  if (!urlConflict) {
    await db.query(
      `INSERT INTO seen_names (name_original, name_normalized, name_tokens, entry_id, wire, first_seen)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (entry_id) DO NOTHING`,
      [entry.name, normalized_name, tokens, entry.id, entry.wire, entry.scanDate],
    );
  }

  return { urlConflict, conflictEntryId };
}

export async function registerSeen(
  pool: Pool,
  entry: SeenEntry,
): Promise<RegisterSeenResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockDuplicateGraph(client);
    const result = await registerSeenInTransaction(client, entry);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface ExistingEntryDedupInput {
  id: number;
  sourceUrl: string;
  name: string;
  wire: string;
  scanDate: string | Date;
  expectedStatus: string;
  deadline?: string | Date | null;
}

export type ExistingEntryDedupOutcome = 'unique' | 'duplicate' | 'seed-conflict' | 'stale' | 'unresolved-parent';

/**
 * Move a raw row forward when its URL matches an entry that can never be a
 * canonical duplicate parent (a permanent `unresolvable` demotion). The row
 * advances to 'deduped' — exactly like a unique row — so process-raw and
 * daily-intake queue it for a human instead of retrying the impossible demotion
 * every cycle. distributable is left untouched: once queued it is an ordinary
 * review candidate. Returns false if the row changed under us (a real stale).
 */
async function surfaceUnresolvableDuplicate(
  db: Queryable,
  entry: ExistingEntryDedupInput,
  reason: string | undefined,
): Promise<boolean> {
  const surfaced = await db.query(
    `UPDATE scan_entries
     SET status = 'deduped', duplicate_of_id = NULL,
         duplicate_reason = $2, updated_at = NOW()
     WHERE id = $1 AND status = $3 AND source_url = $4 AND name = $5 AND wire = $6
     RETURNING id`,
    [entry.id, `Unresolvable duplicate parent (${reason ?? 'unknown'}); surfaced for review`,
     entry.expectedStatus, entry.sourceUrl, entry.name, entry.wire],
  );
  return surfaced.rowCount === 1;
}

/**
 * Recheck, URL-claim, and finalize an already-visible entry in one transaction.
 * This is the shared path for daily intake and the raw-entry worker.
 */
export async function finalizeExistingEntryDedup(
  pool: Pool,
  entry: ExistingEntryDedupInput,
  lookbackDays: number,
  options?: { programGate?: boolean },
): Promise<{
  outcome: ExistingEntryDedupOutcome;
  canonicalParentId: number | null;
  programResolution?: DedupResult['programResolution'];
  priorCycle?: DedupResult['priorCycle'];
}> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Duplicate graph before URL registry is the global mutation lock order.
    await lockDuplicateGraph(client);
    const currentResult = await client.query(
      `SELECT id, status, source_url, name, wire
       FROM scan_entries
       WHERE id = $1
       FOR UPDATE`,
      [entry.id],
    );
    const current = currentResult.rows[0];
    if (!current
        || current.status !== entry.expectedStatus
        || current.source_url !== entry.sourceUrl
        || current.name !== entry.name
        || current.wire !== entry.wire) {
      await client.query('ROLLBACK');
      return { outcome: 'stale', canonicalParentId: null };
    }

    // Repeat the semantic check after locking. Results obtained before this
    // transaction are only hints and cannot authorize a state transition.
    const dedupResult = await checkDuplicate(
      client as unknown as Pool,
      {
        sourceUrl: entry.sourceUrl,
        name: entry.name,
        wire: entry.wire,
        excludeEntryId: entry.id,
        deadline: entry.deadline,
      },
      lookbackDays,
      { programGate: options?.programGate },
    );

    if (dedupResult.isDuplicate) {
      if (!Number.isSafeInteger(dedupResult.matchedEntryId)) {
        throw new Error('Duplicate result did not identify a parent entry');
      }
      const linked = await demoteEntryToDuplicateInTransaction(client, {
        targetId: entry.id,
        requestedParentId: dedupResult.matchedEntryId!,
        expectedStatus: entry.expectedStatus,
        expectedSourceUrl: entry.sourceUrl,
        reason: dedupResult.reason || 'Duplicate detected during intake',
        // Program identity is advisory. Automatic duplicate outcomes here are
        // exact URL or exact name matches and remain dedup-worker actions.
        actor: 'dedup-worker',
      });
      if (linked.outcome === 'unresolvable') {
        // Permanent: the matched parent can never be a canonical reference, so
        // demotion can't succeed. Surface the row for review instead of looping.
        const surfaced = await surfaceUnresolvableDuplicate(client, entry, linked.unresolvableReason);
        if (!surfaced) {
          await client.query('ROLLBACK');
          return { outcome: 'stale', canonicalParentId: null };
        }
        await client.query('COMMIT');
        return { outcome: 'unresolved-parent', canonicalParentId: null };
      }
      if (linked.outcome !== 'linked') {
        await client.query('ROLLBACK');
        return { outcome: 'stale', canonicalParentId: null };
      }
      await client.query('COMMIT');
      return { outcome: 'duplicate', canonicalParentId: linked.canonicalParentId };
    }

    const scanDate = entry.scanDate instanceof Date
      ? entry.scanDate.toISOString().split('T')[0]
      : String(entry.scanDate);
    const claim = await registerSeenInTransaction(client, {
      id: entry.id,
      sourceUrl: entry.sourceUrl,
      name: entry.name,
      wire: entry.wire,
      scanDate,
      deadline: entry.deadline,
    });

    if (claim.urlConflict && claim.conflictEntryId !== null) {
      const linked = await demoteEntryToDuplicateInTransaction(client, {
        targetId: entry.id,
        requestedParentId: claim.conflictEntryId,
        expectedStatus: entry.expectedStatus,
        expectedSourceUrl: entry.sourceUrl,
        reason: 'URL claimed by concurrent submission',
        actor: 'dedup-worker',
      });
      if (linked.outcome === 'unresolvable') {
        // Permanent: the matched parent can never be a canonical reference, so
        // demotion can't succeed. Surface the row for review instead of looping.
        const surfaced = await surfaceUnresolvableDuplicate(client, entry, linked.unresolvableReason);
        if (!surfaced) {
          await client.query('ROLLBACK');
          return { outcome: 'stale', canonicalParentId: null };
        }
        await client.query('COMMIT');
        return { outcome: 'unresolved-parent', canonicalParentId: null };
      }
      if (linked.outcome !== 'linked') {
        await client.query('ROLLBACK');
        return { outcome: 'stale', canonicalParentId: null };
      }
      await client.query('COMMIT');
      return { outcome: 'duplicate', canonicalParentId: linked.canonicalParentId };
    }

    const reason = claim.urlConflict ? 'URL already exists in seed history' : null;
    const priorNote = !claim.urlConflict && dedupResult.priorCycle
      ? (dedupResult.reason || priorCycleReason(dedupResult.priorCycle.entryId, dedupResult.priorCycle.name))
      : null;
    const finalized = await client.query(
      `UPDATE scan_entries
       SET status = 'deduped',
           duplicate_of_id = NULL,
           duplicate_reason = $2,
           distributable = CASE WHEN $2::text IS NULL THEN distributable ELSE false END,
           operator_notes = CASE WHEN $7::text IS NULL THEN operator_notes
             ELSE CONCAT_WS(E'\n', NULLIF(operator_notes, ''), $7::text) END,
           updated_at = NOW()
       WHERE id = $1
         AND status = $3
         AND source_url = $4
         AND name = $5
         AND wire = $6
       RETURNING id`,
      [entry.id, reason, entry.expectedStatus, entry.sourceUrl, entry.name, entry.wire, priorNote],
    );
    if (finalized.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { outcome: 'stale', canonicalParentId: null };
    }

    await client.query('COMMIT');
    return {
      outcome: claim.urlConflict ? 'seed-conflict' : 'unique',
      canonicalParentId: null,
      programResolution: dedupResult.programResolution ?? null,
      priorCycle: dedupResult.priorCycle ?? null,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
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
  expectedSourceUrl: string,
  related: RelatedOpportunityResult
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE scan_entries
     SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
         operator_notes = CONCAT_WS(E'\n', NULLIF(operator_notes, ''), $2::text)
     WHERE id = $3
       AND status = 'deduped'
       AND source_url = $4
     RETURNING id`,
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
      expectedSourceUrl,
    ]
  );
  return result.rowCount === 1;
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
