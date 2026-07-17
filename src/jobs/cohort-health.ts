import type { Pool } from 'pg';
import { getAppState, setAppState } from '../db';

export const COHORT_SOURCE_NAME = 'claude-cohort-notion';
export const COHORT_HEALTH_STATE_KEY = 'cohort-bridge:health-v1';
export const COHORT_STALE_MS = 30 * 60 * 60 * 1000;
export const COHORT_GAP_MS = 36 * 60 * 60 * 1000;

export interface CohortHealthState {
  lastSuccessfulRunId: string | null;
  lastSuccessfulFinishedAt: string | null;
  lastCheckedAt: string;
  pendingBackfillFrom?: string;
  pendingSince?: string;
  historyInitialized?: boolean;
}

export interface CohortHealthResult {
  lane: { key: string; state: 'ok' | 'warn' | 'fail'; detail: string };
  anomalies: string[];
  backfillFrom: string | null;
}

interface CohortRunRow {
  run_id: string;
  status: string;
  started_at: Date | string;
  finished_at: Date | string | null;
}

interface CohortHealthDeps {
  getAppState: typeof getAppState;
  setAppState: typeof setAppState;
}

const defaultDeps: CohortHealthDeps = { getAppState, setAppState };

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function isSuccessful(status: string | null | undefined): boolean {
  return ['ok', 'success', 'completed'].includes(String(status ?? '').toLowerCase());
}

function isReplay(runId: string): boolean {
  return /backfill|replay/i.test(runId);
}

function hours(ms: number): number {
  return Math.max(0, Math.floor(ms / (60 * 60 * 1000)));
}

/**
 * Verify the 05:00 Notion cohort bridge from durable source_runs evidence.
 * A missed daily window opens a durable backfill cursor in app_state. The
 * cursor remains pending across recovery runs and clears only after a clean
 * run whose run_id contains "backfill" or "replay".
 */
export async function checkCohortHealth(
  pool: Pool,
  deps: CohortHealthDeps = defaultDeps,
  now: Date = new Date(),
): Promise<CohortHealthResult> {
  const anomalies: string[] = [];
  const checkedAt = now.toISOString();
  let prior: CohortHealthState | null = null;

  try {
    prior = await deps.getAppState<CohortHealthState>(COHORT_HEALTH_STATE_KEY);
  } catch (error) {
    return {
      lane: { key: 'cohort', state: 'fail', detail: 'cohort cursor unreadable' },
      anomalies: [`Cohort bridge health state unreadable: ${error instanceof Error ? error.message : String(error)}`],
      backfillFrom: null,
    };
  }

  let rows: CohortRunRow[];
  try {
    const result = await pool.query<CohortRunRow>(`
      SELECT run_id, status, started_at, finished_at
      FROM source_runs
      WHERE source_name = $1
        AND started_at >= NOW() - INTERVAL '45 days'
      ORDER BY started_at DESC
      LIMIT 90`, [COHORT_SOURCE_NAME]);
    rows = result.rows;
  } catch (error) {
    return {
      lane: { key: 'cohort', state: 'fail', detail: 'cohort probe failed' },
      anomalies: [`Cohort bridge heartbeat probe failed: ${error instanceof Error ? error.message : String(error)}`],
      backfillFrom: prior?.pendingBackfillFrom ?? null,
    };
  }

  const successful = rows
    .filter(row => isSuccessful(row.status) && iso(row.finished_at))
    .sort((a, b) => Date.parse(iso(b.finished_at)!) - Date.parse(iso(a.finished_at)!));
  const latest = rows[0] ?? null;
  const latestSuccess = successful[0] ?? null;
  const latestFinishedAt = iso(latestSuccess?.finished_at);

  let pendingBackfillFrom = prior?.pendingBackfillFrom;
  let pendingSince = prior?.pendingSince;
  let historyInitialized = prior?.historyInitialized ?? false;

  // Seed protection from source_runs history. This catches outages that
  // predate the first deployment of the monitor instead of blessing the
  // newest healthy run and forgetting the missed window.
  if (!pendingBackfillFrom && !historyInitialized) {
    let oldestGapCursor: string | undefined;
    for (let i = 0; i < successful.length - 1; i += 1) {
      const later = Date.parse(iso(successful[i].finished_at)!);
      const earlierIso = iso(successful[i + 1].finished_at)!;
      const earlier = Date.parse(earlierIso);
      if (later - earlier > COHORT_GAP_MS) {
        if (!oldestGapCursor || earlier < Date.parse(oldestGapCursor)) oldestGapCursor = earlierIso;
      }
    }
    if (oldestGapCursor) {
      pendingBackfillFrom = oldestGapCursor;
      pendingSince = checkedAt;
    }
    historyInitialized = true;
  }

  const replay = pendingBackfillFrom
    ? successful.find(row => isReplay(row.run_id) && Date.parse(iso(row.finished_at)!) >= Date.parse(pendingSince ?? pendingBackfillFrom!))
    : null;
  if (replay) {
    pendingBackfillFrom = undefined;
    pendingSince = undefined;
  }

  const latestStartedAt = iso(latest?.started_at);
  const latestFailed = Boolean(latest && !isSuccessful(latest.status)
    && latestStartedAt
    && (!latestFinishedAt || Date.parse(latestStartedAt) > Date.parse(latestFinishedAt)));
  const ageMs = latestFinishedAt ? now.getTime() - Date.parse(latestFinishedAt) : Number.POSITIVE_INFINITY;

  if ((latestFailed || ageMs > COHORT_STALE_MS) && !pendingBackfillFrom) {
    pendingBackfillFrom = prior?.lastSuccessfulFinishedAt ?? latestFinishedAt ?? undefined;
    pendingSince = checkedAt;
  }

  const next: CohortHealthState = {
    lastSuccessfulRunId: latestSuccess?.run_id ?? prior?.lastSuccessfulRunId ?? null,
    lastSuccessfulFinishedAt: latestFinishedAt ?? prior?.lastSuccessfulFinishedAt ?? null,
    lastCheckedAt: checkedAt,
    historyInitialized,
    ...(pendingBackfillFrom ? { pendingBackfillFrom, pendingSince: pendingSince ?? checkedAt } : {}),
  };

  try {
    await deps.setAppState(COHORT_HEALTH_STATE_KEY, next);
  } catch (error) {
    return {
      lane: { key: 'cohort', state: 'fail', detail: 'cohort cursor not durable' },
      anomalies: [`Cohort bridge backfill cursor failed to persist: ${error instanceof Error ? error.message : String(error)}`],
      backfillFrom: pendingBackfillFrom ?? null,
    };
  }

  if (!latestSuccess) {
    anomalies.push('Cohort bridge has no successful source run in the last 45 days; no safe backfill cursor is available');
    return {
      lane: { key: 'cohort', state: 'fail', detail: 'cohort no heartbeat' },
      anomalies,
      backfillFrom: pendingBackfillFrom ?? null,
    };
  }

  if (latestFailed) {
    anomalies.push(`Cohort bridge latest run failed; backfill pending from ${pendingBackfillFrom ?? latestFinishedAt}`);
    return {
      lane: { key: 'cohort', state: 'fail', detail: 'cohort failed; backfill pending' },
      anomalies,
      backfillFrom: pendingBackfillFrom ?? null,
    };
  }

  if (ageMs > COHORT_STALE_MS) {
    anomalies.push(`Cohort bridge heartbeat is ${hours(ageMs)}h old; backfill pending from ${pendingBackfillFrom ?? latestFinishedAt}`);
    return {
      lane: { key: 'cohort', state: 'fail', detail: `cohort stale ${hours(ageMs)}h` },
      anomalies,
      backfillFrom: pendingBackfillFrom ?? null,
    };
  }

  if (pendingBackfillFrom) {
    anomalies.push(`Cohort bridge is healthy, but replay remains pending from ${pendingBackfillFrom}`);
    return {
      lane: { key: 'cohort', state: 'fail', detail: 'cohort replay pending' },
      anomalies,
      backfillFrom: pendingBackfillFrom,
    };
  }

  return {
    lane: { key: 'cohort', state: 'ok', detail: 'cohort ✓' },
    anomalies,
    backfillFrom: null,
  };
}
