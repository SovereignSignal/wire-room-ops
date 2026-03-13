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

export async function computeOperatorSignals(wire?: string): Promise<OperatorSignals> {
  const cacheKey = wire || '__all__';
  const cached = signalCache.get(cacheKey);
  if (cached && Date.now() < cached.expires) {
    return cached.signals;
  }

  const pool = getPool();
  const params: (string | number)[] = [LOOKBACK_DAYS];
  let whereClause = '';
  if (wire) {
    params.push(wire);
    whereClause = ` AND wire = $${params.length}`;
  }

  const { rows } = await pool.query<{ name: string; status: string }>(
    `SELECT LOWER(name) AS name, status
     FROM scan_entries
     WHERE status IN ('approved', 'declined')
       AND created_at >= NOW() - INTERVAL '1 day' * $1
       ${whereClause}`,
    params
  );

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
