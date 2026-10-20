/**
 * Shared URL normalization for deduplication.
 * Handles twitter/x.com normalization and tracking param removal.
 *
 * The fragment is part of the key. Snapshot and other hash-routed apps put
 * the proposal id in `#/<space>/proposal/<id>`; dropping the fragment would
 * collapse every proposal on that host into one URL.
 */
function stripLinkArtifacts(url: string): string {
  // Strip markdown link artifacts: "url](url" → take part before ](
  const mdArtifact = url.indexOf('](');
  if (mdArtifact !== -1) {
    url = url.substring(0, mdArtifact);
  }
  // Strip trailing markdown/punctuation junk
  return url.replace(/[\]\).,;:]+$/, '');
}

export function normalizeUrl(url: string): string {
  if (!url) return '';
  url = stripLinkArtifacts(url);

  try {
    const u = new URL(url);

    // Normalize twitter.com to x.com
    if (u.hostname === 'twitter.com' || u.hostname === 'www.twitter.com') {
      u.hostname = 'x.com';
    }
    if (u.hostname === 'www.x.com') {
      u.hostname = 'x.com';
    }

    // Remove common tracking params
    const trackingParams = [
      's', 't', 'ref', 'ref_src',
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
      'fbclid', 'gclid',
    ];
    for (const param of trackingParams) {
      u.searchParams.delete(param);
    }

    // Remove trailing slashes
    let normalized = u.toString().replace(/\/+$/, '');

    return normalized.toLowerCase();
  } catch {
    // If URL parsing fails, just lowercase and trim
    return url.toLowerCase().trim();
  }
}

const LOOKUP_TRACKING_PARAMS = [
  'utm_id', 'utm_name', 'utm_reader', 'utm_brand', 'utm_social', 'utm_social-type',
  'srsltid', 'gad_source', 'gbraid', 'wbraid', 'dclid', 'msclkid', 'twclid', 'yclid',
  'mc_cid', 'mc_eid', '_hsenc', '_hsmi', 'mkt_tok', 'igshid', 'li_fat_id', '_ga', '_gl',
];

const X_HOST_ALIASES = new Set(['mobile.twitter.com', 'm.twitter.com', 'mobile.x.com', 'm.x.com']);

function lookupCanonical(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (X_HOST_ALIASES.has(u.hostname.toLowerCase())) u.hostname = 'x.com';
  for (const param of LOOKUP_TRACKING_PARAMS) u.searchParams.delete(param);
  // `#:~:text=` is a browser highlight, not part of the page. Hash routes keep their fragment.
  const directive = u.hash.indexOf(':~:');
  if (directive !== -1) u.hash = u.hash.slice(0, directive).replace(/^#$/, '');
  const host = u.hostname.toLowerCase();
  if (host === 'x.com' || host === 'twitter.com' || host === 'www.x.com' || host === 'www.twitter.com') {
    u.pathname = u.pathname.replace(/(\/status(?:es)?\/\d+)\/(?:photo|video)\/\d+\/?$/i, '$1');
  }
  return u.toString();
}

/**
 * Stored `seen_urls` keys that name the same page as `url`: the scheme
 * (http/https), a leading `www.`, browser text highlights, extra tracking
 * parameters, mobile X hosts, and X photo/video suffixes are ignored.
 * The first key is `normalizeUrl(url)`. Registration still stores that key,
 * so this only widens lookups and never re-keys the registry.
 */
export function urlLookupKeys(url: string): string[] {
  const primary = normalizeUrl(url);
  if (!primary) return [];
  const cleaned = stripLinkArtifacts(url.trim());
  const spellings = new Set<string>([cleaned]);
  const canonical = lookupCanonical(cleaned);
  if (canonical) spellings.add(canonical);

  const keys = new Set<string>([primary]);
  for (const spelling of spellings) {
    let u: URL;
    try {
      u = new URL(spelling);
    } catch {
      continue;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    const bareHost = u.hostname.replace(/^www\./i, '');
    for (const protocol of ['https:', 'http:']) {
      for (const hostname of [bareHost, `www.${bareHost}`]) {
        const variant = new URL(u.toString());
        variant.protocol = protocol;
        variant.hostname = hostname;
        keys.add(normalizeUrl(variant.toString()));
      }
    }
  }
  keys.delete('');
  return [...keys];
}
