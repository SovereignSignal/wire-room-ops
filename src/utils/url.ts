/**
 * Shared URL normalization for deduplication.
 * Handles twitter/x.com normalization and tracking param removal.
 */
export function normalizeUrl(url: string): string {
  if (!url) return '';
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
