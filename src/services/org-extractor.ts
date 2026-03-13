/**
 * Organization Extractor
 *
 * Extracts canonical organization names from scan_entry names/descriptions.
 * Uses pattern matching + Grok for ambiguous cases.
 * Maintains an org_profiles table for dedup and CRM sync.
 */

import { config } from '../config';
import { getPool } from '../db';

// ============================================================
// Known org aliases → canonical name mapping
// ============================================================
const ORG_ALIASES: Record<string, string> = {
  // Crypto
  'uniswap': 'Uniswap Foundation',
  'uniswap foundation': 'Uniswap Foundation',
  'gitcoin': 'Gitcoin',
  'gitcoin grants': 'Gitcoin',
  'arbitrum': 'Arbitrum Foundation',
  'arbitrum foundation': 'Arbitrum Foundation',
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
  'base': 'Base (Coinbase)',
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

// ============================================================
// Pattern-based org extraction
// ============================================================

/**
 * Extract org name from an entry name using common patterns.
 * Returns the extracted org name or null if no pattern matches.
 */
export function extractOrgFromName(entryName: string): string | null {
  const name = entryName.trim();

  // Pattern 1: "@handle: rest" (X post format) — strip the @
  const xHandle = name.match(/^@?(\w+):\s+/);
  // Don't use X handles as org names — too noisy

  // Pattern 2: "OrgName — Description" or "OrgName - Description" or "OrgName: Description"
  const separatorMatch = name.match(/^([^—\-–:]+?)\s*[—–]\s+/);
  if (separatorMatch) {
    const candidate = separatorMatch[1].trim();
    if (candidate.length >= 2 && candidate.length <= 60 && !candidate.match(/^\d/)) {
      return normalizeOrgName(candidate);
    }
  }

  // Pattern 3: "OrgName: Description" (colon separator, but not X handle format)
  const colonMatch = name.match(/^([A-Z][^:]{1,40}):\s+/);
  if (colonMatch && !xHandle) {
    const candidate = colonMatch[1].trim();
    if (candidate.length >= 2 && candidate.length <= 40) {
      return normalizeOrgName(candidate);
    }
  }

  // Pattern 4: Check if the entry name starts with a known org
  const lowerName = name.toLowerCase();
  for (const [alias, canonical] of Object.entries(ORG_ALIASES)) {
    if (lowerName.startsWith(alias + ' ') || lowerName.startsWith(alias + ':') ||
        lowerName.startsWith(alias + ' —') || lowerName === alias) {
      return canonical;
    }
  }

  return null;
}

/**
 * Normalize an org name — check aliases, clean up formatting.
 */
function normalizeOrgName(raw: string): string {
  const cleaned = raw
    .replace(/\s+/g, ' ')
    .replace(/^[@#]/, '')
    .trim();

  // Check alias map
  const lower = cleaned.toLowerCase();
  if (ORG_ALIASES[lower]) return ORG_ALIASES[lower];

  // Check partial matches
  for (const [alias, canonical] of Object.entries(ORG_ALIASES)) {
    if (lower.includes(alias) && alias.length > 3) return canonical;
  }

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
    const org = extractOrgFromName(entry.name);
    if (org) {
      // Check if it came from alias map
      const lower = entry.name.toLowerCase();
      const isAlias = Object.keys(ORG_ALIASES).some(a => lower.includes(a));
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
  if (needsGrok.length > 0 && config.apis.grok.apiKey) {
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
- Return the FUNDING ORGANIZATION, not the recipient
- Use canonical names (e.g., "Gitcoin" not "Gitcoin Grants", "Ethereum Foundation" not "EF ESP")
- If the entry is from an X post by a random user sharing info about a grant, extract the org that RUNS the grant, not the poster
- If you can't determine the org with confidence, return null
- Remove Twitter/X handles from org names

Entries:
${entriesText}

Return ONLY valid JSON array, no explanation.`;

  const response = await fetch(`${config.apis.grok.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apis.grok.apiKey}`,
    },
    body: JSON.stringify({
      model: 'grok-4.20-beta-0309-non-reasoning',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1000,
      temperature: 0.1,
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
    return parsed.map(p => ({
      entryId: p.id,
      orgName: p.org ? normalizeOrgName(p.org) : null,
      confidence: p.org ? 'medium' as const : 'low' as const,
      method: 'grok' as const,
    }));
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
 * Upsert an org profile — creates if new, updates counts if existing.
 */
export async function upsertOrgProfile(
  orgName: string,
  wire: string,
  scanDate?: string
): Promise<number> {
  const pool = getPool();
  const slug = slugify(orgName);
  const date = scanDate || new Date().toISOString().split('T')[0];

  const result = await pool.query(`
    INSERT INTO org_profiles (name, slug, wires, first_seen, last_seen, entry_count)
    VALUES ($1, $2, ARRAY[$3], $4::date, $4::date, 1)
    ON CONFLICT (name) DO UPDATE SET
      wires = (SELECT ARRAY(SELECT DISTINCT unnest(org_profiles.wires || ARRAY[$3]))),
      last_seen = GREATEST(org_profiles.last_seen, $4::date),
      entry_count = org_profiles.entry_count + 1,
      updated_at = NOW()
    RETURNING id
  `, [orgName, slug, wire, date]);

  return result.rows[0].id;
}

/**
 * Link a scan_entry to an org profile.
 */
export async function linkEntryToOrg(entryId: number, orgId: number): Promise<void> {
  const pool = getPool();
  await pool.query(`UPDATE scan_entries SET org_id = $1 WHERE id = $2`, [orgId, entryId]);
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

  // Ensure table exists
  await ensureOrgProfilesTable();

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

  // Check which orgs already exist
  const { rows: existingOrgs } = await pool.query(`SELECT id, name FROM org_profiles`);
  const orgMap = new Map(existingOrgs.map(o => [o.name.toLowerCase(), o.id]));

  for (const extraction of extractions) {
    if (!extraction.orgName) continue;

    try {
      const entry = entries.find(e => e.id === extraction.entryId);
      if (!entry) continue;

      // Check if org exists
      const existingId = orgMap.get(extraction.orgName.toLowerCase());
      let orgId: number;

      if (existingId) {
        // Update existing org
        orgId = existingId;
        await pool.query(`
          UPDATE org_profiles SET
            wires = (SELECT ARRAY(SELECT DISTINCT unnest(wires || ARRAY[$1]))),
            last_seen = GREATEST(last_seen, $2::date),
            entry_count = entry_count + 1,
            updated_at = NOW()
          WHERE id = $3
        `, [entry.wire, entry.scan_date, orgId]);
      } else {
        // Create new org
        orgId = await upsertOrgProfile(extraction.orgName, entry.wire, entry.scan_date);
        orgMap.set(extraction.orgName.toLowerCase(), orgId);
        stats.newOrgs++;
      }

      // Link entry
      await linkEntryToOrg(extraction.entryId, orgId);
      stats.linked++;
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
