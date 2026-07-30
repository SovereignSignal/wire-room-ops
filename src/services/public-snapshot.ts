import {
  SNAPSHOT_VERSION, type BucketRow, type PublicEvent, type PublicItem,
  type PublicSnapshot, type PublishRow, type SnapshotInput,
} from '../types/public-snapshot';

const WINDOW_HOURS = 24;
const RUNNING_WITHIN_MS = 10 * 60 * 1000;

/** Statuses that mean "this never reached a human". */
const ARCHIVED_STATUSES = new Set(['archived', 'incomplete', 'skipped']);

/**
 * Build a published item. Constructed field by field on purpose — spreading the
 * row is what leaks, and the row legitimately carries private columns.
 */
function toItem(row: PublishRow, telegramBase: string): PublicItem {
  return {
    name: String(row.name ?? '').slice(0, 120),
    amount: row.amount == null ? null : String(row.amount).slice(0, 40),
    wire: String(row.wire ?? ''),
    url: row.external_id ? `${telegramBase}/${row.external_id}` : telegramBase,
  };
}

function bucketKind(status: string): PublicEvent['kind'] | null {
  if (status === 'duplicate') return 'dedup';
  if (ARCHIVED_STATUSES.has(status)) return 'archive';
  if (status === 'queued') return 'queue';
  return null;
}

export function buildPublicSnapshot(input: SnapshotInput, generatedAt: Date): PublicSnapshot {
  const byStatus = new Map(input.funnel.map(r => [r.status, Number(r.n) || 0]));
  const sum = (...keys: string[]) => keys.reduce((t, k) => t + (byStatus.get(k) ?? 0), 0);

  const scanned = [...byStatus.values()].reduce((t, n) => t + n, 0);
  const funnel = [
    { stage: 'scanned', count: scanned },
    { stage: 'duplicate', count: sum('duplicate') },
    { stage: 'archived', count: sum('archived', 'incomplete', 'skipped') },
    { stage: 'review', count: sum('queued') },
    { stage: 'published', count: input.publishes.length },
  ];

  const events: PublicEvent[] = [];

  // One synthetic 'run' event per bucket that saw any activity, so the room has
  // a heartbeat even when nothing published.
  const runTotals = new Map<number, number>();
  for (const b of input.buckets as BucketRow[]) {
    runTotals.set(b.bucket.getTime(), (runTotals.get(b.bucket.getTime()) ?? 0) + (Number(b.n) || 0));
  }
  for (const [ms, n] of runTotals) {
    events.push({ at: new Date(ms).toISOString(), kind: 'run', station: 'stringer', n });
  }
  for (const b of input.buckets as BucketRow[]) {
    const kind = bucketKind(b.status);
    if (!kind) continue;
    events.push({ at: new Date(b.bucket.getTime() + 60_000).toISOString(), kind, n: Number(b.n) || 0 });
  }
  for (const p of input.publishes) {
    events.push({ at: p.created_at.toISOString(), kind: 'publish', item: toItem(p, input.telegramBase) });
  }
  events.sort((a, b) => a.at.localeCompare(b.at));

  const stations = input.stations.map(s => ({
    id: String(s.id),
    state: (s.last_run_at && generatedAt.getTime() - s.last_run_at.getTime() < RUNNING_WITHIN_MS
      ? 'running' : 'idle') as 'idle' | 'running',
    lastRunAt: s.last_run_at ? s.last_run_at.toISOString() : null,
    itemsTouched: Number(s.items_touched) || 0,
  }));

  return {
    v: SNAPSHOT_VERSION,
    generatedAt: generatedAt.toISOString(),
    windowHours: WINDOW_HOURS,
    desk: {
      surfacesWatched: Number(input.coverage.total) || 0,
      weekNumber: Number(input.desk.weekNumber) || 0,
      wires: input.desk.wires.map(String),
    },
    funnel,
    stations,
    coverage: {
      total: Number(input.coverage.total) || 0,
      fresh: Number(input.coverage.fresh) || 0,
      dark: Number(input.coverage.dark) || 0,
    },
    events,
  };
}
