/**
 * Curator-editable overlay on the hard-coded SOURCE_REGISTRY.
 *
 * The code registry stays the default. app_state key `source-feeds:config`
 * holds patches (endpoint, enabled, name, wire, title filter, scrape prompt)
 * and added rss/scrape feeds. The daily job reads the overlay. A bad stored
 * value is ignored so one broken row cannot stop the lane.
 */

import { CORE_WIRES } from '../db';
import { isSafeHttpUrl } from '../utils/ssrf';
import { SOURCE_REGISTRY, type FeedSource } from './source-feeds';

export const SOURCE_FEED_CONFIG_KEY = 'source-feeds:config';

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WIRES = new Set<string>(CORE_WIRES);

export interface SourceFeedPatch {
  endpoint?: string;
  enabled?: boolean;
  name?: string;
  wire?: string;
  urlPrefix?: string;
  /** Regex source, applied case-insensitively. null clears a built-in filter. */
  titleAllow?: string | null;
  scrapePrompt?: string;
}

export interface AddedSourceFeed {
  key: string;
  name: string;
  wire: string;
  method: 'rss' | 'scrape';
  endpoint: string;
  enabled: boolean;
  urlPrefix?: string;
  titleAllow?: string;
  scrapePrompt?: string;
}

export interface SourceFeedConfig {
  patches: Record<string, SourceFeedPatch>;
  added: AddedSourceFeed[];
}

export function emptySourceFeedConfig(): SourceFeedConfig {
  return { patches: {}, added: [] };
}

function httpsUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const parsed = isSafeHttpUrl(raw.trim());
  if (!parsed || parsed.protocol !== 'https:') return null;
  return parsed.toString();
}

function compileTitleAllow(pattern: string): RegExp | null {
  if (!pattern || pattern.length > 300) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

function asPatch(raw: unknown): SourceFeedPatch | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const patch: SourceFeedPatch = {};
  if (row.endpoint !== undefined) {
    const endpoint = httpsUrl(row.endpoint);
    if (!endpoint) return null;
    patch.endpoint = endpoint;
  }
  if (row.enabled !== undefined) {
    if (typeof row.enabled !== 'boolean') return null;
    patch.enabled = row.enabled;
  }
  if (row.name !== undefined) {
    if (typeof row.name !== 'string' || !row.name.trim() || row.name.length > 120) return null;
    patch.name = row.name.trim();
  }
  if (row.wire !== undefined) {
    if (typeof row.wire !== 'string' || !WIRES.has(row.wire)) return null;
    patch.wire = row.wire;
  }
  if (row.urlPrefix !== undefined) {
    const prefix = httpsUrl(row.urlPrefix);
    if (!prefix) return null;
    patch.urlPrefix = prefix.replace(/\/$/, '');
  }
  if (row.titleAllow === null) patch.titleAllow = null;
  else if (row.titleAllow !== undefined) {
    if (typeof row.titleAllow !== 'string' || !compileTitleAllow(row.titleAllow)) return null;
    patch.titleAllow = row.titleAllow;
  }
  if (row.scrapePrompt !== undefined) {
    if (typeof row.scrapePrompt !== 'string' || row.scrapePrompt.length > 2000) return null;
    patch.scrapePrompt = row.scrapePrompt;
  }
  return patch;
}

function asAdded(raw: unknown): AddedSourceFeed | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.key !== 'string' || !KEY_RE.test(row.key)) return null;
  if (typeof row.name !== 'string' || !row.name.trim() || row.name.length > 120) return null;
  if (typeof row.wire !== 'string' || !WIRES.has(row.wire)) return null;
  if (row.method !== 'rss' && row.method !== 'scrape') return null;
  const endpoint = httpsUrl(row.endpoint);
  if (!endpoint) return null;
  if (row.method === 'scrape' && (typeof row.scrapePrompt !== 'string' || !row.scrapePrompt.trim())) return null;
  const feed: AddedSourceFeed = {
    key: row.key,
    name: row.name.trim(),
    wire: row.wire,
    method: row.method,
    endpoint,
    enabled: row.enabled !== false,
  };
  if (row.urlPrefix !== undefined) {
    const prefix = httpsUrl(row.urlPrefix);
    if (!prefix) return null;
    feed.urlPrefix = prefix.replace(/\/$/, '');
  }
  if (typeof row.titleAllow === 'string') {
    if (!compileTitleAllow(row.titleAllow)) return null;
    feed.titleAllow = row.titleAllow;
  }
  if (typeof row.scrapePrompt === 'string') feed.scrapePrompt = row.scrapePrompt;
  return feed;
}

/** Drop malformed pieces. Never throws. */
export function normalizeSourceFeedConfig(raw: unknown): SourceFeedConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptySourceFeedConfig();
  const row = raw as Record<string, unknown>;
  const patches: Record<string, SourceFeedPatch> = {};
  if (row.patches && typeof row.patches === 'object' && !Array.isArray(row.patches)) {
    for (const [key, value] of Object.entries(row.patches as Record<string, unknown>)) {
      if (!KEY_RE.test(key)) continue;
      const patch = asPatch(value);
      if (patch && Object.keys(patch).length > 0) patches[key] = patch;
    }
  }
  const added: AddedSourceFeed[] = [];
  if (Array.isArray(row.added)) {
    for (const item of row.added) {
      const feed = asAdded(item);
      if (feed && !SOURCE_REGISTRY.some(source => source.key === feed.key) && !added.some(existing => existing.key === feed.key)) {
        added.push(feed);
      }
    }
  }
  return { patches, added };
}

function addedToSource(feed: AddedSourceFeed): FeedSource {
  const titleAllow = feed.titleAllow ? compileTitleAllow(feed.titleAllow) || undefined : undefined;
  return {
    key: feed.key,
    name: feed.name,
    wire: feed.wire,
    method: feed.method,
    endpoint: feed.endpoint,
    enabled: feed.enabled,
    urlPrefix: feed.urlPrefix,
    titleAllow: titleAllow || undefined,
    scrapePrompt: feed.scrapePrompt,
    maxItems: 40,
  };
}

export function applySourceFeedConfig(registry: readonly FeedSource[], config: SourceFeedConfig): FeedSource[] {
  const patched = registry.map(source => {
    const patch = config.patches[source.key];
    if (!patch) return source;
    const titleAllow = patch.titleAllow === null
      ? undefined
      : (typeof patch.titleAllow === 'string' ? compileTitleAllow(patch.titleAllow) || source.titleAllow : source.titleAllow);
    return {
      ...source,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.wire !== undefined ? { wire: patch.wire } : {}),
      ...(patch.endpoint !== undefined ? { endpoint: patch.endpoint } : {}),
      ...(patch.urlPrefix !== undefined ? { urlPrefix: patch.urlPrefix } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.scrapePrompt !== undefined ? { scrapePrompt: patch.scrapePrompt } : {}),
      titleAllow,
    };
  });
  return [...patched, ...config.added.map(addedToSource)];
}

export interface PublicSourceFeed {
  key: string;
  name: string;
  wire: string;
  method: string;
  endpoint: string;
  enabled: boolean;
  origin: 'builtin' | 'added';
  urlPrefix: string | null;
  titleAllow: string | null;
  scrapePrompt: string | null;
}

export function describeSources(config: SourceFeedConfig): PublicSourceFeed[] {
  const addedKeys = new Set(config.added.map(feed => feed.key));
  return applySourceFeedConfig(SOURCE_REGISTRY, config).map(source => ({
    key: source.key,
    name: source.name,
    wire: source.wire,
    method: source.method,
    endpoint: source.endpoint,
    enabled: source.enabled,
    origin: addedKeys.has(source.key) ? 'added' : 'builtin',
    urlPrefix: source.urlPrefix || null,
    titleAllow: source.titleAllow ? source.titleAllow.source : null,
    scrapePrompt: source.scrapePrompt || null,
  }));
}

export function validateFeedKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  return KEY_RE.test(key) ? key : null;
}

export function validatePatchBody(raw: unknown): { ok: true; patch: SourceFeedPatch } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'JSON object required' };
  const patch = asPatch(raw);
  if (!patch) return { ok: false, error: 'Invalid feed update. Use https endpoints, a core wire (crypto, ai, oss), and a valid title pattern.' };
  if (Object.keys(patch).length === 0) return { ok: false, error: 'No editable fields in the body' };
  return { ok: true, patch };
}

export function validateAddedBody(raw: unknown): { ok: true; feed: AddedSourceFeed } | { ok: false; error: string } {
  const feed = asAdded(raw);
  if (!feed) {
    return { ok: false, error: 'A new feed needs key, name, wire (crypto, ai, or oss), method (rss or scrape), and an https endpoint. Scrape feeds also need scrapePrompt.' };
  }
  if (SOURCE_REGISTRY.some(source => source.key === feed.key)) return { ok: false, error: 'That key is already a built-in feed. Update it with PUT.' };
  return { ok: true, feed };
}
