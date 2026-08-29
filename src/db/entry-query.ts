/**
 * Shared scan_entries list filters for GET /entries (queue + dashboard).
 * Pure SQL-clause builder so the operator filters can be unit-tested
 * without a live Postgres pool.
 */

export const QUEUE_CLASSIFICATIONS = ['GRANT', 'EXPIRED', 'NEWS', 'NOISE', 'UNCHECKED'] as const;
export const QUEUE_ROUTES = ['publish', 'source_check', 'park', 'relationship_signal', 'decline', 'none'] as const;
export const QUEUE_DATE_STATUSES = ['upcoming', 'no_date', 'expired'] as const;

export type QueueClassification = (typeof QUEUE_CLASSIFICATIONS)[number];
export type QueueRoute = (typeof QUEUE_ROUTES)[number];
export type QueueDateStatus = (typeof QUEUE_DATE_STATUSES)[number];

export interface ScanEntryQueryFilters {
  wire?: string;
  date?: string;
  promptId?: string;
  minScore?: number;
  maxScore?: number;
  unscored?: boolean;
  excludeSources?: string[];
  classification?: string;
  route?: string;
  dateStatus?: QueueDateStatus;
  hideTweets?: boolean;
}

const EFFECTIVE_ROUTE_SQL = `COALESCE(metadata->'curator'->>'route', metadata->>'operator_route')`;

export function isQueueClassification(value: string): value is QueueClassification {
  return (QUEUE_CLASSIFICATIONS as readonly string[]).includes(value);
}

export function isQueueRoute(value: string): value is QueueRoute {
  return (QUEUE_ROUTES as readonly string[]).includes(value);
}

export function isQueueDateStatus(value: string): value is QueueDateStatus {
  return (QUEUE_DATE_STATUSES as readonly string[]).includes(value);
}

export function buildScanEntryFilterClauses(
  opts: ScanEntryQueryFilters | undefined,
  startIndex: number,
): { conditions: string[]; values: unknown[]; nextIndex: number } {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIndex = startIndex;

  if (opts?.wire) {
    conditions.push(`wire = $${paramIndex++}`);
    values.push(opts.wire);
  }
  if (opts?.date) {
    conditions.push(`scan_date = $${paramIndex++}`);
    values.push(opts.date);
  }
  if (opts?.promptId) {
    conditions.push(`prompt_id = $${paramIndex++}`);
    values.push(opts.promptId);
  }
  if (opts?.unscored) {
    conditions.push(`quality_score IS NULL`);
  } else {
    if (opts?.minScore != null) {
      conditions.push(`quality_score >= $${paramIndex++}`);
      values.push(opts.minScore);
    }
    if (opts?.maxScore != null) {
      conditions.push(`quality_score <= $${paramIndex++}`);
      values.push(opts.maxScore);
    }
  }
  if (opts?.excludeSources && opts.excludeSources.length > 0) {
    conditions.push(`COALESCE(scan_source, '') != ALL($${paramIndex++})`);
    values.push(opts.excludeSources);
  }
  if (opts?.classification) {
    conditions.push(`COALESCE(classification, 'UNCHECKED') = $${paramIndex++}`);
    values.push(opts.classification);
  }
  if (opts?.route === 'none') {
    conditions.push(`${EFFECTIVE_ROUTE_SQL} IS NULL`);
  } else if (opts?.route) {
    conditions.push(`${EFFECTIVE_ROUTE_SQL} = $${paramIndex++}`);
    values.push(opts.route);
  }
  if (opts?.dateStatus === 'upcoming') {
    conditions.push(`deadline_parsed IS NOT NULL AND deadline_parsed >= CURRENT_DATE`);
  } else if (opts?.dateStatus === 'expired') {
    conditions.push(`deadline_parsed IS NOT NULL AND deadline_parsed < CURRENT_DATE`);
  } else if (opts?.dateStatus === 'no_date') {
    conditions.push(`deadline_parsed IS NULL`);
  }
  if (opts?.hideTweets) {
    conditions.push(`(source_url IS NULL OR source_url !~* '^https?://(?:[^/]+\\.)*(?:x\\.com|twitter\\.com)(?:[/?#]|$)')`);
  }

  return { conditions, values, nextIndex: paramIndex };
}
