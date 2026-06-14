import type { Pool } from 'pg';
import { notionRequest, getIntegrationConfigs, queryAllNotionPages } from './notion-sync';
import { getCachedProvider } from './api-provider';
import { config } from '../config';
import { logApiUsage } from './api-usage';

const DEFAULT_CONTACTS_DB_ID = '66190528a1194cdc85797763d67c5a71';
const DEFAULT_ORGS_DB_ID = '301000c0-d590-81c4-8435-c6db7782db12';

// Model that supports the web_search tool via the Responses API (mirrors org-enricher.ts)
const DISCOVER_MODEL = 'grok-4.20-beta-0309-non-reasoning';

// ============================================================
// Responses API types (mirrors org-enricher.ts)
// ============================================================

interface ResponsesAPIOutput {
  type: string;
  content?: Array<{ type: string; text?: string }>;
}
interface ResponsesAPIResponse {
  output: ResponsesAPIOutput[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function normName(n: string): string { return (n || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

export async function ensureDiscoveredContactsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discovered_contacts (
      id SERIAL PRIMARY KEY,
      org_id INTEGER NOT NULL REFERENCES org_profiles(id) ON DELETE CASCADE,
      name_norm TEXT NOT NULL,
      name TEXT NOT NULL,
      x_handle TEXT,
      notion_page_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (org_id, name_norm)
    )`);
}

export async function recordDiscoveredContact(
  pool: Pool, c: { orgId: number; name: string; xHandle: string | null; notionPageId: string | null },
): Promise<void> {
  await pool.query(
    `INSERT INTO discovered_contacts (org_id, name_norm, name, x_handle, notion_page_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id, name_norm) DO UPDATE SET notion_page_id = COALESCE(EXCLUDED.notion_page_id, discovered_contacts.notion_page_id)`,
    [c.orgId, normName(c.name), c.name, c.xHandle, c.notionPageId],
  );
}

export interface ContactCandidate {
  name: string;
  role: string | null;
  x_handle: string | null;
  profile_url: string | null;
  source: string | null;
  is_bot?: boolean;
}

/** Pseudonyms/handles and independent (org-less) individuals are valid (owner decision).
 *  Require a stable identifier (name OR handle), a descriptor (org role OR independent
 *  capacity), a reachable profile (X handle OR profile URL), and a backing source.
 *  Reject empty/unidentifiable and pure engagement-farm/bot accounts. */
export function passesContactBar(c: ContactCandidate): boolean {
  const name = (c.name || '').trim();
  if (!name) return false;
  if (!c.role || !c.role.trim()) return false;
  if (!c.source || !/^https?:\/\//.test(c.source)) return false;
  const hasHandle = !!(c.x_handle && c.x_handle.trim());
  const hasProfile = !!(c.profile_url && /^https?:\/\//.test(c.profile_url));
  if (!(hasHandle || hasProfile)) return false;
  if (c.is_bot === true) return false;
  return true;
}

/**
 * Build a Notion properties object for a contact page in the Contacts DB.
 * Always sets Status=Needs Review and Source=Discovered.
 * Omits X when no handle, Org when no orgPageId.
 */
export function buildContactProperties(
  c: { name: string; role: string | null; x_handle: string | null; evidence: string | null; wire: string | null; program: string | null },
  orgPageId: string | null,
): Record<string, any> {
  const props: Record<string, any> = {
    Name: { title: [{ text: { content: c.name } }] },
    Status: { select: { name: 'Needs Review' } },
    Source: { select: { name: 'Discovered' } },
  };
  if (c.x_handle) props['X'] = { url: `https://x.com/${c.x_handle.replace(/^@/, '')}` };
  if (c.role) props['Role'] = { rich_text: [{ text: { content: c.role.slice(0, 1900) } }] };
  if (c.program) props['Program'] = { rich_text: [{ text: { content: c.program.slice(0, 1900) } }] };
  if (c.evidence) props['Evidence'] = { rich_text: [{ text: { content: c.evidence.slice(0, 1900) } }] };
  if (c.wire) props['Wire'] = { select: { name: c.wire } };
  if (orgPageId) props['Org'] = { relation: [{ id: orgPageId }] };
  return props;
}

// ============================================================
// Notion page type (local alias matching notion-sync internal shape)
// ============================================================

interface NotionPage {
  id: string;
  properties: Record<string, any>;
}

interface CreateContactDeps {
  pool: Pool;
  token: string;
  contactsDbId?: string;
  orgsDbId?: string;
  existingContacts?: NotionPage[];
  orgPages?: NotionPage[];
}

interface CreateContactCandidate {
  name: string;
  role: string | null;
  x_handle: string | null;
  profile_url: string | null;
  evidence: string | null;
  wire: string | null;
  program: string | null;
  source: string | null;
}

/**
 * Create a contact in the Notion Contacts DB, with dedup against both Notion and
 * the local discovered_contacts table.
 *
 * Dedup logic:
 *   1. Check Contacts DB for an existing page by Name (title match) or X url match.
 *      Uses pre-loaded existingContacts if provided; otherwise queries Notion.
 *   2. If orgName provided, also check discovered_contacts by org_id + name_norm.
 *   3. If any match found, return { created: false, reason: 'exists' }.
 *   4. Otherwise create the page and record in discovered_contacts.
 *
 * Org page lookup uses pre-loaded orgPages if provided; otherwise queries Notion.
 */
export async function createNotionContact(
  deps: CreateContactDeps,
  candidate: CreateContactCandidate,
  orgName?: string,
): Promise<{ created: boolean; pageId?: string; reason?: string }> {
  const { pool, token } = deps;
  const contactsDbId = deps.contactsDbId ?? DEFAULT_CONTACTS_DB_ID;
  const orgsDbId = deps.orgsDbId ?? DEFAULT_ORGS_DB_ID;

  // --- Dedup: check Notion Contacts DB ---
  // Use pre-loaded pages if provided (batch mode); otherwise query Notion (back-compat)
  const existingPages = deps.existingContacts ?? await queryAllNotionPages(token, contactsDbId);
  const nameLower = normName(candidate.name);
  const handleUrl = candidate.x_handle
    ? `https://x.com/${candidate.x_handle.replace(/^@/, '')}`
    : null;

  for (const page of existingPages) {
    // Check title match
    const nameProp = page.properties['Name'] || page.properties['name'] || page.properties['Title'];
    if (nameProp?.title) {
      const pageNameLower = normName((nameProp.title as any[]).map((t: any) => t.plain_text).join(''));
      if (pageNameLower === nameLower) return { created: false, reason: 'exists' };
    }
    // Check X url match
    if (handleUrl) {
      const xProp = page.properties['X'] || page.properties['Twitter'];
      if (xProp?.url && xProp.url === handleUrl) return { created: false, reason: 'exists' };
    }
  }

  // --- Dedup: check local discovered_contacts ---
  let orgId: number | null = null;
  if (orgName) {
    const { rows } = await pool.query(
      `SELECT org_id FROM discovered_contacts WHERE name_norm = $1 AND org_id IN (SELECT id FROM org_profiles WHERE name = $2) LIMIT 1`,
      [normName(candidate.name), orgName],
    );
    if (rows.length > 0) return { created: false, reason: 'exists' };

    // Resolve org_id for later use
    const { rows: orgRows } = await pool.query(
      `SELECT id FROM org_profiles WHERE name = $1 LIMIT 1`,
      [orgName],
    );
    if (orgRows.length > 0) orgId = orgRows[0].id as number;
  }

  // --- Resolve org Notion page id (for the Org relation property) ---
  let orgPageId: string | null = null;
  if (orgName) {
    // Use pre-loaded pages if provided; otherwise query Notion (back-compat)
    const orgPageList = deps.orgPages ?? await queryAllNotionPages(token, orgsDbId);
    const orgNameNorm = normName(orgName);
    for (const page of orgPageList) {
      const nameProp = page.properties['Name'] || page.properties['name'] || page.properties['Title'];
      if (nameProp?.title) {
        const pageNameNorm = normName((nameProp.title as any[]).map((t: any) => t.plain_text).join(''));
        if (pageNameNorm === orgNameNorm) {
          orgPageId = page.id;
          break;
        }
      }
    }
  }

  // --- Create the Contacts page ---
  const properties = buildContactProperties(
    {
      name: candidate.name,
      role: candidate.role,
      x_handle: candidate.x_handle,
      evidence: candidate.evidence,
      wire: candidate.wire,
      program: candidate.program,
    },
    orgPageId,
  );

  try {
    const created = await notionRequest('POST', '/pages', token, { parent: { database_id: contactsDbId }, properties });
    if (orgId !== null) {
      await recordDiscoveredContact(pool, { orgId, name: candidate.name, xHandle: candidate.x_handle ?? null, notionPageId: created.id });
    }
    return { created: true, pageId: created.id };
  } catch (err: any) {
    console.error(`[ContactDiscovery] create failed for "${candidate.name}": ${err?.message || err}`);
    return { created: false, reason: 'error' };
  }
}

// ============================================================
// Grok web_search helper (mirrors org-enricher.ts Responses API pattern)
// ============================================================

/**
 * Call Grok Responses API with web_search tool enabled.
 * Returns the extracted output text. Throws on HTTP errors.
 * Mirrors the exact request shape used by enrichOrgs in org-enricher.ts:
 *   endpoint: /v1/responses
 *   tools:    [{ type: 'web_search' }]
 *   body:     { model, input: [{role:'user', content: prompt}], tools }
 *   extract:  output[].type==='message' → content[].type==='output_text' → .text
 */
export async function grokWebSearch(prompt: string): Promise<string> {
  const provider = getCachedProvider('grok');
  const apiKey = provider?.api_key || config.apis.grok.apiKey;
  if (!apiKey) throw new Error('[ContactDiscovery] No Grok API key available');

  // Strip trailing /v1 to build the Responses API URL (mirrors org-enricher.ts line 147)
  const baseUrl = (provider?.base_url || config.apis.grok.baseUrl).replace(/\/v1$/, '');
  const model = provider?.default_model || DISCOVER_MODEL;

  const start = Date.now();

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      signal: AbortSignal.timeout(180_000),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search' }],
      }),
    });
  } catch (err) {
    logApiUsage({ provider: 'grok', model, purpose: 'contact-discovery', duration_ms: Date.now() - start, success: false, error_message: String(err) });
    throw err;
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown');
    logApiUsage({ provider: 'grok', model, purpose: 'contact-discovery', duration_ms: Date.now() - start, success: false, error_message: `${response.status}` });
    throw new Error(`Grok returned ${response.status}: ${errorText}`);
  }

  const data = await response.json() as ResponsesAPIResponse;

  // Extract text from Responses API output (mirrors org-enricher.ts lines 209-217)
  let content = '';
  for (const item of data.output || []) {
    if (item.type === 'message' && item.content) {
      for (const block of item.content) {
        if (block.type === 'output_text' && block.text) {
          content += block.text;
        }
      }
    }
  }

  logApiUsage({
    provider: 'grok', model, purpose: 'contact-discovery', duration_ms: Date.now() - start,
    tokens_in: data.usage?.input_tokens, tokens_out: data.usage?.output_tokens,
  });

  return content;
}

// ============================================================
// Pure parser (exported for unit testing)
// ============================================================

/**
 * Extract a JSON array of contact candidates from Grok response text.
 * Strips markdown fences. Returns [] on any parse failure.
 * Coerces fields to ContactCandidate types (string|null, is_bot bool).
 */
export function parseContactsResponse(text: string): ContactCandidate[] {
  // Strip markdown code fences (mirrors parseEnrichmentResponse in org-enricher.ts)
  const stripped = text.replace(/^```[\w]*\n?/m, '').replace(/\n?```$/m, '').trim();

  // Extract JSON array
  const arrayMatch = stripped.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return [];

  let parsed: unknown[];
  try {
    const result = JSON.parse(arrayMatch[0]);
    if (!Array.isArray(result)) return [];
    parsed = result;
  } catch {
    return [];
  }

  return parsed.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const o = item as Record<string, unknown>;

    const str = (v: unknown): string | null =>
      typeof v === 'string' && v.trim() ? v.trim() : null;

    const name = str(o['name']);
    if (!name) return [];

    return [{
      name,
      role: str(o['role']),
      x_handle: str(o['x_handle']),
      profile_url: str(o['profile_url']),
      source: str(o['source']),
      is_bot: o['is_bot'] === true,
    }];
  });
}

// ============================================================
// Discovery functions
// ============================================================

/**
 * Discover up to 3 key contacts at an org via Grok web_search.
 * Returns parsed, gate-filtered ContactCandidates.
 */
export async function discoverContactsForOrg(
  org: { id: number; name: string; website?: string | null },
  grokCall: (prompt: string) => Promise<string> = grokWebSearch,
): Promise<ContactCandidate[]> {
  const websiteHint = org.website ? ` (website: ${org.website})` : '';
  const prompt = `You are researching key people at an organization for a grant/funding intelligence CRM.

Organization: "${org.name}"${websiteHint}

Search the web and return a JSON array of up to 3 key individuals at this organization. Focus on:
- The founder or CEO
- The head of grants, ecosystem, or developer relations (if they run a grant program)
- Any other notable lead (CTO, prominent contributor, etc.)

Return ONLY a JSON array with this exact shape. No explanation, no markdown fences.
[
  {
    "name": "Full Name or pseudonym/handle",
    "role": "their role or capacity at the org",
    "x_handle": "twitter/X handle without @ (or null if not found)",
    "profile_url": "a URL to their profile, GitHub, LinkedIn, or personal site (must start with https://)",
    "source": "the URL you found this information at (must start with https://)",
    "is_bot": false
  }
]

Rules:
- Only include real, verifiable individuals
- Set is_bot to true if the account is clearly a bot or engagement farm
- Use null (not empty string) for missing fields
- source must be a real URL you found; do not guess`;

  let text: string;
  try {
    text = await grokCall(prompt);
  } catch (err) {
    console.error(`[ContactDiscovery] Grok call failed for org "${org.name}":`, err);
    return [];
  }

  const candidates = parseContactsResponse(text);
  return candidates.filter(passesContactBar);
}

/**
 * Discover notable individuals from recent AI/crypto/OSS content via Grok web_search.
 * Surfaces independent researchers, pseudonymous builders, OSS authors.
 * These are org-less; orgName will be undefined when creating them.
 */
export async function discoverContactsFromContent(
  grokCall: (prompt: string) => Promise<string> = grokWebSearch,
): Promise<ContactCandidate[]> {
  const prompt = `You are surfacing notable individuals for a grant/funding intelligence CRM focused on AI, crypto, and open-source software.

Search recent news, GitHub, and social media for INDIVIDUALS (not organizations) who are prominent in:
- AI/ML research or independent model development
- Crypto/DeFi/Web3 building or protocol work
- OSS grant recipients, repo authors, or notable contributors

Return a JSON array of up to 5 individuals. Focus on independent builders, pseudonymous developers, and researchers — people who might be missed by org-anchored searches.

Return ONLY a JSON array with this exact shape. No explanation, no markdown fences.
[
  {
    "name": "Full Name or pseudonym/handle",
    "role": "their independent capacity (e.g. 'independent AI researcher', 'OSS maintainer - ratatui', 'protocol developer')",
    "x_handle": "twitter/X handle without @ (or null if not found)",
    "profile_url": "a URL to their profile, GitHub, or personal site (must start with https://)",
    "source": "the URL where you found this person (must start with https://)",
    "is_bot": false
  }
]

Rules:
- Only include real, verifiable individuals
- Set is_bot to true if the account is clearly a bot or engagement farm
- Use null (not empty string) for missing fields
- source must be a real URL you found; do not guess
- Prefer individuals who are actively building, shipping, or publishing`;

  let text: string;
  try {
    text = await grokCall(prompt);
  } catch (err) {
    console.error('[ContactDiscovery] Grok call failed for content-anchored discovery:', err);
    return [];
  }

  const candidates = parseContactsResponse(text);
  return candidates.filter(passesContactBar);
}

// ============================================================
// Runner
// ============================================================

/**
 * Run contact discovery: org-anchored (top N qualifying orgs) + content-anchored (once).
 * Loads Notion pages once per run and passes them to createNotionContact for in-memory dedup.
 */
export async function runContactDiscovery(
  pool: Pool,
  opts?: { limit?: number },
): Promise<{ orgsProcessed: number; contactsCreated: number; skipped: number; errors: number }> {
  const stats = { orgsProcessed: 0, contactsCreated: 0, skipped: 0, errors: 0 };
  const limit = opts?.limit ?? 20;

  // Step 1: ensure table
  await ensureDiscoveredContactsTable(pool);

  // Step 2: resolve SimpleCRM Notion integration
  const integrations = await getIntegrationConfigs('notion');
  const crm = integrations.find((i) => i.name === 'SimpleCRM - Notion' && i.enabled);
  if (!crm) {
    console.warn('[ContactDiscovery] SimpleCRM - Notion integration not found or disabled — skipping');
    return stats;
  }

  const token = crm.config.notion_token;
  const contactsDbId = crm.config.contacts_database_id || DEFAULT_CONTACTS_DB_ID;
  const orgsDbId = crm.config.database_id || DEFAULT_ORGS_DB_ID;

  if (!token) {
    console.warn('[ContactDiscovery] No notion_token in SimpleCRM config — skipping');
    return stats;
  }

  // Step 3: load existing Contacts and Orgs pages ONCE (avoid per-contact full DB scan)
  const existingContacts = await queryAllNotionPages(token, contactsDbId);
  const orgPages = await queryAllNotionPages(token, orgsDbId);

  const deps = { pool, token, contactsDbId, orgsDbId, existingContacts, orgPages };

  // Step 4: org-anchored discovery
  // Select qualifying orgs ordered by signal volume (scan_entries + digest_item_orgs)
  const { rows: orgs } = await pool.query(
    `SELECT id, name, website FROM org_profiles
     WHERE website IS NOT NULL
       AND id NOT IN (SELECT org_id FROM discovered_contacts)
     ORDER BY (
       (SELECT count(*) FROM scan_entries WHERE org_id = org_profiles.id)
       + (SELECT count(*) FROM digest_item_orgs WHERE org_id = org_profiles.id)
     ) DESC
     LIMIT $1`,
    [limit],
  );

  for (const org of orgs) {
    try {
      stats.orgsProcessed++;
      const candidates = await discoverContactsForOrg(org);
      for (const candidate of candidates) {
        try {
          const result = await createNotionContact(
            deps,
            {
              name: candidate.name,
              role: candidate.role,
              x_handle: candidate.x_handle,
              profile_url: candidate.profile_url,
              evidence: candidate.source,
              wire: null,
              program: null,
              source: candidate.source,
            },
            org.name,
          );
          if (result.created) {
            stats.contactsCreated++;
          } else if (result.reason === 'exists') {
            stats.skipped++;
          } else {
            stats.errors++;
          }
        } catch (err) {
          console.error(`[ContactDiscovery] Failed to create contact "${candidate.name}" for org "${org.name}":`, err);
          stats.errors++;
        }
      }
    } catch (err) {
      console.error(`[ContactDiscovery] Failed to process org "${org.name}":`, err);
      stats.errors++;
    }
  }

  // Step 5: content-anchored discovery (once per run, org-less)
  try {
    const contentCandidates = await discoverContactsFromContent();
    for (const candidate of contentCandidates) {
      try {
        const result = await createNotionContact(deps, {
          name: candidate.name,
          role: candidate.role,
          x_handle: candidate.x_handle,
          profile_url: candidate.profile_url,
          evidence: candidate.source,
          wire: null,
          program: null,
          source: candidate.source,
        });
        if (result.created) {
          stats.contactsCreated++;
        } else if (result.reason === 'exists') {
          stats.skipped++;
        } else {
          stats.errors++;
        }
      } catch (err) {
        console.error(`[ContactDiscovery] Failed to create content-anchored contact "${candidate.name}":`, err);
        stats.errors++;
      }
    }
  } catch (err) {
    console.error('[ContactDiscovery] Content-anchored discovery failed:', err);
    stats.errors++;
  }

  console.log(
    `[ContactDiscovery] Done: orgsProcessed=${stats.orgsProcessed} contactsCreated=${stats.contactsCreated} skipped=${stats.skipped} errors=${stats.errors}`,
  );

  return stats;
}
