import type { Pool } from 'pg';
import { config } from '../config';
import { getAppState, setAppState } from '../db';
import { assertSnapshotShape, buildPublicSnapshot } from '../services/public-snapshot';
import type { SnapshotInput } from '../types/public-snapshot';

export interface PublishResult { ok: boolean; reason?: string; bytes?: number }

/** app_state key the daily digest reads to surface publisher health. */
export const SNAPSHOT_STATE_KEY = 'public-snapshot:last';

/**
 * app_state access is injected rather than imported directly. Without this the
 * week-number read would reach for the global pool while every other read used
 * the pool argument — inconsistent, and it makes the gather step untestable.
 */
export interface SnapshotDeps {
  getAppState: typeof getAppState;
  setAppState: typeof setAppState;
}
const defaultDeps: SnapshotDeps = { getAppState, setAppState };

/**
 * Six narrow queries. Every SELECT names its columns — no SELECT *, ever, and
 * only the three tables the projection is allowed to read. tests/public-snapshot-
 * contract.test.js enforces both by reading this file.
 */
export async function gatherSnapshotInput(
  pool: Pool,
  deps: SnapshotDeps = defaultDeps,
): Promise<SnapshotInput> {
  const [funnel, buckets, publishes, stations, coverage, week] = await Promise.all([
    pool.query(`
      SELECT status, COUNT(*)::int AS n
      FROM scan_entries
      WHERE created_at >= NOW() - INTERVAL '24 hours'
      GROUP BY status`),
    pool.query(`
      SELECT date_trunc('hour', created_at)
               + INTERVAL '15 minutes' * FLOOR(EXTRACT(minute FROM created_at) / 15) AS bucket,
             status, COUNT(*)::int AS n
      FROM scan_entries
      WHERE created_at >= NOW() - INTERVAL '24 hours'
      GROUP BY 1, 2
      ORDER BY 1`),
    pool.query(`
      SELECT dl.created_at, dl.external_id, dl.wire, se.name, se.amount
      FROM distribution_logs dl
      JOIN scan_entries se ON se.id = dl.entry_id
      WHERE dl.channel = 'telegram' AND dl.status = 'success'
        AND dl.created_at >= NOW() - INTERVAL '24 hours'
      ORDER BY dl.created_at`),
    pool.query(`
      SELECT 'intake'::text AS id, MAX(created_at) AS last_run_at, COUNT(*)::int AS items_touched
      FROM scan_entries WHERE created_at >= NOW() - INTERVAL '24 hours'
      UNION ALL
      SELECT 'dedup', MAX(updated_at), COUNT(*)::int
      FROM scan_entries
      WHERE status = 'duplicate' AND updated_at >= NOW() - INTERVAL '24 hours'
      UNION ALL
      SELECT 'classifier', MAX(updated_at), COUNT(*)::int
      FROM scan_entries
      WHERE classification IS NOT NULL AND classification <> 'UNCHECKED'
        AND updated_at >= NOW() - INTERVAL '24 hours'`),
    pool.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE last_changed_at >= NOW() - INTERVAL '30 days')::int AS fresh,
             COUNT(*) FILTER (WHERE last_checked_at IS NULL
                                 OR last_checked_at < NOW() - INTERVAL '30 days')::int AS dark
      FROM watch_surfaces WHERE status = 'active'`),
    // Last number written by the retired weekly issue. Nothing advances it.
    deps.getAppState<number>('weekly:week-number'),
  ]);

  return {
    funnel: funnel.rows.map(r => ({ status: r.status, n: r.n })),
    buckets: buckets.rows.map(r => ({ bucket: new Date(r.bucket), status: r.status, n: r.n })),
    publishes: publishes.rows.map(r => ({
      created_at: new Date(r.created_at),
      name: r.name, amount: r.amount, wire: r.wire, external_id: r.external_id,
    })),
    stations: stations.rows.map(r => ({
      id: r.id,
      last_run_at: r.last_run_at ? new Date(r.last_run_at) : null,
      items_touched: r.items_touched,
    })),
    coverage: coverage.rows[0] ?? { total: 0, fresh: 0, dark: 0 },
    desk: { weekNumber: Number(week) || 0, wires: ['crypto', 'ai', 'oss'] },
    telegramBase: config.publicSnapshot.telegramBase,
  };
}

/** Persist the outcome so the daily digest can report on it. Never masks the result. */
async function record(result: PublishResult, deps: SnapshotDeps): Promise<PublishResult> {
  try {
    await deps.setAppState(SNAPSHOT_STATE_KEY, { ...result, at: new Date().toISOString() });
  } catch (error) {
    console.error('[PublicSnapshot] could not record run state:', error);
  }
  return result;
}

/**
 * Gather → build → assert → push. Never throws: the caller runs inside the
 * 5-minute pipeline cycle and a broken publisher must not stop process-raw.
 */
export async function publishPublicSnapshot(
  pool: Pool,
  deps: SnapshotDeps = defaultDeps,
): Promise<PublishResult> {
  const { pushUrl, pushToken } = config.publicSnapshot;
  // Not recorded: "unconfigured" never changes, the digest ignores it, and
  // persisting it would mean a wasted app_state write every 5 minutes forever.
  if (!pushUrl || !pushToken) return { ok: false, reason: 'unconfigured' };

  try {
    const input = await gatherSnapshotInput(pool, deps);
    const snapshot = buildPublicSnapshot(input, new Date());
    assertSnapshotShape(snapshot);          // refuse to publish a violating payload
    const body = JSON.stringify(snapshot);

    const res = await fetch(pushUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${pushToken}`,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      console.error(`[PublicSnapshot] push failed: HTTP ${res.status}`);
      return record({ ok: false, reason: `http_${res.status}` }, deps);
    }
    console.log(`[PublicSnapshot] published ${body.length} bytes, ${snapshot.events.length} events`);
    return record({ ok: true, bytes: body.length }, deps);
  } catch (error) {
    console.error('[PublicSnapshot] publish failed:', error);
    return record({ ok: false, reason: 'exception' }, deps);
  }
}
