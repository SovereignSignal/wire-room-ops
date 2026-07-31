/**
 * Registry watchers (Watchtower Phase 1): adapt watch_surfaces rows into the
 * existing feeds engine. Selection + per-surface state here; fetching stays in
 * source-feeds (fetchSource), intake stays in daily-intake.
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { SOURCE_REGISTRY, type FeedSource } from './source-feeds';
import { normalizeUrl } from '../utils/url';

export interface WatchSurface {
  id: number;
  org_name: string;
  wire: string | null;
  surface_type: string;
  url: string;
  tier: string | null;
}

export function isTier12(tier: string | null): boolean {
  if (!tier) return false;
  return /^tier ?1\b/i.test(tier) || /^tier ?2\b/i.test(tier) || /^official$/i.test(tier);
}

const TIER_1 = `(tier ILIKE 'Tier 1%' OR tier ILIKE 'Tier1%' OR tier = 'Official')`;
const TIER_2 = `(tier ILIKE 'Tier 2%' OR tier ILIKE 'Tier2%')`;

/**
 * SQL predicate for the requested tiers. Input is a comma list ("1", "1,2", "2").
 * Anything unrecognised falls back to Tier 1 — widening coverage is an operator
 * decision, never the result of a typo in an env var.
 *
 * Built from constants only; no caller input reaches the SQL string.
 */
export function tierClause(tiers: string): string {
  const requested = new Set((tiers || '').split(',').map(s => s.trim()).filter(Boolean));
  const parts: string[] = [];
  if (requested.has('1')) parts.push(TIER_1);
  if (requested.has('2')) parts.push(TIER_2);
  if (parts.length === 0) parts.push(TIER_1);
  return `(${parts.join(' OR ')})`;
}

/** Due = active surface (scoped by tiers, default Tier 1) of a wanted type, least-recently-checked first. */
export async function getDueSurfaces(pool: Pool, types: string[], limit: number, tiers: string = '1'): Promise<WatchSurface[]> {
  const { rows } = await pool.query<WatchSurface & { tier: string | null }>(
    `SELECT id, org_name, wire, surface_type, url, tier
       FROM watch_surfaces
      WHERE status = 'active'
        AND surface_type = ANY($1)
        AND ${tierClause(tiers)}
        AND (last_checked_at IS NULL OR last_checked_at < NOW() - INTERVAL '20 hours')
      ORDER BY last_checked_at ASC NULLS FIRST
      LIMIT $2`,
    [types, limit],
  );
  return rows;
}

const GRANTS_EXTRACT_PROMPT =
  'Extract each currently-open grant, RFP, fund, fellowship, or bounty round a builder could apply to on this page; use each opportunity\'s own application/details URL.';

export function surfaceToRssSource(s: WatchSurface): FeedSource {
  return {
    key: `ws-rss-${s.id}`,
    name: `${s.org_name} — registry RSS`,
    wire: s.wire || 'crypto',
    method: 'rss',
    endpoint: s.url,
    enabled: true,
    maxItems: 20,
  };
}

export function surfaceToScrapeSource(s: WatchSurface): FeedSource {
  return {
    key: `ws-diff-${s.id}`,
    name: `${s.org_name} — registry page`,
    wire: s.wire || 'crypto',
    method: 'scrape',
    endpoint: s.url,
    enabled: true,
    maxItems: 15,
    scrapePrompt: GRANTS_EXTRACT_PROMPT,
    usagePurpose: 'watchtower-registry-extract',
  };
}

const SEED_ENDPOINTS = new Set(SOURCE_REGISTRY.filter(x => x.enabled).map(x => normalizeUrl(x.endpoint)));

export function overlapsSeedRegistry(s: WatchSurface): boolean {
  return SEED_ENDPOINTS.has(normalizeUrl(s.url));
}

/** Strip tags/scripts/styles, collapse whitespace. Deliberately keeps text only. */
export function normalizeForHash(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function contentHash(html: string): string {
  return createHash('sha256').update(normalizeForHash(html)).digest('hex');
}

export async function markChecked(
  pool: Pool,
  id: number,
  opts: { changed?: boolean; itemsFound?: number; failed?: boolean } = {},
): Promise<void> {
  await pool.query(
    `UPDATE watch_surfaces
        SET last_checked_at = NOW(),
            last_changed_at = CASE WHEN $2 THEN NOW() ELSE last_changed_at END,
            failure_streak  = CASE WHEN $3 THEN failure_streak + 1 ELSE 0 END,
            items_found_30d = items_found_30d + $4,
            updated_at      = NOW()
      WHERE id = $1`,
    [id, Boolean(opts.changed), Boolean(opts.failed), opts.itemsFound || 0],
  );
}
