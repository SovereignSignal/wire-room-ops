/**
 * Sourcing orgs from tele-sum digest content (repos/models/claw) into org_profiles.
 * Pure helpers here; DB-touching runner is sourceDigestOrgs() below.
 */
import type { Pool } from 'pg';

export function normalizeDigestOrg(raw: string | null | undefined): string {
  return (raw || '').replace(/\s+/g, ' ').trim();
}

/**
 * Auto-create quality bar. A digest org mention becomes a CRM org only if it is a
 * real organization (not an incidental owner/repo handle) AND has enough signal:
 * >=2 distinct mentions, or a resolvable link from the content.
 */
export function qualifiesAsDigestOrg(
  rawName: string,
  signal: { mentionCount: number; hasLink: boolean },
): boolean {
  const name = normalizeDigestOrg(rawName);
  if (!name) return false;
  if (name.includes('/')) return false;       // owner/repo handle, not an org
  if (name.length < 2) return false;
  // Org-shaped names (have an uppercase letter or a space) qualify on >=2
  // mentions OR a resolvable link. Bare lowercase single-token names look like
  // personal handles (e.g. 'orhun'), so they need repeated mentions (>=2) to
  // qualify — a single link isn't enough. This still admits multi-mention
  // lowercase-branded orgs like 'openai' / 'huggingface-org'.
  const orgShaped = /[A-Z]/.test(name) || name.includes(' ');
  if (orgShaped) return signal.mentionCount >= 2 || signal.hasLink === true;
  return signal.mentionCount >= 2;
}

export async function ensureDigestItemOrgsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS digest_item_orgs (
      id SERIAL PRIMARY KEY,
      summary_id INTEGER NOT NULL,
      item_index INTEGER NOT NULL,
      org_id INTEGER NOT NULL REFERENCES org_profiles(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (summary_id, item_index, org_id)
    )
  `);
}

export async function linkDigestItemToOrg(
  pool: Pool, summaryId: number, itemIndex: number, orgId: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO digest_item_orgs (summary_id, item_index, org_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (summary_id, item_index, org_id) DO NOTHING`,
    [summaryId, itemIndex, orgId],
  );
}
