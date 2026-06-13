/**
 * Sourcing orgs from tele-sum digest content (repos/models/claw) into org_profiles.
 * Pure helpers here; DB-touching runner is sourceDigestOrgs() below.
 */

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
  if (!/[A-Z]/.test(name)) return false;     // bare lowercase handles (e.g. usernames) are not orgs
  return signal.mentionCount >= 2 || signal.hasLink === true;
}
