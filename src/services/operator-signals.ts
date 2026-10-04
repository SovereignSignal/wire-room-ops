/**
 * Operator Signals — lightweight feedback loop for classifier tuning.
 *
 * Mines historical approve/decline decisions from scan_entries and computes
 * keyword signals that predict operator preferences. These signals are
 * injected into the classifier prompt to calibrate scoring.
 *
 * No new tables, no new columns — pure query-based learning from existing data.
 */

import { getPool } from '../db';

// ============================================================
// Types
// ============================================================

export interface TokenSignal {
  word: string;
  approved: number;
  declined: number;
  rate: number; // approval rate 0-1
  count: number; // total occurrences
}

export interface OperatorSignals {
  approveSignals: TokenSignal[];
  declineSignals: TokenSignal[];
  totalApproved: number;
  totalDeclined: number;
  computedAt: Date;
  wire?: string;
}

// ============================================================
// Constants
// ============================================================

const LOOKBACK_DAYS = 30;
/** Decisions before the six-area scope change must not teach the classifier to down-rank awards or governance. */
export const SIGNAL_DECISION_CUTOFF = '2026-10-04';
const MIN_OCCURRENCES = 3;
const MAX_SIGNALS = 8;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Words too generic to carry signal — they appear in almost every entry
const SIGNAL_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'has',
  'will', 'can', 'not', 'new', 'open', 'our', 'more', 'all', 'its',
]);

// ============================================================
// Cache
// ============================================================

const signalCache = new Map<string, { signals: OperatorSignals; expires: number }>();

export function clearSignalCache(): void {
  signalCache.clear();
}

// ============================================================
// Core computation
// ============================================================

function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9$\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !SIGNAL_STOP_WORDS.has(w));
}

/**
 * Scope declines from the pre-six-area wire rules. Award slates, "not an open
 * call", and governance votes are eligible areas now, so they must not pull
 * scores down.
 */
export function isScopeDeclineReason(reason: string | null | undefined): boolean {
  if (!reason || !reason.trim()) return false;
  return /not[-\s]+open|not an open|\baward|\bgovernance\b/i.test(reason);
}

export function includeOperatorSignalRow(
  row: { status: string; decision_at?: string | Date | null; action_reason?: string | null },
  now = new Date(),
): boolean {
  if (row.status !== 'approved' && row.status !== 'declined') return false;
  if (row.decision_at == null || row.decision_at === '') return false;
  const decided = row.decision_at instanceof Date ? row.decision_at : new Date(row.decision_at);
  if (Number.isNaN(decided.getTime())) return false;
  const cutoff = new Date(`${SIGNAL_DECISION_CUTOFF}T00:00:00.000Z`);
  if (decided < cutoff) return false;
  const lookback = now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  if (decided.getTime() < lookback) return false;
  if (row.status === 'declined' && isScopeDeclineReason(row.action_reason)) return false;
  return true;
}

export function operatorSignalQuery(wire?: string): { sql: string; params: Array<string | number> } {
  const params: Array<string | number> = [LOOKBACK_DAYS];
  let whereClause = '';
  if (wire) {
    params.push(wire);
    whereClause = ` AND wire = $${params.length}`;
  }
  const sql = `SELECT LOWER(name) AS name, status, action_reason, decision_at
     FROM scan_entries
     WHERE status IN ('approved', 'declined')
       AND decision_at >= $${params.length + 1}::timestamptz
       AND decision_at >= NOW() - INTERVAL '1 day' * $1
       AND NOT (
         status = 'declined'
         AND COALESCE(action_reason, '') ~* 'not[-[:space:]]+open|not an open|\\maward|governance'
       )
       ${whereClause}`;
  return { sql, params: [...params, SIGNAL_DECISION_CUTOFF] };
}

export async function computeOperatorSignals(wire?: string): Promise<OperatorSignals> {
  const cacheKey = wire || '__all__';
  const cached = signalCache.get(cacheKey);
  if (cached && Date.now() < cached.expires) {
    return cached.signals;
  }

  const pool = getPool();
  const signalQuery = operatorSignalQuery(wire);
  const { rows: fetched } = await pool.query<{
    name: string;
    status: string;
    action_reason: string | null;
    decision_at: string | Date | null;
  }>(signalQuery.sql, signalQuery.params);
  const rows = fetched.filter(row => includeOperatorSignalRow(row));

  // Tokenize and compute frequency per status
  const freq = new Map<string, { approved: number; declined: number }>();
  let totalApproved = 0;
  let totalDeclined = 0;

  for (const row of rows) {
    const isApproved = row.status === 'approved';
    if (isApproved) totalApproved++;
    else totalDeclined++;

    // Dedupe tokens within a single entry name
    const seen = new Set<string>();
    for (const token of tokenize(row.name)) {
      if (seen.has(token)) continue;
      seen.add(token);

      const entry = freq.get(token) || { approved: 0, declined: 0 };
      if (isApproved) entry.approved++;
      else entry.declined++;
      freq.set(token, entry);
    }
  }

  // Filter to tokens with enough data and clear signal
  const allTokens: TokenSignal[] = [];
  for (const [word, counts] of freq) {
    const total = counts.approved + counts.declined;
    if (total < MIN_OCCURRENCES) continue;

    const rate = counts.approved / total;
    // Skip tokens near 50/50 — they carry no signal
    if (rate > 0.35 && rate < 0.65) continue;

    allTokens.push({
      word,
      approved: counts.approved,
      declined: counts.declined,
      rate,
      count: total,
    });
  }

  // Split into approve/decline signals
  const approveSignals = allTokens
    .filter((t) => t.rate >= 0.65)
    .sort((a, b) => b.rate - a.rate || b.count - a.count)
    .slice(0, MAX_SIGNALS);

  const declineSignals = allTokens
    .filter((t) => t.rate <= 0.35)
    .sort((a, b) => a.rate - b.rate || b.count - a.count)
    .slice(0, MAX_SIGNALS);

  const signals: OperatorSignals = {
    approveSignals,
    declineSignals,
    totalApproved,
    totalDeclined,
    computedAt: new Date(),
    wire,
  };

  signalCache.set(cacheKey, { signals, expires: Date.now() + CACHE_TTL_MS });
  console.log(
    `[OperatorSignals] Computed for ${cacheKey}: ${totalApproved} approved, ${totalDeclined} declined, ` +
    `${approveSignals.length} approve signals, ${declineSignals.length} decline signals`
  );

  return signals;
}

// ============================================================
// Prompt formatting
// ============================================================

export function formatSignalsForPrompt(signals: OperatorSignals): string {
  const totalDecisions = signals.totalApproved + signals.totalDeclined;
  if (totalDecisions < 10) return ''; // Not enough data

  const parts: string[] = [];
  parts.push('## Operator Calibration (from recent editorial decisions)');

  if (signals.declineSignals.length > 0) {
    const words = signals.declineSignals.map((s) => s.word).join(', ');
    parts.push(
      `Entries mentioning [${words}] are rarely approved by the operator. Adjust quality_score down by 10-15 points for these patterns.`
    );
  }

  if (signals.approveSignals.length > 0) {
    const words = signals.approveSignals.map((s) => s.word).join(', ');
    parts.push(
      `Entries mentioning [${words}] are frequently approved. These match operator preferences — do not penalize.`
    );
  }

  if (parts.length === 1) return ''; // No signals to report

  parts.push(
    'This calibration adjusts scoring within each classification category. It does not override classification logic.'
  );

  return parts.join('\n');
}
