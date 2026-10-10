/**
 * Pre-insert URL check for forum-sourced scan entries.
 *
 * Forum scan reaches scan_entries through runDailyIntake, which inserts every
 * result and only afterwards marks URL duplicates. Threads already stored under
 * any status were still getting a new row. This key is intentionally stricter
 * than normalizeUrl: the shared key keeps fragments because Snapshot proposal
 * ids live in the hash, and it does not treat a Discourse post number as the
 * same topic. Those rules stay on this forum path only.
 */

import type { Pool } from 'pg';
import { normalizeUrl } from '../utils/url';

/**
 * Canonical topic key for a forum source URL.
 *
 * Starts from normalizeUrl (tracking params, trailing slash, case, markdown
 * junk), then:
 * - drops the fragment
 * - treats http and https as the same
 * - drops a Discourse post-number suffix (`/t/slug/123/4` and `/t/123/4`
 *   collapse to the topic, `/t/slug/123`)
 */
export function forumTopicKey(url: string): string {
  if (!url || typeof url !== 'string') return '';
  let normalized = normalizeUrl(url.trim());
  if (!normalized) return '';

  const hash = normalized.indexOf('#');
  if (hash !== -1) normalized = normalized.slice(0, hash);
  normalized = normalized.replace(/\/+$/, '');
  if (normalized.startsWith('http://')) {
    normalized = `https://${normalized.slice('http://'.length)}`;
  }

  try {
    const parsed = new URL(normalized);
    parsed.hash = '';
    parsed.protocol = 'https:';
    const parts = parsed.pathname.split('/').filter(Boolean);
    // Discourse topic URLs are /t/{slug}/{topicId} or /t/{topicId}. A trailing
    // all-digit segment is a post number only when the segment before it is
    // the numeric topic id. That keeps /t/slug/123 intact.
    if (parts[0] === 't' && parts.length >= 3) {
      const postNumber = parts[parts.length - 1];
      const topicId = parts[parts.length - 2];
      if (/^\d+$/.test(postNumber) && /^\d+$/.test(topicId)) {
        parts.pop();
        parsed.pathname = `/${parts.join('/')}`;
      }
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return normalized;
  }
}

/**
 * Indexes into `urls` that should not be inserted.
 * The first URL for a topic key is kept; later equivalents in the same batch
 * are skipped even when the database does not have the topic yet.
 */
export function forumResultIndexesToSkip(urls: string[], existingSourceUrls: string[]): Set<number> {
  const seenKeys = new Set<string>();
  for (const existing of existingSourceUrls) {
    const key = forumTopicKey(existing);
    if (key) seenKeys.add(key);
  }

  const skip = new Set<number>();
  const claimed = new Set<string>();
  urls.forEach((url, index) => {
    const key = forumTopicKey(url);
    if (!key) return;
    if (seenKeys.has(key) || claimed.has(key)) {
      skip.add(index);
      return;
    }
    claimed.add(key);
  });
  return skip;
}

export function forumTopicHosts(urls: string[]): string[] {
  const hosts = new Set<string>();
  for (const url of urls) {
    const key = forumTopicKey(url);
    if (!key) continue;
    try {
      const host = new URL(key).host;
      if (host) hosts.add(host);
    } catch {
      // forumTopicKey already rejected anything that is not a URL.
    }
  }
  return [...hosts];
}

/**
 * Source URLs already stored on scan_entries for these hosts.
 * Any status counts: a declined, duplicate, queued, or approved row is enough
 * to skip the topic. No wire filter — a forum thread is the same page on
 * every wire.
 */
export async function findForumSourceUrlsByHost(
  pool: Pick<Pool, 'query'>,
  urls: string[],
): Promise<string[]> {
  const hosts = forumTopicHosts(urls);
  if (hosts.length === 0) return [];

  const { rows } = await pool.query<{ source_url: string }>(
    `SELECT source_url
     FROM scan_entries
     WHERE source_url IS NOT NULL
       AND split_part(regexp_replace(lower(btrim(source_url)), '^https?://', ''), '/', 1) = ANY($1::text[])`,
    [hosts],
  );
  return rows
    .map(row => row.source_url)
    .filter((sourceUrl): sourceUrl is string => typeof sourceUrl === 'string' && sourceUrl.length > 0);
}
