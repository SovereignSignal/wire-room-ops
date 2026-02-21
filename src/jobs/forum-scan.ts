/**
 * Forum Scan Job
 *
 * Orchestrates forum scanning via discuss.watch:
 * 1. Search for grant-related discussions across 150+ Discourse forums
 * 2. Map results to ScanSubmission format
 * 3. Feed into the daily intake pipeline (dedup -> score -> queue)
 *
 * Same pattern as scan-execution.ts but for forum data.
 */

import type { Pool } from 'pg';
import type {
  ScanSubmission,
  IntakeRunSummary,
  IntakeJobConfig,
} from '../types/intake';
import { searchForumDiscussions } from '../services/forum';
import { runDailyIntake } from './daily-intake';

export interface ForumScanOptions {
  wire?: string;
  onProgress?: (message: string, pct: number) => void;
  config?: Partial<IntakeJobConfig>;
}

export interface ForumScanResult {
  totalResults: number;
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

  progress('Starting forum scan via discuss.watch...', 0);

  // 1. Search discuss.watch for grant discussions
  const results = await searchForumDiscussions({
    wire: options.wire,
    onProgress: (msg, pct) => {
      // Map search progress (0-85) to our range (0-60)
      progress(msg, Math.round(pct * 0.7));
    },
  });

  if (results.length === 0) {
    const durationMs = Date.now() - startTime;
    progress('No forum results found', 100);
    return {
      totalResults: 0,
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

  progress(`Found ${results.length} forum discussions, running intake...`, 65);

  // 2. Build submission for intake pipeline
  const submission: ScanSubmission = {
    wire: options.wire || 'crypto',
    promptVariant: 'N',
    scanDate: today,
    source: 'forum',
    results,
    submittedBy: 'forum:discuss.watch',
  };

  // 3. Feed into daily intake pipeline
  const intakeSummary = await runDailyIntake(pool, [submission], {
    config: options.config,
    onProgress: (msg, pct) => {
      // Map intake progress (0-100) to our range (65-100)
      progress(msg, 65 + Math.round(pct * 0.35));
    },
  });

  const durationMs = Date.now() - startTime;

  progress(
    `Forum scan complete: ${results.length} results, ${intakeSummary.newUnique} unique, ${intakeSummary.highQualityCount} high quality`,
    100
  );

  return {
    totalResults: results.length,
    intakeSummary,
    durationMs,
  };
}
