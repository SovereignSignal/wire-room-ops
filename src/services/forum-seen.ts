/**
 * Source-observation identity for forum-sourced scan entries.
 *
 * Forum scan reaches scan_entries through runDailyIntake, which inserts every
 * result and only afterwards marks URL duplicates. Repeated observations still
 * skip insertion; collector-verified changes can enter source-check review.
 * This key is intentionally stricter
 * than normalizeUrl: the shared key keeps fragments because Snapshot proposal
 * ids live in the hash, and it does not treat a Discourse post number as the
 * same topic. Those rules stay on this forum path only.
 */

import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import type { RawScanResult } from '../types/intake';
import { normalizeUrl } from '../utils/url';

/**
 * Canonical topic key for a forum source URL.
 *
 * Starts from normalizeUrl (tracking params, trailing slash, case, markdown
 * junk), then:
 * - drops Discourse post fragments (preserves non-Discourse identities)
 * - treats http and https as the same
 * - drops a Discourse post-number suffix (`/t/slug/123/4` and `/t/123/4`
 *   collapse to the topic id, `/t/123`)
 */
export function forumTopicKey(url: string): string {
  if (!url || typeof url !== 'string') return '';
  let normalized = normalizeUrl(url.trim());
  if (!normalized) return '';

  normalized = normalized.replace(/\/+$/, '');
  if (normalized.startsWith('http://')) {
    normalized = `https://${normalized.slice('http://'.length)}`;
  }

  try {
    const parsed = new URL(normalized);
    parsed.protocol = 'https:';
    const parts = parsed.pathname.split('/').filter(Boolean);
    // Discourse topic URLs are /t/{slug}/{topicId} or /t/{topicId}. A trailing
    // all-digit segment is a post number only when the segment before it is
    // the numeric topic id. That keeps /t/slug/123 intact.
    if (parts[0] === 't' && parts.length >= 2) {
      const postNumber = parts[parts.length - 1];
      const topicId = parts[parts.length - 2];
      if (/^\d+$/.test(postNumber) && /^\d+$/.test(topicId)) {
        parts.pop();
      }
      // A changed title can change the slug without changing the topic.
      if (/^\d+$/.test(parts[parts.length - 1])) {
        parsed.pathname = `/t/${parts[parts.length - 1]}`;
        parsed.hash = '';
      }
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return normalized;
  }
}

export interface ForumObservation {
  version: 1;
  topicKey: string;
  revision: string;
  fingerprint: string;
  originalPublishedAt: string | null;
  lastActivityAt: string | null;
  evidence: 'topic_detail' | 'grants_feed' | 'activity_only';
  complete: boolean;
  excerpt: string;
  priorEntryId?: number;
  changeEvidence?: 'content' | 'activity';
}

export interface ForumHistoryEntry {
  id: number;
  source_url: string;
  scan_source?: string;
  submitted_by?: string;
  wire?: string;
  status?: string;
  created_at?: string | Date;
  metadata?: unknown;
}

// Only objects produced in this process by the forum collector can acquire
// this capability. JSON metadata submitted through an intake route cannot.
const observations = new WeakMap<RawScanResult, ForumObservation>();
export function stampForumObservation(result: RawScanResult, observation: ForumObservation): RawScanResult {
  observations.set(result, observation);
  return result;
}
export function trustedForumObservation(result: RawScanResult): ForumObservation | undefined {
  return observations.get(result);
}
export function forumFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function forumIntakeMetadata(result: RawScanResult, scanSource: string, submittedBy?: string): Record<string, unknown> | undefined {
  const metadata = { ...result.metadata };
  // Reserved server-owned field, including for non-forum submissions.
  delete metadata.forum_observation;
  const observation = scanSource === 'forum' && submittedBy === 'forum:discuss.watch'
    ? trustedForumObservation(result) : undefined;
  if (observation) metadata.forum_observation = observation;
  return Object.keys(metadata).length ? metadata : undefined;
}

export function storedForumObservation(entry: ForumHistoryEntry): ForumObservation | null {
  if (entry.scan_source !== 'forum' || entry.submitted_by !== 'forum:discuss.watch') return null;
  const value = (entry.metadata as { forum_observation?: ForumObservation } | null)?.forum_observation;
  if (!value || value.version !== 1 || value.topicKey !== forumTopicKey(entry.source_url)
      || !/^[a-f0-9]{64}$/.test(value.fingerprint) || typeof value.revision !== 'string'
      || !['topic_detail', 'grants_feed', 'activity_only'].includes(value.evidence)
      || typeof value.excerpt !== 'string' || typeof value.complete !== 'boolean') return null;
  return value;
}

export async function findForumHistoryByHost(pool: Pick<Pool, 'query'>, urls: string[]): Promise<ForumHistoryEntry[]> {
  const hosts = forumTopicHosts(urls);
  if (!hosts.length) return [];
  const { rows } = await pool.query<ForumHistoryEntry>(
    `SELECT id, source_url, scan_source, submitted_by, wire, status, created_at, metadata
     FROM scan_entries
     WHERE source_url IS NOT NULL
       AND split_part(regexp_replace(lower(btrim(source_url)), '^https?://', ''), '/', 1) = ANY($1::text[])
     ORDER BY id DESC`, [hosts]);
  // An archived replay did not change source state. Keep genuine declined and
  // archived observations, and do not trust this reserved reason without a stamp.
  return rows.filter(row => !(row.status === 'archived' && storedForumObservation(row)
    && (row.metadata as { archived_reason?: string }).archived_reason === 'unchanged_forum_observation'));
}

/** Compare current state, not every historical value: A -> B -> A is a change.
 * A persisted update still belongs to the baseline it was captured against;
 * replaying it after a newer observation must not reopen that older state. */
export function forumObservationAlreadySeen(observation: ForumObservation, history: ForumHistoryEntry[]): boolean {
  const matching = history.filter(row => storedForumObservation(row)?.topicKey === observation.topicKey);
  const newest = (rows: ForumHistoryEntry[]) => rows.reduce<ForumHistoryEntry | undefined>((last, row) => !last || row.id > last.id ? row : last, undefined);
  const latest = newest(matching);
  if (!latest) return false;
  // Feed extraction and thread bodies use different fingerprint recipes. A
  // repeat feed must not reopen just because a detail snapshot arrived later.
  const comparable = newest(matching.filter(row => storedForumObservation(row)!.evidence === observation.evidence));
  return (comparable && storedForumObservation(comparable)!.fingerprint === observation.fingerprint) === true
    || (observation.priorEntryId !== undefined && observation.priorEntryId < latest.id);
}

export function forumObservationMayBeNew(observation: ForumObservation, prior: ForumHistoryEntry): boolean {
  const old = storedForumObservation(prior);
  if (old) {
    if (old.fingerprint === observation.fingerprint) return false;
    const oldTime = Date.parse(old.lastActivityAt || '');
    const newTime = Date.parse(observation.lastActivityAt || '');
    return !Number.isFinite(oldTime) || !Number.isFinite(newTime) || newTime >= oldTime;
  }
  const activity = Date.parse(observation.lastActivityAt || '');
  const captured = new Date(prior.created_at || '').getTime();
  return Number.isFinite(activity) && Number.isFinite(captured) && activity > captured;
}

export function forumUpdateNote(observation: ForumObservation): string {
  const coverage = observation.changeEvidence === 'content'
    ? 'Source content changed; verify whether the change is material.'
    : 'Source activity changed; the prior or current topic detail is unavailable or incomplete. Verify the thread: this is not proof of a material change.';
  return `Possible forum update to #${observation.priorEntryId}. ${coverage} Original post: ${observation.originalPublishedAt || 'unknown'}; latest source activity: ${observation.lastActivityAt || 'unknown'}.`;
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
