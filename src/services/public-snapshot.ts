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

const FORBIDDEN_KEYS = new Set([
  'description', 'quality_score', 'classification', 'operator_route',
  'actioned_by', 'action_reason', 'org_id', 'metadata', 'operator_read',
  'contact_email', 'email', 'cost',
]);
const MAX_BYTES = 512 * 1024;

/**
 * Last line of defence before the payload leaves the building. buildPublicSnapshot
 * is already explicit, but this catches a future edit that reintroduces a spread.
 * Throws rather than returning a flag: the caller must not be able to ignore it.
 */
export function assertSnapshotShape(snap: PublicSnapshot): void {
  (function walk(node: unknown): void {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (FORBIDDEN_KEYS.has(k)) throw new Error(`snapshot contains forbidden key: ${k}`);
        walk(v);
      }
    }
  })(snap);

  for (const e of snap.events) {
    if (e.item && e.kind !== 'publish') {
      throw new Error(`only publish events may carry an item (saw ${e.kind})`);
    }
    if (e.item) {
      const keys = Object.keys(e.item).sort().join(',');
      if (keys !== 'amount,name,url,wire') {
        throw new Error(`publish item has unexpected fields: ${keys}`);
      }
    }
  }

  const bytes = JSON.stringify(snap).length;
  if (bytes > MAX_BYTES) throw new Error(`snapshot too large: ${bytes} bytes`);
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
    events.push({ at: new Date(ms).toISOString(), kind: 'run', station: 'intake', n });
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

  const stations = input.stations.map(s => {
    const rawId = String(s.id);
    return {
      // The intake station used to be published as `stringer`. Canonical id is
      // `intake`. A `stringer` alias is added below for the Live prototype.
      id: rawId === 'stringer' ? 'intake' : rawId,
      state: (s.last_run_at && generatedAt.getTime() - s.last_run_at.getTime() < RUNNING_WITHIN_MS
        ? 'running' : 'idle') as 'idle' | 'running',
      lastRunAt: s.last_run_at ? s.last_run_at.toISOString() : null,
      itemsTouched: Number(s.items_touched) || 0,
    };
  });
  const intake = stations.find(s => s.id === 'intake');
  if (intake && !stations.some(s => s.id === 'stringer')) {
    stations.push({ ...intake, id: 'stringer' });
  }

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
