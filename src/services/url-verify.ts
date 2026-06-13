/** Deterministic URL reachability check for enrichment verification.
 *  'ok' = resolves (2xx/3xx); 'notfound' = definitively absent (404/410);
 *  'inconclusive' = blocked/throttled/timeout (403/429/5xx/network) — DO NOT penalize. */
export type UrlVerdict = 'ok' | 'notfound' | 'inconclusive';

export async function verifyUrl(url: string, fetchImpl: typeof fetch = fetch): Promise<UrlVerdict> {
  if (!url || !/^https?:\/\//i.test(url)) return 'inconclusive';
  try {
    let resp: Response;
    try {
      resp = await fetchImpl(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(12000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; wire-room-ops-verify/1.0)' } });
      // Some servers reject HEAD; retry GET on 405/501
      if (resp.status === 405 || resp.status === 501) {
        resp = await fetchImpl(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(12000),
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; wire-room-ops-verify/1.0)' } });
      }
    } catch {
      return 'inconclusive';
    }
    if (resp.status === 404 || resp.status === 410) return 'notfound';
    if (resp.status >= 200 && resp.status < 400) return 'ok';
    return 'inconclusive'; // 403/429/5xx etc.
  } catch {
    return 'inconclusive';
  }
}

/** Verify the URL-bearing fields of an enrichment; returns the set of field names
 *  that were definitively NOT FOUND (caller should null those). */
export async function findDeadUrlFields(
  fields: { website?: string | null; github_url?: string | null; twitter?: string | null },
  verify: (u: string) => Promise<UrlVerdict> = verifyUrl,
): Promise<string[]> {
  const dead: string[] = [];
  for (const key of ['website', 'github_url', 'twitter'] as const) {
    const v = fields[key];
    if (v && (await verify(v)) === 'notfound') dead.push(key);
  }
  return dead;
}
