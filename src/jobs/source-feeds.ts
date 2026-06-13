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
import { runDailyIntake } from './daily-intake';
import {
  SOURCE_REGISTRY,
  getEnabledSources,
  fetchSource,
  type FeedSource,
  type FeedItem,
} from '../services/source-feeds';

export interface SourceFeedsOptions {
  wire?: string;
  sourceKeys?: string[];
  onProgress?: (message: string, pct: number) => void;
  config?: Partial<IntakeJobConfig>;
}

export interface SourceFeedsResult {
  perSource: Array<{ key: string; name: string; fetched: number; fresh: number; firstRun: boolean; error?: string }>;
  totalFresh: number;
  intakeSummary: IntakeRunSummary;
  durationMs: number;
}

const SEEN_CAP = 800;             // rolling per-source seen-URL memory
const FIRST_RUN_LIMIT = 12;       // baseline items to submit when a source is first seen

interface SeenState { urls: string[]; lastRun?: string }

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

export async function runSourceFeeds(
  pool: Pool,
  options: SourceFeedsOptions = {},
): Promise<SourceFeedsResult> {
  const progress = options.onProgress || (() => {});
  const startTime = Date.now();
  const today = new Date().toISOString().split('T')[0];
  const nowIso = new Date().toISOString();

  const sources: FeedSource[] = options.sourceKeys?.length
    ? SOURCE_REGISTRY.filter(s => options.sourceKeys!.includes(s.key))
    : getEnabledSources(options.wire);

  progress(`Pulling ${sources.length} feed sources...`, 0);

  const submissions: ScanSubmission[] = [];
  const perSource: SourceFeedsResult['perSource'] = [];

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
      const items = await fetchSource(source);

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
        submissions.push({
          wire: source.wire,
          promptVariant: 'N',
          scanDate: today,
          source: 'feed',
          submittedBy: `feed:${source.key}`,
          results: fresh.map(toRaw),
        });
      }

      // Mark ALL fetched URLs seen (so old/recency-skipped items aren't reconsidered),
      // newest first, capped.
      const mergedUrls = [...items.map(it => normalizeUrl(it.url)), ...(state?.urls || [])];
      const dedupedUrls: string[] = [];
      const s = new Set<string>();
      for (const u of mergedUrls) { if (!s.has(u)) { s.add(u); dedupedUrls.push(u); } if (dedupedUrls.length >= SEEN_CAP) break; }
      await setAppState(stateKey, { urls: dedupedUrls, lastRun: nowIso });

      perSource.push({ key: source.key, name: source.name, fetched: items.length, fresh: fresh.length, firstRun });
      console.log(`[Feeds] ${source.key}: ${items.length} fetched, ${fresh.length} fresh${capped ? ` (first-run capped to ${FIRST_RUN_LIMIT})` : ''}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      perSource.push({ key: source.key, name: source.name, fetched: 0, fresh: 0, firstRun, error: msg });
      console.warn(`[Feeds] ${source.key} failed: ${msg}`);
    }
  }

  const totalFresh = perSource.reduce((n, s) => n + s.fresh, 0);

  if (submissions.length === 0) {
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

  progress(`Feeds complete: ${totalFresh} fresh, ${intakeSummary.newUnique} unique, ${intakeSummary.highQualityCount} high quality`, 100);
  return { perSource, totalFresh, intakeSummary, durationMs: Date.now() - startTime };
}
