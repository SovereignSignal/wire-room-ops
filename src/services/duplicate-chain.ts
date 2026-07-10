import { Pool, PoolClient } from 'pg';

export interface DuplicateChainResolution {
  id: number | null;
  status: string | null;
  depth: number;
  error: 'missing' | 'cycle' | 'dead-end' | 'max-depth' | 'invalid-status' | null;
}

type Queryable = Pick<Pool | PoolClient, 'query'>;

/** Resolve a duplicate pointer to its terminal row with cycle and depth guards. */
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
