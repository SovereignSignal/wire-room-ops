/**
 * Auto-summarize service — generates newsletter summaries for approved entries.
 *
 * Chain: Ollama primary model (OLLAMA_DEFAULT_MODEL), then Ollama fallback
 * model (OLLAMA_FALLBACK_MODEL). Grok is not in this chain. Every accepted
 * string has passed summary-guard.
 *
 * Called as a fire-and-forget side effect on entry approval. The leak backfill
 * uses generateValidatedSummary, so it follows the same chain.
 */

import { config } from '../config';
import { getPool } from '../db';
import { getCachedProvider } from './api-provider';
import { ollamaAutoSummarize } from './ollama';
import { findSummaryLeak } from './summary-guard';

export function cleanText(s: string): string {
  return s
    .replace(/\[?\[(\d+)\]\]?\([^)]*\)/g, '') // strip [[N]](url) citation refs
    .replace(/```[\w]*\n?/g, '')               // strip code fences
    .replace(/\s{2,}/g, ' ')
    .trim();
}

interface SummarizeOpts {
  name: string;
  description: string;
  amount: string | null;
  deadline: string | null;
  sourceUrl: string | null;
  wire?: string;
}

export type SummarySlot = 'primary' | 'fallback';

export interface SummaryStep {
  slot: SummarySlot;
  model: string;
}

export interface SummaryAttempt {
  provider: 'ollama';
  model: string;
  slot: SummarySlot;
  outcome: 'ok' | 'empty' | 'rejected' | 'error';
  detail?: string;
}

export interface SummaryResult {
  summary: string | null;
  provider: 'ollama' | null;
  model: string | null;
  attempts: SummaryAttempt[];
}

export interface SummaryInput {
  entryId?: number;
  name: string;
  description: string;
  amount: string | null;
  deadline: string | null;
  sourceUrl: string | null;
  wire?: string;
}

/**
 * Primary model, then fallback model. When only one model is configured, it
 * is tried twice so a single rejected output is not final.
 */
export function planSummaryAttempts(models?: { primary?: string; fallback?: string }): SummaryStep[] {
  const primary = (models?.primary ?? config.apis.ollama.defaultModel).trim();
  const fallback = (models?.fallback ?? config.apis.ollama.fallbackModel).trim();
  if (primary && fallback && fallback !== primary) {
    return [
      { slot: 'primary', model: primary },
      { slot: 'fallback', model: fallback },
    ];
  }
  const only = primary || fallback;
  return only
    ? [{ slot: 'primary', model: only }, { slot: 'primary', model: only }]
    : [];
}

/**
 * Generate a summary and accept it only if it reads as a finished summary.
 * Never persists anything; callers decide where the result goes.
 */
export async function generateValidatedSummary(
  input: SummaryInput,
  deps: {
    ollama?: (opts: SummarizeOpts, model: string) => Promise<string | null>;
    available?: boolean;
    models?: { primary?: string; fallback?: string };
  } = {},
): Promise<SummaryResult> {
  const opts: SummarizeOpts = {
    name: cleanText(input.name),
    description: cleanText(input.description),
    amount: input.amount,
    deadline: input.deadline,
    sourceUrl: input.sourceUrl,
    wire: input.wire,
  };
  const available = deps.available ?? !!getCachedProvider('ollama')?.api_key;
  if (!available) return { summary: null, provider: null, model: null, attempts: [] };

  const plan = planSummaryAttempts(deps.models);
  const callOllama = deps.ollama ?? ollamaAutoSummarize;
  const attempts: SummaryAttempt[] = [];

  for (const step of plan) {
    let text: string | null;
    try {
      text = await callOllama(opts, step.model);
    } catch (err) {
      attempts.push({
        provider: 'ollama',
        model: step.model,
        slot: step.slot,
        outcome: 'error',
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const trimmed = (text || '').trim();
    if (trimmed.length < 20) {
      attempts.push({ provider: 'ollama', model: step.model, slot: step.slot, outcome: 'empty' });
      continue;
    }
    const leak = findSummaryLeak(trimmed);
    if (leak) {
      attempts.push({
        provider: 'ollama',
        model: step.model,
        slot: step.slot,
        outcome: 'rejected',
        detail: `${leak.rule}: ${leak.excerpt}`,
      });
      continue;
    }
    attempts.push({ provider: 'ollama', model: step.model, slot: step.slot, outcome: 'ok' });
    return { summary: trimmed, provider: 'ollama', model: step.model, attempts };
  }

  return { summary: null, provider: null, model: null, attempts };
}

function describeAttempts(attempts: SummaryAttempt[]): string {
  return attempts.map(a => `${a.model}=${a.outcome}${a.detail ? ` (${a.detail.slice(0, 120)})` : ''}`).join(', ');
}

/** Returns true when a validated summary was stored. */
export async function autoSummarizeOnApprove(
  entryId: number,
  summaryId: number | null,
  name: string,
  description: string,
  amount: string | null,
  deadline: string | null,
  sourceUrl: string | null,
  wire?: string
): Promise<boolean> {
  try {
    const result = await generateValidatedSummary({
      entryId, name, description, amount, deadline, sourceUrl, wire,
    });
    const pool = getPool();

    if (!result.summary) {
      if (result.attempts.length === 0) {
        console.warn(`[AutoSummarize] No Ollama key configured for entry ${entryId}`);
        return false;
      }
      console.warn(`[AutoSummarize] No usable summary for entry ${entryId}: ${describeAttempts(result.attempts)}`);
      await pool.query(`UPDATE scan_entries SET auto_summarize_failed = true WHERE id = $1`, [entryId]);
      return false;
    }

    await pool.query(
      `UPDATE scan_entries
       SET enriched_summary = $1, auto_summarize_failed = false, updated_at = NOW()
       WHERE id = $2`,
      [result.summary, entryId]
    );

    if (summaryId) {
      await pool.query(
        `UPDATE summaries SET summary = $1 WHERE id = $2`,
        [result.summary, summaryId]
      ).catch(err => console.warn(`[AutoSummarize] Failed to patch summaries row ${summaryId}:`, err.message));
    }

    console.log(`[AutoSummarize] Generated summary for entry ${entryId} via ${result.model} (${result.summary.length} chars)`);
    return true;
  } catch (err) {
    console.error(`[AutoSummarize] Failed for entry ${entryId}:`, err);
    try {
      const pool = getPool();
      await pool.query(
        `UPDATE scan_entries SET auto_summarize_failed = true WHERE id = $1`,
        [entryId]
      );
    } catch (markErr) {
      console.error(`[AutoSummarize] Failed to mark entry ${entryId} as failed:`, markErr);
    }
    return false;
  }
}
