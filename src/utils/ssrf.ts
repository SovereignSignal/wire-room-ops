/**
 * Shared SSRF guard for any code path that fetches a URL that originated
 * outside this system (scraped tweets, feed items, operator-pasted links,
 * LLM-extracted URLs). Extracted from the shortener-resolution hardening in
 * src/jobs/decided-recheck.ts so every outbound-fetch site uses one blocklist.
 *
 * Three layers:
 *   1. isSafeHttpUrl()   — static URL validation (scheme, userinfo, host shape,
 *                          IP-literal blocklist fast path)
 *   2. resolvesToPublicAddresses() — DNS resolution check: EVERY address the
 *                          hostname resolves to must be public
 *   3. safePublicFetch()  — fetch wrapper that validates layers 1+2 on the
 *                          initial URL AND on every redirect hop (redirects are
 *                          followed manually, never automatically)
 *
 * Note: safePublicFetch validates DNS immediately before fetch() re-resolves,
 * which closes the practical SSRF hole for these call sites. The strictest
 * variant (pinning the connection to the validated IP via a custom lookup)
 * lives in decided-recheck's safeHeadRequest for shortener resolution.
 */
import { lookup as dnsLookup } from 'node:dns';

export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  // IPv4 literal?
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some(n => n > 255)) return true;
    const [a, b] = o;
    if (a === 0 || a === 127 || a === 10 || a >= 224) return true;            // 0/8, loopback, 10/8, multicast/reserved
    if (a === 169 && b === 254) return true;                                  // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;                         // 172.16/12
    if (a === 192 && b === 168) return true;                                  // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true;                        // CGNAT 100.64/10
    return false;
  }
  // IPv6 literal — block loopback, link-local, ULA, unspecified
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;
    if (h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true;
    if (h.startsWith('::ffff:')) return true;                                 // IPv4-mapped — reject; can't cheaply re-validate here
    return false;
  }
  return false; // a DNS name; resolution is validated separately
}

export function isSafeHttpUrl(raw: string): URL | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;               // reject user:pass@ userinfo
  // Hostname must be a literal IP we can check, or a normal dotted DNS name.
  // WHATWG URL already normalizes integer/hex/octal IPv4 to dotted-quad, so
  // anything else weird (no dot, not an IP) is rejected up front.
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const looksLikeDns = /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/i.test(host);
  const looksLikeIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  if (!looksLikeDns && !looksLikeIp) return null;
  if (isBlockedHost(u.hostname)) return null;              // fast-path for IP literals
  return u;
}

/** Resolve a hostname and require EVERY returned address to be public. IP
 *  literals pass without a DNS query (already screened by isSafeHttpUrl). */
export function resolvesToPublicAddresses(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, '');
  const isLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  if (isLiteral) return Promise.resolve(!isBlockedHost(host));
  return new Promise(resolve => {
    dnsLookup(host, { all: true, verbatim: true }, (err, addresses: any) => {
      if (err) return resolve(false);
      const list = Array.isArray(addresses) ? addresses : [addresses];
      resolve(list.length > 0 && list.every((a: any) => !isBlockedHost(a.address)));
    });
  });
}

/**
 * fetch() a URL that came from untrusted input, validating the URL and its DNS
 * resolution at the initial request and at every redirect hop. Returns the
 * final Response (redirects consumed), or null if any hop is blocked/invalid.
 * Network errors propagate to the caller like plain fetch.
 */
export async function safePublicFetch(
  rawUrl: string,
  init?: RequestInit,
  maxRedirects = 5,
): Promise<Response | null> {
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = isSafeHttpUrl(current);
    if (!u) return null;
    if (!(await resolvesToPublicAddresses(u.hostname))) return null;
    const resp = await fetch(u.toString(), { ...init, redirect: 'manual' });
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc) return resp;
      // drain the redirect body so the connection can be reused
      try { await resp.arrayBuffer(); } catch { /* ignore */ }
      current = new URL(loc, u).toString();
      continue;
    }
    return resp;
  }
  return null; // too many redirects
}
