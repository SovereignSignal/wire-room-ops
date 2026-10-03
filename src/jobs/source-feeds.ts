/**
 * Source Feeds Job — pull net-new opportunities from registry sources into intake.
 *
 * For each enabled source: fetch -> filter to net-new since a per-source watermark
 * (app_state KV) -> push through runDailyIntake as scan_source='feed'. Only net-new
 * items reach the classifier, so steady-state cost is pennies/day. A first-run guard
 * seeds the watermark from the current backlog and submits only the most-recent few,
 * so turning a source on doesn't flood the queue with its archive.
 */

import type { Pool } from 'pg';
import type { ScanSubmission, RawScanResult, IntakeRunSummary, IntakeJobConfig } from '../types/intake';
import { getAppState, setAppState } from '../db';
import { normalizeUrl } from '../utils/url';
import { sleep } from '../utils/async';
import { runDailyIntake } from './daily-intake';
import {
  SOURCE_REGISTRY,
  fetchSource,
  classifyFetchError,
  DEFAULT_TIMEOUT_MS,
  type FeedSource,
  type FeedItem,
} from '../services/source-feeds';
import { applySourceFeedConfig, normalizeSourceFeedConfig, SOURCE_FEED_CONFIG_KEY } from '../services/source-feed-config';
import { EMPTY_SCRAPE_DAYS, nextEmptyScrapeStreak } from './daily-digest';

export interface SourceFeedsOptions {
  wire?: string;
  sourceKeys?: string[];
  onProgress?: (message: string, pct: number) => void;
  config?: Partial<IntakeJobConfig>;
}

export interface SourceFeedsResult {
  perSource: Array<{ key: string; name: string; fetched: number; fresh: number; firstRun: boolean; error?: string; lastOk?: string | null; emptyStreak?: number }>;
  totalFresh: number;
  intakeSummary: IntakeRunSummary;
  durationMs: number;
}

const SEEN_CAP = 800;             // rolling per-source seen-URL memory
const FIRST_RUN_LIMIT = 12;       // baseline items to submit when a source is first seen

interface SeenState { urls: string[]; lastRun?: string; emptyStreak?: number }

function toRaw(it: FeedItem): RawScanResult {
  return {
    name: it.name,
    description: it.description,
    sourceUrl: it.url,
    amount: it.amount,
    deadline: it.deadline,
    sourcePublishedAt: it.publishedAt,
    metadata: it.metadata,
  };
}

/**
 * One retry, transient failures only.
 *
 * Deliberately not `withRetry()`: that helper retries every error, and the
 * `scrape` method calls Firecrawl (paid). Retrying a permanently-broken scrape
 * source would double that cost every day, forever.
 *
 * fetchImpl/sleepImpl are injectable seams so this is unit-testable without network.
 */
export async function fetchSourceWithTransientRetry(
  source: FeedSource,
  fetchImpl: (s: FeedSource) => Promise<FeedItem[]> = fetchSource,
  sleepImpl: (ms: number) => Promise<void> = sleep,
): Promise<FeedItem[]> {
  const timeoutMs = source.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    return await fetchImpl(source);
  } catch (err) {
    const first = classifyFetchError(err, timeoutMs);
    if (!first.transient) throw first;
    console.warn(`[Feeds] ${source.key} transient failure (${first.message}) — retrying once`);
    await sleepImpl(2000);
    try {
      return await fetchImpl(source);
    } catch (err2) {
      throw classifyFetchError(err2, timeoutMs);
    }
  }
}

export async function runSourceFeeds(
  pool: Pool,
  options: SourceFeedsOptions = {},
): Promise<SourceFeedsResult> {
  const progress = options.onProgress || (() => {});
  const startTime = Date.now();
  const today = new Date().toISOString().split('T')[0];
  const nowIso = new Date().toISOString();

  let feedConfig = normalizeSourceFeedConfig(null);
  try {
    feedConfig = normalizeSourceFeedConfig(await getAppState(SOURCE_FEED_CONFIG_KEY));
  } catch { /* a missing config table uses the built-in registry */ }
  const effective = applySourceFeedConfig(SOURCE_REGISTRY, feedConfig);
  const sources: FeedSource[] = options.sourceKeys?.length
    ? effective.filter(s => options.sourceKeys!.includes(s.key))
    : effective.filter(s => s.enabled && (!options.wire || s.wire === options.wire));

  progress(`Pulling ${sources.length} feed sources...`, 0);

  const submissions: ScanSubmission[] = [];
  const perSource: SourceFeedsResult['perSource'] = [];
  // Seen-URL watermarks are collected here and only persisted AFTER intake
  // succeeds. Writing them earlier permanently discarded a run's discoveries
  // whenever intake failed: items were marked seen but never reached the DB.
  const pendingSeenStates: Array<{ stateKey: string; state: SeenState }> = [];
  const flushSeenStates = async () => {
    for (const p of pendingSeenStates) {
      try { await setAppState(p.stateKey, p.state); }
      catch (err) { console.warn(`[Feeds] Failed to persist seen-state ${p.stateKey}:`, err instanceof Error ? err.message : err); }
    }
  };

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const pct = Math.round((i / Math.max(sources.length, 1)) * 55);
    progress(`Fetching ${source.name}`, pct);

    const stateKey = `feed:seen:${source.key}`;
    let state: SeenState | null = null;
    try { state = await getAppState<SeenState>(stateKey); } catch { /* treat as first run */ }
    const firstRun = !state || !Array.isArray(state.urls);
    const seen = new Set((state?.urls || []).map(normalizeUrl));

    try {
      const items = await fetchSourceWithTransientRetry(source);

      // net-new (unseen URL) + within-run dedup. No publish-age filter: an opportunity
      // posted months ago can still be open (its deadline gates relevance, not its post date).
      const batch = new Set<string>();
      let fresh: FeedItem[] = [];
      for (const it of items) {
        const nu = normalizeUrl(it.url);
        if (seen.has(nu) || batch.has(nu)) continue;
        batch.add(nu);
        fresh.push(it);
      }

      // First-run baseline: a source's whole backlog is "new". Submit only a capped slice,
      // preferring still-open items (no deadline or a future one), so activation doesn't
      // flood the queue. Everything fetched is marked seen, so the rest won't re-surface.
      let capped = false;
      if (firstRun && fresh.length > FIRST_RUN_LIMIT) {
        const now = Date.now();
        const isOpen = (it: FeedItem) => {
          if (!it.deadline) return true;
          const t = Date.parse(it.deadline);
          return Number.isNaN(t) ? true : t >= now;
        };
        fresh = fresh.slice().sort((a, b) => {
          const ao = isOpen(a) ? 1 : 0, bo = isOpen(b) ? 1 : 0;
          if (ao !== bo) return bo - ao;                                                    // open first
          return (Date.parse(b.publishedAt || '') || 0) - (Date.parse(a.publishedAt || '') || 0); // then newest
        }).slice(0, FIRST_RUN_LIMIT);
        capped = true;
      }

      if (fresh.length) {
        const groups = new Map<string, FeedItem[]>();
        for (const it of fresh) {
          const itemWire = it.wire || source.wire;
          const list = groups.get(itemWire) || [];
          list.push(it);
          groups.set(itemWire, list);
        }
        for (const [itemWire, items] of groups) {
          submissions.push({
            wire: itemWire,
            promptVariant: 'N',
            scanDate: today,
            source: 'feed',
            submittedBy: `feed:${source.key}`,
            results: items.map(toRaw),
          });
        }
      }

      // Mark ALL fetched URLs seen (so old/recency-skipped items aren't reconsidered),
      // newest first, capped. Deferred to flushSeenStates() after intake succeeds.
      const mergedUrls = [...items.map(it => normalizeUrl(it.url)), ...(state?.urls || [])];
      const dedupedUrls: string[] = [];
      const s = new Set<string>();
      for (const u of mergedUrls) { if (!s.has(u)) { s.add(u); dedupedUrls.push(u); } if (dedupedUrls.length >= SEEN_CAP) break; }
      const emptyStreak = nextEmptyScrapeStreak(source.method, items.length, state?.emptyStreak);
      pendingSeenStates.push({ stateKey, state: { urls: dedupedUrls, lastRun: nowIso, emptyStreak } });

      perSource.push({ key: source.key, name: source.name, fetched: items.length, fresh: fresh.length, firstRun, emptyStreak });
      if (emptyStreak >= EMPTY_SCRAPE_DAYS) {
        console.warn(`[Feeds] ${source.key}: fetched 0 items ${emptyStreak} days running — the page may have moved`);
      }
      console.log(`[Feeds] ${source.key}: ${items.length} fetched, ${fresh.length} fresh${capped ? ` (first-run capped to ${FIRST_RUN_LIMIT})` : ''}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      perSource.push({
        key: source.key, name: source.name, fetched: 0, fresh: 0, firstRun,
        error: msg,
        lastOk: state?.lastRun ?? null,
      });
      console.warn(`[Feeds] ${source.key} failed: ${msg}`);
    }
  }

  const totalFresh = perSource.reduce((n, s) => n + s.fresh, 0);

  if (submissions.length === 0) {
    // Nothing fresh anywhere — persisting the watermarks loses nothing.
    await flushSeenStates();
    progress('No new feed items', 100);
    return {
      perSource, totalFresh: 0,
      intakeSummary: { runDate: today, wire: options.wire || 'all', totalIngested: 0, duplicatesFound: 0, newUnique: 0, averageQualityScore: 0, highQualityCount: 0, byPrompt: {}, topFinds: [] },
      durationMs: Date.now() - startTime,
    };
  }

  progress(`Running intake on ${totalFresh} fresh items from ${submissions.length} sources...`, 60);
  const intakeSummary = await runDailyIntake(pool, submissions, {
    config: options.config,
    onProgress: (msg, p) => progress(msg, 60 + Math.round(p * 0.4)),
  });

  // Intake persisted everything (per-item errors are handled inside runDailyIntake;
  // a throw above means nothing was durably processed — watermarks stay unwritten
  // so the next run retries the same items).
  await flushSeenStates();

  progress(`Feeds complete: ${totalFresh} fresh, ${intakeSummary.newUnique} unique, ${intakeSummary.highQualityCount} high quality`, 100);
  return { perSource, totalFresh, intakeSummary, durationMs: Date.now() - startTime };
}
