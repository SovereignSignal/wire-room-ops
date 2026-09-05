/**
 * Daily Digest Job
 *
 * Runs once per day (default: 6 AM PT). Aggregates all scan activity across
 * every wire from the past 24 hours and sends a single summary email.
 *
 * This replaces per-scan email notifications in the scheduler.
 */

import type { Pool } from 'pg';
import { getAppState, setAppState } from '../db';
import { SNAPSHOT_STATE_KEY } from './public-snapshot';
import { config } from '../config';
import { sendDailyDigestEmail } from '../services/email';
import type { DigestBdLead, ClosingSoonRow } from '../services/email';
import { runDeadlineDigest } from './deadline-digest';
import { checkCohortHealth } from './cohort-health';

export interface WireDigestStats {
  wire: string;
  scansRun: number;
  totalIngested: number;
  newUnique: number;
  duplicatesFound: number;
  avgQualityScore: number;
  highQualityCount: number;
  pendingReview: number;
  recentlyApproved: number;
}

export interface DailyDigestResult {
  date: string;
  wires: WireDigestStats[];
  totalPendingReview: number;
  totalNewUnique: number;
  hasActivity: boolean;
}

export async function runDailyDigest(pool: Pool): Promise<DailyDigestResult> {
  const client = await pool.connect();
  const dateStr = new Date().toISOString().slice(0, 10);

  try {
    // Intake runs from the past 24 hours, grouped by wire
    const intakeRows = await client.query<{
      wire: string;
      scans_run: string;
      total_ingested: string;
      new_unique: string;
      duplicates_found: string;
      avg_quality: string;
      high_quality: string;
    }>(`
      SELECT
        wire,
        COUNT(*)                      AS scans_run,
        COALESCE(SUM(total_ingested), 0) AS total_ingested,
        COALESCE(SUM(new_unique), 0)     AS new_unique,
        COALESCE(SUM(duplicates_found), 0) AS duplicates_found,
        COALESCE(ROUND(AVG(avg_quality_score)), 0) AS avg_quality,
        COALESCE(SUM(high_quality_count), 0) AS high_quality
      FROM intake_runs
      WHERE created_at >= NOW() - INTERVAL '24 hours'
        AND wire IS NOT NULL
      GROUP BY wire
      ORDER BY wire
    `);

    // Pending review counts per wire (all-time queue, not just today)
    const pendingRows = await client.query<{ wire: string; cnt: string }>(`
      SELECT wire, COUNT(*) AS cnt
      FROM scan_entries
      WHERE status = 'queued'
      GROUP BY wire
    `);
    const pendingByWire = Object.fromEntries(
      pendingRows.rows.map(r => [r.wire, parseInt(r.cnt, 10)])
    );

    // Recently approved in the past 24h
    const approvedRows = await client.query<{ wire: string; cnt: string }>(`
      SELECT wire, COUNT(*) AS cnt
      FROM scan_entries
      WHERE status = 'approved'
        AND updated_at >= NOW() - INTERVAL '24 hours'
      GROUP BY wire
    `);
    const approvedByWire = Object.fromEntries(
      approvedRows.rows.map(r => [r.wire, parseInt(r.cnt, 10)])
    );

    // If no intake runs today, still report pending queue state
    const wiresFromRuns = new Set(intakeRows.rows.map(r => r.wire));
    const wiresFromPending = new Set(Object.keys(pendingByWire));
    const allWires = new Set([...wiresFromRuns, ...wiresFromPending]);

    const wires: WireDigestStats[] = Array.from(allWires).sort().map(wire => {
      const run = intakeRows.rows.find(r => r.wire === wire);
      return {
        wire,
        scansRun: run ? parseInt(run.scans_run, 10) : 0,
        totalIngested: run ? parseInt(run.total_ingested, 10) : 0,
        newUnique: run ? parseInt(run.new_unique, 10) : 0,
        duplicatesFound: run ? parseInt(run.duplicates_found, 10) : 0,
        avgQualityScore: run ? parseInt(run.avg_quality, 10) : 0,
        highQualityCount: run ? parseInt(run.high_quality, 10) : 0,
        pendingReview: pendingByWire[wire] ?? 0,
        recentlyApproved: approvedByWire[wire] ?? 0,
      };
    });

    const totalPendingReview = wires.reduce((sum, w) => sum + w.pendingReview, 0);
    const totalNewUnique = wires.reduce((sum, w) => sum + w.newUnique, 0);

    return {
      date: dateStr,
      wires,
      totalPendingReview,
      totalNewUnique,
      hasActivity: totalNewUnique > 0 || totalPendingReview > 0,
    };
  } finally {
    client.release();
  }
}

import type { TopFindEntry, RunLedger, RunLedgerLane } from '../services/email';

export interface SourceBreakdownRow {
  wire: string;
  source: string;
  total: number;
  queued: number;
  approved: number;
  archived: number;
  duplicates: number;
  parked: number;
  signals: number;
}

export interface CostRow {
  provider: string;
  calls: number;
  cost_usd: number;
}

/**
 * Per-provider API cost for the last 24 hours, from api_usage_log. Covers all
 * per-cost tools: grok/anthropic/perplexity/ollama (LLM tokens), parallel
 * (search fee), twitter (X reads), firecrawl (scrapes), resend (email).
 * Providers without pricing rows show $0 — see model_pricing.
 */
export async function getCostRecap(pool: Pool): Promise<{ rows: CostRow[]; total: number }> {
  const { rows } = await pool.query<CostRow>(`
    SELECT provider,
           COUNT(*)::int AS calls,
           ROUND(COALESCE(SUM(estimated_cost_usd), 0)::numeric, 4)::float AS cost_usd
    FROM api_usage_log
    WHERE created_at >= NOW() - INTERVAL '24 hours'
    GROUP BY provider
    HAVING COUNT(*) > 0
    ORDER BY cost_usd DESC NULLS LAST
  `);
  const total = rows.reduce((sum, r) => sum + (r.cost_usd || 0), 0);
  return { rows, total: Math.round(total * 10000) / 10000 };
}

/**
 * Per-wire, per-source intake breakdown for the last 24 hours, including how
 * many entries the operator routing parked (kept in DB, not published).
 */
export async function getSourceBreakdown(pool: Pool): Promise<SourceBreakdownRow[]> {
  const { rows } = await pool.query<SourceBreakdownRow>(`
    SELECT
      wire,
      COALESCE(scan_source, 'unknown') AS source,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
      COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
      COUNT(*) FILTER (WHERE status = 'archived')::int AS archived,
      COUNT(*) FILTER (WHERE status = 'duplicate')::int AS duplicates,
      COUNT(*) FILTER (WHERE metadata->>'operator_route' = 'park')::int AS parked,
      COUNT(*) FILTER (WHERE metadata->>'operator_route' = 'relationship_signal')::int AS signals
    FROM scan_entries
    WHERE created_at >= NOW() - INTERVAL '24 hours'
    GROUP BY wire, COALESCE(scan_source, 'unknown')
    ORDER BY wire, total DESC
  `);
  return rows;
}

export interface LaneYieldRow {
  source: string;
  total: number;
  netNew: number;
}

/** Below this volume, zero net-new is not evidence of anything. */
const YIELD_MIN_VOLUME = 10;

/** Human and chat intake re-submit known listings by nature; their yield is not lane health. */
const NON_AUTOMATED_SOURCES = new Set(['telegram', 'telegram-intake', 'manual-intake']);

/** Net-new (non-duplicate) entries per ingestion lane over a trailing window. */
export async function getLaneYield(pool: Pool, days: number = 3): Promise<LaneYieldRow[]> {
  const { rows } = await pool.query<{ source: string; total: number; net_new: number }>(`
    SELECT
      COALESCE(scan_source, 'unknown') AS source,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status NOT IN ('duplicate', 'deduped'))::int AS net_new
    FROM scan_entries
    WHERE created_at >= NOW() - ($1 || ' days')::interval
    GROUP BY 1
    ORDER BY total DESC
  `, [String(days)]);
  return rows.map(r => ({ source: r.source, total: r.total, netNew: r.net_new }));
}

/**
 * A lane that fetched real volume and produced nothing new is the signal worth
 * escalating. This replaces the duplicate-rate anomaly, which fired when dedup
 * was WORKING and carried a per-wire volume floor that hid crypto entirely.
 *
 * The 3-day trailing window IS the persistence gate — a lane must be dry
 * across three consecutive days, not blip once. There is deliberately no
 * consecutive-run counter, which would require new state. Accepted
 * consequence: a genuinely quiet low-volume lane that still clears the
 * volume floor can report once during a slow stretch.
 */
export function formatYieldAnomalies(rows: LaneYieldRow[], days: number = 3): string[] {
  return rows
    .filter(r => !NON_AUTOMATED_SOURCES.has(r.source))
    .filter(r => r.total >= YIELD_MIN_VOLUME && r.netNew === 0)
    .map(r => `Lane ${r.source}: 0 net-new in ${days} days (${r.total} fetched)`);
}

// ── Silent producer anomalies ──────────────────────────────────────────────
// A producer that fed the pipeline most days this week and sent nothing in the
// last 24h. Expectation is derived from the producer's own recent cadence, so
// there is no schedule registry to keep in sync and no new state: a lane that
// runs three days a week never trips it, a lane that runs daily trips it the
// morning after its first miss.

export interface ProducerActivityRow {
  /** scan_source, suffixed with the agent identity for internal-key submissions
   *  so Grok Build (`telegram / agent:stringer`) is a producer distinct from a
   *  human pasting into the bot (`telegram`). */
  producer: string;
  activeDays7d: number;
  rows24h: number;
  rows7d: number;
}

/** Fewer active days than this in the trailing week is not a daily cadence. */
const DAILY_PRODUCER_MIN_ACTIVE_DAYS = 5;

export async function getProducerActivity(pool: Pool): Promise<ProducerActivityRow[]> {
  const { rows } = await pool.query<{ producer: string; active_days_7d: number; rows_24h: number; rows_7d: number }>(`
    SELECT
      COALESCE(scan_source, 'unknown')
        || CASE WHEN submitted_by LIKE 'agent:%' THEN ' / ' || submitted_by ELSE '' END AS producer,
      COUNT(DISTINCT created_at::date)::int AS active_days_7d,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS rows_24h,
      COUNT(*)::int AS rows_7d
    FROM scan_entries
    WHERE created_at >= NOW() - INTERVAL '7 days'
    GROUP BY 1
    ORDER BY rows_7d DESC
  `);
  return rows.map(r => ({ producer: r.producer, activeDays7d: r.active_days_7d, rows24h: r.rows_24h, rows7d: r.rows_7d }));
}

/** Daily cadence this week, nothing in the last 24h. The one rule this anomaly rests on. */
export function isSilentProducer(row: ProducerActivityRow): boolean {
  return row.activeDays7d >= DAILY_PRODUCER_MIN_ACTIVE_DAYS && row.rows24h === 0;
}

export function formatSilentProducerAnomalies(rows: ProducerActivityRow[]): string[] {
  return rows
    .filter(r => !NON_AUTOMATED_SOURCES.has(r.producer))
    .filter(isSilentProducer)
    .map(r => `Producer ${r.producer}: 0 rows in 24h after ${r.activeDays7d} active days this week (${r.rows7d} rows) — did its schedule fire?`);
}

// ── Stale source anomalies ─────────────────────────────────────────────────
// Name each failing source and how long it has been failing, escalating at 2+ days.

export interface StaleSourceInput {
  key: string;
  error?: string;
  lastOk?: string | null;
}

/** A source stale >= this many days is a production issue, not a blip. */
const STALE_SOURCE_DAYS = 2;

/**
 * Name each failing source and how long it has been failing.
 *
 * "1 of 21 sources errored" read identically on day 1 and day 30, which is how
 * Karma GAP stayed dark for three days. Day 1 stays a ledger warning; day 2+ is
 * an issue. Derived from the per-source watermark's lastRun — no new state.
 *
 * A source that has never succeeded is reported on its first failure,
 * bypassing the 2-day rule. This is deliberate — a source with no track
 * record failing immediately is more suspicious than an established one
 * blipping — and there is no first-attempted-at timestamp that would let us
 * grant a grace period without new state.
 */
export function formatStaleSourceAnomalies(perSource: StaleSourceInput[], now: number = Date.now()): string[] {
  const rows = perSource
    .filter(s => s.error)
    .map(s => {
      const parsed = s.lastOk ? Date.parse(s.lastOk) : NaN;
      if (Number.isNaN(parsed)) return { key: s.key, days: null, date: null };
      return {
        key: s.key,
        days: Math.floor((now - parsed) / 86400000),
        // Format the recorded timestamp itself, never a value recomputed from the
        // floored day count — those disagree whenever the fetch time of day drifts.
        date: new Date(parsed).toISOString().split('T')[0],
      };
    });

  return rows
    .filter(r => r.days === null || r.days >= STALE_SOURCE_DAYS)
    .sort((a, b) => (b.days ?? Infinity) - (a.days ?? Infinity))
    .map(r => r.days === null
      ? `Source feeds: ${r.key} failing (never succeeded)`
      : `Source feeds: ${r.key} failing ${r.days} days (last OK ${r.date})`);
}

// ── Digest email watermark ─────────────────────────────────────────────────
// An entry is emailed by the digest at most once (best-effort: no
// cross-process lock, so concurrent cron + send-now can in rare cases repeat
// an item). The watermark is a forward-only map in app_state; it advances
// only after a successful send (same pattern as the BD roles lane), so a
// failed email never swallows items.

export const DIGEST_WATERMARK_KEY = 'digest:emailed-ids';
const WATERMARK_MAX_AGE_DAYS = 60;

/** entryId -> ISO timestamp of the digest that emailed it */
export type EmailedIdsMap = Record<string, string>;

export interface WatermarkDeps {
  getAppState: typeof getAppState;
  setAppState: typeof setAppState;
}
const defaultWatermarkDeps: WatermarkDeps = { getAppState, setAppState };

export function pruneEmailedIds(map: EmailedIdsMap, now = new Date(), maxAgeDays = WATERMARK_MAX_AGE_DAYS): EmailedIdsMap {
  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
  const out: EmailedIdsMap = {};
  for (const [id, iso] of Object.entries(map)) {
    const t = Date.parse(iso);
    if (!Number.isNaN(t) && t >= cutoff) out[id] = iso;
  }
  return out;
}

export interface FreshFindsResult {
  finds: TopFindEntry[];
  totalNew: number;   // all eligible never-emailed items (finds is the top slice)
  seeded: boolean;    // first run: watermark initialized, nothing surfaced
  fallback: boolean;  // watermark unreadable: 24h window used instead
}

const FRESH_FINDS_SELECT = `
  SELECT q.id, q.name, q.wire, q.quality_score, q.amount, q.deadline, q.source_url,
         q.metadata->'curator'->>'route' AS curator_route,
         q.metadata->'curator'->>'confidence' AS curator_confidence,
         COALESCE(NULLIF(q.metadata->>'summary', ''), LEFT(q.description, 220)) AS summary,
         q.metadata->'decided_recheck'->>'verdict' AS recheck_verdict,
         m.name AS recheck_matched_name,
         m.status AS recheck_matched_status,
         q.metadata->'program'->>'verdict' AS program_verdict,
         CASE WHEN p.id IS NULL THEN NULL ELSE
           'seen ' || p.entry_count || '×'
           || CASE WHEN p.approved_count > 0 THEN ' · approved ' || p.approved_count || '×' ELSE '' END
           || CASE WHEN p.declined_count > 0 THEN ' · declined ' || p.declined_count || '×' ELSE '' END
           || CASE WHEN p.last_decision IS NOT NULL THEN ' · last ' || p.last_decision ELSE '' END
         END AS program_history
  FROM scan_entries q
  LEFT JOIN scan_entries m
    ON m.id = NULLIF(q.metadata->'decided_recheck'->>'matched_id', '')::int
  LEFT JOIN programs p ON p.id = q.program_id
  WHERE q.status = 'queued'
    AND (q.deadline_parsed IS NULL OR q.deadline_parsed >= CURRENT_DATE)
    -- candidate window matches watermark retention (60d) so an entry can
    -- never outlive its watermark entry and reappear as "new"
    AND q.created_at >= NOW() - INTERVAL '60 days'
    -- a stamped same_listing verdict IS a known duplicate even when the
    -- status demotion didn't fire — never email it. EXCEPT held entries:
    -- recheck blocks (cross-wire, wrong canonical parent, broken chain) leave
    -- the row queued precisely so a human reviews it, so it must stay visible.
    AND NOT (
      COALESCE(q.metadata->'decided_recheck'->>'verdict', '') = 'same_listing'
      AND COALESCE(q.metadata->'decided_recheck'->>'cross_wire_blocked', '') <> 'true'
      AND COALESCE(q.metadata->'decided_recheck'->>'canonical_parent_blocked', '') <> 'true'
      AND (q.metadata->'duplicate_chain_error') IS NULL
    )`;

const CURATOR_ORDER = `
  ORDER BY
    CASE q.metadata->'curator'->>'route'
      WHEN 'publish' THEN 0
      WHEN 'source_check' THEN 1
      WHEN 'relationship_signal' THEN 2
      WHEN 'park' THEN 3
      WHEN 'decline' THEN 4
      ELSE 5
    END,
    CASE q.metadata->'curator'->>'confidence'
      WHEN 'high' THEN 0
      WHEN 'med' THEN 1
      WHEN 'low' THEN 2
      ELSE 3
    END,
    q.quality_score DESC NULLS LAST,
    q.deadline_parsed ASC NULLS LAST,
    q.created_at DESC`;

/** 24h-window fallback used whenever the watermark can't be trusted (unreadable, or a seed write failed). */
async function fetch24hFallbackFinds(pool: Pool, limit: number): Promise<FreshFindsResult> {
  const { rows } = await pool.query<TopFindEntry>(
    `${FRESH_FINDS_SELECT}
      AND q.created_at >= NOW() - INTERVAL '24 hours'
    ${CURATOR_ORDER}
    LIMIT $1`, [limit]);
  return { finds: rows, totalNew: rows.length, seeded: false, fallback: true };
}

export async function getFreshFinds(pool: Pool, limit = 8, deps: WatermarkDeps = defaultWatermarkDeps): Promise<FreshFindsResult> {
  let map: EmailedIdsMap | null;
  try {
    map = await deps.getAppState<EmailedIdsMap>(DIGEST_WATERMARK_KEY);
  } catch (err) {
    console.error('[DailyDigest] Watermark read failed — falling back to 24h window:', err instanceof Error ? err.message : err);
    return fetch24hFallbackFinds(pool, limit);
  }

  if (map === null) {
    const { rows } = await pool.query<{ id: number }>(`SELECT id FROM scan_entries WHERE status = 'queued'`);
    const nowIso = new Date().toISOString();
    const seeded: EmailedIdsMap = {};
    for (const r of rows) seeded[String(r.id)] = nowIso;
    try {
      await deps.setAppState(DIGEST_WATERMARK_KEY, seeded);
    } catch (err) {
      console.error('[DailyDigest] Watermark seeding write failed — degrading to 24h window for today:', err instanceof Error ? err.message : err);
      return fetch24hFallbackFinds(pool, limit);
    }
    console.log(`[DailyDigest] Watermark seeded with ${rows.length} queued entries (forward-only start)`);
    return { finds: [], totalNew: 0, seeded: true, fallback: false };
  }

  const excluded = Object.keys(map).map(Number).filter(Number.isInteger);
  const { rows } = await pool.query<TopFindEntry>(
    `${FRESH_FINDS_SELECT}
      AND NOT (q.id = ANY($2::int[]))
    ${CURATOR_ORDER}
    LIMIT $1`, [limit, excluded]);
  const count = await pool.query<{ total_new: string }>(
    `SELECT COUNT(*) AS total_new
     FROM scan_entries
     WHERE status = 'queued'
       AND (deadline_parsed IS NULL OR deadline_parsed >= CURRENT_DATE)
       AND created_at >= NOW() - INTERVAL '60 days'
       AND NOT (
         COALESCE(metadata->'decided_recheck'->>'verdict', '') = 'same_listing'
         AND COALESCE(metadata->'decided_recheck'->>'cross_wire_blocked', '') <> 'true'
         AND COALESCE(metadata->'decided_recheck'->>'canonical_parent_blocked', '') <> 'true'
         AND (metadata->'duplicate_chain_error') IS NULL
       )
       AND NOT (id = ANY($1::int[]))`, [excluded]);
  return { finds: rows, totalNew: parseInt(count.rows[0]?.total_new ?? '0', 10), seeded: false, fallback: false };
}

export async function advanceDigestWatermark(ids: number[], deps: WatermarkDeps = defaultWatermarkDeps, now = new Date()): Promise<void> {
  if (ids.length === 0) return;
  let map: EmailedIdsMap;
  try {
    map = (await deps.getAppState<EmailedIdsMap>(DIGEST_WATERMARK_KEY)) ?? {};
  } catch (err) {
    // Unreadable map: skip the advance entirely rather than writing a fresh
    // map — that would silently wipe up to 60 days of watermark history and
    // flood every already-emailed item back as "new". Worst case here is
    // strictly safer: today's shown items may repeat once tomorrow.
    console.error('[DailyDigest] Watermark advance read failed — skipping advance (no write):', err instanceof Error ? err.message : err);
    return;
  }
  const iso = now.toISOString();
  for (const id of ids) map[String(id)] = iso;
  await deps.setAppState(DIGEST_WATERMARK_KEY, pruneEmailedIds(map, now));
}

export interface RunLedgerInputs {
  date: string;                                  // digest date — the agent-brief app_state key
  feeds?: { ok: number; total: number } | null;  // just-ran fold result; omit on send-now
  forum?: 'ok' | 'fail' | null;                  // null/undefined = lane disabled → omitted
}

/**
 * Assemble the run ledger from durable evidence, never scheduler bookkeeping
 * (in-memory JobStatus resets on restart). Every probe is isolated: a failed
 * probe renders "?" and can never block the digest email.
 */
export async function buildRunLedger(
  pool: Pool,
  inputs: RunLedgerInputs,
  deps: WatermarkDeps = defaultWatermarkDeps,
): Promise<{ ledger: RunLedger; anomalies: string[] }> {
  const lanes: RunLedgerLane[] = [];
  const anomalies: string[] = [];

  // scans — api_usage_log purpose='scan' over 24h (grok/perplexity/parallel all log it)
  try {
    const { rows } = await pool.query<{ ok: string; failed: string }>(`
      SELECT COUNT(*) FILTER (WHERE success) AS ok,
             COUNT(*) FILTER (WHERE NOT success) AS failed
      FROM api_usage_log
      WHERE purpose = 'scan' AND created_at >= NOW() - INTERVAL '24 hours'`);
    const ok = parseInt(rows[0]?.ok ?? '0', 10);
    const failed = parseInt(rows[0]?.failed ?? '0', 10);
    // A few transient failures among successful calls are visible as a warning
    // in the ledger, but do not turn the email into a production incident.
    // Escalate when every scan failed or failures are both repeated and at
    // least half of all attempts.
    const materialFailure = failed > 0 && (ok === 0 || (failed >= 2 && failed >= ok));
    if (materialFailure) {
      lanes.push({ key: 'scans', state: 'fail', detail: `scans ${ok}✓ ${failed}✗` });
      anomalies.push(`Scan calls: ${failed} failed in 24h`);
    } else if (failed > 0) {
      lanes.push({ key: 'scans', state: 'warn', detail: `scans ${ok}✓ ${failed}✗` });
    } else if (ok === 0) {
      lanes.push({ key: 'scans', state: 'warn', detail: 'scans 0' });
    } else {
      lanes.push({ key: 'scans', state: 'ok', detail: `scans ${ok}✓` });
    }
  } catch {
    lanes.push({ key: 'scans', state: 'warn', detail: 'scans ?' });
  }

  // held — recheck blocks (cross-wire, wrong canonical parent, broken chain)
  // that parked a queued entry for mandatory human review in the last 24h.
  // Replaces the retired program-gate lane: the gate is advisory-only now and
  // no longer produces actioned_by='program-gate' rows.
  try {
    const { rows } = await pool.query<{ n: string }>(`
      SELECT COUNT(*) AS n FROM scan_entries
      WHERE status = 'queued'
        AND (
          metadata->'decided_recheck'->>'cross_wire_blocked' = 'true'
          OR metadata->'decided_recheck'->>'canonical_parent_blocked' = 'true'
          OR (metadata->'duplicate_chain_error') IS NOT NULL
        )
        AND COALESCE((metadata->'decided_recheck'->>'at')::timestamptz, updated_at) >= NOW() - INTERVAL '24 hours'`);
    const n = parseInt(rows[0]?.n ?? '0', 10);
    if (n > 0) lanes.push({ key: 'held', state: 'warn', detail: `held ${n} for review` });
  } catch {
    // omit — optional evidence
  }

  // provider outages — a provider with failures and ZERO successes across all
  // production purposes in 24h is an account/endpoint-level problem. Prompt
  // Lab traffic stays out so experiments cannot create production incidents.
  // The 2026-07-10 xAI billing block hid behind the scans-only probe above:
  // classify/recheck/discovery were down for a day with no digest signal.
  try {
    const { rows } = await pool.query<{ provider: string; ok: string; failed: string }>(`
      SELECT provider,
             COUNT(*) FILTER (WHERE success) AS ok,
             COUNT(*) FILTER (WHERE NOT success) AS failed
      FROM api_usage_log
      WHERE created_at >= NOW() - INTERVAL '24 hours'
        AND purpose <> 'scan-test'
        AND purpose NOT LIKE 'parallel-test-%'
      GROUP BY provider`);
    for (const r of rows) {
      const ok = parseInt(r.ok ?? '0', 10);
      const failed = parseInt(r.failed ?? '0', 10);
      if (failed >= 5 && ok === 0) {
        lanes.push({ key: `api:${r.provider}`, state: 'fail', detail: `${r.provider} ${failed}✗ all calls` });
        anomalies.push(`Provider ${r.provider}: ${failed} failed calls and 0 successes in 24h — account/endpoint-level outage`);
      }
    }
  } catch {
    // optional evidence — never blocks the ledger
  }

  if (inputs.feeds) {
    const { ok, total } = inputs.feeds;
    // feed-source failures already push their own anomaly in the scheduler fold
    lanes.push({ key: 'feeds', state: ok === total ? 'ok' : 'fail', detail: `feeds ${ok}/${total}` });
  }
  if (inputs.forum) {
    lanes.push({ key: 'forum', state: inputs.forum === 'ok' ? 'ok' : 'fail', detail: inputs.forum === 'ok' ? 'forum ✓' : 'forum ✗' });
  }

  // bridge — tele-sum summary-sync watermark age (15-min cycle; >6h = stale).
  // The watermark only advances when tele-sum processed new summaries, so it
  // measures content arrival, not bridge health — a quiet Telegram night is
  // indistinguishable from a broken bridge. Warn glyph only; never flips the
  // digest's overall verdict. A proper heartbeat probe is a follow-up.
  try {
    const wm = await deps.getAppState<string>('summary-sync:watermark');
    if (wm) {
      const age = Date.now() - Date.parse(wm);
      if (Number.isNaN(age) || age > 6 * 60 * 60 * 1000) {
        lanes.push({ key: 'bridge', state: 'warn', detail: 'bridge stale' });
      } else {
        lanes.push({ key: 'bridge', state: 'ok', detail: 'bridge ✓' });
      }
    }
  } catch {
    lanes.push({ key: 'bridge', state: 'warn', detail: 'bridge ?' });
  }

  // cohort: the Notion Cowork+Codex bridge must produce one durable
  // source_run per day. WRO runs that bridge in this same daily fold; a
  // missed window becomes an email anomaly and opens a persistent replay
  // cursor that survives ordinary recovery runs.
  const cohort = await checkCohortHealth(pool, deps);
  lanes.push(cohort.lane);
  anomalies.push(...cohort.anomalies);

  // agent — today's brief presence; omitted when no agent ran (that is normal)
  try {
    const brief = await deps.getAppState<{ runs?: unknown[] }>(`agent-brief:${inputs.date}`);
    const runs = brief?.runs?.length ?? 0;
    if (runs > 0) lanes.push({ key: 'agent', state: 'ok', detail: `agent ${runs} run${runs === 1 ? '' : 's'}` });
  } catch {
    // omit — agent lane is optional evidence
  }

  // snapshot — the public Wire Room Live feed is a lane like any other: if it has
  // gone stale the page is serving old data, and that should surface in the
  // morning band rather than only in the logs. Omitted entirely when the
  // publisher is unconfigured, so this adds no noise before it is switched on.
  try {
    const last = await deps.getAppState<{ ok?: boolean; at?: string; reason?: string }>(SNAPSHOT_STATE_KEY);
    if (last && last.reason !== 'unconfigured') {
      const ageMin = last.at ? (Date.now() - Date.parse(last.at)) / 60000 : Infinity;
      if (!last.ok) {
        lanes.push({ key: 'snapshot', state: 'fail', detail: `snapshot ✗ ${last.reason ?? 'error'}` });
        anomalies.push(`Public snapshot failing (${last.reason ?? 'error'}) — the Wire Room Live page is serving stale data.`);
      } else if (ageMin > 30) {
        lanes.push({ key: 'snapshot', state: 'warn', detail: `snapshot ${Math.round(ageMin)}m old` });
      } else {
        lanes.push({ key: 'snapshot', state: 'ok', detail: 'snapshot ✓' });
      }
    }
  } catch {
    lanes.push({ key: 'snapshot', state: 'warn', detail: 'snapshot ?' });
  }

  return { ledger: { lanes }, anomalies };
}

export interface AssembleDigestOptions {
  recipients?: string[];
  /** In-fold lane failures collected by the scheduler (forum/feeds/weekly/BD) */
  laneAnomalies?: string[];
  feeds?: { ok: number; total: number } | null;
  forum?: 'ok' | 'fail' | null;
  bdLeads?: DigestBdLead[];
  bdLeadsUrl?: string;
}

export interface DigestSendSummary {
  date: string;
  freshCount: number;
  totalNew: number;
  issueCount: number;
  seeded: boolean;
}

export interface AssembleDigestDeps {
  digest: typeof runDailyDigest;
  fresh: typeof getFreshFinds;
  ledger: typeof buildRunLedger;
  deadlines: typeof runDeadlineDigest;
  cost: typeof getCostRecap;
  yield_: typeof getLaneYield;
  producers: typeof getProducerActivity;
  send: typeof sendDailyDigestEmail;
  advance: (ids: number[]) => Promise<void>;
}

const defaultAssembleDeps: AssembleDigestDeps = {
  digest: runDailyDigest,
  fresh: getFreshFinds,
  ledger: buildRunLedger,
  deadlines: runDeadlineDigest,
  cost: getCostRecap,
  yield_: getLaneYield,
  producers: getProducerActivity,
  send: sendDailyDigestEmail,
  advance: (ids) => advanceDigestWatermark(ids),
};

/**
 * ONE code path for the digest email — used by both the scheduler's daily
 * fold and the dashboard send-now button, so the two can never diverge.
 * The watermark advances only after the send succeeds.
 */
export async function assembleAndSendDailyDigest(
  pool: Pool,
  opts: AssembleDigestOptions = {},
  deps: AssembleDigestDeps = defaultAssembleDeps,
): Promise<DigestSendSummary> {
  const digest = await deps.digest(pool);
  const freshRes = await deps.fresh(pool, 8);

  let ledger: import('../services/email').RunLedger = { lanes: [] };
  const anomalies = [...(opts.laneAnomalies ?? [])];
  try {
    const built = await deps.ledger(pool, { date: digest.date, feeds: opts.feeds ?? null, forum: opts.forum ?? null });
    ledger = built.ledger;
    anomalies.push(...built.anomalies);
  } catch (e) {
    console.error('[DailyDigest] Run ledger failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  let closingSoon: ClosingSoonRow[] = [];
  try {
    const results = await deps.deadlines(pool);
    closingSoon = results.flatMap(r => r.entries.map(e => ({
      name: e.name, wire: r.wire, deadline: e.deadline, daysUntil: e.daysUntil,
      amount: e.amount, sourceUrl: e.sourceUrl,
    })));
  } catch (e) {
    console.error('[DailyDigest] Closing-soon fold failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  let costRecap: { rows: CostRow[]; total: number } | undefined;
  try {
    costRecap = await deps.cost(pool);
    if (costRecap.total > 5) anomalies.push(`API spend $${costRecap.total.toFixed(2)} in 24h (>$5)`);
  } catch (e) {
    console.error('[DailyDigest] Cost recap failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  try {
    const laneYield = await deps.yield_(pool, 3);
    anomalies.push(...formatYieldAnomalies(laneYield, 3));
  } catch (e) {
    console.error('[DailyDigest] Lane yield check failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  try {
    const producers = await deps.producers(pool);
    anomalies.push(...formatSilentProducerAnomalies(producers));
  } catch (e) {
    console.error('[DailyDigest] Silent producer check failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  await deps.send(digest, config.app.url, opts.recipients, {
    freshFinds: freshRes.finds,
    totalNewEligible: freshRes.totalNew,
    runLedger: ledger,
    closingSoon,
    costRecap,
    bdLeads: opts.bdLeads,
    bdLeadsUrl: opts.bdLeadsUrl,
    anomalies,
  });
  try {
    await deps.advance(freshRes.finds.map(f => f.id));
  } catch (e) {
    console.error('[DailyDigest] Watermark advance failed after send — shown items may repeat once:', e instanceof Error ? e.message : e);
  }

  return {
    date: digest.date,
    freshCount: freshRes.finds.length,
    totalNew: freshRes.totalNew,
    issueCount: anomalies.length,
    seeded: freshRes.seeded,
  };
}
