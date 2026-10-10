/**
 * Pre-insert URL check for the Grok Telegram Batch door.
 *
 * That workflow posts to POST /api/scan/telegram-batch (scan_source telegram,
 * agent origin). It inserts through processBatchMessage and never reaches the
 * forum check in runDailyIntake. This key is for X post links only: x.com and
 * twitter.com are the same post, query strings and fragments are ignored, and
 * /handle/status/ID is the status ID (handle case does not matter). Any
 * scan_entries row with that post, in any status, is enough to skip.
 *
 * It is not the Discourse topic key and it is not normalizeUrl. Snapshot
 * proposal hashes stay in the shared normalizer. Human telegram pastes and
 * manual intake do not use this check.
 */

import type { Pool } from 'pg';

const X_STATUS_HOSTS = ['x.com', 'twitter.com'];

/**
 * Status ID for an X post URL, or '' when the URL is not an X/Twitter status.
 * Query strings (?s=20, ?t=...) and fragments are ignored. The handle is not
 * part of the key.
 */
export function xStatusId(url: string): string {
  if (!url || typeof url !== 'string') return '';
  let raw = url.trim();
  const markdown = raw.indexOf('](');
  if (markdown !== -1) raw = raw.slice(0, markdown);
  raw = raw.replace(/[\]).,;:]+$/, '');

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return '';
  }

  const host = parsed.hostname.toLowerCase().replace(/^(www|mobile|m)\./, '');
  if (host !== 'x.com' && host !== 'twitter.com') return '';

  const parts = parsed.pathname.split('/').filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    const segment = parts[i].toLowerCase();
    if (segment !== 'status' && segment !== 'statuses') continue;
    const id = parts[i + 1];
    return /^\d{15,20}$/.test(id) ? id : '';
  }
  return '';
}

/** Agent telegram-batch is the Grok Telegram Batch workflow. */
export function grokBatchTracksXStatus(scanSource: string, origin?: string): boolean {
  return scanSource === 'telegram' && origin === 'agent';
}

/**
 * Indexes into `urls` that should not be inserted.
 * The first URL for a status ID is kept; later equivalents in the same batch
 * are skipped even when the database does not have the post yet. Non-status
 * URLs are left alone.
 */
export function xStatusIndexesToSkip(urls: string[], existingSourceUrls: string[]): Set<number> {
  const seenIds = new Set<string>();
  for (const existing of existingSourceUrls) {
    const id = xStatusId(existing);
    if (id) seenIds.add(id);
  }

  const skip = new Set<number>();
  const claimed = new Set<string>();
  urls.forEach((url, index) => {
    const id = xStatusId(url);
    if (!id) return;
    if (seenIds.has(id) || claimed.has(id)) {
      skip.add(index);
      return;
    }
    claimed.add(id);
  });
  return skip;
}

/**
 * Source URLs already stored on scan_entries for these X status IDs.
 * Any status counts, including declined. No wire filter — one post is the
 * same page on every wire.
 */
export async function findXStatusSourceUrls(
  pool: Pick<Pool, 'query'>,
  urls: string[],
): Promise<string[]> {
  const ids = [...new Set(urls.map(xStatusId).filter(id => id.length > 0))];
  if (ids.length === 0) return [];

  const { rows } = await pool.query<{ source_url: string }>(
    `SELECT source_url
     FROM scan_entries
     WHERE source_url IS NOT NULL
       AND split_part(regexp_replace(lower(btrim(source_url)), '^https?://(www\\.|mobile\\.|m\\.)?', ''), '/', 1) = ANY($1::text[])
       AND (regexp_match(lower(source_url), '/status(es)?/([0-9]+)'))[2] = ANY($2::text[])`,
    [X_STATUS_HOSTS, ids],
  );
  return rows
    .map(row => row.source_url)
    .filter((sourceUrl): sourceUrl is string => typeof sourceUrl === 'string' && sourceUrl.length > 0);
}
