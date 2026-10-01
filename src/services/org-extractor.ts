/**
 * Organization Extractor
 *
 * Extracts canonical organization names from scan_entry names/descriptions.
 * Uses pattern matching + Grok for ambiguous cases.
 * Maintains an org_profiles table for dedup and CRM sync.
 */

import { config } from '../config';
import { getPool } from '../db';
import { getCachedProvider } from './api-provider';
import { fillMissingProgramOrgLinks } from './program-org-links';
import { DEFAULT_GROK_MODEL, chatCompletionExtras } from './grok';

// ============================================================
// Known org aliases → canonical name mapping
// ============================================================
const ORG_ALIASES: Record<string, string> = {
  'prezenti': 'Prezenti',
  'nebius': 'Nebius',
  'floss/fund': 'FLOSS/fund',
  'unitary foundation': 'Unitary Foundation',
  'funding the commons': 'Funding the Commons',
  'foresight institute': 'Foresight Institute',
  'bluedot impact': 'BlueDot Impact',
  'rust foundation': 'Rust Foundation',
  // Crypto
  'uniswap': 'Uniswap Foundation',
  'uniswap foundation': 'Uniswap Foundation',
  'colosseum': 'Colosseum',
  'gitcoin': 'Gitcoin',
  'gitcoin grants': 'Gitcoin',
  'arbitrum': 'Arbitrum Foundation',
  'arbitrum foundation': 'Arbitrum Foundation',
  'rocket pool': 'Rocket Pool',
  'rocket pool gmc': 'Rocket Pool',
  'rocket pool grants management committee': 'Rocket Pool',
  'optimism': 'Optimism Foundation',
  'op foundation': 'Optimism Foundation',
  'ethereum foundation': 'Ethereum Foundation',
  'ef': 'Ethereum Foundation',
  'esp': 'Ethereum Foundation',
  'filecoin': 'Filecoin Foundation',
  'filecoin foundation': 'Filecoin Foundation',
  'protocol labs': 'Protocol Labs',
  'web3 foundation': 'Web3 Foundation',
  'polkadot': 'Web3 Foundation',
  'near': 'NEAR Foundation',
  'near foundation': 'NEAR Foundation',
  'solana': 'Solana Foundation',
  'solana foundation': 'Solana Foundation',
  'avalanche': 'Avalanche Foundation',
  'avalanche foundation': 'Avalanche Foundation',
  'chainlink': 'Chainlink',
  'starknet': 'Starknet Foundation',
  'starknet foundation': 'Starknet Foundation',
  'base (coinbase)': 'Base (Coinbase)',
  'coinbase': 'Base (Coinbase)',
  'sui': 'Sui Foundation',
  'sui foundation': 'Sui Foundation',
  'aptos': 'Aptos Foundation',
  'aptos foundation': 'Aptos Foundation',
  'ton': 'TON Foundation',
  'ton foundation': 'TON Foundation',
  'cosmos': 'Interchain Foundation',
  'interchain': 'Interchain Foundation',
  'interchain foundation': 'Interchain Foundation',
  'aave': 'Aave',
  'compound': 'Compound',
  'makerdao': 'Sky (MakerDAO)',
  'sky': 'Sky (MakerDAO)',
  'ens': 'ENS',
  'ens foundation': 'ENS',

  // AI
  'openai': 'OpenAI',
  'anthropic': 'Anthropic',
  'google': 'Google',
  'google.org': 'Google.org',
  'google deepmind': 'Google DeepMind',
  'deepmind': 'Google DeepMind',
  'nvidia': 'NVIDIA',
  'meta': 'Meta',
  'microsoft': 'Microsoft',
  'mozilla': 'Mozilla Foundation',
  'mozilla foundation': 'Mozilla Foundation',
  'open phil': 'Open Philanthropy',
  'open philanthropy': 'Open Philanthropy',
  'schmidt sciences': 'Schmidt Sciences',
  'y combinator': 'Y Combinator',

  // OSS
  'linux foundation': 'Linux Foundation',
  'apache': 'Apache Software Foundation',
  'apache software foundation': 'Apache Software Foundation',
  'nlnet': 'NLnet Foundation',
  'nlnet foundation': 'NLnet Foundation',
  'sovereign tech': 'Sovereign Tech Agency',
  'sovereign tech agency': 'Sovereign Tech Agency',
  'r consortium': 'R Consortium',
  'nsf': 'National Science Foundation',
  'national science foundation': 'National Science Foundation',
  'aria': 'ARIA',
  'github': 'GitHub',
  'ecmwf': 'ECMWF',
};

// A title can start with a program run by a known organization. Prefer the
// most specific alias, so Google DeepMind never falls through to Google.
// Verified program owners apply to title extraction only. A program profile
// still fails automatic creation and selection. Sources: docs/org-identity.md.
const PROGRAM_OWNERS: Record<string, string> = {
  'pl research grant program': 'Protocol Labs',
  "colosseum crypto world's fair": 'Colosseum',
  "crypto world's fair": 'Colosseum',
  'bnb hack': 'BNB Chain',
  'acquia fair trade initiative': 'Acquia',
  'base batches': 'Base (Coinbase)',
  'base ecosystem fund': 'Base (Coinbase)',
};
const TITLE_ALIASES = Object.entries({ ...ORG_ALIASES, ...PROGRAM_OWNERS })
  .sort(([a], [b]) => b.length - a.length);

function titleKey(title: string): string {
  return title.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()
    .replace(/^\[([^\]]+)\](?=\s|$)/, '$1').toLowerCase();
}

function hasTitlePrefix(title: string, prefix: string): boolean {
  return title === prefix || (title.startsWith(prefix) && /^(?:[\s:—–]|-\s)/.test(title.slice(prefix.length)));
}

function isAmbiguousBaseName(name: string): boolean {
  return normalizeOrgName(name).toLowerCase() === 'base';
}

// Capitalization cannot distinguish Coinbase's Base from BASE Research.
// Unknown Base titles stay unresolved, including at the model and write gates.
function needsBaseIdentityReview(title: string): boolean {
  return hasTitlePrefix(titleKey(title), 'base') && knownOrgAtStart(title) === null;
}

function knownOrgAtStart(title: string): string | null {
  const lower = titleKey(title);
  for (const [alias, canonical] of TITLE_ALIASES) {
    if (hasTitlePrefix(lower, alias)) {
      return canonical;
    }
  }
  return null;
}

// ============================================================
// Prevention guards — reject bad candidates before they become orgs
// ============================================================

/**
 * Detect person names: "Firstname Lastname" or "Otto Kekäläinen (LF Advocate)"
 * Returns false for names containing known org suffixes.
 */
function looksLikePersonName(candidate: string): boolean {
  const ORG_SUFFIXES = /\b(foundation|labs?|inc|corp|dao|protocol|network|funds?|funding|philanthropy|ventures|capital|institute|consortium|alliance|council|agency|committee|group)\b/i;
  if (ORG_SUFFIXES.test(candidate)) return false;
  const PERSON = /^[A-Z][a-z\u00C0-\u00FF]+ (?:[A-Z]\. )?[A-Z][a-z\u00C0-\u00FF]+(?:\s*\(.*\))?$/;
  return PERSON.test(candidate);
}

/**
 * Detect event/program names: "Season 7 Nominations", "Official Launch", etc.
 */
function looksLikeEventOrProgram(candidate: string): boolean {
  const PATTERNS = [
    /\b(season|nominations?|launch|update|announcement|recap|roundup|cycle)\b/i,
    /\b(week|day|summit|conference)\s+\d/i,
    /^(official|introducing|presenting|announcing)\b/i,
    /\b20\d{2}\s+(fall|spring|winter|summer)\b/i,
    /\b(fall|spring|winter|summer)\s+20\d{2}\b/i,
  ];
  return PATTERNS.some(p => p.test(candidate));
}

/**
 * Detect junk org names: too short, all-caps abbreviations not in alias map.
 */
function isJunkOrgName(candidate: string): boolean {
  if (candidate.length <= 3) return true;
  if (candidate.length <= 4 && /^[A-Z\/]+$/.test(candidate) && !ORG_ALIASES[candidate.toLowerCase()]) return true;
  return false;
}

/** Entry titles previously stored as org names (not real organizations). */
const EXACT_NOISE_NAMES = new Set([
  'official launch',
  'season 7 nominations',
  'thrive polygon update',
  'stacks new grants program live',
  'opportunities for youth',
  'foresight ai nodes grants',
  'introducing @pl_genesis: frontiers of collaboration',
  'webfalainitiat1',
].map(n => n.toLowerCase()));

export type OrgNameKind = 'org' | 'noise' | 'program' | 'person' | 'event' | 'abbrev';

function isRetweetOrHandleNoise(candidate: string): boolean {
  if (/^\s*RT\b/i.test(candidate)) return true;
  if (/^\s*@[\w]{1,15}\s*$/i.test(candidate)) return true;
  return false;
}

function isLowerKebabSlug(candidate: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(candidate);
}

function looksLikeProgramOffering(candidate: string): boolean {
  return [
    /\bround\s+\d+\b/i,
    /\bfellowships?\b/i,
    /\bincubators?\b/i,
    /\b(grant|grants|bounty|developer)\s+programs?\b/i,
    /\bcompute grants\b/i,
    /\bmaintainer funding\b/i,
  ].some(p => p.test(candidate));
}

/** Explicit organization/committee names that resemble program labels.
 * Sources and the separate historical-cleanup contract: docs/org-identity.md. */
const PROGRAM_NAMED_ORGS = new Set([
  'united nations development programme', 'zcash community grants', 'ai grant',
]);

/** Conservative automatic-link guard. A rejected name needs identity review;
 * it is not permission to archive the existing profile or guess its parent. */
export function isProgramOrgName(name: string): boolean {
  const candidate = normalizeOrgName(name);
  if (PROGRAM_NAMED_ORGS.has(candidate.toLowerCase())) return false;
  return Object.keys(PROGRAM_OWNERS).some(program => hasTitlePrefix(titleKey(candidate), program)) ||
    looksLikeProgramOffering(candidate) ||
    /\b(program(?:me)?s?|scholarships?|microgrants?|grants?|awards?|cohorts?|hackathons?)\s*(?:20\d{2})?$/i.test(candidate) ||
    /\bbug bount(?:y|ies)\b/i.test(candidate) ||
    /\bgrants?\s+(?:are\s+)?open\b/i.test(candidate);
}

/**
 * Classify a candidate org-profile name. Used both to block new junk at
 * extract time and to decide which existing rows the CRM cleanup may archive.
 */
export function classifyOrgName(name: string): OrgNameKind {
  const candidate = (name || '').replace(/\s+/g, ' ').trim();
  if (!candidate) return 'noise';
  if (EXACT_NOISE_NAMES.has(candidate.toLowerCase())) return 'noise';
  const lower = candidate.toLowerCase();
  if (ORG_ALIASES[lower] || Object.values(ORG_ALIASES).some(v => v.toLowerCase() === lower)) {
    return 'org';
  }
  if (isRetweetOrHandleNoise(candidate)) return 'noise';
  if (/\s+today$/i.test(candidate)) return 'noise';
  if (isLowerKebabSlug(candidate)) return 'noise';
  if (looksLikePersonName(candidate)) return 'person';
  if (looksLikeEventOrProgram(candidate)) return 'event';
  if (looksLikeProgramOffering(candidate)) return 'program';
  if (isJunkOrgName(candidate)) return 'abbrev';
  return 'org';
}

export interface OrgArchiveFields {
  name: string;
  org_type?: string | null;
  website?: string | null;
  description?: string | null;
}

/**
 * Existing CRM rows we will archive: tweet/title noise, people, events, and
 * unenriched program-shaped names. Short abbreviations already in the CRM
 * (CRC, QIE) stay — they are not new junk, just terse names.
 */
export function shouldArchiveOrgProfile(org: OrgArchiveFields): boolean {
  const kind = classifyOrgName(org.name);
  if (kind === 'noise' || kind === 'event') return true;
  // Two-word Title Case names match the person heuristic (e.g. "Renaissance
  // Philanthropy", "Ethereum Mexico") — do not auto-archive those.
  if (kind === 'program') {
    const enriched = Boolean(org.org_type || org.website || org.description);
    return !enriched;
  }
  return false;
}

// ============================================================
// Exact identity matching against existing orgs
// ============================================================

/**
 * Ignore case and whitespace, preserving punctuation that can distinguish orgs.
 */
function normalizeForComparison(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Reuse a unique exact name or explicitly recorded alias. Related names are
 * insufficient evidence to link records. Ambiguity aborts the caller's link.
 */
export async function findSimilarOrg(candidateName: string): Promise<{ id: number; name: string } | null> {
  if (isAmbiguousBaseName(candidateName)) throw new Error('Ambiguous Base organization requires review');
  const pool = getPool();
  const { rows: orgs } = await pool.query(`SELECT id, name, aliases FROM org_profiles`);
  if (orgs.length === 0) return null;

  const normCandidate = normalizeForComparison(candidateName);
  if (!normCandidate) return null;
  const exact = orgs.filter(org => normalizeForComparison(org.name) === normCandidate);
  const canonical = normalizeForComparison(canonicalizeOrgName(candidateName));
  const matches = exact.length ? exact : orgs.filter(org =>
    normalizeForComparison(org.name) === canonical ||
    (org.aliases || []).some((alias: string) => normalizeForComparison(alias) === normCandidate)
  );
  if (matches.length > 1) throw new Error(`Ambiguous organization match for "${candidateName}"`);
  const match = matches[0];
  if (match && (isProgramOrgName(match.name) || isAmbiguousBaseName(match.name))) {
    throw new Error(`Organization profile requires review: "${match.name}"`);
  }
  return match ? { id: match.id, name: match.name } : null;
}

// ============================================================
// Pattern-based org extraction
// ============================================================

/**
 * Extract org name from an entry name using common patterns.
 * Returns the extracted org name or null if no pattern matches.
 * Applies prevention guards to reject persons, events, and junk.
 */
export function extractOrgFromName(entryName: string): string | null {
  const name = entryName.trim();
  if (needsBaseIdentityReview(name)) return null;
  const known = knownOrgAtStart(name);
  if (known) return known;

  // Pattern 1: "@handle: rest" (X post format) — strip the @
  const xHandle = name.match(/^@?(\w+):\s+/);
  // Don't use X handles as org names — too noisy

  // Pattern 2: "OrgName — Description" or "OrgName - Description" or "OrgName: Description"
  const separatorMatch = name.match(/^([^—\-–:]+?)\s*[—–]\s+/);
  if (separatorMatch) {
    const candidate = separatorMatch[1].trim();
    if (candidate.length >= 2 && candidate.length <= 60 && !candidate.match(/^\d/)) {
      const normalized = normalizeOrgName(candidate);
      if (passesGuards(normalized)) return normalized;
      return null;
    }
  }

  // Pattern 3: "OrgName: Description" (colon separator, but not X handle format)
  const colonMatch = name.match(/^([A-Z][^:]{1,40}):\s+/);
  if (colonMatch && !xHandle) {
    const candidate = colonMatch[1].trim();
    if (candidate.length >= 2 && candidate.length <= 40) {
      const normalized = normalizeOrgName(candidate);
      if (passesGuards(normalized)) return normalized;
      return null;
    }
  }

  return null;
}

/**
 * Run all prevention guards on a candidate org name.
 * Returns true if the candidate should be accepted.
 */
function passesGuards(candidate: string): boolean {
  return !isAmbiguousBaseName(candidate) && classifyOrgName(candidate) === 'org' && !isProgramOrgName(candidate);
}

/**
 * Normalize an org name — check aliases, clean up formatting.
 */
export function canonicalizeOrgName(raw: string): string {
  return normalizeOrgName(raw);
}

function normalizeOrgName(raw: string): string {
  const cleaned = raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/^[@#]/, '')
    .replace(/\s*@[a-zA-Z0-9_]+/g, '')
    .trim();

  // Check alias map
  const lower = cleaned.toLowerCase();
  if (ORG_ALIASES[lower]) return ORG_ALIASES[lower];

  return cleaned;
}

// ============================================================
// Batch extraction with Grok fallback
// ============================================================

interface OrgExtractionResult {
  entryId: number;
  orgName: string | null;
  confidence: 'high' | 'medium' | 'low';
  method: 'pattern' | 'alias' | 'grok';
}

/**
 * Extract org names from a batch of entries.
 * First tries pattern matching, then uses Grok for unresolved entries.
 */
export async function extractOrgsFromEntries(
  entries: Array<{ id: number; name: string; description: string; wire: string }>
): Promise<OrgExtractionResult[]> {
  const results: OrgExtractionResult[] = [];
  const needsGrok: typeof entries = [];

  // Phase 1: Pattern matching
  for (const entry of entries) {
    if (needsBaseIdentityReview(entry.name)) {
      results.push({ entryId: entry.id, orgName: null, confidence: 'low', method: 'pattern' });
      continue;
    }
    const org = extractOrgFromName(entry.name);
    if (org) {
      // Check if it came from alias map
      const isAlias = knownOrgAtStart(entry.name) !== null;
      results.push({
        entryId: entry.id,
        orgName: org,
        confidence: isAlias ? 'high' : 'medium',
        method: isAlias ? 'alias' : 'pattern',
      });
    } else {
      needsGrok.push(entry);
    }
  }

  // Phase 2: Grok batch extraction for unresolved (chunks of 20)
  if (needsGrok.length > 0 && getCachedProvider('grok')?.api_key) {
    const CHUNK_SIZE = 20;
    for (let i = 0; i < needsGrok.length; i += CHUNK_SIZE) {
      const chunk = needsGrok.slice(i, i + CHUNK_SIZE);
      try {
        const grokResults = await extractOrgsWithGrok(chunk);
        results.push(...grokResults);
      } catch (err) {
        console.error(`[OrgExtractor] Grok batch failed:`, err);
        // Fall back to null for this chunk
        for (const entry of chunk) {
          results.push({ entryId: entry.id, orgName: null, confidence: 'low', method: 'pattern' });
        }
      }

      // Rate limit
      if (i + CHUNK_SIZE < needsGrok.length) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  }

  return results;
}

/**
 * Use Grok to extract org names from a batch of entries.
 */
async function extractOrgsWithGrok(
  entries: Array<{ id: number; name: string; description: string }>
): Promise<OrgExtractionResult[]> {
  const entriesText = entries.map((e, i) =>
    `${i + 1}. [ID:${e.id}] "${e.name}" — ${(e.description || '').substring(0, 100)}`
  ).join('\n');

  const prompt = `Extract the primary organization or foundation name from each grant/funding entry below. Return ONLY a JSON array of objects with "id" (the entry ID number) and "org" (canonical organization name, or null if unclear).

Rules:
- Return the FUNDING ORGANIZATION, not the recipient or the name of its program, grant, award, fellowship, or bounty
- Use canonical names (e.g., "Gitcoin" not "Gitcoin Grants", "Ethereum Foundation" not "EF ESP")
- If the entry is from an X post by a random user sharing info about a grant, extract the org that RUNS the grant, not the poster
- If you can't determine the org with confidence, return null
- Remove Twitter/X handles from org names

Entries:
${entriesText}

Return ONLY valid JSON array, no explanation.`;

  const provider = getCachedProvider('grok');
  const apiKey = provider?.api_key;
  const baseUrl = provider?.base_url || config.apis.grok.baseUrl;
  const model = provider?.default_model || DEFAULT_GROK_MODEL;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4000,
      temperature: 0.1,
      ...chatCompletionExtras(baseUrl),
    }),
  });

  if (!response.ok) throw new Error(`Grok returned ${response.status}`);

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim() || '';

  // Parse JSON response
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return entries.map(e => ({ entryId: e.id, orgName: null, confidence: 'low' as const, method: 'grok' as const }));

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Array<{ id: number; org: string | null }>;
    // Only the entries in this request can receive a model result. An extra
    // result must not bypass an identity review excluded from the request.
    return parsed.filter(p => entries.some(entry => entry.id === p.id)).map(p => {
      const orgName = p.org ? normalizeOrgName(p.org) : null;
      const accepted = orgName && passesGuards(orgName) ? orgName : null;
      return {
        entryId: p.id,
        orgName: accepted,
        confidence: accepted ? 'medium' as const : 'low' as const,
        method: 'grok' as const,
      };
    });
  } catch {
    return entries.map(e => ({ entryId: e.id, orgName: null, confidence: 'low' as const, method: 'grok' as const }));
  }
}

// ============================================================
// Database operations
// ============================================================

/**
 * Ensure org_profiles table exists.
 */
export async function ensureOrgProfilesTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_profiles (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      description TEXT,
      website TEXT,
      wires TEXT[] DEFAULT '{}',
      entry_count INTEGER DEFAULT 0,
      total_funding TEXT,
      tags TEXT[] DEFAULT '{}',
      first_seen DATE,
      last_seen DATE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Add new enrichment columns
  await pool.query(`ALTER TABLE org_profiles ADD COLUMN IF NOT EXISTS twitter TEXT`);
  await pool.query(`ALTER TABLE org_profiles ADD COLUMN IF NOT EXISTS org_type TEXT`);
  await pool.query(`ALTER TABLE org_profiles ADD COLUMN IF NOT EXISTS source_type TEXT`);
  await pool.query(`ALTER TABLE org_profiles ADD COLUMN IF NOT EXISTS tier TEXT`);
  await pool.query(`ALTER TABLE org_profiles ADD COLUMN IF NOT EXISTS avg_quality_score NUMERIC(5,1)`);
  await pool.query(`ALTER TABLE org_profiles ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ`);

  await pool.query(`ALTER TABLE org_profiles ADD COLUMN IF NOT EXISTS github_url TEXT`);

  // Columns written by org-enricher / contact-discovery — MUST exist on a
  // fresh DB or every enrichment UPDATE breaks (the ensure*-drift pattern):
  await pool.query(`ALTER TABLE org_profiles ADD COLUMN IF NOT EXISTS relationship_context TEXT`);
  await pool.query(`ALTER TABLE org_profiles ADD COLUMN IF NOT EXISTS operator_read TEXT`);
  await pool.query(`ALTER TABLE org_profiles ADD COLUMN IF NOT EXISTS last_signal TEXT`);
  await pool.query(`ALTER TABLE org_profiles ADD COLUMN IF NOT EXISTS contacts_checked_at TIMESTAMPTZ`);

  // Dedup & intelligence columns
  await pool.query(`ALTER TABLE org_profiles ADD COLUMN IF NOT EXISTS parent_org_id INTEGER REFERENCES org_profiles(id)`);
  await pool.query(`ALTER TABLE org_profiles ADD COLUMN IF NOT EXISTS aliases TEXT[] DEFAULT '{}'`);

  // Add org_id to scan_entries if not exists
  try {
    await pool.query(`ALTER TABLE scan_entries ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES org_profiles(id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_scan_entries_org ON scan_entries(org_id)`);
  } catch (err) {
    // Column might already exist
  }

  console.log('[OrgExtractor] org_profiles table ensured');
}

/**
 * Generate a URL-safe slug from an org name.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 80);
}

/**
 * Upsert profile metadata. Counts come from actual linked entries in the DB.
 */
export async function upsertOrgProfile(
  orgName: string,
  wire: string,
  scanDate?: string
): Promise<number> {
  const pool = getPool();
  orgName = normalizeOrgName(orgName);
  if (!passesGuards(orgName)) throw new Error(`Organization name requires review: "${orgName}"`);
  const slug = slugify(orgName);
  const date = scanDate || new Date().toISOString().split('T')[0];

  const result = await pool.query(`
    INSERT INTO org_profiles (name, slug, wires, first_seen, last_seen)
    VALUES ($1, $2, ARRAY[$3], $4::date, $4::date)
    ON CONFLICT (name) DO UPDATE SET
      wires = (SELECT ARRAY(SELECT DISTINCT unnest(org_profiles.wires || ARRAY[$3]))),
      last_seen = GREATEST(org_profiles.last_seen, $4::date),
      updated_at = NOW()
    RETURNING id
  `, [orgName, slug, wire, date]);

  return result.rows[0].id;
}

/**
 * Automatically fill an unlinked, unheld entry with an organization profile.
 * Returns false when the entry no longer needs an automatic association.
 */
export async function linkEntryToOrg(entryId: number, orgId: number): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // Re-read after locking: extraction may finish after an operator resolves
    // the entry or places it on hold. Automatic linking never overrides either.
    const { rows: entries } = await client.query(
      `SELECT name, org_id,
         (concat_ws(' ', operator_notes, action_reason) ~* '\\mhold\\M|human review required'
          OR metadata #>> '{decided_recheck,canonical_parent_blocked}' = 'true'
          OR metadata #>> '{decided_recheck,cross_wire_blocked}' = 'true') AS held
       FROM scan_entries WHERE id = $1 FOR UPDATE`, [entryId],
    );
    if (!entries.length || entries[0].org_id != null || entries[0].held) {
      await client.query('COMMIT');
      return false;
    }
    if (needsBaseIdentityReview(entries[0].name || '')) {
      throw new Error(`Entry ${entryId} requires Base identity review`);
    }
    const { rows: orgs } = await client.query(
      'SELECT name FROM org_profiles WHERE id = $1 FOR NO KEY UPDATE', [orgId],
    );
    if (!orgs.length || isProgramOrgName(orgs[0].name) || isAmbiguousBaseName(orgs[0].name)) {
      throw new Error(`Organization profile ${orgId} requires identity review`);
    }
    const { rows } = await client.query(
      `UPDATE scan_entries SET org_id = $1 WHERE id = $2 RETURNING program_id`, [orgId, entryId],
    );
    const programId = rows[0]?.program_id;
    if (programId != null) {
      await client.query('SELECT id FROM programs WHERE id = $1 FOR UPDATE', [programId]);
      await fillMissingProgramOrgLinks(client, [programId]);
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run full org extraction on all unlinked entries.
 */
export async function runOrgExtraction(): Promise<{
  processed: number;
  linked: number;
  newOrgs: number;
  errors: number;
}> {
  const pool = getPool();
  const stats = { processed: 0, linked: 0, newOrgs: 0, errors: 0 };

  // Get unlinked entries
  const { rows: entries } = await pool.query(`
    SELECT id, name, description, wire, scan_date
    FROM scan_entries
    WHERE org_id IS NULL
      AND status IN ('queued', 'approved', 'enriched')
    ORDER BY id DESC
    LIMIT 500
  `);

  if (entries.length === 0) {
    console.log('[OrgExtractor] No unlinked entries to process');
    return stats;
  }

  console.log(`[OrgExtractor] Processing ${entries.length} unlinked entries`);

  // Extract orgs
  const extractions = await extractOrgsFromEntries(entries);
  stats.processed = entries.length;

  for (const extraction of extractions) {
    if (!extraction.orgName) continue;

    try {
      const entry = entries.find(e => e.id === extraction.entryId);
      if (!entry) continue;

      // Use the same ambiguity checks as approval-time linking.
      const existingId = (await findSimilarOrg(extraction.orgName))?.id;
      let orgId: number;

      if (existingId) {
        // Update existing org
        orgId = existingId;
        await pool.query(`
          UPDATE org_profiles SET
            wires = (SELECT ARRAY(SELECT DISTINCT unnest(wires || ARRAY[$1]))),
            last_seen = GREATEST(last_seen, $2::date),
            updated_at = NOW()
          WHERE id = $3
        `, [entry.wire, entry.scan_date, orgId]);
      } else {
        // Create new org
        orgId = await upsertOrgProfile(extraction.orgName, entry.wire, entry.scan_date);
        stats.newOrgs++;
      }

      // Link entry
      if (await linkEntryToOrg(extraction.entryId, orgId)) stats.linked++;
    } catch (err) {
      console.error(`[OrgExtractor] Failed to process entry ${extraction.entryId}:`, err);
      stats.errors++;
    }
  }

  console.log(`[OrgExtractor] Done: ${stats.linked} linked, ${stats.newOrgs} new orgs, ${stats.errors} errors`);
  return stats;
}

// ============================================================
// Query functions
// ============================================================

export async function getOrgProfiles(opts?: {
  wire?: string;
  limit?: number;
  offset?: number;
  search?: string;
}): Promise<{ orgs: any[]; total: number }> {
  const pool = getPool();
  const conditions: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (opts?.wire) {
    conditions.push(`$${paramIndex++} = ANY(wires)`);
    values.push(opts.wire);
  }
  if (opts?.search) {
    conditions.push(`name ILIKE $${paramIndex++}`);
    values.push(`%${opts.search}%`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts?.limit || 50;
  const offset = opts?.offset || 0;

  const [dataRes, countRes] = await Promise.all([
    pool.query(
      `SELECT * FROM org_profiles ${whereClause} ORDER BY entry_count DESC, last_seen DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values, limit, offset]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM org_profiles ${whereClause}`,
      values
    ),
  ]);

  return { orgs: dataRes.rows, total: countRes.rows[0].total };
}

export async function getOrgById(orgId: number): Promise<any | null> {
  const pool = getPool();
  const { rows } = await pool.query(`SELECT * FROM org_profiles WHERE id = $1`, [orgId]);
  return rows[0] || null;
}

export async function getEntriesByOrg(orgId: number, limit = 50): Promise<any[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, name, wire, status, quality_score, amount, deadline, source_url, created_at
     FROM scan_entries WHERE org_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [orgId, limit]
  );
  return rows;
}
