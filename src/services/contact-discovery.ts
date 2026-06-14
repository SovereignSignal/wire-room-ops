import type { Pool } from 'pg';
import { notionRequest, getIntegrationConfigs, queryAllNotionPages } from './notion-sync';

const DEFAULT_CONTACTS_DB_ID = '66190528a1194cdc85797763d67c5a71';
const DEFAULT_ORGS_DB_ID = '301000c0-d590-81c4-8435-c6db7782db12';

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

interface CreateContactDeps {
  pool: Pool;
  token: string;
  contactsDbId?: string;
  orgsDbId?: string;
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
 *   1. Query Contacts DB for an existing page by Name (title match) or X url match.
 *   2. If orgName provided, also check discovered_contacts by org_id + name_norm.
 *   3. If any match found, return { created: false, reason: 'exists' }.
 *   4. Otherwise create the page and record in discovered_contacts.
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
  const existingPages = await queryAllNotionPages(token, contactsDbId);
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
    const orgPages = await queryAllNotionPages(token, orgsDbId);
    const orgNameNorm = normName(orgName);
    for (const page of orgPages) {
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
