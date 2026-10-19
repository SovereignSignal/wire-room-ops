/**
 * Parallel Frontier pre-insert gate.
 *
 * URL dedup misses the same program when Parallel returns a different page.
 * Of the decided Frontier rows, 1 of 37 was approved and 41% were duplicates
 * of programs already on the wire, plus closed calls. Before a variant-P
 * web-search row is inserted, skip it when the same funder, program, and
 * round already exist on that wire, or when the call is closed. A different
 * round number, or a different year or cohort, is a new program and stays.
 *
 * Other lanes are unchanged. The advisory program resolver still does not
 * demote entries after they exist.
 */

import { extractCycleMarkers } from './dedup';
import { parseDeadline } from './intake';
import { canonicalizeOrgName, classifyOrgName, extractOrgFromName } from './org-extractor';
import { normalizeProgramKey, sameOrgIdentity } from './program-identity';

export type ParallelSkipReason = 'closed' | 'known_program';

export interface ParallelGateResult {
  name: string;
  description?: string | null;
  deadline?: string | null;
  orgName?: string | null;
}

export interface ExistingProgramRow {
  name: string;
  canonicalName?: string | null;
  orgName?: string | null;
  description?: string | null;
}

interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

const GENERIC_TOKENS = new Set([
  'grant', 'grants', 'program', 'programme', 'programs', 'programmes',
  'fund', 'funds', 'funding', 'fellowship', 'fellowships', 'foundation',
  'open', 'call', 'calls', 'application', 'applications', 'general',
  'public', 'developer', 'developers', 'research', 'community', 'support',
  'ecosystem', 'round', 'cohort', 'award', 'awards', 'initiative',
]);

const CLOSED_SOURCE = /\bclosed[\s-]*source\b/gi;

const CLOSED_WORDING = new RegExp(
  [
    String.raw`\b(?:applications?|submissions?|nominations?|proposals?)\s+(?:are\s+|is\s+|have\s+|has\s+)?(?:now\s+)?closed\b`,
    String.raw`\b(?:call|round|program|programme|window|cycle|cohort)\s+(?:is\s+|has\s+|have\s+)?(?:now\s+)?closed\b`,
    String.raw`\bnow\s+closed\b`,
    String.raw`\b(?:has|have)\s+(?:already\s+)?closed\b`,
    String.raw`\bclosed\s+(?:for|to)\s+(?:applications?|submissions?|new\s+applicants)\b`,
    String.raw`\bno\s+longer\s+(?:accepting|open)\b`,
    String.raw`\bnot\s+accepting\s+(?:new\s+)?(?:applications?|submissions?|proposals?)\b`,
    String.raw`\b(?:deadline|application\s+window|submission\s+window)\s+(?:has\s+)?passed\b`,
  ].join('|'),
  'i',
);

const REOPENED = /\b(?:re-?opened|open again|now open|applications?\s+(?:are\s+|is\s+)?(?:now\s+)?open|accepting\s+applications)\b/i;

const RUN_BY = /\b(?:run|offered|funded|hosted)\s+by\s+(?:the\s+)?([A-Z][\w.&'-]*(?:\s+[A-Z][\w.&'-]*){0,4})/;

/** Parallel Frontier rows land as web-search with prompt variant P. */
export function isParallelFrontierIntake(source: string | null | undefined, variant: string | null | undefined): boolean {
  return source === 'web-search' && variant === 'P';
}

export function normalizedFunderKey(name: string | null | undefined): string {
  return canonicalizeOrgName(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function calendarDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function deadlineCalendarDay(deadline: string | null | undefined): string | null {
  if (!deadline) return null;
  const iso = deadline.trim().match(/^(\d{4}-\d{2}-\d{2})(?:T|\b)/)?.[1];
  if (iso) {
    const parsed = new Date(`${iso}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
  }
  const parsed = parseDeadline(deadline);
  return parsed ? calendarDay(parsed) : null;
}

function closedWording(text: string): boolean {
  const scrubbed = text.replace(CLOSED_SOURCE, ' ');
  if (REOPENED.test(scrubbed)) return false;
  return CLOSED_WORDING.test(scrubbed);
}

/**
 * A call is closed when its deadline is already past, or the text says so.
 * A deadline of today stays open for the rest of that calendar date. A future
 * deadline stays open even if the text mentions an earlier closed round.
 * "Closed-source" is not a closed call.
 */
export function parallelCallClosed(result: Pick<ParallelGateResult, 'name' | 'description' | 'deadline'>, now = new Date()): boolean {
  const deadline = (result.deadline || '').trim();
  if (/^(?:closed|expired|passed|ended)$/i.test(deadline)) return true;
  const day = deadlineCalendarDay(deadline);
  const today = calendarDay(now);
  if (day) return day < today;
  const blob = [result.name, result.description, deadline].filter(Boolean).join('\n');
  return closedWording(blob);
}

function funderFromDescription(description: string | null | undefined): string | null {
  if (!description) return null;
  const titled = extractOrgFromName(description);
  if (titled) return titled;
  const match = description.match(RUN_BY);
  if (!match) return null;
  const candidate = canonicalizeOrgName(match[1].trim());
  if (!candidate || classifyOrgName(candidate) !== 'org') return null;
  return candidate;
}

/** Funder for a Parallel row: stored org, a title prefix, or "run by …" in the description. */
export function parallelFunderName(input: ParallelGateResult): string | null {
  const explicit = (input.orgName || '').trim();
  if (explicit) return canonicalizeOrgName(explicit);
  return extractOrgFromName(input.name || '') || funderFromDescription(input.description);
}

function programKeys(name: string, funder: string | null): string[] {
  const full = normalizeProgramKey(name);
  const keys = new Set<string>();
  if (full.length >= 4) keys.add(full);
  if (!funder) return [...keys];

  let stripped = name;
  const words = funder.split(/\s+/).map(word => word.trim()).filter(word => word.length >= 3);
  for (const word of words) {
    stripped = stripped.replace(new RegExp(`\\b${escapeRegExp(word)}\\b`, 'ig'), ' ');
  }
  const initials = words.filter(word => /^[A-Za-z]/.test(word)).map(word => word[0]).join('');
  if (initials.length >= 2 && initials.length <= 6) {
    stripped = stripped.replace(new RegExp(`\\b${escapeRegExp(initials)}\\b`, 'ig'), ' ');
  }
  const reduced = normalizeProgramKey(stripped);
  if (reduced.length >= 10 && reduced !== full) keys.add(reduced);
  return [...keys];
}

function nameContainsFunder(name: string, funder: string): boolean {
  const needle = funder.trim();
  if (needle.length < 3) return false;
  return new RegExp(`(?:^|[^A-Za-z0-9])${escapeRegExp(needle)}(?:[^A-Za-z0-9]|$)`, 'i').test(name);
}

const MONTH_WORDS = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec';
const SEASON_WORDS = 'spring|summer|autumn|winter|fall';
const MONTH_KEY: Record<string, string> = {
  january: 'jan', jan: 'jan',
  february: 'feb', feb: 'feb',
  march: 'mar', mar: 'mar',
  april: 'apr', apr: 'apr',
  may: 'may',
  june: 'jun', jun: 'jun',
  july: 'jul', jul: 'jul',
  august: 'aug', aug: 'aug',
  september: 'sep', sept: 'sep', sep: 'sep',
  october: 'oct', oct: 'oct',
  november: 'nov', nov: 'nov',
  december: 'dec', dec: 'dec',
};

function numberedRoundSignature(name: string): string {
  const parts = extractCycleMarkers(name).numbered.map(marker => `${marker.kind}:${marker.value}`);
  const cohortNumber = name.match(/\bcohorts?\s*#?\s*(\d+)\b/i)
    || name.match(/\b(\d+)(?:st|nd|rd|th)\s+cohorts?\b/i);
  // A 20xx figure next to "cohort" is a year, not a cohort index.
  if (cohortNumber && !/^20\d\d$/.test(cohortNumber[1])) {
    parts.push(`cohort:${Number(cohortNumber[1])}`);
  }
  if (parts.length === 0) {
    const ordinal = name.match(/\b(\d+)(?:st|nd|rd|th)\s+(rounds?|cycles?|seasons?|batches|batch|waves?|funds?)\b/i);
    if (ordinal) {
      const raw = ordinal[2].toLowerCase();
      const kind = raw.startsWith('batch') ? 'batch'
        : raw.startsWith('wave') ? 'wave'
        : raw.startsWith('season') ? 'season'
        : raw.startsWith('cycle') ? 'cycle'
        : raw.startsWith('fund') ? 'fund'
        : 'round';
      parts.push(`${kind}:${Number(ordinal[1])}`);
    }
  }
  return [...new Set(parts)].sort().join(',');
}

function yearSignature(name: string): string {
  const markers = extractCycleMarkers(name);
  const years = new Set(markers.years.map(year => String(year)));
  if (markers.fiscal) {
    for (const year of markers.fiscal.match(/20\d\d/g) || []) years.add(year);
  }
  return [...years].sort().join(',');
}

/** Month or season written next to the word "cohort". A bare year stays in the year signature. */
function cohortSeasonKey(name: string): string {
  if (!/\bcohorts?\b/i.test(name)) return '';
  const before = name.match(new RegExp(`\\b(${MONTH_WORDS}|${SEASON_WORDS})\\b(?:\\s+20\\d\\d)?\\s+cohorts?\\b`, 'i'));
  const after = name.match(new RegExp(`\\bcohorts?\\b(?:\\s+20\\d\\d)?\\s+(${MONTH_WORDS}|${SEASON_WORDS})\\b`, 'i'));
  const token = (before?.[1] || after?.[1] || '').toLowerCase();
  if (!token) return '';
  if (token === 'autumn') return 'fall';
  if (token === 'spring' || token === 'summer' || token === 'winter' || token === 'fall') return token;
  return MONTH_KEY[token] || token.slice(0, 3);
}

/**
 * The same round is the same number, the same year, and the same cohort
 * season. A missing marker on one side is not the same round. Two names
 * with no round, year, or cohort are the standing program.
 */
function sameParallelRound(incomingName: string, existingName: string): boolean {
  return numberedRoundSignature(incomingName) === numberedRoundSignature(existingName)
    && yearSignature(incomingName) === yearSignature(existingName)
    && cohortSeasonKey(incomingName) === cohortSeasonKey(existingName);
}

/**
 * Same program when the normalized funder and program name agree and the
 * round agrees. A different round number, year, or cohort is a different
 * program. The source URL is not part of the match, so the same round
 * reposted at a new address still matches.
 */
export function parallelProgramsMatch(incoming: ParallelGateResult, existing: ExistingProgramRow): boolean {
  const incomingFunder = parallelFunderName(incoming);
  const existingFunder = parallelFunderName({
    name: existing.canonicalName || existing.name,
    description: existing.description,
    orgName: existing.orgName,
  });
  if (incomingFunder && existingFunder && !sameOrgIdentity(incomingFunder, existingFunder)) return false;
  const funder = incomingFunder || existingFunder;
  if (!funder) return false;

  const incomingKeys = new Set(programKeys(incoming.name, funder));
  const existingNames = [existing.canonicalName, existing.name].filter((name): name is string => Boolean(name));
  const existingKeys = existingNames.flatMap(name => programKeys(name, funder));
  if (!existingKeys.some(key => incomingKeys.has(key))) return false;

  const incomingHasFunder = Boolean(incomingFunder) || nameContainsFunder(incoming.name, funder);
  const existingHasFunder = Boolean(existingFunder) || existingNames.some(name => nameContainsFunder(name, funder));
  if (!incomingHasFunder || !existingHasFunder) return false;
  return existingNames.some(name => sameParallelRound(incoming.name, name));
}

function distinctiveWords(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length >= 4 && !GENERIC_TOKENS.has(word) && !['the', 'and', 'for'].includes(word));
}

export function parallelLookupTokens(name: string, funder: string | null): { program: string[]; funder: string[] } {
  const funderTokens = [...new Set(distinctiveWords(funder || ''))].slice(0, 3);
  const funderSet = new Set(funderTokens);
  const program = [...new Set(distinctiveWords(name))].filter(word => !funderSet.has(word)).slice(0, 3);
  return { program, funder: funderTokens };
}

function likePatterns(tokens: string[]): string[] {
  return tokens.map(token => `%${token.replace(/[%_\\]/g, '')}%`);
}

export async function findExistingProgramRows(
  pool: Queryable,
  wire: string,
  tokens: { program: string[]; funder: string[] },
): Promise<ExistingProgramRow[]> {
  if (!wire || (tokens.program.length === 0 && tokens.funder.length === 0)) return [];
  const params: unknown[] = [wire];
  // Program words and funder words are separate so a short title still
  // matches when the funder lives only on the org profile.
  const groups: string[] = [];
  if (tokens.program.length > 0) {
    params.push(likePatterns(tokens.program));
    const programIndex = params.length;
    groups.push(`(se.name ILIKE ALL($${programIndex}::text[]) OR COALESCE(p.canonical_name, '') ILIKE ALL($${programIndex}::text[]))`);
  }
  if (tokens.funder.length > 0) {
    params.push(likePatterns(tokens.funder));
    const funderIndex = params.length;
    groups.push(`(se.name ILIKE ALL($${funderIndex}::text[]) OR COALESCE(p.canonical_name, '') ILIKE ALL($${funderIndex}::text[]) OR COALESCE(op.name, '') ILIKE ALL($${funderIndex}::text[]) OR COALESCE(p.org_name, '') ILIKE ALL($${funderIndex}::text[]))`);
  }

  const { rows } = await pool.query(
    `SELECT se.name,
            p.canonical_name AS "canonicalName",
            COALESCE(op.name, p.org_name) AS "orgName"
     FROM scan_entries se
     LEFT JOIN org_profiles op ON op.id = se.org_id
     LEFT JOIN programs p ON p.id = se.program_id
     WHERE se.wire = $1
       AND se.status NOT IN ('duplicate', 'incomplete')
       AND ${groups.join(' AND ')}
     LIMIT 50`,
    params,
  );
  return rows.map(row => ({
    name: String(row.name ?? ''),
    canonicalName: (row.canonicalName ?? row.canonical_name ?? null) as string | null,
    orgName: (row.orgName ?? row.org_name ?? null) as string | null,
  })).filter(row => row.name);
}

export interface ParallelFrontierItem extends ParallelGateResult {
  wire: string;
}

/**
 * Decide which Parallel Frontier rows to drop before insert.
 * Closed calls are decided locally. A known program needs the database;
 * if that lookup throws, the open rows are kept.
 */
export async function parallelFrontierSkips(
  pool: Queryable,
  items: ParallelFrontierItem[],
  now = new Date(),
): Promise<Array<ParallelSkipReason | null>> {
  const skips: Array<ParallelSkipReason | null> = items.map(item => (
    parallelCallClosed(item, now) ? 'closed' : null
  ));

  try {
    const existingByIndex: ExistingProgramRow[][] = items.map(() => []);
    for (let i = 0; i < items.length; i++) {
      if (skips[i]) continue;
      const funder = parallelFunderName(items[i]);
      const tokens = parallelLookupTokens(items[i].name, funder);
      existingByIndex[i] = await findExistingProgramRows(pool, items[i].wire, tokens);
    }

    const claimed: ParallelFrontierItem[] = [];
    for (let i = 0; i < items.length; i++) {
      if (skips[i]) continue;
      const item = items[i];
      const known = existingByIndex[i].some(row => parallelProgramsMatch(item, row))
        || claimed.some(prior => parallelProgramsMatch(item, prior));
      if (known) {
        skips[i] = 'known_program';
        continue;
      }
      claimed.push(item);
    }
  } catch (err) {
    console.warn(
      '[ParallelIntake] program lookup failed; keeping open rows:',
      err instanceof Error ? err.message : err,
    );
  }

  return skips;
}
