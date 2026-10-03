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

import { getBrand } from '../config/brand';
import { config } from '../config';
import { getPool } from '../db';
import { getCachedProvider } from './api-provider';
import { ollamaAutoSummarize } from './ollama';
import { checkFaithfulness } from './post-faithfulness';
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
  prompt?: string;
}

export function summaryFactText(opts: Pick<SummarizeOpts, 'name' | 'description' | 'amount' | 'deadline' | 'sourceUrl'>): string {
  return [opts.name, opts.description, opts.amount, opts.deadline, opts.sourceUrl]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join('\n');
}

/**
 * Enriched-summary instructions. Same faithfulness rules as the wire post:
 * only facts in the input, the funder's own verb, no invented amounts, and no hype.
 */
export function buildEnrichedSummaryPrompt(opts: SummarizeOpts, violations?: string[]): string {
  const brand = getBrand();
  const wireLabel = opts.wire === 'ai' ? 'AI funding' : opts.wire === 'oss' ? 'open-source funding' : 'crypto grants';
  const lines = [
    `You are writing a concise opportunity summary for a ${wireLabel} newsletter (${brand.name}).`,
    'Use only facts written in the fields below. If a detail is not there, leave it out.',
    'If the fields are thin, write one sentence. Never add filler.',
    'Keep the funder\'s own verb. Use opens, launches, new, or relaunch only when the fields say so.',
    'For a program that is already running, use neutral wording such as "is accepting applications".',
    'Say rolling or no deadline only when the fields state it.',
    'Copy amounts and other numbers exactly as written. Do not add, round, or combine them.',
    'Do not add opinion or hype (rare, one of the, notable, signals, worth exploring, major, significant, largest, groundbreaking, exciting, or similar praise).',
    'When the fields include an apply path, a deadline, or eligibility, include it. Do not invent eligibility.',
    '',
    `Grant name: ${opts.name}`,
    opts.amount ? `Amount: ${opts.amount}` : '',
    opts.deadline ? `Deadline: ${opts.deadline}` : '',
    opts.sourceUrl && opts.sourceUrl.startsWith('http') ? `Source: ${opts.sourceUrl}` : '',
    `Description: ${opts.description || '(none)'}`,
    '',
    'Write ONLY the final summary. No thinking, no explanation, no markdown. Plain prose, no bullet points. Max 120 words.',
  ];
  if (violations?.length) {
    lines.push('', 'The previous summary was rejected. Rewrite it so none of these remain:');
    for (const violation of violations.slice(0, 12)) lines.push(`- ${violation}`);
  }
  return lines.filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n');
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
    check?: (input: string, output: string) => string[];
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
  const check = deps.check ?? ((input: string, output: string) => checkFaithfulness(input, output, { html: false }).violations);
  const facts = summaryFactText(opts);
  const attempts: SummaryAttempt[] = [];

  const judge = (text: string | null, step: SummaryStep): { verdict: 'ok' | 'empty' | 'leak' | 'unfaithful'; summary: string | null; violations: string[] } => {
    const trimmed = (text || '').trim();
    if (trimmed.length < 20) {
      attempts.push({ provider: 'ollama', model: step.model, slot: step.slot, outcome: 'empty' });
      return { verdict: 'empty', summary: null, violations: [] };
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
      return { verdict: 'leak', summary: null, violations: [] };
    }
    const violations = check(facts, trimmed);
    if (violations.length) {
      attempts.push({
        provider: 'ollama',
        model: step.model,
        slot: step.slot,
        outcome: 'rejected',
        detail: violations.slice(0, 3).join('; '),
      });
      return { verdict: 'unfaithful', summary: null, violations };
    }
    attempts.push({ provider: 'ollama', model: step.model, slot: step.slot, outcome: 'ok' });
    return { verdict: 'ok', summary: trimmed, violations: [] };
  };

  for (const step of plan) {
    let text: string | null;
    try {
      text = await callOllama({ ...opts, prompt: buildEnrichedSummaryPrompt(opts) }, step.model);
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

    const first = judge(text, step);
    if (first.verdict === 'ok' && first.summary) {
      return { summary: first.summary, provider: 'ollama', model: step.model, attempts };
    }
    if (first.verdict !== 'unfaithful') continue;
    let retried: string | null;
    try {
      retried = await callOllama({ ...opts, prompt: buildEnrichedSummaryPrompt(opts, first.violations) }, step.model);
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
    const second = judge(retried, step);
    if (second.verdict === 'ok' && second.summary) {
      return { summary: second.summary, provider: 'ollama', model: step.model, attempts };
    }
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
