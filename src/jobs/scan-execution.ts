/**
 * Scan Execution Job
 *
 * Orchestrates automated scan execution:
 * 1. Fetch active prompts from DB (optionally filtered by wire)
 * 2. Execute each prompt against Grok Responses API sequentially
 * 3. Parse structured output into RawScanResult[]
 * 4. Feed all results into the daily intake pipeline
 *
 * Each Grok call takes 60-90s, so a full run of 9 prompts takes ~9-14 min.
 */

import type { Pool } from 'pg';
import { PROMPT_VARIANTS } from '../types/intake';
import type {
  PromptVariant,
  ScanSource,
  ScanSubmission,
  IntakeRunSummary,
  IntakeJobConfig,
} from '../types/intake';
import { getAllScanPrompts, ScanPromptRecord, findSeenUrls } from '../db';
import { executeScanPrompt } from '../services/grok';
import { executePerplexityScan } from '../services/perplexity';
import { executeParallelScan } from '../services/parallel';
import { parseStructuredOutput } from '../services/intake';
import { withRetry } from '../services/processor';
import { runDailyIntake } from './daily-intake';
import { checkBudget, withDiscoveryBudget } from '../services/budget-guard';

// ============================================================
// Types
// ============================================================

export interface ScanExecutionOptions {
  wire?: string;
  onProgress?: (message: string, pct: number) => void;
  config?: Partial<IntakeJobConfig>;
}

export interface PerPromptResult {
  promptId: string;
  wire: string;
  label: string;
  variant: string;
  resultCount: number;
  error?: string;
  durationMs: number;
}

export interface ScanExecutionResult {
  promptsExecuted: number;
  promptsFailed: number;
  totalResults: number;
  intakeSummary: IntakeRunSummary;
  perPrompt: PerPromptResult[];
  totalDurationMs: number;
  /** True when completed prompt results were durably ingested before an upstream abort. */
  partial: boolean;
  partialReason?: string;
}

/**
 * Freshness floor for discovery-intent Parallel scans.
 *
 * The Frontier prompts ask for "the last 21 days" in their own text; the floor
 * was 90, over 4x wider than operator intent, which is a large part of why the
 * lane re-found the same canonical programs daily. Canonical/signal prompts
 * still pass no after_date — that would drop long-standing rolling programs.
 */
export const DISCOVERY_WINDOW_DAYS = 21;

// ============================================================
// Variant inference
// ============================================================

const VALID_VARIANTS: readonly PromptVariant[] = PROMPT_VARIANTS;
const FALLBACK_VARIANTS: PromptVariant[] = ['A', 'B', 'C'];

function resolveVariant(prompt: ScanPromptRecord): PromptVariant {
  if (prompt.variant && VALID_VARIANTS.includes(prompt.variant as PromptVariant)) {
    return prompt.variant as PromptVariant;
  }
  // Infer from sortOrder: 0→A, 1→B, 2→C, wrap around
  return FALLBACK_VARIANTS[prompt.sortOrder % 3];
}

function isQuotaExhaustedError(message: string): boolean {
  return /resource has been exhausted|used all available credits|monthly spending limit/i.test(message);
}

// ============================================================
// Main execution
// ============================================================

export async function runScanExecution(
  pool: Pool,
  options: ScanExecutionOptions = {}
): Promise<ScanExecutionResult> {
  const progress = options.onProgress || (() => {});
  const startTime = Date.now();
  const today = new Date().toISOString().split('T')[0];

  // 1. Fetch active prompts
  progress('Fetching active prompts...', 0);
  const prompts = await getAllScanPrompts(options.wire, true);

  if (prompts.length === 0) {
    throw new Error(
      options.wire
        ? `No active prompts found for wire "${options.wire}"`
        : 'No active prompts found'
    );
  }

  progress(`Found ${prompts.length} active prompts`, 2);

  // Tier 2 discovery spend guard. Every prompt below routes to a paid
  // provider (Grok x_search via executeScanPrompt logging purpose 'scan',
  // Perplexity, or Parallel) — consulting the budget here, before the
  // execution loop starts, brakes ALL of those lanes at once instead of
  // gating them individually. Same shape as x-lists' budget skip.
  const budget = await checkBudget(pool);
  if (!budget.allowed) {
    console.warn(`[ScanExec] Discovery paused: $${budget.spentUsd} of $${budget.capUsd}; ${budget.unpricedCalls} unpriced calls`);
    return {
      promptsExecuted: 0,
      promptsFailed: prompts.length,
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
      perPrompt: [],
      totalDurationMs: Date.now() - startTime,
      partial: true,
      partialReason: `Discovery paused by budget guard: $${budget.spentUsd} of $${budget.capUsd}; ${budget.unpricedCalls} unpriced calls`,
    };
  }

  // 2. Execute each prompt sequentially
  const submissions: ScanSubmission[] = [];
  const perPrompt: PerPromptResult[] = [];
  let totalResults = 0;
  let promptsFailed = 0;
  let fatalError: string | null = null;

  // Progress range: 2% -> 70% for prompt execution
  const progressPerPrompt = 68 / prompts.length;

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    const variant = resolveVariant(prompt);
    const promptStart = Date.now();
    const pctBase = 2 + i * progressPerPrompt;

    progress(
      `Executing "${prompt.label}" (${prompt.wire}, variant ${variant})... ${i + 1}/${prompts.length}`,
      Math.round(pctBase)
    );

    try {
      // Route to the correct model provider based on tool_type
      const scanResult = await withRetry(
        () => withDiscoveryBudget(pool, async () => {
          if (prompt.toolType === 'perplexity') {
            return executePerplexityScan(prompt.promptText, {
              model: prompt.model || undefined,
              responseFormat: prompt.responseFormat,
              outputFormat: prompt.outputFormat,
            });
          }
          if (prompt.toolType === 'parallel') {
            // Discovery prompts want fresh announcements → server-side freshness floor.
            // Canonical/signal prompts must NOT use after_date (it would drop the pages
            // of long-standing rolling programs that are still open).
            const afterDate = prompt.intent === 'discovery'
              ? new Date(Date.now() - DISCOVERY_WINDOW_DAYS * 86400000).toISOString().split('T')[0]
              : undefined;
            return executeParallelScan(prompt.promptText, {
              model: prompt.model || undefined,
              responseFormat: prompt.responseFormat,
              outputFormat: prompt.outputFormat,
              wire: prompt.wire,
              afterDate,
              filterSeenUrls: (urls) => findSeenUrls(pool, urls, prompt.wire),
            });
          }
          return executeScanPrompt(prompt.promptText, {
            model: prompt.model || undefined,
            responseFormat: prompt.responseFormat,
            toolType: prompt.toolType,
          });
        }),
        2 // 2 total attempts (1 retry) — these are expensive calls
      );

      const parseHint = prompt.outputFormat === 'json' ? 'json' as const : undefined;
      const { results: parsed, strategy: parseStrategy } = parseStructuredOutput(scanResult.content, parseHint);
      const durationMs = Date.now() - promptStart;

      if (parsed.length === 0) {
        console.warn(`[ScanExecution] Prompt "${prompt.label}" returned 0 parseable results (strategy: ${parseStrategy})`);
        console.warn(`[ScanExecution] Raw output (first 500 chars): ${scanResult.content.substring(0, 500)}`);
      } else {
        console.log(`[ScanExecution] Prompt "${prompt.label}" parsed ${parsed.length} results (strategy: ${parseStrategy})`);
      }

      // Build submission
      const source: ScanSource =
        prompt.toolType === 'perplexity' ? 'perplexity' :
        prompt.toolType === 'parallel' ? 'web-search' :
        prompt.toolType === 'web_search' ? 'web-search'
          : 'x-scan';
      submissions.push({
        wire: prompt.wire,
        promptVariant: variant,
        scanDate: today,
        source,
        results: parsed,
        promptId: prompt.id,
        rawOutput: scanResult.content,
        parseStrategy,
      });

      totalResults += parsed.length;

      perPrompt.push({
        promptId: prompt.id,
        wire: prompt.wire,
        label: prompt.label,
        variant,
        resultCount: parsed.length,
        durationMs,
      });

      progress(
        `"${prompt.label}": ${parsed.length} results (${Math.round(durationMs / 1000)}s)`,
        Math.round(pctBase + progressPerPrompt * 0.9)
      );
    } catch (error) {
      const durationMs = Date.now() - promptStart;
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[ScanExecution] Prompt "${prompt.label}" failed: ${errMsg}`);

      promptsFailed++;
      perPrompt.push({
        promptId: prompt.id,
        wire: prompt.wire,
        label: prompt.label,
        variant,
        resultCount: 0,
        error: errMsg,
        durationMs,
      });

      progress(
        `"${prompt.label}" FAILED: ${errMsg.substring(0, 80)}`,
        Math.round(pctBase + progressPerPrompt * 0.9)
      );

      if (isQuotaExhaustedError(errMsg)) {
        fatalError = errMsg;

        // Mark all remaining prompts as skipped due fatal upstream error.
        for (let j = i + 1; j < prompts.length; j++) {
          const remainingPrompt = prompts[j];
          const remainingVariant = resolveVariant(remainingPrompt);
          perPrompt.push({
            promptId: remainingPrompt.id,
            wire: remainingPrompt.wire,
            label: remainingPrompt.label,
            variant: remainingVariant,
            resultCount: 0,
            error: `Skipped after fatal quota error: ${errMsg}`,
            durationMs: 0,
          });
        }

        promptsFailed += prompts.length - i - 1;
        progress(
          `Aborting remaining prompts: upstream Grok quota exhausted`,
          Math.round(pctBase + progressPerPrompt)
        );
        break;
      }
    }
  }

  // 3. Run intake pipeline on all collected submissions. A later quota error
  // must not discard successful, already-paid prompt results. If nothing
  // completed, preserve the existing all-failed exception contract.
  if (submissions.length === 0 || totalResults === 0) {
    if (prompts.length - promptsFailed === 0) {
      const firstError = perPrompt.find((p) => !!p.error)?.error || 'Unknown prompt execution error';
      throw new Error(`All scan prompts failed: ${firstError}`);
    }

    const totalDurationMs = Date.now() - startTime;
    // Return empty result with a minimal summary
    return {
      promptsExecuted: prompts.length - promptsFailed,
      promptsFailed,
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
      perPrompt,
      totalDurationMs,
      partial: fatalError !== null,
      ...(fatalError ? { partialReason: fatalError } : {}),
    };
  }

  progress(`Running intake pipeline on ${totalResults} results...`, 70);

  const intakeSummary = await runDailyIntake(pool, submissions, {
    config: options.config,
    onProgress: (msg, pct) => {
      // Map intake progress (0-100) to our range (70-100)
      progress(msg, 70 + Math.round(pct * 0.3));
    },
  });

  const totalDurationMs = Date.now() - startTime;

  progress(
    `${fatalError ? 'Scan partial' : 'Scan complete'}: ${totalResults} results, ${intakeSummary.newUnique} unique, ${intakeSummary.highQualityCount} high quality`,
    100
  );

  return {
    promptsExecuted: prompts.length - promptsFailed,
    promptsFailed,
    totalResults,
    intakeSummary,
    perPrompt,
    totalDurationMs,
    partial: fatalError !== null,
    ...(fatalError ? { partialReason: fatalError } : {}),
  };
}
