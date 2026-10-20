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
import { urlLookupKeys } from '../utils/url';
import { demoteEntryToDuplicateInTransaction, lockDuplicateGraph } from './duplicate-chain';
import { resolveProgram, assessRound, historyLine, ProgramResolutionStamp } from './program-identity';
import { blockedSourceDomain, classifySourceLink } from './source-filter';
import { intakeLifecycleAction } from '../types/lifecycle';
import { findForumHistoryByHost, forumTopicKey, storedForumObservation, forumObservationAlreadySeen, forumObservationMayBeNew, forumUpdateNote } from './forum-seen';

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
  /** When the incoming row was created. Omitted on a pre-insert check means "now". */
  createdAt?: string | Date | null;
  sourceUrl?: string | null;
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

// ============================================================
// Same round, premature decline
// ============================================================
// A declined copy of the SAME round is not proof the round should stay
// buried. #14294 declined NumFOCUS SDG 2026 Round 2 on 2026-08-11 because no
// official announcement was found; #18508 arrived 2026-10-02 with the real
// CFP and was still marked a duplicate. Yield only when every gate below
// holds. Anything else keeps the #199 block.
//
// 1. Prior status is declined. Approved, queued, raw, and archived rows do
//    not yield through this path. Open approved and queued rows still block.
// 2. The incoming name is the same cycle (same round markers / same deadline).
//    A different round stays on reopenedRoundNote. A generic reprint with no
//    round of its own stays a duplicate.
// 3. The new row's created_at is strictly later than the decline instant.
//    That instant is the later of metadata.curator.at and decision_at, using
//    whichever of the two parses. No usable timestamp → keep blocking. Do not
//    guess from updated_at. A later re-decline therefore still blocks a
//    submission that landed between the two stamps.
// 4. Neither the curator rationale nor action_reason reads as a substantive
//    rejection: off-scope, scam/fraud/phishing/spam, not funding / not a
//    grant, or a duplicate of an approved/published entry. Substantive wins
//    when both kinds of phrase appear.
// 5. And either the rationale reads as premature or unverified (not found,
//    no official announcement, unverified, not yet announced, not open yet,
//    and the close variants listed below), or the new source is official and
//    non-social. Official means classifySourceLink === 'ok' (not a tweet,
//    shortener, or placeholder), not a Gate-1 aggregator, and not a social
//    host. An empty reason plus a tweet stays a duplicate. An empty reason
//    plus a later official page re-surfaces, because there is no substantive
//    rejection on record.
//
// The new row is queued with `Re-surfaced after premature decline of #<id>: "…"`.
// Callers that have not inserted the row yet may omit createdAt; that means
// the submission is happening now. finalizeExistingEntryDedup passes the
// stored created_at so an older raw row cannot use wall-clock time.
// This does not set priorCycle, so the known-program new-cycle guard stays off.

const SOCIAL_SOURCE_HOSTS = [
  'x.com', 'twitter.com', 't.me', 'telegram.me', 'telegram.org',
  'facebook.com', 'fb.com', 'instagram.com', 'threads.net',
  'linkedin.com', 'lnkd.in', 'reddit.com', 'bsky.app',
  'discord.com', 'discord.gg', 'youtube.com', 'youtu.be',
  'tiktok.com', 'truthsocial.com',
];

const PREMATURE_RATIONALE = [
  /\bno official\b/i,
  /\bnot found\b/i,
  /\bnone found\b/i,
  /\bno announcement\b/i,
  /\bnot yet announced\b/i,
  /\bnot announced\b/i,
  /\bunverified\b/i,
  /\bnot verified\b/i,
  /\bunconfirmed\b/i,
  /\bnot confirmed\b/i,
  /\bnot yet open\b/i,
  /\bnot open yet\b/i,
  /\bpremature\b/i,
  /\bno evidence\b/i,
  /\bcould(?:\s+not|n't)\s+(?:find|verify|confirm)\b/i,
  /\bcannot\s+(?:find|verify|confirm)\b/i,
  /\bcan't\s+(?:find|verify|confirm)\b/i,
  /\bunable to\s+(?:find|verify|confirm)\b/i,
  /\bwas(?:\s+not|n't)\s+(?:found|announced|verified|confirmed)\b/i,
];

const SUBSTANTIVE_RATIONALE = [
  /\boff[-\s]?scope\b/i,
  /\bout of scope\b/i,
  /\bscam\b/i,
  /\bfraud(?:ulent)?\b/i,
  /\bphishing\b/i,
  /\bspam\b/i,
  /\bnot funding\b/i,
  /\bnot a funding\b/i,
  /\bnot a grant\b/i,
  /\bduplicate of\b/i,
  /\bdupe of\b/i,
  /\balready approved\b/i,
  /\balready published\b/i,
];

const RATIONALE_QUOTE_LIMIT = 160;

export interface PriorDeclineFacts {
  id: number;
  status?: string | null;
  curatorAt?: string | Date | null;
  decisionAt?: string | Date | null;
  rationale?: string | null;
  actionReason?: string | null;
}

function timeMs(value: string | Date | null | undefined): number | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  const ms = Date.parse(String(value));
  return Number.isNaN(ms) ? null : ms;
}

function declineInstantMs(prior: Pick<PriorDeclineFacts, 'curatorAt' | 'decisionAt'>): number | null {
  const times = [timeMs(prior.curatorAt), timeMs(prior.decisionAt)].filter((ms): ms is number => ms !== null);
  return times.length > 0 ? Math.max(...times) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function sourceHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '').replace(/\.+$/, '');
  } catch {
    return null;
  }
}

function isSocialSourceHost(host: string): boolean {
  return SOCIAL_SOURCE_HOSTS.some(social => host === social || host.endsWith(`.${social}`));
}

/** First-party page: not a tweet, shortener, placeholder, aggregator, or social host. */
export function isOfficialNonSocialSource(url: string | null | undefined): boolean {
  if (classifySourceLink(url) !== 'ok') return false;
  if (blockedSourceDomain(url)) return false;
  const host = sourceHost(url || '');
  return !!host && !isSocialSourceHost(host);
}

export function priorDeclineFacts(row: {
  id?: number | string | null;
  first_seen_entry_id?: number | string | null;
  status?: string | null;
  decision_at?: string | Date | null;
  action_reason?: string | null;
  metadata?: unknown;
}): PriorDeclineFacts {
  const rawId = row.id ?? row.first_seen_entry_id;
  const id = typeof rawId === 'number' ? rawId : Number(rawId);
  const metadata = asRecord(row.metadata);
  const curator = asRecord(metadata?.curator);
  const curatorAt = typeof curator?.at === 'string' || curator?.at instanceof Date ? curator.at : null;
  return {
    id,
    status: row.status ?? null,
    curatorAt,
    decisionAt: row.decision_at ?? null,
    rationale: typeof curator?.rationale === 'string' ? curator.rationale : null,
    actionReason: typeof row.action_reason === 'string' ? row.action_reason : null,
  };
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text));
}

function quoteDeclineReason(text: string): string {
  const clean = text.replace(/\s+/g, ' ').replace(/"/g, "'").trim();
  const clipped = clean.length > RATIONALE_QUOTE_LIMIT
    ? `${clean.slice(0, RATIONALE_QUOTE_LIMIT - 1)}…`
    : clean;
  return `"${clipped}"`;
}

/**
 * Operator note when a declined same-round prior should yield, or null when
 * that prior still blocks. See the block comment above for the gates.
 */
export function prematureDeclineNote(
  incoming: { createdAt?: string | Date | null; sourceUrl?: string | null },
  prior: PriorDeclineFacts,
): string | null {
  if (prior.status !== 'declined' || !Number.isSafeInteger(prior.id)) return null;
  const declineMs = declineInstantMs(prior);
  const createdMs = timeMs(incoming.createdAt ?? null);
  if (declineMs === null || createdMs === null || createdMs <= declineMs) return null;
  const text = [prior.rationale, prior.actionReason].filter(part => typeof part === 'string' && part.trim()).join('\n');
  if (matchesAny(text, SUBSTANTIVE_RATIONALE)) return null;
  const premature = matchesAny(text, PREMATURE_RATIONALE);
  const official = isOfficialNonSocialSource(incoming.sourceUrl);
  if (!premature && !official) return null;
  const quotedSource = (prior.rationale || prior.actionReason || '').trim();
  const quoted = quotedSource ? quoteDeclineReason(quotedSource) : '"later official source"';
  return `Re-surfaced after premature decline of #${prior.id}: ${quoted}`;
}

interface UrlCycleSibling {
  id: number;
  name: string;
  deadline: string | Date | null;
  deadline_parsed?: string | Date | null;
  status: string;
  decision_at?: string | Date | null;
  action_reason?: string | null;
  metadata?: unknown;
}

/** A sibling on the same URL blocks only when it is this round and still holds it. */
function blocksAsSameRound(incoming: RoundCandidate, sibling: UrlCycleSibling): boolean {
  const siblingDeadline = sibling.deadline_parsed ?? sibling.deadline;
  if (!isSameProgramCycle(incoming.name, sibling.name, incoming.deadline, siblingDeadline)) return false;
  if (reopenedRoundNote(incoming, {
    name: sibling.name,
    deadline: sibling.deadline,
    deadlineParsed: sibling.deadline_parsed,
    status: sibling.status,
  }) !== null) return false;
  // A premature decline of this same round does not hold the URL. A substantive
  // decline, or any open approved/queued/raw sibling, still does.
  return prematureDeclineNote(
    { createdAt: incoming.createdAt, sourceUrl: incoming.sourceUrl },
    priorDeclineFacts(sibling),
  ) === null;
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
    `SELECT id, name, deadline, deadline_parsed, status, decision_at, action_reason, metadata
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
    /**
     * When the row already exists (process-raw, daily intake). Omitted on a
     * pre-insert check, which is treated as a submission happening now.
     */
    createdAt?: string | Date | null;
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
    entry.createdAt ?? new Date(),
  );
  if (urlResult.isDuplicate) {
    return urlResult;
  }
  // A new numbered/seasonal cutoff on a known official URL is not a
  // duplicate. Skip the exact-name layer: same-name reopenings (later
  // deadline, new FY) would otherwise be killed after the URL escape.
  // A same-round resubmission that escaped a premature decline must skip
  // the name layer too, or the declined copy's exact name re-blocks it.
  // A forthcoming owner yields the same way: the name layer must not
  // collapse the later open intake into a duplicate before classification.
  if (urlResult.priorCycle || urlResult.resurfacedDecline || urlResult.lifecyclePromotion) {
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
    if (nameResult.isDuplicate || nameResult.lifecyclePromotion) {
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

function forthcomingYield(entryId: number, name: string): DedupResult {
  return {
    isDuplicate: false,
    matchType: null,
    matchedEntryId: entryId,
    matchedEntryName: name,
    confidence: 0,
    reason: `Forthcoming call #${entryId} ("${name}") stays the record; a later open intake updates its lifecycle`,
    lifecyclePromotion: { entryId, name },
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
  createdAt?: string | Date | null,
): Promise<DedupResult> {
  const keys = urlLookupKeys(sourceUrl);

  // Match against active intake states, including raw.
  // Batch classification is async, so a second paste can arrive while the first
  // copy is still raw. Excluding raw lets exact URL duplicates slip through.
  // Only archived (auto-filtered junk) is excluded — those may deserve a second look.
  // http/https, www, highlight fragments and tracking parameters name the same page.
  const result = await pool.query(
    `SELECT su.first_seen_entry_id, se.name, su.url, se.deadline, se.deadline_parsed, se.status,
            se.decision_at, se.action_reason, se.metadata, se.lifecycle
     FROM seen_urls su
     JOIN scan_entries se ON se.id = su.first_seen_entry_id
     WHERE su.normalized_url = ANY($1::text[]) AND su.wire = $2
       AND se.status IN ('raw', 'approved', 'queued', 'declined')
       AND ($3::int IS NULL OR su.first_seen_entry_id != $3)
     ORDER BY (su.normalized_url = $4) DESC, su.first_seen_entry_id ASC
     LIMIT 1`,
    [keys, wire, excludeEntryId ?? null, keys[0] ?? '']
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
    // A premature decline of this same round yields as well; the note is not
    // a new-cycle stamp.
    const incoming: RoundCandidate = {
      name: entryName || '',
      deadline,
      createdAt,
      sourceUrl,
    };
    const siblingDeadline = row.deadline_parsed ?? row.deadline;
    const newCycle = !!entryName && !!matchedName
      && isNewProgramCycle(entryName, matchedName, deadline, siblingDeadline);
    const closedPrior = !newCycle && entryName && matchedName
      ? reopenedRoundNote(incoming, {
        name: matchedName, deadline: row.deadline, deadlineParsed: row.deadline_parsed, status: row.status,
      })
      : null;
    const sameRound = !newCycle && !closedPrior && !!entryName && !!matchedName
      && isSameProgramCycle(entryName, matchedName, deadline, siblingDeadline);
    const premature = sameRound
      ? prematureDeclineNote(
        { createdAt, sourceUrl },
        priorDeclineFacts(row),
      )
      : null;
    if (newCycle || closedPrior || premature) {
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

      if (premature && !newCycle && !closedPrior) {
        return {
          isDuplicate: false,
          matchType: null,
          matchedEntryId: entryId,
          matchedEntryName: displayName,
          confidence: 0,
          reason: premature,
          resurfacedDecline: { entryId, name: displayName },
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

    if (row.lifecycle === 'forthcoming' && entryId) {
      return forthcomingYield(entryId, displayName);
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

// Whitespace, ASCII punctuation, and the dash/quote/bullet forms models emit.
// Letters and digits (including non-ASCII letters) are never removed, so a
// fold cannot merge names that differ by a word. Keep the two forms in step.
const FOLD_CHARS = String.raw`!-/:-@[-\`{-~\u00A0—–―‒’‘“”«»…·•`;
const FOLD_JS = new RegExp(`[\\s${FOLD_CHARS}]+`, 'g');
const FOLDED_NAME_SQL = String.raw`btrim(regexp_replace(lower(name), '[[:space:]!-/:-@[-${'`'}{-~\u00A0—–―‒’‘“”«»…·•]+', ' ', 'g'))`;

/**
 * Name key that ignores case, spacing, and punctuation: "OpenSats — General
 * Fund" and "OpenSats: General Fund" are one name. Null for keys under two
 * words or eight characters, where the plain exact match is the safer test.
 */
export function foldedNameKey(name: string): string | null {
  const key = (name || '').toLowerCase().replace(FOLD_JS, ' ').trim();
  if (key.length < 8 || key.split(' ').length < 2) return null;
  return key;
}

/**
 * Check if an entry with the identical (case-insensitive) name already exists
 * on this wire. Punctuation and spacing differences count as identical. Deliberately exact-only — the token-overlap fuzzy layer stays
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
  const folded = foldedNameKey(name);

  const result = await pool.query(
    `SELECT id, name, lifecycle FROM scan_entries
     WHERE (lower(btrim(name)) = $1
            OR ($5::text IS NOT NULL AND ${FOLDED_NAME_SQL} = $5))
       AND wire = $2
       AND status IN ('raw', 'queued', 'approved', 'declined')
       AND created_at >= NOW() - INTERVAL '1 day' * $3
       AND ($4::int IS NULL OR id != $4)
     ORDER BY created_at ASC
     LIMIT 1`,
    [normalized, wire, lookbackDays, excludeEntryId ?? null, folded]
  );

  if (result.rows.length > 0) {
    const row = result.rows[0];
    if (row.lifecycle === 'forthcoming') {
      return forthcomingYield(row.id, row.name);
    }
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

const RELATED_NOISE_TOKENS = new Set([
  'application', 'applications', 'apply', 'open', 'opens', 'opened', 'announced',
  'announcement', 'accepting', 'launch', 'launched', 'program', 'grant', 'grants',
]);

// Years and programme-structure words are not identity. A stored token list
// of {horizon, 2027} must not score as a perfect match for a different call
// that happens to contain those words.
const NON_DISTINCTIVE_TOKENS = new Set<string>([
  ...SEMI_GENERIC_TOKENS,
  ...RELATED_NOISE_TOKENS,
  'programme', 'programmes', 'programs',
  'fellowship', 'fellowships', 'fellow', 'fellows',
  'cohort', 'cohorts',
  'fund', 'funds', 'funding',
  'call', 'calls', 'topic', 'topics',
]);

function isDistinctiveToken(token: string): boolean {
  return !NON_DISTINCTIVE_TOKENS.has(token) && !/^20\d{2}$/.test(token) && !/^\d+$/.test(token);
}

/**
 * Shared distinctive tokens over the larger distinctive set.
 * Dividing by the shorter name alone scored 100% whenever the short name
 * was contained in the long one, including {horizon, 2027} inside an
 * unrelated title. A perfect score means the distinctive words agree.
 */
function distinctiveOverlapScore(tokensA: Iterable<string>, tokensB: Iterable<string>): number {
  const distA = [...new Set(tokensA)].filter(isDistinctiveToken);
  const distB = [...new Set(tokensB)].filter(isDistinctiveToken);
  if (distA.length === 0 || distB.length === 0) return 0;
  const distBSet = new Set(distB);
  let shared = 0;
  for (const token of distA) {
    if (distBSet.has(token)) shared++;
  }
  if (shared === 0) return 0;
  return shared / Math.max(distA.length, distB.length);
}

/**
 * Overlap between two token sets. Requires at least one distinctive token
 * (not a year, a bare number, or a generic programme word).
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
      if (isDistinctiveToken(token)) anchorIntersection++;
    }
  }

  const minSize = Math.min(setA.size, setB.size);

  // Require at least 2 overlapping tokens when both sets have multiple tokens,
  // to avoid false positives like "Optimism Grant" vs "Optimism Governance Update".
  if (intersection < 2 && minSize > 1 && setA.size + setB.size > 3) {
    return 0;
  }

  // Require at least one distinctive token in the overlap.
  // Without this, matches like "Foundation Labs Rewards" vs "Foundation Labs Incentives"
  // would trigger on purely generic vocabulary.
  if (anchorIntersection === 0 && intersection > 0) {
    return 0;
  }

  return distinctiveOverlapScore(setA, setB);
}

function relationNameTokens(name: string): string[] {
  return normalizeName(name)
    .split(' ')
    .filter(token => token.length > 2 && !RELATED_NOISE_TOKENS.has(token));
}

function relationOverlapScore(nameA: string, nameB: string): number {
  const tokensA = relationNameTokens(nameA);
  const tokensB = relationNameTokens(nameB);
  if (tokensA.length < 2 || tokensB.length < 2) return 0;
  return distinctiveOverlapScore(tokensA, tokensB);
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
  /** Set when the URL owner is a forthcoming call. The claim is not a conflict. */
  lifecyclePromotion?: { entryId: number; name: string } | null;
}

interface SeenEntry {
  id: number;
  sourceUrl: string;
  name: string;
  wire: string;
  scanDate: string;
  deadline?: string | Date | null;
  /** Stored created_at when the row already exists. Omitted → read it if a decline timestamp is in play. */
  createdAt?: string | Date | null;
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
  let lifecyclePromotion: { entryId: number; name: string } | null = null;
  if (urlRes.rowCount === 0) {
    const existing = await db.query(
      `SELECT su.first_seen_entry_id, se.name, se.status, se.deadline, se.deadline_parsed,
              se.decision_at, se.action_reason, se.metadata, se.lifecycle
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
          const incoming: RoundCandidate = {
            name: entry.name,
            deadline: entry.deadline,
            sourceUrl: entry.sourceUrl,
            createdAt: entry.createdAt,
          };
          const allowSharedNewCycle = Boolean(
            ownerName
            && (isNewProgramCycle(entry.name, ownerName, entry.deadline, ownerDeadlineParsed ?? ownerDeadline)
              || reopenedRoundNote(incoming, {
                name: ownerName, deadline: ownerDeadline, deadlineParsed: ownerDeadlineParsed, status: ownerStatus,
              }))
          );
          let allowPrematureDecline = false;
          if (!allowSharedNewCycle && ownerId !== null && ownerStatus === 'declined') {
            const ownerFacts = priorDeclineFacts({
              id: ownerId,
              status: ownerStatus,
              decision_at: existing.rows[0].decision_at,
              action_reason: existing.rows[0].action_reason,
              metadata: existing.rows[0].metadata,
            });
            // Skip the created_at read unless a decline timestamp exists. Callers
            // that pass createdAt (finalize) never take the extra query.
            if (declineInstantMs(ownerFacts) !== null) {
              let createdAt = entry.createdAt ?? null;
              if (createdAt == null) {
                const created = await db.query(
                  `SELECT created_at FROM scan_entries WHERE id = $1`,
                  [entry.id],
                );
                createdAt = created.rows[0]?.created_at ?? null;
              }
              incoming.createdAt = createdAt;
              allowPrematureDecline = prematureDeclineNote(
                { createdAt, sourceUrl: entry.sourceUrl },
                ownerFacts,
              ) !== null;
            }
          }
          if (allowSharedNewCycle || allowPrematureDecline) {
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
          } else if (ownerId !== null && existing.rows[0].lifecycle === 'forthcoming') {
            lifecyclePromotion = { entryId: ownerId, name: ownerName || String(ownerId) };
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

  return lifecyclePromotion
    ? { urlConflict, conflictEntryId, lifecyclePromotion }
    : { urlConflict, conflictEntryId };
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

export type ExistingEntryDedupOutcome = 'unique' | 'duplicate' | 'seed-conflict' | 'stale' | 'unresolved-parent' | 'forum-update';

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
 * Remember the URL of a name-matched duplicate so the next search skips it.
 * ON CONFLICT leaves an existing owner (including a seed-only null) in place.
 */
async function rememberNameMatchUrl(
  db: Queryable,
  entry: ExistingEntryDedupInput,
  canonicalParentId: number,
): Promise<void> {
  const url = (entry.sourceUrl || '').trim();
  if (!url) return;
  const normalized = normalizeUrl(url);
  if (!normalized) return;
  const scanDate = entry.scanDate instanceof Date
    ? entry.scanDate.toISOString().split('T')[0]
    : String(entry.scanDate).slice(0, 10);
  await db.query(
    `INSERT INTO seen_urls (url, normalized_url, first_seen_entry_id, first_seen_date, wire)
     VALUES ($1, $2, $3, $4::date, $5)
     ON CONFLICT (normalized_url, wire) DO NOTHING`,
    [url, normalized, canonicalParentId, scanDate, entry.wire],
  );
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
  lifecyclePromotion?: DedupResult['lifecyclePromotion'];
}> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Duplicate graph before URL registry is the global mutation lock order.
    await lockDuplicateGraph(client);
    const currentResult = await client.query(
      `SELECT id, status, source_url, name, wire, created_at, scan_source, submitted_by, metadata
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

    // The forum collector's persisted source snapshot survives crash/resume.
    // Revalidate it under the same graph lock as URL/name claims. Public intake
    // cannot create this reserved stamp; title variations never authorize it.
    const observation = storedForumObservation(current);
    if (observation) {
      const history = (await findForumHistoryByHost(client, [entry.sourceUrl]))
        .filter(row => row.id < entry.id && forumTopicKey(row.source_url) === observation.topicKey);
      if (forumObservationAlreadySeen(observation, history)) {
        await client.query(
          `UPDATE scan_entries SET status = 'archived', distributable = false,
             metadata = COALESCE(metadata, '{}'::jsonb) || '{"archived_reason":"unchanged_forum_observation"}'::jsonb
           WHERE id = $1 AND status = $2`, [entry.id, entry.expectedStatus]);
        await client.query('COMMIT');
        return { outcome: 'duplicate', canonicalParentId: null };
      }
      const prior = history.find(row => row.id === observation.priorEntryId);
      if (prior && forumObservationMayBeNew(observation, prior)) {
        const note = forumUpdateNote(observation);
        await client.query(
          `UPDATE scan_entries SET status = 'queued', classification = 'UNCHECKED', quality_score = NULL,
             duplicate_of_id = NULL, duplicate_reason = NULL, distributable = false,
             operator_notes = CONCAT_WS(E'\n', NULLIF(operator_notes, ''), $2::text),
             metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'operator_route', 'source_check', 'related_decided', $3::int,
               'decided_recheck', jsonb_build_object('verdict', 'update', 'reason', $2::text, 'source', 'forum_observation')),
             updated_at = NOW()
           WHERE id = $1 AND status = $4`, [entry.id, note, prior.id, entry.expectedStatus]);
        await client.query('COMMIT');
        return { outcome: 'forum-update', canonicalParentId: null };
      }
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
        createdAt: current.created_at,
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
      // A name match leaves the child's URL out of seen_urls, so the next
      // Parallel search buys the same page again. Record it under the live
      // parent after demotion, which already moved any URL this row owned.
      if (dedupResult.matchType === 'name_exact' && linked.canonicalParentId != null) {
        await rememberNameMatchUrl(client, entry, linked.canonicalParentId);
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
      createdAt: current.created_at,
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
    const cycleNote = dedupResult.priorCycle
      ? (dedupResult.reason || priorCycleReason(dedupResult.priorCycle.entryId, dedupResult.priorCycle.name))
      : null;
    const resurfacedNote = !dedupResult.priorCycle && dedupResult.resurfacedDecline
      ? dedupResult.reason
      : null;
    const priorNote = !claim.urlConflict ? (cycleNote || resurfacedNote) : null;
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
      lifecyclePromotion: dedupResult.lifecyclePromotion ?? claim.lifecyclePromotion ?? null,
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

// EU topic ids (HORIZON-BRIDGING-2027-01-13) are their own opportunity.
// A fresh regex per call: a shared /g pattern keeps lastIndex between names.
function euTopicPattern(): RegExp {
  return /\b[a-z]{3,}(?:-[a-z0-9]{1,24}){3,}\b/gi;
}

function extractEuTopicIds(...parts: Array<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const part of parts) {
    const text = (part || '').toLowerCase();
    for (const raw of text.matchAll(euTopicPattern())) {
      const id = raw[0].toUpperCase();
      const segments = id.split('-');
      if (!/^[A-Z]{3,}$/.test(segments[0])) continue;
      const yearAt = segments.findIndex(segment => /^20\d{2}$/.test(segment));
      if (yearAt < 1) continue;
      const numericTail = segments.slice(yearAt + 1).filter(segment => /^\d{2}$/.test(segment));
      if (numericTail.length < 2) continue;
      found.add(id);
    }
  }
  return [...found].sort();
}

function sameIdentity(left: string[], right: string[]): boolean {
  return left.length > 0 && left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Numbered round/cohort/season markers. Bare years are not identifiers. */
function numberedRoundIdentity(name: string): string[] {
  const stripped = (name || '').replace(euTopicPattern(), ' ');
  const markers = extractCycleMarkers(stripped);
  const keys = markers.numbered.map(marker => `${marker.kind}:${marker.value}`);
  for (const match of stripped.matchAll(/\bcohorts?\s*#?\s*(\d+)\b/gi)) {
    const value = Number(match[1]);
    if (value > 0 && value < 1900) keys.push(`cohort:${value}`);
  }
  return [...new Set(keys)].sort();
}

/**
 * Find a likely prior appearance of the same opportunity without blocking the
 * current row. This is the review-intelligence layer: it annotates alternate
 * source links and sibling-ish replays so the operator can make the call in queue.
 * Exact identifiers (EU topic ids, numbered rounds) are decided before token overlap.
 */
export async function findRelatedOpportunity(
  pool: Pool,
  entry: { sourceUrl: string; name: string; wire: string },
  lookbackDays: number = 180
): Promise<RelatedOpportunityResult> {
  const tokens = extractNameTokens(entry.name);
  const entryTopics = extractEuTopicIds(entry.name, entry.sourceUrl);
  if (tokens.length < 2 && entryTopics.length === 0) {
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

  const topicNeedles = entryTopics.map(id => id.toLowerCase());
  const result = entryTopics.length === 0
    ? await pool.query(
      `SELECT sn.entry_id, sn.name_original, sn.name_tokens, se.source_url, se.status
       FROM seen_names sn
       JOIN scan_entries se ON se.id = sn.entry_id
       WHERE sn.wire = $1
         AND sn.first_seen >= CURRENT_DATE - INTERVAL '1 day' * $2
         AND sn.name_tokens && $3::text[]
         AND se.status IN ('approved', 'queued', 'declined')
       ORDER BY sn.first_seen DESC`,
      [entry.wire, lookbackDays, tokens]
    )
    : await pool.query(
      `SELECT sn.entry_id, sn.name_original, sn.name_tokens, se.source_url, se.status
       FROM seen_names sn
       JOIN scan_entries se ON se.id = sn.entry_id
       WHERE sn.wire = $1
         AND sn.first_seen >= CURRENT_DATE - INTERVAL '1 day' * $2
         AND se.status IN ('approved', 'queued', 'declined')
         AND (
           ($3::text[] <> '{}'::text[] AND sn.name_tokens && $3::text[])
           OR EXISTS (
             SELECT 1 FROM unnest($4::text[]) AS topic(needle)
             WHERE strpos(lower(sn.name_original), needle) > 0
                OR strpos(lower(COALESCE(se.source_url, '')), needle) > 0
           )
         )
       ORDER BY sn.first_seen DESC`,
      [entry.wire, lookbackDays, tokens, topicNeedles]
    );

  let bestMatch: {
    entryId: number;
    name: string;
    sourceUrl: string | null;
    status: any;
    score: number;
    via: 'topic' | 'tokens';
    topicLabel: string | null;
  } | null = null;

  const entryRounds = numberedRoundIdentity(entry.name);

  for (const row of result.rows) {
    if (normalizeUrl(row.source_url || '') === normalizeUrl(entry.sourceUrl)) continue;
    const rowTopics = extractEuTopicIds(row.name_original, row.source_url);
    if (entryTopics.length > 0 || rowTopics.length > 0) {
      if (!sameIdentity(entryTopics, rowTopics)) continue;
      bestMatch = {
        entryId: row.entry_id,
        name: row.name_original,
        sourceUrl: row.source_url || null,
        status: row.status || null,
        score: 1,
        via: 'topic',
        topicLabel: entryTopics.join(', '),
      };
      continue;
    }

    const rowRounds = numberedRoundIdentity(row.name_original || '');
    if (entryRounds.length > 0 && rowRounds.length > 0 && !sameIdentity(entryRounds, rowRounds)) continue;

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
        via: 'tokens',
        topicLabel: null,
      };
    }
  }

  const ALTERNATE_SOURCE_THRESHOLD = 0.66;
  if (bestMatch && bestMatch.score >= ALTERNATE_SOURCE_THRESHOLD) {
    const reason = bestMatch.via === 'topic'
      ? `Same EU topic ${bestMatch.topicLabel} as entry #${bestMatch.entryId}: "${bestMatch.name}"`
      : `Likely alternate source for entry #${bestMatch.entryId}: "${bestMatch.name}" (${Math.round(bestMatch.score * 100)}% token overlap)`;
    return {
      isRelated: true,
      relationType: 'alternate_source',
      matchedEntryId: bestMatch.entryId,
      matchedEntryName: bestMatch.name,
      matchedSourceUrl: bestMatch.sourceUrl,
      matchedStatus: bestMatch.status,
      confidence: bestMatch.score,
      reason,
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

export interface LifecyclePromotionInput {
  sourceId: number;
  lifecycle: string | null | undefined;
  openingDate: string | null;
  expectedStatus: string;
  sourceUrl: string;
  name: string;
  wire: string;
  /**
   * Owner found during dedup. Null means dedup did not yield a forthcoming
   * owner, so this intake is not a promotion. Omit the field to look one up
   * (classify backfill, which does not carry the dedup result).
   */
  ownerId?: number | null;
}

/**
 * Point a forthcoming call at open intake. The carrier is archived, not
 * marked duplicate, so the owner's program record stays the one that finalised.
 * An already-approved hold is released onto the publication queue.
 */
export async function promoteOpenCall(
  pool: Pool,
  input: {
    ownerId: number;
    sourceId: number;
    openingDate: string | null;
    expectedStatus: string;
    sourceUrl: string;
  },
): Promise<{ promoted: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockDuplicateGraph(client);
    const note = `Opened by intake #${input.sourceId}; lifecycle updated from forthcoming to open.`;
    const owner = await client.query(
      `UPDATE scan_entries
       SET lifecycle = 'open',
           opening_date = COALESCE($2::date, opening_date),
           operator_notes = CONCAT_WS(E'\n', NULLIF(operator_notes, ''), $3::text),
           distributable = CASE
             WHEN status = 'approved' AND metadata->'lifecycle_hold'->>'reason' = 'forthcoming' THEN true
             ELSE distributable
           END,
           metadata = (COALESCE(metadata, '{}'::jsonb) - 'lifecycle_hold')
             || jsonb_build_object('lifecycle', 'open', 'lifecycle_opened', jsonb_build_object('by_entry_id', $4::int)),
           updated_at = NOW()
       WHERE id = $1 AND lifecycle = 'forthcoming'
       RETURNING id, status`,
      [input.ownerId, input.openingDate, note, input.sourceId],
    );
    if (owner.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { promoted: false };
    }
    const carrier = await client.query(
      `UPDATE scan_entries
       SET status = 'archived',
           distributable = false,
           duplicate_of_id = NULL,
           duplicate_reason = NULL,
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'archived_reason', 'lifecycle_opened_existing',
             'opened_entry_id', $2::int
           ),
           updated_at = NOW()
       WHERE id = $1 AND status = $3 AND source_url = $4
       RETURNING id`,
      [input.sourceId, input.ownerId, input.expectedStatus, input.sourceUrl],
    );
    if (carrier.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { promoted: false };
    }
    if (owner.rows[0].status === 'approved') {
      await client.query(
        `UPDATE publication_queue
         SET status = 'queued', error_message = NULL, available_at = NOW(), updated_at = NOW()
         WHERE entry_id = $1 AND status = 'withheld' AND error_message LIKE 'Forthcoming call%'`,
        [input.ownerId],
      );
    }
    await client.query('COMMIT');
    return { promoted: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** The later intake is the same call and still not open. Demote it onto the owner. */
export async function collapseUnopenedIntake(
  pool: Pool,
  input: { ownerId: number; sourceId: number; expectedStatus: string; sourceUrl: string },
): Promise<'duplicate' | 'stale'> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const linked = await demoteEntryToDuplicateInTransaction(client, {
      targetId: input.sourceId,
      requestedParentId: input.ownerId,
      expectedStatus: input.expectedStatus,
      expectedSourceUrl: input.sourceUrl,
      reason: `Same forthcoming call as #${input.ownerId}; intake is not open yet`,
      actor: 'dedup-worker',
    });
    if (linked.outcome !== 'linked') {
      await client.query('ROLLBACK');
      return 'stale';
    }
    await client.query('COMMIT');
    return 'duplicate';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function findForthcomingOwner(
  pool: Pool,
  input: Pick<LifecyclePromotionInput, 'sourceId' | 'sourceUrl' | 'name' | 'wire'>,
): Promise<{ id: number; name: string } | null> {
  const normalized = normalizeUrl(input.sourceUrl);
  if (normalized) {
    const byUrl = await pool.query(
      `SELECT se.id, se.name
       FROM seen_urls su
       JOIN scan_entries se ON se.id = su.first_seen_entry_id
       WHERE su.normalized_url = $1 AND su.wire = $2
         AND se.lifecycle = 'forthcoming'
         AND se.id <> $3
         AND se.status IN ('raw', 'approved', 'queued', 'declined')
       LIMIT 1`,
      [normalized, input.wire, input.sourceId],
    );
    if (byUrl.rows[0]) return { id: Number(byUrl.rows[0].id), name: byUrl.rows[0].name };
  }
  const byName = await pool.query(
    `SELECT id, name FROM scan_entries
     WHERE lower(btrim(name)) = lower(btrim($1)) AND wire = $2
       AND lifecycle = 'forthcoming'
       AND id <> $3
       AND status IN ('raw', 'queued', 'approved', 'declined')
     ORDER BY created_at ASC
     LIMIT 1`,
    [input.name, input.wire, input.sourceId],
  );
  if (!byName.rows[0]) return null;
  return { id: Number(byName.rows[0].id), name: byName.rows[0].name };
}

/**
 * After classification: open a forthcoming owner in place, or collapse a
 * still-unopened copy onto it. `promoted` is false when the owner moved
 * first, so the caller can still finalise the carrier.
 */
export async function settleForthcomingIntake(
  pool: Pool,
  input: LifecyclePromotionInput,
): Promise<{ action: 'none' | 'promote' | 'collapse'; promoted: boolean }> {
  if (input.ownerId === null) return { action: 'none', promoted: false };
  const owner = input.ownerId != null
    ? { id: input.ownerId, name: '' }
    : await findForthcomingOwner(pool, input);
  if (!owner) return { action: 'none', promoted: false };
  const action = intakeLifecycleAction('forthcoming', input.lifecycle);
  if (action === 'promote') {
    const result = await promoteOpenCall(pool, {
      ownerId: owner.id,
      sourceId: input.sourceId,
      openingDate: input.openingDate,
      expectedStatus: input.expectedStatus,
      sourceUrl: input.sourceUrl,
    });
    return { action, promoted: result.promoted };
  }
  await collapseUnopenedIntake(pool, {
    ownerId: owner.id,
    sourceId: input.sourceId,
    expectedStatus: input.expectedStatus,
    sourceUrl: input.sourceUrl,
  });
  return { action: 'collapse', promoted: false };
}
