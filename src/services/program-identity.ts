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
