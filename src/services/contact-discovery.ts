import type { Pool } from 'pg';

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
