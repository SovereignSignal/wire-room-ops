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

export type QueryPool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

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

// ── Creation & sighting ─────────────────────────────────────────────────
export async function createProgram(
  pool: QueryPool,
  data: { name: string; canonicalName?: string | null; orgName?: string | null; wire?: string | null; sourceUrl?: string | null; roundLabel?: string | null },
): Promise<number> {
  const canonical = (data.canonicalName || data.name).trim();
  let key = normalizeProgramKey(canonical) || normalizeProgramKey(data.name);
  // Collision guard (Task-1 review finding): noise-stripping can collapse two
  // genuinely different programs to one key ("Round Table Grants" class).
  // When the existing key-holder belongs to a DIFFERENT org, disambiguate the
  // key with the org instead of merging identities.
  const orgNorm = data.orgName ? norm(data.orgName) : null;
  if (orgNorm) {
    const existing = await pool.query(`SELECT org_name FROM programs WHERE normalized_key = $1`, [key]) as { rows: Array<{ org_name: string | null }> };
    const other = existing.rows[0]?.org_name ? norm(existing.rows[0].org_name) : null;
    if (other && other !== orgNorm && !other.includes(orgNorm) && !orgNorm.includes(other)) {
      key = `${key}--${orgNorm}`;
    }
  }
  const dom = domainOf(data.sourceUrl);
  const { rows } = await pool.query(
    `INSERT INTO programs (canonical_name, normalized_key, org_name, wire, aliases, canonical_url, url_domains, latest_round_label, entry_count, first_seen, last_seen)
     VALUES ($1, $2, $3, $4, ARRAY[$5]::text[], $6, CASE WHEN $7::text IS NULL THEN '{}'::text[] ELSE ARRAY[$7]::text[] END, $8, 0, CURRENT_DATE, CURRENT_DATE)
     ON CONFLICT (normalized_key) DO UPDATE SET
       aliases = (SELECT ARRAY(SELECT DISTINCT unnest(programs.aliases || ARRAY[$5]::text[]))),
       last_seen = CURRENT_DATE, updated_at = NOW()
     RETURNING id`,
    [canonical, key, data.orgName ?? null, data.wire ?? null, data.name, data.sourceUrl ? normalizeUrl(data.sourceUrl) : null, dom, data.roundLabel ?? null],
  );
  return rows[0].id;
}

export async function recordSighting(
  pool: QueryPool,
  programId: number,
  entry: { name: string; sourceUrl?: string | null; deadline?: string | null; roundLabel?: string | null },
): Promise<void> {
  const dom = domainOf(entry.sourceUrl);
  await pool.query(
    `UPDATE programs SET
       aliases = (SELECT ARRAY(SELECT DISTINCT unnest(aliases || ARRAY[$2]::text[]))),
       url_domains = CASE WHEN $3::text IS NULL OR $3 = ANY(url_domains) THEN url_domains ELSE url_domains || ARRAY[$3]::text[] END,
       entry_count = entry_count + 1,
       latest_round_label = COALESCE($4, latest_round_label),
       latest_deadline = CASE
         WHEN NULLIF($5, '') IS NULL THEN latest_deadline
         WHEN latest_deadline IS NULL THEN NULLIF($5, '')::date
         ELSE GREATEST(latest_deadline, NULLIF($5, '')::date)
       END,
       last_seen = CURRENT_DATE, updated_at = NOW()
     WHERE id = $1`,
    [programId, entry.name, dom, entry.roundLabel ?? null, entry.deadline ?? null],
  );
}

// ── LLM canonicalization (mirrors org-extractor's extractOrgsWithGrok) ──
export async function canonicalizeBatch(
  entries: Array<{ id: number; name: string; description: string }>,
  fetchImpl: typeof fetch = fetch,
): Promise<Array<{ id: number; org: string | null; program: string | null; round_label: string | null }>> {
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
  const apiKey = provider?.api_key || config.apis.grok.apiKey;
  const baseUrl = provider?.base_url || config.apis.grok.baseUrl;
  const model = provider?.default_model || 'grok-4.20-beta-0309-non-reasoning';
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
    const cleaned = content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    logApiUsage({ provider: 'grok', model, purpose: 'program-identity', duration_ms: Date.now() - start });
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r: any) => r && typeof r.id === 'number')
      .map((r: any) => ({ id: r.id, org: r.org ?? null, program: r.program ?? null, round_label: r.round_label ?? null }));
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
  pool: QueryPool,
  entry: { id: number; name: string; sourceUrl?: string | null; wire?: string | null; deadline?: string | null; description?: string | null },
  resolution: ProgramResolutionStamp | null,
): Promise<void> {
  try {
    if (resolution) {
      await recordSighting(pool, resolution.programId, { name: entry.name, sourceUrl: entry.sourceUrl, deadline: entry.deadline, roundLabel: resolution.roundLabel });
      const verdict = resolution.confidence >= 0.85 ? resolution.verdict : 'tentative';
      await pool.query(
        `UPDATE scan_entries SET program_id = $2,
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('program', $3::jsonb)
         WHERE id = $1`,
        [entry.id, resolution.programId, JSON.stringify({ id: resolution.programId, verdict, confidence: resolution.confidence, round_label: resolution.roundLabel, history: resolution.historyLine })],
      );
      return;
    }
    // New program: introspect link identity first, then LLM canonicalization
    const intro = introspectEntryUrl({ sourceUrl: entry.sourceUrl, description: entry.description ?? null });
    const scraped = intro.canonicalUrl === entry.sourceUrl ? await maybeScrapeAggregator(entry) : null;
    const bestUrl = scraped ?? intro.canonicalUrl ?? entry.sourceUrl ?? null;
    const [canon] = await canonicalizeBatch([{ id: entry.id, name: entry.name, description: '' }]);
    const orgName = intro.orgHint ?? canon?.org ?? extractOrgFromName(entry.name);
    const programId = await createProgram(pool, {
      name: entry.name,
      canonicalName: canon?.program ?? null,
      orgName, wire: entry.wire ?? null, sourceUrl: bestUrl,
      roundLabel: canon?.round_label ?? extractRoundLabel(entry.name),
    });
    await pool.query(
      `UPDATE scan_entries SET program_id = $2,
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('program', $3::jsonb)
       WHERE id = $1`,
      [entry.id, programId, JSON.stringify({ id: programId, verdict: 'new_program' })],
    );
  } catch (err) {
    console.error(`[ProgramIdentity] finalize failed for entry ${entry.id} (fail-open):`, err instanceof Error ? err.message : err);
  }
}
