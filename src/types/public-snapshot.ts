/**
 * The public projection contract. Anything not declared here cannot reach the
 * open internet — see src/services/public-snapshot.ts, which constructs every
 * object literally rather than spreading database rows.
 */
export const SNAPSHOT_VERSION = 1 as const;

export type EventKind = 'run' | 'dedup' | 'archive' | 'queue' | 'publish';

/** The ONLY shape allowed to carry text from an entry, and only once published. */
export interface PublicItem {
  name: string;
  amount: string | null;
  wire: string;
  url: string;
}

export interface PublicEvent {
  at: string;            // ISO 8601
  kind: EventKind;
  station?: string;      // 'run' only
  n?: number;            // counts for non-publish kinds
  item?: PublicItem;     // publish only
}

export interface PublicSnapshot {
  v: typeof SNAPSHOT_VERSION;
  generatedAt: string;
  windowHours: number;
  desk: { surfacesWatched: number; weekNumber: number; wires: string[] };
  funnel: { stage: string; count: number }[];
  stations: { id: string; state: 'idle' | 'running'; lastRunAt: string | null; itemsTouched: number }[];
  coverage: { total: number; fresh: number; dark: number };
  events: PublicEvent[];
}

// ── raw query row shapes (input side) ────────────────────────────────────────
export interface FunnelRow { status: string; n: number }
export interface BucketRow { bucket: Date; status: string; n: number }
export interface StationRow { id: string; last_run_at: Date | null; items_touched: number }
export interface CoverageRow { total: number; fresh: number; dark: number }

/** Rows may carry any number of extra private columns; the builder ignores them. */
export interface PublishRow {
  created_at: Date;
  name: string;
  amount: string | null;
  wire: string;
  external_id: string | null;
  [extra: string]: unknown;
}

export interface SnapshotInput {
  funnel: FunnelRow[];
  buckets: BucketRow[];
  publishes: PublishRow[];
  stations: StationRow[];
  coverage: CoverageRow;
  desk: { weekNumber: number; wires: string[] };
  telegramBase: string;
}
