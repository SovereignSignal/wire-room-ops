/**
 * Forum Scan Job
 *
 * Governance-forum discovery via discuss.watch:
 * 1. Pull candidates from a curated per-wire governance/grants forum allowlist
 *    (plus a `hot` catch-all), retaining recent changes to known older topics.
 * 2. LLM judge each thread: opportunity / not + structured extraction.
 * 3. Feed opportunities into the intake pipeline (dedup -> classify -> queue).
 *
 * Replaces the retired broad-keyword dual scan, which drowned in noise
 * (2% approve / 67% dupe). scan_source = 'forum'.
 */

import type { Pool } from 'pg';
import type {
  ScanSubmission,
  IntakeRunSummary,
  IntakeJobConfig,
} from '../types/intake';
import { config } from '../config';
import { runGovernanceForumScan } from '../services/forum';
import { runDailyIntake } from './daily-intake';
import { getActiveWires } from '../services/intake-core';

export interface ForumScanOptions {
  wire?: string;
  lookbackDays?: number;
  onProgress?: (message: string, pct: number) => void;
  config?: Partial<IntakeJobConfig>;
}

export interface ForumScanResult {
  totalResults: number;      // opportunities sent to intake (post-LLM-judge)
  candidateCount: number;    // governance-forum threads pulled before judging
  opportunityCount: number;  // alias of totalResults, explicit
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

  progress('Starting governance-forum scan via discuss.watch...', 0);

  // Compute since date from lookbackDays
  const lookbackDays = options.lookbackDays || config.forum.defaultLookbackDays;
  const since = new Date(Date.now() - lookbackDays * 86400000).toISOString().split('T')[0];

  // 1. Pull governance-forum candidates and LLM-judge them into opportunities
  const scanResult = await runGovernanceForumScan({
    pool,
    wire: options.wire,
    since,
    onProgress: (msg, pct) => {
      // Map scan progress (0-100) to our range (0-60)
      progress(msg, Math.round(pct * 0.6));
    },
  });

  const totalResults = scanResult.opportunityCount;

  if (totalResults === 0) {
    const durationMs = Date.now() - startTime;
    progress(`No forum opportunities found (${scanResult.candidateCount} candidates screened)`, 100);
    return {
      totalResults: 0,
      candidateCount: scanResult.candidateCount,
      opportunityCount: 0,
      intakeSummary: {
        runDate: today,
        wire: options.wire || 'all',
        totalIngested: 0,
        duplicatesFound: 0,
        skippedAlreadySeen: 0,
        newUnique: 0,
        averageQualityScore: 0,
        highQualityCount: 0,
        byPrompt: {},
        topFinds: [],
      },
      durationMs,
    };
  }

  progress(`Found ${totalResults} forum opportunities (from ${scanResult.candidateCount} candidates), running intake...`, 62);

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
    `Forum scan complete: ${totalResults} opportunities, ${intakeSummary.newUnique} unique, ${intakeSummary.skippedAlreadySeen ?? 0} already-seen skipped, ${intakeSummary.highQualityCount} high quality`,
    100
  );

  return {
    totalResults,
    candidateCount: scanResult.candidateCount,
    opportunityCount: scanResult.opportunityCount,
    intakeSummary,
    durationMs,
  };
}
