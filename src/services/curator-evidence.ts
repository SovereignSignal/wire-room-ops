/**
 * Evidence required on curator-key decide and curate writes.
 * INTERNAL_API_KEY callers do not pass through this parser.
 */

export interface CuratorQuote {
  url: string;
  quote: string;
}

export interface CuratorEvidence {
  reason: string;
  sources: string[];
  quotes: CuratorQuote[];
}

export type EvidenceParse =
  | { ok: true; evidence: CuratorEvidence }
  | { ok: false; error: string };

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch {
    return false;
  }
}

/**
 * `sources` is a non-empty list of https URLs, or objects `{url, quote}`.
 * Approve also needs at least one non-empty quote. A top-level `quotes`
 * array is accepted as the same `{url, quote}` evidence.
 */
export function parseCuratorEvidence(body: unknown, opts: { requireQuote: boolean }): EvidenceParse {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
  if (!reason) return { ok: false, error: 'reason is required' };
  if (reason.length > 2000) return { ok: false, error: 'reason must be at most 2000 characters' };

  if (!Array.isArray(record.sources) || record.sources.length === 0) {
    return { ok: false, error: 'sources must be a non-empty array of https URLs' };
  }

  const sources: string[] = [];
  const quotes: CuratorQuote[] = [];

  const pushQuote = (url: string, quote: string): EvidenceParse | null => {
    if (!quote) return null;
    if (quote.length > 2000) return { ok: false, error: 'quote must be at most 2000 characters' };
    quotes.push({ url, quote });
    return null;
  };

  for (const item of record.sources) {
    if (typeof item === 'string') {
      const url = item.trim();
      if (!isHttpsUrl(url)) return { ok: false, error: 'sources must be https URLs' };
      sources.push(url);
      continue;
    }
    if (item && typeof item === 'object') {
      const row = item as Record<string, unknown>;
      const url = typeof row.url === 'string' ? row.url.trim() : '';
      if (!isHttpsUrl(url)) return { ok: false, error: 'sources must be https URLs' };
      sources.push(url);
      const quote = typeof row.quote === 'string' ? row.quote.trim() : '';
      const rejected = pushQuote(url, quote);
      if (rejected) return rejected;
      continue;
    }
    return { ok: false, error: 'sources must be https URLs or {url, quote} objects' };
  }

  if (Array.isArray(record.quotes)) {
    for (const item of record.quotes) {
      if (!item || typeof item !== 'object') {
        return { ok: false, error: 'quotes must be {url, quote} objects' };
      }
      const row = item as Record<string, unknown>;
      const url = typeof row.url === 'string' ? row.url.trim() : '';
      const quote = typeof row.quote === 'string' ? row.quote.trim() : '';
      if (!isHttpsUrl(url) || !quote) {
        return { ok: false, error: 'quotes must include an https URL and a non-empty quote' };
      }
      const rejected = pushQuote(url, quote);
      if (rejected) return rejected;
      if (!sources.includes(url)) sources.push(url);
    }
  }

  if (sources.length === 0) return { ok: false, error: 'sources must include at least one https URL' };
  if (opts.requireQuote && quotes.length === 0) {
    return { ok: false, error: 'approve requires at least one {url, quote} with a non-empty quote' };
  }
  return { ok: true, evidence: { reason, sources, quotes } };
}

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

/** Merge the evidence packet onto each entry. No new table. */
export async function attachCuratorEvidence(
  db: Queryable,
  ids: number[],
  evidence: CuratorEvidence,
  by: string,
): Promise<void> {
  if (ids.length === 0) return;
  const payload = { ...evidence, by, at: new Date().toISOString() };
  await db.query(
    `UPDATE scan_entries
     SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('curator_evidence', $1::jsonb),
         action_reason = $2
     WHERE id = ANY($3::bigint[])`,
    [JSON.stringify(payload), evidence.reason, ids],
  );
}
