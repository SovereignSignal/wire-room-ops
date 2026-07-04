/**
 * Registry Watch Job (Watchtower Phase 1) — two lanes over watch_surfaces:
 *
 *  - rss: surfaces with a machine-readable feed. Reuses the feeds engine
 *    (fetchSource) plus a per-surface seen-URL watermark (same shape as
 *    source-feeds, smaller cap: this table is O(100s) of small surfaces, not
 *    a handful of high-volume aggregators).
 *  - html_diff: surfaces with only an HTML page. Hash the page's text content
 *    and only pay for an LLM extraction (Firecrawl + grok, via the same
 *    fetchSource('scrape') path) when the hash actually changes AND it isn't
 *    the surface's first-ever check (a baseline has nothing to diff against).
 *
 * Selection, seed-registry overlap, content hashing, and checked-state
 * writeback live in services/registry-watchers.ts; this job wires those into
 * intake exactly like jobs/source-feeds.ts / jobs/x-lists.ts. Deps-injection
 * style mirrors x-lists.ts so every branch (baseline, unchanged, budget-block,
 * cap-overflow, dry-run) is unit-testable without network or DB.
 *
 * Gates: default OFF (REGISTRY_WATCH_ENABLED, read at call time — the
 * scheduler also guards this; double gate is deliberate) and default dry-run
 * (registryWatchDryRun). Watermarks/hashes/checked-state advance in BOTH
 * modes — dry-run only withholds the intake call, mirroring x-lists.
 */
import type { Pool } from 'pg';
import type { ScanSubmission, RawScanResult } from '../types/intake';
import { getAppState, setAppState } from '../db';
import { normalizeUrl } from '../utils/url';
import { runDailyIntake } from './daily-intake';
import { fetchSource, type FeedItem } from '../services/source-feeds';
import {
  getDueSurfaces,
  surfaceToRssSource,
  surfaceToScrapeSource,
  overlapsSeedRegistry,
  contentHash,
  markChecked,
} from '../services/registry-watchers';
import { checkBudget } from '../services/budget-guard';
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
  reason?: string;
  rss: LaneStat;
  diff: LaneStat;
}

/** Injectable seams so runRegistryWatch's branches are unit-testable without network or DB. */
export interface RegistryWatchDeps {
  getDue?: typeof getDueSurfaces;
  fetchSourceImpl?: typeof fetchSource;
  fetchPage?: (url: string) => Promise<string>;
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
 * Net-new items against a surface's seen-URL watermark (same shape/merge logic
 * as source-feeds' per-source watermark, cap lowered to SEEN_CAP). First-ever
 * application of a given watermark key is a baseline: everything fetched is
 * marked seen and nothing is reported fresh, so turning a lane on for a
 * surface (or a surface's first-ever content-change extraction) doesn't flood
 * intake with its whole existing backlog.
 */
function diffSeen(items: FeedItem[], state: SeenState | null, nowIso: string): { fresh: FeedItem[]; baseline: boolean; nextState: SeenState } {
  const baseline = !state || !Array.isArray(state.urls);
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
    return { ran: false, reason: 'disabled', rss: emptyStat(), diff: emptyStat() };
  }

  const getDueImpl = deps.getDue ?? getDueSurfaces;
  const fetchSourceImpl = deps.fetchSourceImpl ?? fetchSource;
  const fetchPageImpl = deps.fetchPage ?? defaultFetchPage;
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

  // ---- RSS lane ----
  const rssStat: LaneStat = { surfaces: 0, fresh: 0, errors: 0 };
  const rssSurfaces = await getDueImpl(pool, ['rss'], rssCap);
  rssStat.surfaces = rssSurfaces.length;

  for (const surf of rssSurfaces) {
    if (overlapsSeedRegistry(surf)) {
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
      await setStateImpl(stateKey, nextState);

      if (fresh.length) {
        submissions.push({
          wire: surf.wire || 'crypto',
          promptVariant: 'N',
          scanDate: today,
          source: 'feed',
          submittedBy: `ws-rss:${surf.id}`,
          results: fresh.map(toRaw),
        });
      }
      rssStat.fresh += fresh.length;
      await markImpl(pool, surf.id, { changed: fresh.length > 0, itemsFound: fresh.length, failed: false });
    } catch (err) {
      rssStat.errors++;
      await markImpl(pool, surf.id, { failed: true });
      console.warn(`[RegistryWatch] rss surface ${surf.id} (${surf.org_name}) failed:`, err instanceof Error ? err.message : err);
    }
  }

  // ---- html_diff lane ----
  const diffStat: LaneStat = { surfaces: 0, fresh: 0, changed: 0, extracted: 0, errors: 0 };
  const diffSurfaces = await getDueImpl(pool, ['grants_page', 'application'], diffCap);
  diffStat.surfaces = diffSurfaces.length;

  // Budget is consulted at most once per run, lazily, the first time a page
  // is found actually changed (and not a baseline) — not paid up front for
  // pages that never change, and not paid again once we know the answer.
  let budgetChecked = false;
  let budgetAllowed = true;
  let extractedThisRun = 0;

  for (const surf of diffSurfaces) {
    let html: string;
    try {
      html = await fetchPageImpl(surf.url);
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
    await setStateImpl(hashKey, hash);

    const baseline = !prevHash;
    if (baseline) {
      // First-ever check of this surface: nothing to diff against yet, so
      // there's nothing to extract — the hash we just stored *is* the baseline.
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
        // This is a cost brake under an explicit owner cap: if the probe
        // itself breaks, fail CLOSED — never spend on a guess. Changes are
        // still recorded (hash + markChecked), so extraction just waits for
        // a run where the budget answer is actually known.
        budgetAllowed = false;
        console.warn(`[RegistryWatch] budget check failed — failing closed, no extraction this run: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!budgetAllowed) {
      console.log('[RegistryWatch] extraction skipped — budget reached');
      await markImpl(pool, surf.id, { changed: true });
      continue;
    }

    if (extractedThisRun >= extractCap) {
      console.log(`[RegistryWatch] extraction cap reached (${extractCap}/run) — recording change without extracting`);
      await markImpl(pool, surf.id, { changed: true });
      continue;
    }

    extractedThisRun++;
    diffStat.extracted = (diffStat.extracted || 0) + 1;

    try {
      const items = await fetchSourceImpl(surfaceToScrapeSource(surf));
      const stateKey = `ws:seen:${surf.id}`;
      const seenState = await getStateImpl<SeenState>(stateKey);
      const { fresh, nextState } = diffSeen(items, seenState, nowIso);
      await setStateImpl(stateKey, nextState);

      if (fresh.length) {
        submissions.push({
          wire: surf.wire || 'crypto',
          promptVariant: 'N',
          scanDate: today,
          source: 'feed',
          submittedBy: `ws-diff:${surf.id}`,
          results: fresh.map(toRaw),
        });
      }
      diffStat.fresh += fresh.length;
      await markImpl(pool, surf.id, { changed: true, itemsFound: fresh.length });
    } catch (err) {
      diffStat.errors++;
      await markImpl(pool, surf.id, { failed: true });
      console.warn(`[RegistryWatch] diff surface ${surf.id} (${surf.org_name}) extraction failed:`, err instanceof Error ? err.message : err);
    }
  }

  const totalFresh = rssStat.fresh + diffStat.fresh;
  if (totalFresh > 0) {
    if (dryRun) {
      console.log(`[RegistryWatch] DRY RUN — would submit ${submissions.length} submission(s), ${totalFresh} fresh item(s)`);
    } else {
      await intakeImpl(pool, submissions, {});
    }
  }

  logApiUsage({ provider: 'watchtower', model: 'registry-watch', purpose: 'watchtower-registry-run', duration_ms: Date.now() - start, success: true });
  return { ran: true, rss: rssStat, diff: diffStat };
}
