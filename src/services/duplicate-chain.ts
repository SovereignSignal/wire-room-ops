import { Pool } from 'pg';

export interface DuplicateChainResolution {
  id: number | null;
  status: string | null;
  depth: number;
  error: 'missing' | 'cycle' | 'dead-end' | 'max-depth' | 'invalid-status' | null;
}

type Queryable = Pick<Pool, 'query'>;

const DUPLICATE_GRAPH_LOCK_KEY = 'wire-room-ops:duplicate-graph';

/** Serialize graph mutations that can create duplicate edges. Must run in a transaction. */
export async function lockDuplicateGraph(db: Queryable): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [DUPLICATE_GRAPH_LOCK_KEY]);
}

export async function resolveDuplicateChain(
  db: Queryable,
  startId: number,
  maxDepth = 16,
): Promise<DuplicateChainResolution> {
  const result = await db.query(
    `WITH RECURSIVE duplicate_chain AS (
       SELECT id, status, duplicate_of_id, ARRAY[id]::bigint[] AS path,
              0 AS depth, false AS cycle
       FROM scan_entries
       WHERE id = $1
       UNION ALL
       SELECT next.id, next.status, next.duplicate_of_id,
              chain.path || next.id, chain.depth + 1,
              next.id = ANY(chain.path) AS cycle
       FROM duplicate_chain chain
       JOIN scan_entries next ON next.id = chain.duplicate_of_id
       WHERE chain.status = 'duplicate'
         AND chain.duplicate_of_id IS NOT NULL
         AND chain.depth < $2
         AND NOT chain.cycle
     )
     SELECT id, status, duplicate_of_id, depth, cycle
     FROM duplicate_chain
     ORDER BY depth DESC
     LIMIT 1`,
    [startId, maxDepth],
  );
  const terminal = result.rows[0];
  if (!terminal) return { id: null, status: null, depth: 0, error: 'missing' };
  if (terminal.cycle) return { id: null, status: terminal.status, depth: terminal.depth, error: 'cycle' };
  if (terminal.status === 'duplicate') {
    const error = terminal.duplicate_of_id && terminal.depth >= maxDepth ? 'max-depth' : 'dead-end';
    return { id: null, status: terminal.status, depth: terminal.depth, error };
  }
  if (!['approved', 'declined', 'queued'].includes(terminal.status)) {
    return { id: null, status: terminal.status, depth: terminal.depth, error: 'invalid-status' };
  }
  return { id: terminal.id, status: terminal.status, depth: terminal.depth, error: null };
}

/** Keep exact URL dedup ownership pointed at the terminal canonical entry. */
export async function reassignSeenUrlOwnership(
  db: Queryable,
  duplicateEntryId: number,
  canonicalEntryId: number,
): Promise<void> {
  await db.query(
    `UPDATE seen_urls
     SET first_seen_entry_id = $2
     WHERE first_seen_entry_id = $1`,
    [duplicateEntryId, canonicalEntryId],
  );
}

export interface DuplicateDemotionOptions {
  targetId: number;
  requestedParentId: number;
  expectedStatus: string;
  expectedSourceUrl: string;
  reason: string;
  actor?: string;
}

export interface DuplicateDemotionResult {
  outcome: 'linked' | 'stale';
  canonicalParentId: number | null;
}

/**
 * Create a duplicate edge inside the caller's transaction.
 *
 * Every production writer uses the same graph lock, deterministic endpoint
 * locks, recursive parent resolution, and source/status compare-and-set. This
 * prevents concurrent A to B / B to A writes and stops background jobs from
 * overwriting an operator edit made after they read the row.
 */
export async function demoteEntryToDuplicateInTransaction(
  db: Queryable,
  opts: DuplicateDemotionOptions,
): Promise<DuplicateDemotionResult> {
  if (opts.targetId === opts.requestedParentId) {
    throw new Error('Entry cannot duplicate itself');
  }

  await lockDuplicateGraph(db);
  const endpointIds = [opts.targetId, opts.requestedParentId].sort((a, b) => a - b);
  const endpointResult = await db.query(
    `SELECT id, status, source_url, duplicate_of_id
     FROM scan_entries
     WHERE id = ANY($1::bigint[])
     ORDER BY id
     FOR UPDATE`,
    [endpointIds],
  );
  const target = endpointResult.rows.find(row => Number(row.id) === opts.targetId);
  const requestedParent = endpointResult.rows.find(row => Number(row.id) === opts.requestedParentId);
  if (!target
      || target.status !== opts.expectedStatus
      || target.source_url !== opts.expectedSourceUrl) {
    return { outcome: 'stale', canonicalParentId: null };
  }
  if (!requestedParent) throw new Error('Duplicate parent is missing');

  const resolution = await resolveDuplicateChain(db, opts.requestedParentId);
  if (resolution.error || resolution.id === null) {
    throw new Error(`Duplicate parent chain is invalid (${resolution.error || 'unknown'})`);
  }
  if (resolution.id === opts.targetId) {
    throw new Error('Duplicate link would create a cycle');
  }

  const terminalResult = await db.query(
    `SELECT id, status, duplicate_of_id
     FROM scan_entries
     WHERE id = $1
     FOR UPDATE`,
    [resolution.id],
  );
  const terminal = terminalResult.rows[0];
  if (!terminal
      || !['approved', 'declined', 'queued'].includes(terminal.status)
      || terminal.duplicate_of_id !== null) {
    throw new Error('Duplicate parent changed before write');
  }

  const revalidated = await resolveDuplicateChain(db, opts.requestedParentId);
  if (revalidated.error || revalidated.id !== resolution.id) {
    throw new Error('Duplicate parent changed before write');
  }

  const updated = await db.query(
    `UPDATE scan_entries AS target SET
       status = 'duplicate',
       duplicate_of_id = $2,
       duplicate_reason = $3,
       distributable = false,
       actioned_by = COALESCE($4, target.actioned_by),
       action_reason = COALESCE($3, target.action_reason),
       updated_at = NOW()
     WHERE target.id = $1
       AND target.status = $5
       AND target.source_url IS NOT DISTINCT FROM $6
       AND EXISTS (
         SELECT 1 FROM scan_entries AS parent
         WHERE parent.id = $2
           AND parent.status IN ('approved', 'declined', 'queued')
           AND parent.duplicate_of_id IS NULL
       )
     RETURNING target.id`,
    [
      opts.targetId,
      resolution.id,
      opts.reason,
      opts.actor ?? null,
      opts.expectedStatus,
      opts.expectedSourceUrl,
    ],
  );
  if (updated.rowCount !== 1) {
    return { outcome: 'stale', canonicalParentId: null };
  }

  await reassignSeenUrlOwnership(db, opts.targetId, resolution.id);
  return { outcome: 'linked', canonicalParentId: resolution.id };
}
