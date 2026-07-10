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
import { getPool } from '../db';

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
  /\bfund\s*(\d+)\b/gi,                           // Fund14 → fund (number dropped below)
  /\bq[1-4]\b/gi,
  /\bh[12]\b/gi,
  /\b\d+(?:st|nd|rd|th)\b/gi,                     // ordinals
];

export function normalizeProgramKey(name: string): string {
  let s = (name || '').toLowerCase();
  s = s.replace(/\bfund\s*\d+\b/gi, 'fund');
  for (const p of NOISE_PATTERNS) s = s.replace(p, ' ');
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
const tokensOf = (s: string) => new Set((s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(t => t.length > 3));
const domainOf = (url: string | null | undefined): string | null => {
  const m = (url || '').match(/^https?:\/\/(?:www\.)?([^/]+)/i);
  return m ? m[1].toLowerCase() : null;
};

type QueryPool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

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
    // Org mismatch vetoes fuzzy passes (key match survives — the key IS the identity)
    if (pass !== 'key' && orgAgrees === false) continue;

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
