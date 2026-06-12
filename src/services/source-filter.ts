/**
 * Source filter — Gate 1 rejection of known Tier-3 aggregator domains.
 *
 * The agent playbook already says "skip aggregators" but nothing enforced it
 * on inbound URLs, so opportunity-aggregator scholarship/fellowship content
 * (opportunitydesk, afredac, menterprise, etc.) flowed straight into the queue
 * and defaulted to the crypto wire. This blocks those sources before they
 * cost a classification call.
 *
 * Deliberately conservative: only unambiguous aggregator domains. Borderline
 * sources are left to the classifier's domain-scope gate, which flags rather
 * than hard-blocks. Extend via the SOURCE_BLOCKLIST_EXTRA env var
 * (comma-separated domains).
 */

const DEFAULT_BLOCKED_DOMAINS = [
  // Opportunity aggregators (scholarships/fellowships listicles)
  'opportunitydesk.org',
  'opd.to',                       // opportunitydesk shortener
  'opportunitiesforyouth.org',
  'globalsouthopportunities.com',
  'afredac.net',
  'menterprise.africa',
  'mystudypals.com',
  'scholarshipbob.com',
  'scholarshipair.com',
  'scholarshipregion.com',
  'youthop.com',
  'oyaop.com',
  'oyaop.org',
  'afterschoolafrica.com',
  'scholarshippositions.com',
  'opportunitiescircle.com',
  'armacad.info',
];

let cachedExtra: string[] | null = null;
function extraBlocked(): string[] {
  if (cachedExtra) return cachedExtra;
  const raw = process.env.SOURCE_BLOCKLIST_EXTRA || '';
  cachedExtra = raw.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
  return cachedExtra;
}

/** Normalize a URL to its registrable host (lowercased, no www). */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Returns the matched blocked domain if the URL's host is (or is a subdomain
 * of) a blocked aggregator, else null.
 */
export function blockedSourceDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  const host = hostOf(url);
  if (!host) return null;
  const list = [...DEFAULT_BLOCKED_DOMAINS, ...extraBlocked()];
  for (const blocked of list) {
    if (host === blocked || host.endsWith('.' + blocked)) return blocked;
  }
  return null;
}
