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

/** The full blocklist of aggregator domains (defaults + env extras). */
export function blockedDomains(): string[] {
  return [...DEFAULT_BLOCKED_DOMAINS, ...extraBlocked()];
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

export type SourceLinkClass = 'missing' | 'invalid' | 'placeholder' | 'shortener' | 'tweet-only' | 'ok';

/**
 * Classify whether a source URL is publishable evidence or an intake marker.
 * Keep this shared: batch intake, raw processing, source sweep, and approval
 * must agree or placeholders can become queued entries merely by changing path.
 */
export function classifySourceLink(url: string | null | undefined): SourceLinkClass {
  const value = (url || '').trim();
  if (!value) return 'missing';
  if (/^scan:\/\//i.test(value)) return 'placeholder';

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'invalid';
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return 'invalid';
  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  if (!host) return 'invalid';
  if (host === 'manual' && /^\/needs-source(?:\/|$)/i.test(parsed.pathname)) return 'placeholder';
  if (host === 't.me' && /^\/manual(?:\/|$)/i.test(parsed.pathname)) return 'placeholder';
  if (['t.co', 'bit.ly', 'tinyurl.com', 'buff.ly', 'ow.ly'].includes(host)) return 'shortener';
  if (host === 'x.com' || host === 'twitter.com') return 'tweet-only';
  return 'ok';
}
