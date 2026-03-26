/**
 * Forum Scan Job
 *
 * Orchestrates dual-strategy forum scanning via discuss.watch:
 * 1. Fetch recent discussions (date-filtered, category-aware, high volume)
 * 2. Keyword search for precision matches
 * 3. Cross-deduplicate and feed into intake pipeline (dedup -> classify -> queue)
 *
 * Same pattern as scan-execution.ts but for forum data.
 */

import type { Pool } from 'pg';
import type {
  ScanSubmission,
  IntakeRunSummary,
  IntakeJobConfig,
} from '../types/intake';
import { config } from '../config';
import { runDualForumScan } from '../services/forum';
import { runDailyIntake } from './daily-intake';
import { getActiveWires } from '../services/intake-core';

export interface ForumScanOptions {
  wire?: string;
  lookbackDays?: number;
  onProgress?: (message: string, pct: number) => void;
  config?: Partial<IntakeJobConfig>;
}

export interface ForumScanResult {
  totalResults: number;
  discussionsResults: number;
  searchResults: number;
  intakeSummary: IntakeRunSummary;
  durationMs: number;
}

export async function runForumScan(
  pool: Pool,
  options: ForumScanOptions = {}
): Promise<ForumScanResult> {
  const progress = options.onProgress || (() => {});
  const startTime = Date.now();
  const today = new Date().toISOString().split('T')[0];

  progress('Starting dual-strategy forum scan via discuss.watch...', 0);

  // Compute since date from lookbackDays
  const lookbackDays = options.lookbackDays || config.forum.defaultLookbackDays;
  const since = new Date(Date.now() - lookbackDays * 86400000).toISOString().split('T')[0];

  // 1. Run dual-strategy scan (discussions + search)
  const scanResult = await runDualForumScan({
    wire: options.wire,
    since,
    onProgress: (msg, pct) => {
      // Map scan progress (0-100) to our range (0-60)
      progress(msg, Math.round(pct * 0.6));
    },
  });

  const totalResults = scanResult.discussionsCount + scanResult.searchCount;

  if (totalResults === 0) {
    const durationMs = Date.now() - startTime;
    progress('No forum results found', 100);
    return {
      totalResults: 0,
      discussionsResults: 0,
      searchResults: 0,
      intakeSummary: {
        runDate: today,
        wire: options.wire || 'all',
        totalIngested: 0,
        duplicatesFound: 0,
        newUnique: 0,
        averageQualityScore: 0,
        highQualityCount: 0,
        byPrompt: {},
        topFinds: [],
      },
      durationMs,
    };
  }

  progress(`Found ${totalResults} forum discussions (${scanResult.discussionsCount} recent + ${scanResult.searchCount} search), running intake...`, 62);

  // 2. Build one submission per wire
  const defaultWire = (await getActiveWires())[0] || 'crypto';
  const submissions: ScanSubmission[] = scanResult.byWire.map(wr => ({
    wire: wr.wire || options.wire || defaultWire,
    promptVariant: 'N' as const,
    scanDate: today,
    source: 'forum' as const,
    results: wr.results,
    submittedBy: 'forum:discuss.watch',
  }));

  // 3. Feed into daily intake pipeline
  const intakeSummary = await runDailyIntake(pool, submissions, {
    config: options.config,
    onProgress: (msg, pct) => {
      // Map intake progress (0-100) to our range (65-100)
      progress(msg, 65 + Math.round(pct * 0.35));
    },
  });

  const durationMs = Date.now() - startTime;

  progress(
    `Forum scan complete: ${totalResults} results, ${intakeSummary.newUnique} unique, ${intakeSummary.highQualityCount} high quality`,
    100
  );

  return {
    totalResults,
    discussionsResults: scanResult.discussionsCount,
    searchResults: scanResult.searchCount,
    intakeSummary,
    durationMs,
  };
}
