/**
 * Program identity — canonical program registry + resolution.
 *
 * The pipeline has URL identity (seen_urls) and exact-name identity
 * (dedup Layer 1.5), but no PROGRAM identity: the same program re-enters
 * under every new name variant and URL (Anthropic Fellows: ~60 entries,
 * 15+ name variants). This service owns the `programs` table and resolves
 * entries to canonical programs. Design: docs/superpowers/specs/2026-07-10-
 * program-identity-design.md. Table DDL lives here (same pattern as
 * org_profiles living in org-extractor.ts).
 */
import { config } from '../config';
import { getPool, getAppState, setAppState } from '../db';
import { logApiUsage } from './api-usage';
import { getCachedProvider } from './api-provider';
import { extractOrgFromName } from './org-extractor';
import { normalizeUrl } from '../utils/url';
import { scrapeUrl } from './scraper';
import type { Pool, PoolClient } from 'pg';
import { DEFAULT_GROK_MODEL } from './grok';

// ── Key normalization ───────────────────────────────────────────────────
// The primary identity key: lowercase alnum with round/cohort/date noise
// removed BEFORE squashing, so "Fund14" ≡ "Fund12" and "(Sept 2026 cohort)"
// vanishes entirely.
const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec';
const NOISE_PATTERNS: RegExp[] = [
  /\b20\d\d\b/g,                                  // years
  new RegExp(`\\b(?:${MONTHS})\\b`, 'gi'),        // month names
  /\bcohorts?\b/gi,
  /\brounds?\s*\d*\b/gi,
  /\bbatch(?:es)?\s*\d*\b/gi,
  /\bwaves?\s*\d*\b/gi,
  /\bseasons?\s*\d*\b/gi,
  /\bq[1-4]\b/gi,
  /\bh[12]\b/gi,
  /\b\d+(?:st|nd|rd|th)\b/gi,                     // ordinals
];

// Program-type suffixes. The SAME program is written "X Grants", "X Grant
// Program", "X Fund", "X Sponsorships" by different sources; keeping the
// suffix in the key mints a second identity for each spelling (measured
// 2026-07-27: 1,008 of 4,267 program rows were duplicate identities, 61% of
// them exactly this). Stripped only from the END of the name, so a mid-name
// qualifier ("Commons Fund" vs "Core Fund") still separates two genuinely
// different programs.
const PROGRAM_SUFFIX_RE =
  /\s*\b(?:grants?|programs?|programmes?|funds?|funding|sponsorships?|fellowships?|scholarships?|initiatives?|schemes?|rfps?|awards?)\b\s*$/i;

// A key shorter than this carries no identity — "The Fund" must not reduce
// to "the" and start colliding with every other stub.
const MIN_STRIPPED_KEY_LENGTH = 4;

function stripProgramSuffixes(name: string): string {
  let s = name;
  // Loop: "Grant Program" and "Grants Fund" stack two suffixes deep.
  for (let i = 0; i < 3; i++) {
    const next = s.replace(PROGRAM_SUFFIX_RE, '').trim();
    if (!next || next === s) break;
    // Never strip a name down to nothing or to a generic stub — "Grants"
    // stays "Grants", "The Fund" stays "The Fund".
    if (next.replace(/[^a-z0-9]/g, '').length < MIN_STRIPPED_KEY_LENGTH) break;
    s = next;
  }
  return s;
}

export function normalizeProgramKey(name: string): string {
  let s = (name || '').toLowerCase();
  s = s.replace(/\bfund\s*\d+\b/gi, 'fund');
  for (const p of NOISE_PATTERNS) s = s.replace(p, ' ');
  // Punctuation becomes whitespace BEFORE suffix stripping, so a trailing
  // "(...)" left behind by noise removal cannot hide the real suffix —
  // "Fellows Program (Dec 2026 cohort)" must reduce to "fellows", not
  // "fellowsprogram".
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();
  s = stripProgramSuffixes(s);
  return s.replace(/[^a-z0-9]/g, '');
}

// ── Table ───────────────────────────────────────────────────────────────
export interface ProgramRow {
  id: number;
  canonical_name: string;
  normalized_key: string;
  org_id: number | null;
  org_name: string | null;
  wire: string | null;
  aliases: string[];
  canonical_url: string | null;
  url_domains: string[];
  canonical_entry_id: number | null;
  latest_round_label: string | null;
  latest_deadline: string | null;
  entry_count: number;
  approved_count: number;
  declined_count: number;
  last_decision: string | null;
  first_seen: string | null;
  last_seen: string | null;
}

export async function ensureProgramsTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`CREATE TABLE IF NOT EXISTS programs (
    id SERIAL PRIMARY KEY,
    canonical_name TEXT NOT NULL,
    normalized_key TEXT NOT NULL,
    org_id INTEGER REFERENCES org_profiles(id) ON DELETE SET NULL,
    org_name TEXT,
    wire TEXT,
    aliases TEXT[] NOT NULL DEFAULT '{}',
    canonical_url TEXT,
    url_domains TEXT[] NOT NULL DEFAULT '{}',
    canonical_entry_id INTEGER,
    latest_round_label TEXT,
    latest_deadline DATE,
    entry_count INTEGER NOT NULL DEFAULT 0,
    approved_count INTEGER NOT NULL DEFAULT 0,
    declined_count INTEGER NOT NULL DEFAULT 0,
    last_decision TEXT,
    first_seen DATE,
    last_seen DATE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (normalized_key)
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_programs_org ON programs(org_id)`);
  await pool.query(`ALTER TABLE scan_entries ADD COLUMN IF NOT EXISTS program_id INTEGER REFERENCES programs(id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_scan_entries_program ON scan_entries(program_id)`);
}

// ── Resolution ──────────────────────────────────────────────────────────
export interface ProgramMatch { program: ProgramRow; confidence: number; pass: 'key' | 'substring' | 'tokens'; urlBoost: boolean }

const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Initials of the significant words: "Amazon Web Services" -> "aws". */
function initialsOf(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0 && !['of', 'the', 'and', 'for', 'a', 'an'].includes(w))
    .map(w => w[0])
    .join('');
}

/**
 * Do two org strings name the same funder?
 *
 * Sources write the same org as "AWS" and "Amazon Web Services". The
 * collision guard in createProgram compared raw normalized text and forked
 * the program key on that difference alone, minting a duplicate program row
 * with a byte-identical name (production rows #7 / #783). Exact, substring,
 * and initialism agreement all count as one identity.
 */
export function sameOrgIdentity(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  // Initialism: compare the acronym form of the longer name to the shorter.
  const [short, long] = x.length <= y.length ? [x, b] : [y, a];
  const initials = initialsOf(long);
  return initials.length >= 2 && initials === short;
}
const tokensOf = (s: string) => new Set((s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(t => t.length > 3));
const domainOf = (url: string | null | undefined): string | null => {
  const m = (url || '').match(/^https?:\/\/(?:www\.)?([^/]+)/i);
  return m ? m[1].toLowerCase() : null;
};

// ── Link introspection ──────────────────────────────────────────────────
const ATS_PATTERNS: Array<{ re: RegExp }> = [
  { re: /^https?:\/\/job-boards\.greenhouse\.io\/([^/]+)/i },
  { re: /^https?:\/\/jobs\.ashbyhq\.com\/([^/]+)/i },
  { re: /^https?:\/\/jobs\.lever\.co\/([^/]+)/i },
];

export function introspectEntryUrl(entry: { sourceUrl?: string | null; description?: string | null }): { canonicalUrl: string | null; orgHint: string | null } {
  const src = entry.sourceUrl || null;
  if (src && /^https?:\/\/(?:www\.)?(x|twitter)\.com\//i.test(src)) {
    const m = (entry.description || '').match(/https?:\/\/(?!(?:www\.)?(?:x|twitter)\.com)[^\s)\]"'*<>\x60~!\\]+/i);
    if (m) return { canonicalUrl: m[0].replace(/[.,;:*<>\x60~!\\]+$/, ''), orgHint: null };
    return { canonicalUrl: src, orgHint: null };
  }
  for (const { re } of ATS_PATTERNS) {
    const m = src ? src.match(re) : null;
    if (m) return { canonicalUrl: null, orgHint: m[1].replace(/-/g, ' ').toLowerCase() };
  }
  return { canonicalUrl: src, orgHint: null };
}

const DEFAULT_AGGREGATORS = ['opportunitiesforyouth.org', 'opportunities247.org'];
const SCRAPE_CAP_PER_DAY = 10;

export async function maybeScrapeAggregator(
  entry: { sourceUrl?: string | null },
  deps: { getAppState: typeof getAppState; setAppState: typeof setAppState; scrape: typeof scrapeUrl } = { getAppState, setAppState, scrape: scrapeUrl },
): Promise<string | null> {
  try {
    const dom = domainOf(entry.sourceUrl);
    if (!dom) return null;
    const aggregators = new Set([...DEFAULT_AGGREGATORS, ...(process.env.PROGRAM_AGGREGATOR_DOMAINS || '').split(',').map(s => s.trim()).filter(Boolean)]);
    if (!aggregators.has(dom)) return null;
    const key = `program-gate:scrape-count:${new Date().toISOString().slice(0, 10)}`;
    const count = (await deps.getAppState<number>(key)) ?? 0;
    if (count >= SCRAPE_CAP_PER_DAY) return null;
    await deps.setAppState(key, count + 1);
    const result = await deps.scrape(entry.sourceUrl as string);
    if (!result.success || !result.content) return null;
    // Extract all URLs and return the first one that is not from an aggregator domain
    const urlRegex = /https?:\/\/[^\s)\]"'*<>\x60~!\\]+/g;
    let match;
    while ((match = urlRegex.exec(result.content)) !== null) {
      const url = match[0].replace(/[.,;:*<>\x60~!\\]+$/, '');
      const urlDomain = domainOf(url);
      if (urlDomain && !aggregators.has(urlDomain)) {
        return url;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export type QueryPool = Pick<Pool, 'query'>;
export type QueryClient = Pick<PoolClient, 'query' | 'release'>;
export type TransactionPool = Pick<Pool, 'query' | 'connect'>;

export async function resolveProgram(
  pool: QueryPool,
  candidate: { name: string; orgName?: string | null; sourceUrl?: string | null; wire?: string | null },
): Promise<ProgramMatch | null> {
  const key = normalizeProgramKey(candidate.name);
  if (!key) return null;
  // Candidate pull: cheap prefilter on key prefix OR shared org/wire keeps the
  // scan bounded; final scoring happens in JS (mirrors findSimilarOrg's style).
  const { rows } = await pool.query(
    `SELECT * FROM programs
     WHERE normalized_key = $1
        OR normalized_key LIKE $2 || '%' OR $2 LIKE normalized_key || '%'
        OR ($3::text IS NOT NULL AND lower(org_name) = lower($3))
        OR ($4::text IS NOT NULL AND $4 = ANY(url_domains))
        OR EXISTS (
             SELECT 1 FROM unnest(aliases) a
             WHERE lower(regexp_replace(a, '[^a-zA-Z0-9]', '', 'g')) LIKE $2 || '%'
                OR $2 LIKE left(lower(regexp_replace(a, '[^a-zA-Z0-9]', '', 'g')), 10) || '%'
           )
     LIMIT 25`,
    [key, key.slice(0, 10), candidate.orgName ?? null, domainOf(candidate.sourceUrl) ?? null],
  ) as { rows: ProgramRow[] };
  if (rows.length === 0) return null;

  const candDomain = domainOf(candidate.sourceUrl);
  const candTokens = tokensOf(candidate.name);
  const candOrg = candidate.orgName ? norm(candidate.orgName) : null;

  let best: ProgramMatch | null = null;
  for (const p of rows) {
    const keys = [p.normalized_key, ...(p.aliases || []).map(normalizeProgramKey)];
    const orgAgrees = candOrg && p.org_name ? norm(p.org_name) === candOrg || norm(p.org_name).includes(candOrg) || candOrg.includes(norm(p.org_name)) : null;
    const urlBoost = Boolean(candDomain && ((p.url_domains || []).includes(candDomain) || domainOf(p.canonical_url) === candDomain));
    const wireMismatch = Boolean(candidate.wire && p.wire && candidate.wire !== p.wire);

    let pass: ProgramMatch['pass'] | null = null;
    if (keys.includes(key)) pass = 'key';
    else if (key.length >= 8 && keys.some(k => k.length >= 8 && (k.includes(key) || key.includes(k)))) pass = 'substring';
    else {
      const pTokens = tokensOf(`${p.canonical_name} ${(p.aliases || []).join(' ')}`);
      const shared = [...candTokens].filter(t => pTokens.has(t));
      const denom = Math.min(candTokens.size, pTokens.size) || 1;
      if (shared.length >= 2 && shared.length / denom >= 0.6) pass = 'tokens';
    }
    if (!pass) continue;
    // A normalized name alone is insufficient when organization identity
    // disagrees. A shared canonical domain is the only safe override.
    if (orgAgrees === false && !urlBoost) continue;
    if (wireMismatch && orgAgrees !== true && !urlBoost) continue;

    let confidence = pass === 'key' ? 0.95 : pass === 'substring' ? 0.85 : 0.75;
    if (urlBoost) confidence = Math.min(0.99, confidence + 0.10);
    if (!best || confidence > best.confidence) best = { program: p, confidence, pass, urlBoost };
  }
  return best;
}

// ── Round assessment ────────────────────────────────────────────────────
export interface RoundVerdict { verdict: 'same_round' | 'new_round'; roundLabel: string | null }

const ROUND_RE = new RegExp(
  `\\b(?:(?:${MONTHS})[\\s./&-]*)*20\\d\\d\\s*cohorts?\\b|\\bcohorts?\\b|\\bfund\\s*\\d+\\b|\\brounds?\\s*\\d+\\b|\\bseasons?\\s*\\d+\\b|\\bbatch(?:es)?\\s*\\d+\\b|\\bwaves?\\s*\\d+\\b|\\bq[1-4](?:\\s*/\\s*q[1-4])?\\s*20\\d\\d\\b|\\b20\\d\\d\\b`,
  'gi',
);

export function extractRoundLabel(name: string): string | null {
  // Grab the widest round-ish phrase: prefer "(...cohort)" parentheticals, else regex hits joined
  const paren = name.match(/\(([^)]*(?:cohort|round|batch|fund|season)[^)]*)\)/i);
  if (paren) return paren[1].trim().toLowerCase();
  const hits = name.match(ROUND_RE);
  if (!hits || hits.length === 0) return null;
  return hits.join(' ').trim().toLowerCase() || null;
}

export function assessRound(program: ProgramRow, candidate: { name: string; deadline?: string | null }): RoundVerdict {
  const candLabel = extractRoundLabel(candidate.name);
  const progLabel = program.latest_round_label ? program.latest_round_label.toLowerCase() : null;
  if (candLabel && progLabel) {
    return candLabel === progLabel
      ? { verdict: 'same_round', roundLabel: candLabel }
      : { verdict: 'new_round', roundLabel: candLabel }; // ambiguity → new_round bias
  }
  if (candLabel && !progLabel) return { verdict: 'new_round', roundLabel: candLabel };
  // No labels anywhere: a strictly later deadline signals a new cycle
  if (candidate.deadline && program.latest_deadline) {
    const cand = Date.parse(candidate.deadline);
    const prog = Date.parse(program.latest_deadline);
    if (!Number.isNaN(cand) && !Number.isNaN(prog) && cand > prog) {
      return { verdict: 'new_round', roundLabel: null };
    }
  }
  return { verdict: 'same_round', roundLabel: candLabel };
}

// ── Display ─────────────────────────────────────────────────────────────
export function historyLine(p: ProgramRow): string {
  const parts = [`seen ${p.entry_count}×`];
  if (p.approved_count > 0) parts.push(`approved ${p.approved_count}×`);
  if (p.declined_count > 0) parts.push(`declined ${p.declined_count}×`);
  if (p.last_decision) parts.push(`last ${p.last_decision}`);
  return parts.join(' · ');
}

// ── Creation & sighting ─────────────────────────────────────────────────
export async function createProgram(
  pool: QueryPool,
  data: { name: string; canonicalName?: string | null; orgName?: string | null; wire?: string | null; sourceUrl?: string | null; roundLabel?: string | null },
): Promise<number> {
  const canonical = (data.canonicalName || data.name).trim();
  let key = normalizeProgramKey(canonical) || normalizeProgramKey(data.name);
  // Production callers create programs inside a transaction. Serializing on
  // the base key closes the lookup/upsert race for simultaneous org variants.
  await lockProgramCreationKey(pool, key);
  // Collision guard (Task-1 review finding): noise-stripping can collapse two
  // genuinely different programs to one key ("Round Table Grants" class).
  // When the existing key-holder belongs to a DIFFERENT org, disambiguate the
  // key with the org instead of merging identities.
  if (data.orgName) {
    const existing = await pool.query(`SELECT org_name FROM programs WHERE normalized_key = $1`, [key]) as { rows: Array<{ org_name: string | null }> };
    const other = existing.rows[0]?.org_name ?? null;
    // sameOrgIdentity, not string equality: "AWS" and "Amazon Web Services"
    // are one funder, and treating them as two forked the key.
    if (other && !sameOrgIdentity(other, data.orgName)) {
      key = `${key}--${norm(data.orgName)}`;
    }
  }
  const dom = domainOf(data.sourceUrl);
  const { rows } = await pool.query(
    `INSERT INTO programs (canonical_name, normalized_key, org_name, wire, aliases, canonical_url, url_domains, latest_round_label, entry_count, first_seen, last_seen)
     VALUES ($1, $2, $3, $4, ARRAY[$5]::text[], $6, CASE WHEN $7::text IS NULL THEN '{}'::text[] ELSE ARRAY[$7]::text[] END, $8, 0, CURRENT_DATE, CURRENT_DATE)
     ON CONFLICT (normalized_key) DO UPDATE SET
       aliases = (SELECT ARRAY(SELECT DISTINCT unnest(programs.aliases || ARRAY[$5]::text[]))),
       wire = COALESCE(programs.wire, EXCLUDED.wire),
       last_seen = CURRENT_DATE, updated_at = NOW()
     RETURNING id`,
    [canonical, key, data.orgName ?? null, data.wire ?? null, data.name, data.sourceUrl ? normalizeUrl(data.sourceUrl) : null, dom, data.roundLabel ?? null],
  );
  return rows[0].id;
}

export async function recordSighting(
  pool: QueryPool,
  programId: number,
  entry: { id?: number; name: string; sourceUrl?: string | null; deadline?: string | null; roundLabel?: string | null },
): Promise<void> {
  const dom = domainOf(entry.sourceUrl);
  const deadline = normalizeProgramDeadline(entry.deadline);
  await pool.query(
    `UPDATE programs SET
       aliases = (SELECT ARRAY(SELECT DISTINCT unnest(aliases || ARRAY[$2]::text[]))),
       url_domains = CASE WHEN $3::text IS NULL OR $3 = ANY(url_domains) THEN url_domains ELSE url_domains || ARRAY[$3]::text[] END,
       entry_count = entry_count + 1,
       canonical_entry_id = COALESCE(canonical_entry_id, $6),
       latest_round_label = COALESCE($4, latest_round_label),
       latest_deadline = CASE
         WHEN NULLIF($5, '') IS NULL THEN latest_deadline
         WHEN latest_deadline IS NULL THEN NULLIF($5, '')::date
         ELSE GREATEST(latest_deadline, NULLIF($5, '')::date)
       END,
       last_seen = CURRENT_DATE, updated_at = NOW()
     WHERE id = $1`,
    [programId, entry.name, dom, entry.roundLabel ?? null, deadline, entry.id ?? null],
  );
}

/** Accept only real ISO calendar dates for the programs.latest_deadline column. */
export function normalizeProgramDeadline(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== trimmed
    ? null
    : trimmed;
}

/** Recompute all entry-derived program state, including empty programs, idempotently. */
export async function refreshProgramCounters(pool: QueryPool, programIds: number[]): Promise<number> {
  const ids = [...new Set(programIds.filter(Number.isSafeInteger))];
  if (ids.length === 0) return 0;
  const { rows } = await pool.query(
    `WITH target AS (
       SELECT id, canonical_entry_id FROM programs WHERE id = ANY($1::int[])
     ), stats AS (
       SELECT t.id AS program_id,
              COUNT(se.id)::int AS total,
              COUNT(se.id) FILTER (WHERE se.status = 'approved')::int AS approved,
              COUNT(se.id) FILTER (WHERE se.status = 'declined')::int AS declined,
              MIN(se.created_at)::date AS first_seen,
              MAX(se.created_at)::date AS last_seen,
              (ARRAY_AGG(se.id ORDER BY
                 CASE se.status WHEN 'approved' THEN 0 WHEN 'declined' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END,
                 se.created_at DESC, se.id DESC
               ) FILTER (WHERE se.status IN ('approved', 'declined', 'queued', 'archived')
                           AND se.duplicate_of_id IS NULL))[1] AS preferred_exemplar,
              (ARRAY_AGG(se.status || ' ' || se.updated_at::date ORDER BY se.updated_at DESC, se.id DESC)
                FILTER (WHERE se.status IN ('approved', 'declined')))[1] AS last_decision
       FROM target t
       LEFT JOIN scan_entries se ON se.program_id = t.id
       GROUP BY t.id
     ), desired AS (
       SELECT s.*,
              CASE WHEN EXISTS (
                SELECT 1 FROM scan_entries current
                WHERE current.id = p.canonical_entry_id
                  AND current.program_id = p.id
                  AND current.status IN ('approved', 'declined', 'queued', 'archived')
                  AND current.duplicate_of_id IS NULL
              ) THEN p.canonical_entry_id ELSE s.preferred_exemplar END AS exemplar
       FROM stats s
       JOIN programs p ON p.id = s.program_id
     )
     UPDATE programs p SET
       entry_count = s.total,
       approved_count = s.approved,
       declined_count = s.declined,
       first_seen = s.first_seen,
       last_seen = s.last_seen,
       canonical_entry_id = s.exemplar,
       last_decision = s.last_decision,
       updated_at = NOW()
     FROM desired s
     WHERE p.id = s.program_id
       AND (p.entry_count, p.approved_count, p.declined_count,
            p.first_seen, p.last_seen, p.canonical_entry_id, p.last_decision)
           IS DISTINCT FROM
           (s.total, s.approved, s.declined,
            s.first_seen, s.last_seen, s.exemplar, s.last_decision)
     RETURNING p.id`,
    [ids],
  );
  return rows.length;
}

// ── LLM canonicalization (mirrors org-extractor's extractOrgsWithGrok) ──
export type CanonicalizedProgram = {
  id: number;
  org: string | null;
  program: string | null;
  round_label: string | null;
};

const nullableString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

export function parseCanonicalizationContent(content: string, allowedIds?: Set<number>): CanonicalizedProgram[] {
  const unfenced = (content || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    // Some compatible providers prepend a short explanation despite the JSON-only
    // prompt. Recover only when the content contains one complete JSON array.
    const start = unfenced.indexOf('[');
    const end = unfenced.lastIndexOf(']');
    if (start < 0 || end <= start) throw new Error('Canonicalization response contained no JSON array');
    parsed = JSON.parse(unfenced.slice(start, end + 1));
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? Object.values(parsed as Record<string, unknown>).find(Array.isArray)
      : null;
  if (!Array.isArray(rows)) throw new Error('Canonicalization response was not a JSON array');

  const seen = new Set<number>();
  const output: CanonicalizedProgram[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const rawId = (row as Record<string, unknown>).id;
    const id = typeof rawId === 'number'
      ? rawId
      : typeof rawId === 'string' && /^\d+$/.test(rawId.trim())
        ? Number(rawId)
        : NaN;
    if (!Number.isSafeInteger(id) || seen.has(id) || (allowedIds && !allowedIds.has(id))) continue;
    seen.add(id);
    output.push({
      id,
      org: nullableString((row as Record<string, unknown>).org),
      program: nullableString((row as Record<string, unknown>).program),
      round_label: nullableString((row as Record<string, unknown>).round_label),
    });
  }
  return output;
}

export async function canonicalizeBatch(
  entries: Array<{ id: number; name: string; description: string }>,
  fetchImpl: typeof fetch = fetch,
): Promise<CanonicalizedProgram[]> {
  if (entries.length === 0) return [];
  const start = Date.now();
  const entriesText = entries.map(e => `[ID:${e.id}] "${e.name}" — ${(e.description || '').substring(0, 100)}`).join('\n');
  const prompt = `For each grant/funding entry below, name the FUNDING PROGRAM canonically. Return ONLY a JSON array of {"id", "org", "program", "round_label"}.

Rules:
- "program" = funder + program name, WITHOUT cohort/round/dates (e.g. "Anthropic Fellows Program", not "Anthropic Fellows Program (Sept 2026 cohort)")
- "round_label" = the cohort/round/cycle phrase if present (e.g. "sept 2026 cohort", "fund14"), else null
- "org" = the funding organization (canonical name), or null if unclear
- If the entry names no identifiable program, "program": null

Entries:
${entriesText}

  Return ONLY valid JSON array, no explanation.`;
  const provider = getCachedProvider('grok');
  if (!provider?.api_key) return [];
  const apiKey = provider.api_key;
  const baseUrl = provider.base_url || config.apis.grok.baseUrl;
  const model = provider?.default_model || DEFAULT_GROK_MODEL;
  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(120_000),
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0 }),
    });
    if (!response.ok) throw new Error(`grok ${((response as Response).status)}`);
    const data = await (response as Response).json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content || '[]';
    const parsed = parseCanonicalizationContent(content, new Set(entries.map(entry => entry.id)));
    logApiUsage({ provider: 'grok', model, purpose: 'program-identity', duration_ms: Date.now() - start });
    return parsed;
  } catch (err) {
    logApiUsage({ provider: 'grok', model, purpose: 'program-identity', duration_ms: Date.now() - start, success: false, error_message: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

// ── The one post-dedup hook callers use ─────────────────────────────────
export type ProgramResolutionStamp = {
  programId: number; confidence: number;
  verdict: 'same_round' | 'new_round'; roundLabel: string | null; historyLine: string;
};

/**
 * Called by process-raw / daily-intake AFTER an entry survives dedup.
 * resolution present → record the sighting + stamp metadata.program.
 * resolution null → canonicalize (LLM, 1 entry) → create/attach a program.
 * Fail-open: every failure logs and returns; intake never blocks on identity.
 */
export async function finalizeProgramForEntry(
  pool: TransactionPool,
  entry: { id: number; name: string; sourceUrl?: string | null; wire?: string | null; deadline?: string | null; description?: string | null },
  resolution: ProgramResolutionStamp | null,
): Promise<void> {
  try {
    if (resolution) {
      const verdict = resolution.confidence >= 0.85 ? resolution.verdict : 'tentative';
      const stamp = JSON.stringify({ id: resolution.programId, verdict, confidence: resolution.confidence, round_label: resolution.roundLabel, history: resolution.historyLine });
      await withProgramTransaction(pool, async client => {
        const current = await lockEntryProgram(client, entry.id);
        if (current !== null && current !== resolution.programId) {
          throw new Error(`entry is already linked to program ${current}, not ${resolution.programId}`);
        }
        if (current === resolution.programId) {
          await client.query(
            `UPDATE scan_entries SET
               metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('program', $3::jsonb)
             WHERE id = $1 AND program_id = $2`,
            [entry.id, resolution.programId, stamp],
          );
          return;
        }
        // A same-round repeat used to be auto-demoted by the program gate; now
        // it stays queued, so the history must reach the operator. The digest
        // renders metadata.program, but the queue details sheet only shows
        // operator_notes — write the history there too.
        const repeatNote = verdict === 'same_round'
          ? `Program repeat (${resolution.historyLine})${resolution.roundLabel ? ` — round ${resolution.roundLabel}` : ''}. Advisory only: verify before approving.`
          : null;
        const linked = await client.query(
          `UPDATE scan_entries SET program_id = $2,
             metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('program', $3::jsonb),
             operator_notes = CASE WHEN $4::text IS NULL THEN operator_notes
               ELSE CONCAT_WS(E'\n', NULLIF(operator_notes, ''), $4::text) END
           WHERE id = $1 AND program_id IS NULL
           RETURNING id`,
          [entry.id, resolution.programId, stamp, repeatNote],
        );
        if (linked.rows.length !== 1) throw new Error('entry changed before the program link was written');
        await recordSighting(client, resolution.programId, { id: entry.id, name: entry.name, sourceUrl: entry.sourceUrl, deadline: entry.deadline, roundLabel: resolution.roundLabel });
      });
      return;
    }
    // New program: introspect link identity first, then LLM canonicalization
    const intro = introspectEntryUrl({ sourceUrl: entry.sourceUrl, description: entry.description ?? null });
    const scraped = intro.canonicalUrl === entry.sourceUrl ? await maybeScrapeAggregator(entry) : null;
    const bestUrl = scraped ?? intro.canonicalUrl ?? entry.sourceUrl ?? null;
    const [canon] = await canonicalizeBatch([{ id: entry.id, name: entry.name, description: '' }]);
    const orgName = intro.orgHint ?? canon?.org ?? extractOrgFromName(entry.name);
    const roundLabel = canon?.round_label ?? extractRoundLabel(entry.name);
    await withProgramTransaction(pool, async client => {
      await lockProgramCreationKey(client, normalizeProgramKey(canon?.program ?? entry.name));
      const current = await lockEntryProgram(client, entry.id);
      if (current !== null) return;
      const programId = await createProgram(client, {
        name: entry.name,
        canonicalName: canon?.program ?? null,
        orgName, wire: entry.wire ?? null, sourceUrl: bestUrl,
        roundLabel,
      });
      const linked = await client.query(
        `UPDATE scan_entries SET program_id = $2,
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('program', $3::jsonb)
         WHERE id = $1 AND program_id IS NULL
         RETURNING id`,
        [entry.id, programId, JSON.stringify({ id: programId, verdict: 'new_program' })],
      );
      if (linked.rows.length !== 1) throw new Error('entry changed before the program link was written');
      await recordSighting(client, programId, {
        id: entry.id,
        name: entry.name,
        sourceUrl: bestUrl,
        deadline: entry.deadline,
        roundLabel,
      });
    });
  } catch (err) {
    console.error(`[ProgramIdentity] finalize failed for entry ${entry.id} (fail-open):`, err instanceof Error ? err.message : err);
  }
}

async function lockProgramCreationKey(client: QueryPool, normalizedKey: string): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext($1))`,
    [`wire-room-ops:program-key:${normalizedKey}`],
  );
}

async function lockEntryProgram(client: QueryPool, entryId: number): Promise<number | null> {
  const { rows } = await client.query(
    `SELECT program_id FROM scan_entries WHERE id = $1 FOR UPDATE`,
    [entryId],
  );
  if (rows.length !== 1) throw new Error('entry no longer exists');
  return rows[0].program_id == null ? null : Number(rows[0].program_id);
}

async function withProgramTransaction<T>(pool: TransactionPool, work: (client: QueryClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let began = false;
  try {
    await client.query('BEGIN');
    began = true;
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (began) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('[ProgramIdentity] rollback failed:', rollbackError instanceof Error ? rollbackError.message : rollbackError);
      }
    }
    throw error;
  } finally {
    client.release();
  }
}
