/**
 * Registry Watch Job (Watchtower Phase 1) — two lanes over watch_surfaces:
 *
 *  - rss: surfaces with a machine-readable feed. Reuses the feeds engine
 *    (fetchSource) plus a per-surface seen-URL watermark (same shape as
 *    source-feeds, smaller cap: this table is O(100s) of small surfaces, not
 *    a handful of high-volume aggregators).
 *  - html_diff: surfaces with only an HTML page. Hash the page's text content
 *    and only pay for an LLM extraction (via the same fetchSource('scrape')
 *    path, which tries a plain fetch before Firecrawl) when the hash actually
 *    changes AND it isn't the surface's first-ever check (a baseline has
 *    nothing to diff against).
 *
 * Selection, seed-registry overlap, content hashing, and checked-state
 * writeback live in services/registry-watchers.ts; this job wires those into
 * intake exactly like jobs/source-feeds.ts / jobs/x-lists.ts. Deps-injection
 * style mirrors x-lists.ts so every branch (baseline, unchanged, budget-block,
 * cap-overflow, dry-run) is unit-testable without network or DB.
 *
 * Gates: default OFF (REGISTRY_WATCH_ENABLED, read at call time — the
 * scheduler also guards this; double gate is deliberate) and default dry-run
 * (registryWatchDryRun). Baselines and no-op checks advance in dry-run.
 *
 * A dry run does not call intake. It does store the new page hash and the
 * seen-URL watermark, and it writes the would-submit list to app_state
 * (`registry-watch:pending`) for GET /api/registry-watch/pending. That stops
 * the same unchanged page from being extracted again the next day.
 *
 * The first live run records `registry-watch:live-since` and submits only
 * items published at or after that instant. Undated items on that first run
 * are the pre-existing backlog: they are marked seen and not submitted.
 * REGISTRY_WATCH_SUBMIT_BACKLOG=true submits them. REGISTRY_WATCH_LIVE_SINCE
 * sets the cutoff explicitly (ISO timestamp) before that first live run.
 * A failed live intake still leaves the hash and watermark for those items
 * unchanged, so the run can retry. The go-live stamp is written only after
 * the run finishes without an intake error.
 */
import type { Pool } from 'pg';
import type { ScanSubmission, RawScanResult } from '../types/intake';
import { getAppState, setAppState } from '../db';
import { normalizeUrl } from '../utils/url';
import { runDailyIntake } from './daily-intake';
import { fetchSource, SOURCE_REGISTRY, type FeedItem } from '../services/source-feeds';
import { applySourceFeedConfig, normalizeSourceFeedConfig, SOURCE_FEED_CONFIG_KEY } from '../services/source-feed-config';
import {
  getDueSurfaces,
  surfaceToRssSource,
  surfaceToScrapeSource,
  overlapsSeedRegistry,
  contentHash,
  markChecked,
  skipsPlainFetch,
} from '../services/registry-watchers';
import { checkBudget } from '../services/budget-guard';
import { scrapeUrl } from '../services/scraper';
import { sleep } from '../utils/async';
import { logApiUsage } from '../services/api-usage';
import { config } from '../config';

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const SEEN_CAP = 300; // rolling per-surface seen-URL memory (smaller than source-feeds' 800: these are single-org surfaces, not aggregators)

interface SeenState { urls: string[]; lastRun?: string }

export interface LaneStat {
  surfaces: number;
  fresh: number;
  changed?: number;
  extracted?: number;
  errors: number;
}

export interface RegistryWatchResult {
  ran: boolean;
  mode: 'disabled' | 'dry-run' | 'live';
  submitted: number;
  pending: number;
  deferred_surfaces: number;
  reason?: string;
  rss: LaneStat;
  diff: LaneStat;
}

/** Latest dry-run would-submit list. Curator GET /api/registry-watch/pending reads this. */
export const REGISTRY_WATCH_PENDING_KEY = 'registry-watch:pending';
/** ISO timestamp written at the end of the first successful live run. */
export const REGISTRY_WATCH_LIVE_SINCE_KEY = 'registry-watch:live-since';
const PENDING_ITEM_CAP = 2000;

export interface RegistryWatchPendingItem {
  title: string;
  url: string;
  org: string;
  wire: string;
  reason: string;
  surfaceId: number;
  recordedAt: string;
}

export interface RegistryWatchPendingSnapshot {
  recordedAt: string | null;
  itemCount: number;
  items: RegistryWatchPendingItem[];
  /** When the latest dry run finished. May be later than recordedAt. */
  lastRunAt?: string | null;
  /** How many items that latest run would have submitted. 0 keeps the previous list. */
  lastRunItemCount?: number;
}

export function emptyPendingSnapshot(): RegistryWatchPendingSnapshot {
  return { recordedAt: null, itemCount: 0, items: [] };
}

export function normalizePendingSnapshot(raw: unknown): RegistryWatchPendingSnapshot {
  if (!raw || typeof raw !== 'object') return emptyPendingSnapshot();
  const row = raw as Record<string, unknown>;
  const recordedAt = typeof row.recordedAt === 'string' ? row.recordedAt : null;
  const items: RegistryWatchPendingItem[] = [];
  if (Array.isArray(row.items)) {
    for (const item of row.items) {
      if (!item || typeof item !== 'object') continue;
      const it = item as Record<string, unknown>;
      if (typeof it.title !== 'string' || typeof it.url !== 'string') continue;
      items.push({
        title: it.title,
        url: it.url,
        org: typeof it.org === 'string' ? it.org : '',
        wire: typeof it.wire === 'string' ? it.wire : '',
        reason: typeof it.reason === 'string' ? it.reason : '',
        surfaceId: typeof it.surfaceId === 'number' ? it.surfaceId : 0,
        recordedAt: typeof it.recordedAt === 'string' ? it.recordedAt : recordedAt || '',
      });
    }
  }
  const itemCount = typeof row.itemCount === 'number' ? row.itemCount : items.length;
  const lastRunAt = typeof row.lastRunAt === 'string' ? row.lastRunAt : null;
  const lastRunItemCount = typeof row.lastRunItemCount === 'number' ? row.lastRunItemCount : itemCount;
  return { recordedAt, itemCount, items, lastRunAt, lastRunItemCount };
}

/**
 * Live-run gate. Dated items submit only when published at or after the
 * go-live cutoff. Undated items submit on later runs (they were not in the
 * backlog the cutoff run already marked seen). The backlog override submits
 * every fresh item.
 */
export function keepForLiveSubmit(
  item: { publishedAt?: string | null },
  liveSinceIso: string,
  firstLiveRun: boolean,
  submitBacklog: boolean,
): boolean {
  if (submitBacklog) return true;
  const published = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
  const cutoff = Date.parse(liveSinceIso);
  if (!Number.isNaN(published) && !Number.isNaN(cutoff)) return published >= cutoff;
  return !firstLiveRun;
}

/** Injectable seams so runRegistryWatch's branches are unit-testable without network or DB. */
export interface RegistryWatchDeps {
  getDue?: typeof getDueSurfaces;
  fetchSourceImpl?: typeof fetchSource;
  fetchPage?: (url: string) => Promise<string>;
  /** Fallback content fetch when the plain fetch fails (bot-walled surfaces). */
  scrapePage?: (url: string) => Promise<string>;
  /** One-shot scrape for hosts that 429 a plain fetch. Defaults to a single Firecrawl attempt. */
  scrapeOnce?: (url: string) => Promise<string>;
  /** Rate-limit gap between Firecrawl-bound calls; injectable so tests don't sleep. */
  pace?: (ms: number) => Promise<void>;
  intake?: typeof runDailyIntake;
  mark?: typeof markChecked;
  getState?: typeof getAppState;
  setState?: typeof setAppState;
  budget?: typeof checkBudget;
}

function toRaw(it: FeedItem): RawScanResult {
  return {
    name: it.name,
    description: it.description,
    sourceUrl: it.url,
    amount: it.amount,
    deadline: it.deadline,
    sourcePublishedAt: it.publishedAt,
  };
}

async function defaultFetchPage(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: { 'User-Agent': BROWSER_UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

/**
 * Change-detection content via Firecrawl for surfaces a plain fetch cannot
 * reach. The 2026-08-01 Tier 1 dry run showed real funders behind bot walls:
 * OpenAI and Octant 403 datacenter IPs, Aptos and fil.org 429 them, and
 * starknet.io drops the TLS handshake — all while serving browsers fine.
 *
 * Cost note: scrapeUrl retries internally (up to 3 Firecrawl calls, ~30s
 * timeout each), so a surface that fails BOTH paths can take ~90s and 3
 * paid calls. SCRAPE_FALLBACK_CAP bounds the blast radius of a mass-failure
 * day (network egress issue, Firecrawl outage): beyond the cap, surfaces
 * fail fast exactly as they did before the fallback existed, so a bad day
 * cannot stall the daily fold that runs the digest after this lane.
 */
const SCRAPE_FALLBACK_CAP = 15;

/**
 * Gap between consecutive Firecrawl-bound calls (fallback scrapes and change
 * extractions). The free tier measured at ~13 req/min with maxConcurrency 2
 * during the 2026-08-01 dry run — an unpaced extraction burst 429'd mid-run
 * and lost surfaces. 6s spacing keeps us near 10/min with headroom for
 * scrapeUrl's internal retries, at zero dollars. The first call is never
 * delayed, so a quiet day (no changes, no fallbacks) pays nothing.
 */
const FIRECRAWL_PACE_MS = 6000;

async function defaultScrapePage(url: string): Promise<string> {
  const r = await scrapeUrl(url, { job: 'registry-watch' });
  if (!r.success || !r.content) throw new Error(r.error || 'scrape returned empty content');
  return r.content;
}

/** One Firecrawl attempt. Used for fil.org and any plain fetch that already returned 429. */
async function defaultScrapeOnce(url: string): Promise<string> {
  const r = await scrapeUrl(url, { attempts: 1, job: 'registry-watch' });
  if (!r.success || !r.content) throw new Error(r.error || 'scrape returned empty content');
  return r.content;
}

/**
 * Net-new items against a surface's seen-URL watermark (same shape/merge logic
 * as source-feeds' per-source watermark, cap lowered to SEEN_CAP). First-ever
 * application of a given watermark key is a baseline: everything fetched is
 * marked seen and nothing is reported fresh, so turning a lane on for a
 * surface (or a surface's first-ever content-change extraction) doesn't flood
 * intake with its whole existing backlog.
 */
function diffSeen(
  items: FeedItem[],
  state: SeenState | null,
  nowIso: string,
  opts: { baselineWhenMissing?: boolean } = {},
): { fresh: FeedItem[]; baseline: boolean; nextState: SeenState } {
  const baseline = (opts.baselineWhenMissing ?? true) && (!state || !Array.isArray(state.urls));
  const seen = new Set((state?.urls || []).map(normalizeUrl));
  const batch = new Set<string>();
  const fresh: FeedItem[] = [];
  for (const it of items) {
    const nu = normalizeUrl(it.url);
    if (seen.has(nu) || batch.has(nu)) continue;
    batch.add(nu);
    if (!baseline) fresh.push(it);
  }
  const mergedUrls = [...items.map(it => normalizeUrl(it.url)), ...(state?.urls || [])];
  const dedupedUrls: string[] = [];
  const s = new Set<string>();
  for (const u of mergedUrls) { if (!s.has(u)) { s.add(u); dedupedUrls.push(u); } if (dedupedUrls.length >= SEEN_CAP) break; }
  return { fresh, baseline, nextState: { urls: dedupedUrls, lastRun: nowIso } };
}

export async function runRegistryWatch(
  pool: Pool,
  opts: { dryRun?: boolean } = {},
  deps: RegistryWatchDeps = {},
): Promise<RegistryWatchResult> {
  const emptyStat = (): LaneStat => ({ surfaces: 0, fresh: 0, errors: 0 });

  // Read at call time (not module load) so tests don't need require-cache
  // gymnastics to flip it; the scheduler's own gate is the module-load-time one.
  if (process.env.REGISTRY_WATCH_ENABLED !== 'true') {
    return { ran: false, mode: 'disabled', submitted: 0, pending: 0, deferred_surfaces: 0, reason: 'disabled', rss: emptyStat(), diff: emptyStat() };
  }

  const getDueImpl = deps.getDue ?? getDueSurfaces;
  const fetchSourceImpl = deps.fetchSourceImpl ?? fetchSource;
  const fetchPageImpl = deps.fetchPage ?? defaultFetchPage;
  const scrapePageImpl = deps.scrapePage ?? defaultScrapePage;
  // Tests that stub scrapePage cover both paths. Production uses one attempt
  // for a host that already 429'd, and the full retry only for other failures.
  const scrapeOnceImpl = deps.scrapeOnce ?? deps.scrapePage ?? defaultScrapeOnce;
  const paceImpl = deps.pace ?? sleep;
  const intakeImpl = deps.intake ?? runDailyIntake;
  const markImpl = deps.mark ?? markChecked;
  const getStateImpl = deps.getState ?? getAppState;
  const setStateImpl = deps.setState ?? setAppState;
  const budgetImpl = deps.budget ?? checkBudget;

  const rssCap = config.watchtower.registryRssCap;
  const diffCap = config.watchtower.registryDiffCap;
  const extractCap = config.watchtower.registryExtractCap;
  const dryRun = opts.dryRun ?? config.watchtower.registryWatchDryRun;

  const start = Date.now();
  const today = new Date().toISOString().split('T')[0];
  const nowIso = new Date().toISOString();
  const submissions: ScanSubmission[] = [];
  const pendingItems: RegistryWatchPendingItem[] = [];
  let submittedCount = 0;
  const pendingDeliveries: Array<{
    checkpoint: () => Promise<void>;
    markSuccess: () => Promise<void>;
    markDeferred: () => Promise<void>;
    markFailure: () => Promise<void>;
  }> = [];

  const storedLiveSince = dryRun ? null : await getStateImpl<string>(REGISTRY_WATCH_LIVE_SINCE_KEY);
  const firstLiveRun = !dryRun && !storedLiveSince;
  const submitBacklog = process.env.REGISTRY_WATCH_SUBMIT_BACKLOG === 'true';
  const envLiveSince = process.env.REGISTRY_WATCH_LIVE_SINCE;
  const liveSince = storedLiveSince
    || (envLiveSince && !Number.isNaN(Date.parse(envLiveSince)) ? new Date(envLiveSince).toISOString() : nowIso);

  const feedConfig = normalizeSourceFeedConfig(await getStateImpl(SOURCE_FEED_CONFIG_KEY));
  const seedEndpoints = new Set(
    applySourceFeedConfig(SOURCE_REGISTRY, feedConfig)
      .filter(source => source.enabled)
      .map(source => normalizeUrl(source.endpoint)),
  );

  async function deliverFresh(args: {
    surf: { id: number; org_name: string; wire: string | null };
    fresh: FeedItem[];
    nextState: SeenState;
    stateKey: string;
    submittedBy: string;
    reason: string;
    hashKey?: string;
    hash?: string;
  }): Promise<void> {
    const toSubmit = dryRun
      ? args.fresh
      : args.fresh.filter(it => keepForLiveSubmit(it, liveSince, firstLiveRun, submitBacklog));

    if (dryRun) {
      for (const it of toSubmit) {
        if (pendingItems.length >= PENDING_ITEM_CAP) break;
        pendingItems.push({
          title: it.name,
          url: it.url,
          org: args.surf.org_name,
          wire: args.surf.wire || 'crypto',
          reason: args.reason,
          surfaceId: args.surf.id,
          recordedAt: nowIso,
        });
      }
    }

    const checkpoint = async () => {
      await setStateImpl(args.stateKey, args.nextState);
      if (args.hashKey) await setStateImpl(args.hashKey, args.hash);
    };

    if (dryRun || toSubmit.length === 0) {
      await checkpoint();
      await markImpl(pool, args.surf.id, {
        changed: true,
        itemsFound: dryRun ? args.fresh.length : toSubmit.length,
        failed: false,
      });
      return;
    }

    submittedCount += toSubmit.length;
    submissions.push({
      wire: args.surf.wire || 'crypto',
      promptVariant: 'N',
      scanDate: today,
      source: 'feed',
      submittedBy: args.submittedBy,
      results: toSubmit.map(toRaw),
    });
    pendingDeliveries.push({
      checkpoint,
      markSuccess: () => markImpl(pool, args.surf.id, { changed: true, itemsFound: toSubmit.length, failed: false }),
      markDeferred: () => markImpl(pool, args.surf.id, { changed: true, itemsFound: 0, failed: false }),
      markFailure: () => markImpl(pool, args.surf.id, { failed: true }),
    });
  }

  // ---- RSS lane ----
  const rssStat: LaneStat = { surfaces: 0, fresh: 0, errors: 0 };
  const rssSurfaces = await getDueImpl(pool, ['rss'], rssCap, config.watchtower.registryTiers);
  rssStat.surfaces = rssSurfaces.length;

  for (const surf of rssSurfaces) {
    if (overlapsSeedRegistry(surf, seedEndpoints)) {
      // Already ingested via the seed registry's own feed source — stop it
      // from coming up as due again without treating it as a failure.
      await markImpl(pool, surf.id, { itemsFound: 0 });
      continue;
    }
    try {
      const items = await fetchSourceImpl(surfaceToRssSource(surf));
      const stateKey = `ws:seen:${surf.id}`;
      const seenState = await getStateImpl<SeenState>(stateKey);
      const { fresh, nextState } = diffSeen(items, seenState, nowIso);

      if (fresh.length) {
        await deliverFresh({
          surf,
          fresh,
          nextState,
          stateKey,
          submittedBy: `ws-rss:${surf.id}`,
          reason: 'New item on the RSS feed',
        });
      } else {
        // Baselines and clean no-op polls have no downstream durability
        // dependency, so their seen state can advance immediately.
        await setStateImpl(stateKey, nextState);
        await markImpl(pool, surf.id, { changed: false, itemsFound: 0, failed: false });
      }
      rssStat.fresh += fresh.length;
    } catch (err) {
      rssStat.errors++;
      await markImpl(pool, surf.id, { failed: true });
      console.warn(`[RegistryWatch] rss surface ${surf.id} (${surf.org_name}) failed:`, err instanceof Error ? err.message : err);
    }
  }

  // ---- html_diff lane ----
  const diffStat: LaneStat = { surfaces: 0, fresh: 0, changed: 0, extracted: 0, errors: 0 };
  const diffSurfaces = await getDueImpl(pool, ['grants_page', 'application'], diffCap, config.watchtower.registryTiers);
  diffStat.surfaces = diffSurfaces.length;

  // Budget is consulted at most once per run, lazily, the first time a page
  // is found actually changed (and not a baseline) — not paid up front for
  // pages that never change, and not paid again once we know the answer.
  let deferredSurfaces = 0;
  let budgetChecked = false;
  let budgetAllowed = true;
  let extractedThisRun = 0;

  let scrapeFallbacksUsed = 0;

  // First Firecrawl-bound call goes immediately; each subsequent one waits
  // FIRECRAWL_PACE_MS so an extraction/fallback burst stays under the
  // free-tier per-minute limit instead of 429ing mid-run.
  let firecrawlCalls = 0;
  const paceFirecrawl = async (): Promise<void> => {
    if (firecrawlCalls++ > 0) await paceImpl(FIRECRAWL_PACE_MS);
  };

  const scrapeLimited = async (url: string, why: string): Promise<string> => {
    if (scrapeFallbacksUsed >= SCRAPE_FALLBACK_CAP) {
      throw new Error(`${why} (scrape-fallback cap ${SCRAPE_FALLBACK_CAP} reached)`);
    }
    scrapeFallbacksUsed++;
    await paceFirecrawl();
    try {
      return await scrapeOnceImpl(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${why}; scrape fallback failed: ${msg}`);
    }
  };

  for (const surf of diffSurfaces) {
    let html: string;
    try {
      if (skipsPlainFetch(surf.url)) {
        // fil.org 429s every non-browser client. One paced scrape, no plain-fetch loop.
        html = await scrapeLimited(surf.url, `plain fetch skipped (${new URL(surf.url).hostname} returns 429 to non-browser clients)`);
        console.log(`[RegistryWatch] diff surface ${surf.id} (${surf.org_name}) scrape-only — skipped plain fetch`);
      } else {
        try {
          html = await fetchPageImpl(surf.url);
        } catch (err) {
          // Bot-walled funder sites reject the plain fetch but serve Firecrawl fine.
          // NOTE: the hash basis flips between raw HTML and scraped markdown when a
          // surface transitions between modes — worst case one spurious "changed"
          // extraction, still capped and budget-gated below.
          const firstErr = err instanceof Error ? err.message : String(err);
          if (/HTTP 429/.test(firstErr)) {
            await paceImpl(FIRECRAWL_PACE_MS);
            html = await scrapeLimited(surf.url, `plain fetch failed (${firstErr})`);
            console.log(`[RegistryWatch] diff surface ${surf.id} (${surf.org_name}) HTTP 429 — one scrape after backoff`);
          } else if (scrapeFallbacksUsed >= SCRAPE_FALLBACK_CAP) {
            throw new Error(`${firstErr} (scrape-fallback cap ${SCRAPE_FALLBACK_CAP} reached)`);
          } else {
            scrapeFallbacksUsed++;
            await paceFirecrawl();
            try {
              html = await scrapePageImpl(surf.url);
            } catch (err2) {
              const msg = err2 instanceof Error ? err2.message : String(err2);
              throw new Error(`${firstErr}; scrape fallback failed: ${msg}`);
            }
            console.log(`[RegistryWatch] diff surface ${surf.id} (${surf.org_name}) plain fetch failed (${firstErr}) — used scrape fallback`);
          }
        }
      }
    } catch (err) {
      diffStat.errors++;
      await markImpl(pool, surf.id, { failed: true });
      console.warn(`[RegistryWatch] diff surface ${surf.id} (${surf.org_name}) fetch failed:`, err instanceof Error ? err.message : err);
      continue;
    }

    const hash = contentHash(html);
    const hashKey = `ws:hash:${surf.id}`;
    const prevHash = await getStateImpl<string>(hashKey);

    if (prevHash === hash) {
      await markImpl(pool, surf.id, {});
      continue;
    }

    const baseline = !prevHash;
    if (baseline) {
      // First-ever check of this surface: nothing to diff against yet, so
      // there's nothing to extract. Storing only the free page hash avoids a
      // paid baseline extraction. The first later change is treated as fresh.
      await setStateImpl(hashKey, hash);
      await markImpl(pool, surf.id, { changed: false });
      continue;
    }

    diffStat.changed = (diffStat.changed || 0) + 1;

    if (!budgetChecked) {
      budgetChecked = true;
      try {
        const budget = await budgetImpl(pool);
        budgetAllowed = budget.allowed;
      } catch (err) {
        // Fail closed on spend and leave the prior hash intact. The same page
        // change will be retried on the next due run.
        budgetAllowed = false;
        diffStat.errors++;
        console.warn(`[RegistryWatch] budget check failed — failing closed, no extraction this run: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!budgetAllowed) {
      deferredSurfaces++;
      console.log('[RegistryWatch] extraction skipped — budget reached');
      await markImpl(pool, surf.id, { changed: true });
      continue;
    }

    if (extractedThisRun >= extractCap) {
      deferredSurfaces++;
      console.log(`[RegistryWatch] extraction cap reached (${extractCap}/run) — deferring change to the next run`);
      await markImpl(pool, surf.id, { changed: true });
      continue;
    }

    extractedThisRun++;
    diffStat.extracted = (diffStat.extracted || 0) + 1;

    try {
      await paceFirecrawl();
      const items = await fetchSourceImpl(surfaceToScrapeSource(surf));
      const stateKey = `ws:seen:${surf.id}`;
      const seenState = await getStateImpl<SeenState>(stateKey);
      // The initial hash baseline deliberately avoids a paid extraction, so
      // the first actual change must not establish a second seen baseline.
      // Treat its extracted items as fresh and let intake/dedup decide which
      // are already known.
      const { fresh, nextState } = diffSeen(items, seenState, nowIso, { baselineWhenMissing: false });

      if (fresh.length) {
        await deliverFresh({
          surf,
          fresh,
          nextState,
          stateKey,
          submittedBy: `ws-diff:${surf.id}`,
          reason: 'Page content changed',
          hashKey,
          hash,
        });
      } else {
        // Extraction itself completed and produced nothing new, so this
        // change is durably resolved without an intake call.
        await setStateImpl(stateKey, nextState);
        await setStateImpl(hashKey, hash);
        await markImpl(pool, surf.id, { changed: true, itemsFound: 0, failed: false });
      }
      diffStat.fresh += fresh.length;
    } catch (err) {
      diffStat.errors++;
      await markImpl(pool, surf.id, { failed: true });
      console.warn(`[RegistryWatch] diff surface ${surf.id} (${surf.org_name}) extraction failed:`, err instanceof Error ? err.message : err);
    }
  }

  if (dryRun) {
    // A quiet run must not erase the last review copy. Those URLs are already
    // marked seen, so the copy is for reading, not a queue that go-live drains.
    let snapshot: RegistryWatchPendingSnapshot;
    if (pendingItems.length === 0) {
      const existing = normalizePendingSnapshot(await getStateImpl(REGISTRY_WATCH_PENDING_KEY));
      snapshot = existing.items.length > 0
        ? { ...existing, lastRunAt: nowIso, lastRunItemCount: 0 }
        : { recordedAt: nowIso, itemCount: 0, items: [], lastRunAt: nowIso, lastRunItemCount: 0 };
    } else {
      snapshot = {
        recordedAt: nowIso,
        itemCount: pendingItems.length,
        items: pendingItems,
        lastRunAt: nowIso,
        lastRunItemCount: pendingItems.length,
      };
    }
    await setStateImpl(REGISTRY_WATCH_PENDING_KEY, snapshot);
    console.log(`[RegistryWatch] DRY RUN — would submit ${pendingItems.length} item(s); saved to ${REGISTRY_WATCH_PENDING_KEY}`);
  } else if (submissions.length > 0) {
    try {
      await intakeImpl(pool, submissions, {});
      for (const pending of pendingDeliveries) {
        await pending.checkpoint();
        await pending.markSuccess();
      }
    } catch (err) {
      for (const pending of pendingDeliveries) {
        await pending.markFailure().catch(() => undefined);
      }
      logApiUsage({ provider: 'watchtower', model: 'registry-watch', purpose: 'watchtower-registry-run', duration_ms: Date.now() - start, success: false, error_message: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  if (!dryRun && firstLiveRun) {
    await setStateImpl(REGISTRY_WATCH_LIVE_SINCE_KEY, liveSince);
  }

  logApiUsage({ provider: 'watchtower', model: 'registry-watch', purpose: 'watchtower-registry-run', duration_ms: Date.now() - start, success: rssStat.errors + diffStat.errors === 0, error_message: rssStat.errors + diffStat.errors > 0 ? 'Partial run: some surfaces failed' : undefined });
  return {
    ran: true,
    mode: dryRun ? 'dry-run' : 'live',
    submitted: dryRun ? 0 : submittedCount,
    pending: pendingItems.length,
    deferred_surfaces: deferredSurfaces,
    rss: rssStat,
    diff: diffStat,
  };
}
