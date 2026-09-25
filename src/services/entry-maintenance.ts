import { Pool } from 'pg';
import { normalizeUrl } from './intake';
import { classifySourceLink } from './source-filter';
import { lockDuplicateGraph, reconcileDuplicateReferences, resolveDuplicateChain } from './duplicate-chain';

export class EntryMaintenanceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'EntryMaintenanceError';
  }
}

interface GuardedMutationOptions {
  expectedStatus: string;
  actor: string;
  reason: string;
  dryRun?: boolean;
}

export interface RewriteSourceOptions extends GuardedMutationOptions {
  expectedSourceUrl: string;
  newSourceUrl: string;
}

export interface LinkDuplicateOptions extends GuardedMutationOptions {
  duplicateOfId: number;
  expectedSourceUrl: string;
}

export interface RewriteWireOptions {
  wires: string[];
  actor?: string;
  reason?: string;
}

function requireAuditFields(opts: GuardedMutationOptions): void {
  if (!opts.expectedStatus?.trim()) throw new EntryMaintenanceError('expectedStatus is required', 400);
  if (!opts.actor?.trim()) throw new EntryMaintenanceError('actor is required', 400);
  if (!opts.reason?.trim()) throw new EntryMaintenanceError('reason is required', 400);
}

function validateCanonicalSource(url: string): string {
  const trimmed = url?.trim();
  if (!trimmed) throw new EntryMaintenanceError('newSourceUrl is required', 400);
  try {
    const parsed = new URL(trimmed);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
  } catch {
    throw new EntryMaintenanceError('newSourceUrl must be an HTTP or HTTPS URL', 400);
  }
  const sourceClass = classifySourceLink(trimmed);
  if (sourceClass !== 'ok' && sourceClass !== 'tweet-only') {
    throw new EntryMaintenanceError(`newSourceUrl is not canonical (${sourceClass})`, 400);
  }
  return trimmed;
}

/** Rewrite a source URL and its dedup registry row in one guarded transaction. */
export async function rewriteEntrySource(
  pool: Pool,
  entryId: number,
  opts: RewriteSourceOptions,
): Promise<{ entryId: number; oldSourceUrl: string; newSourceUrl: string; status: string; dryRun: boolean }> {
  requireAuditFields(opts);
  if (!opts.expectedSourceUrl?.trim()) throw new EntryMaintenanceError('expectedSourceUrl is required', 400);
  const newSourceUrl = validateCanonicalSource(opts.newSourceUrl);
  const normalizedNew = normalizeUrl(newSourceUrl);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    // Source rewrites participate in the same lifecycle lock as URL claims,
    // archived-owner transfer, duplicate linking, and restore.
    await lockDuplicateGraph(client);
    const currentResult = await client.query(
      `SELECT id, status, source_url, wire, scan_date
       FROM scan_entries WHERE id = $1 FOR UPDATE`,
      [entryId],
    );
    const current = currentResult.rows[0];
    if (!current) throw new EntryMaintenanceError('Entry not found', 404);
    if (current.status === 'duplicate') {
      throw new EntryMaintenanceError('Duplicate entries cannot own rewritten source URLs', 409);
    }
    if (current.status !== opts.expectedStatus || current.source_url !== opts.expectedSourceUrl) {
      throw new EntryMaintenanceError(
        `Entry changed before write (expected status=${opts.expectedStatus} and source_url=${opts.expectedSourceUrl})`,
        409,
      );
    }

    const conflict = await client.query(
      `SELECT first_seen_entry_id FROM seen_urls
       WHERE normalized_url = $1 AND wire = $2
       FOR UPDATE`,
      [normalizedNew, current.wire],
    );
    if (conflict.rows.length > 0 && conflict.rows[0].first_seen_entry_id !== entryId) {
      const owner = conflict.rows[0].first_seen_entry_id;
      throw new EntryMaintenanceError(
        owner === null
          ? 'Canonical URL already exists in the seed registry'
          : `Canonical URL already belongs to entry #${owner}`,
        409,
      );
    }

    if (opts.dryRun) {
      await client.query('ROLLBACK');
      return { entryId, oldSourceUrl: current.source_url, newSourceUrl, status: current.status, dryRun: true };
    }

    const audit = JSON.stringify([{
      at: new Date().toISOString(),
      actor: opts.actor,
      reason: opts.reason,
      from: current.source_url,
      to: newSourceUrl,
    }]);
    const updated = await client.query(
      `UPDATE scan_entries SET
         source_url = $2,
         actioned_by = $3,
         action_reason = $4,
         metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           '{source_rewrites}',
           COALESCE(metadata->'source_rewrites', '[]'::jsonb) || $5::jsonb,
           true
         ),
         updated_at = NOW()
       WHERE id = $1 AND status = $6 AND source_url = $7
       RETURNING id, status, source_url`,
      [entryId, newSourceUrl, opts.actor, opts.reason, audit, opts.expectedStatus, opts.expectedSourceUrl],
    );
    if (updated.rowCount !== 1) throw new EntryMaintenanceError('Entry changed before write', 409);

    await client.query(
      `DELETE FROM seen_urls
       WHERE first_seen_entry_id = $1 AND wire = $2 AND normalized_url = $3`,
      [entryId, current.wire, normalizeUrl(current.source_url)],
    );
    const registered = await client.query(
      `INSERT INTO seen_urls (url, normalized_url, first_seen_entry_id, first_seen_date, wire)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (normalized_url, wire) DO UPDATE SET
         url = EXCLUDED.url,
         first_seen_entry_id = EXCLUDED.first_seen_entry_id,
         first_seen_date = EXCLUDED.first_seen_date
       WHERE seen_urls.first_seen_entry_id = EXCLUDED.first_seen_entry_id
       RETURNING first_seen_entry_id`,
      [newSourceUrl, normalizedNew, entryId, current.scan_date, current.wire],
    );
    if (registered.rowCount !== 1) {
      throw new EntryMaintenanceError('Canonical URL was claimed concurrently', 409);
    }
    await client.query('COMMIT');
    return { entryId, oldSourceUrl: current.source_url, newSourceUrl, status: current.status, dryRun: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Reassign an entry's primary Wire and move exact-URL ownership atomically. */
export async function rewriteEntryWires(
  pool: Pool,
  entryId: number,
  opts: RewriteWireOptions,
): Promise<{ entryId: number; wire: string; wires: string[] }> {
  const wires = [...new Set(opts.wires.map(wire => wire.trim()).filter(Boolean))];
  if (wires.length === 0) throw new EntryMaintenanceError('At least one wire is required', 400);
  const primaryWire = wires[0];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockDuplicateGraph(client);
    const currentResult = await client.query(
      `SELECT id, status, source_url, wire, wires, scan_date
       FROM scan_entries
       WHERE id = $1
       FOR UPDATE`,
      [entryId],
    );
    const current = currentResult.rows[0];
    if (!current) throw new EntryMaintenanceError('Entry not found', 404);

    if (current.wire !== primaryWire) {
      const ownedOldClaims = await client.query(
        `SELECT id, url, normalized_url, wire, first_seen_entry_id
         FROM seen_urls
         WHERE first_seen_entry_id = $1 AND wire = $2
         ORDER BY normalized_url
         FOR UPDATE`,
        [entryId, current.wire],
      );
      const primaryNormalized = current.source_url ? normalizeUrl(current.source_url) : null;
      const normalizedUrls = [...new Set([
        ...ownedOldClaims.rows.map(row => row.normalized_url),
        ...(primaryNormalized ? [primaryNormalized] : []),
      ])];

      if (normalizedUrls.length > 0) {
        const scopeClaims = await client.query(
          `SELECT id, url, normalized_url, wire, first_seen_entry_id
           FROM seen_urls
           WHERE normalized_url = ANY($1::text[]) AND wire = ANY($2::text[])
           ORDER BY normalized_url, wire
           FOR UPDATE`,
          [normalizedUrls, [current.wire, primaryWire]],
        );
        for (const claim of scopeClaims.rows) {
          const ownerId = claim.first_seen_entry_id === null ? null : Number(claim.first_seen_entry_id);
          if (claim.wire === current.wire && ownerId !== entryId) {
            throw new EntryMaintenanceError(
              ownerId === null
                ? 'Current Wire URL exists in seed history'
                : `Current Wire URL belongs to entry #${claim.first_seen_entry_id}`,
              409,
            );
          }
          if (claim.wire === primaryWire && ownerId !== entryId) {
            throw new EntryMaintenanceError(
              ownerId === null
                ? 'Target Wire URL exists in seed history'
                : `Target Wire URL belongs to entry #${claim.first_seen_entry_id}`,
              409,
            );
          }
        }

        const targetOwned = new Set(
          scopeClaims.rows
            .filter(claim => claim.wire === primaryWire && Number(claim.first_seen_entry_id) === entryId)
            .map(claim => claim.normalized_url),
        );
        const redundantOldIds = ownedOldClaims.rows
          .filter(claim => targetOwned.has(claim.normalized_url))
          .map(claim => Number(claim.id));
        if (redundantOldIds.length > 0) {
          await client.query(
            `DELETE FROM seen_urls WHERE id = ANY($1::bigint[]) AND first_seen_entry_id = $2 AND wire = $3`,
            [redundantOldIds, entryId, current.wire],
          );
        }
        const moved = await client.query(
          `UPDATE seen_urls
           SET wire = $2
           WHERE first_seen_entry_id = $1 AND wire = $3
           RETURNING id, normalized_url`,
          [entryId, primaryWire, current.wire],
        );
        const expectedMoves = ownedOldClaims.rows.length - redundantOldIds.length;
        if (moved.rowCount !== expectedMoves) {
          throw new EntryMaintenanceError('URL alias ownership changed before Wire move', 409);
        }

        if (primaryNormalized && !targetOwned.has(primaryNormalized)
            && !ownedOldClaims.rows.some(claim => claim.normalized_url === primaryNormalized)) {
          await client.query(
            `INSERT INTO seen_urls (url, normalized_url, first_seen_entry_id, first_seen_date, wire)
             VALUES ($1, $2, $3, $4, $5)`,
            [current.source_url, primaryNormalized, entryId, current.scan_date, primaryWire],
          );
        }
      }
    }

    const updated = await client.query(
      `UPDATE scan_entries
       SET wire = $2, wires = $3,
           actioned_by = COALESCE($4, actioned_by),
           action_reason = COALESCE($5, action_reason),
           updated_at = NOW()
       WHERE id = $1 AND wire = $6
       RETURNING id, wire, wires`,
      [
        entryId,
        primaryWire,
        wires,
        opts.actor || null,
        opts.reason || `Wire reassignment ${current.wire} -> ${primaryWire}`,
        current.wire,
      ],
    );
    if (updated.rowCount !== 1) throw new EntryMaintenanceError('Entry changed before Wire move', 409);
    await client.query(`UPDATE seen_names SET wire = $2 WHERE entry_id = $1`, [entryId, primaryWire]);
    await client.query('COMMIT');
    return { entryId, wire: updated.rows[0].wire, wires: updated.rows[0].wires };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Link an entry to a canonical duplicate parent after recursively validating the chain. */
export async function linkEntryDuplicate(
  pool: Pool,
  entryId: number,
  opts: LinkDuplicateOptions,
): Promise<{ entryId: number; duplicateOfId: number; requestedParentId: number; dryRun: boolean }> {
  requireAuditFields(opts);
  if (!opts.expectedSourceUrl) {
    throw new EntryMaintenanceError('expectedSourceUrl is required', 400);
  }
  if (!Number.isSafeInteger(opts.duplicateOfId) || opts.duplicateOfId <= 0) {
    throw new EntryMaintenanceError('duplicateOfId must be a positive integer', 400);
  }
  if (entryId === opts.duplicateOfId) throw new EntryMaintenanceError('Entry cannot duplicate itself', 400);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await lockDuplicateGraph(client);

    // Lock both endpoints in deterministic order. Opposite requests such as
    // A→B and B→A therefore cannot each observe the other as canonical.
    const endpointIds = [entryId, opts.duplicateOfId].sort((a, b) => a - b);
    const endpointResult = await client.query(
      `SELECT id, status, source_url, duplicate_of_id
       FROM scan_entries
       WHERE id = ANY($1::bigint[])
       ORDER BY id
       FOR UPDATE`,
      [endpointIds],
    );
    const current = endpointResult.rows.find((row) => Number(row.id) === entryId);
    const requestedParent = endpointResult.rows.find((row) => Number(row.id) === opts.duplicateOfId);
    if (!current) throw new EntryMaintenanceError('Entry not found', 404);
    if (!requestedParent) throw new EntryMaintenanceError('Duplicate parent chain is invalid (missing)', 409);
    if (current.status !== opts.expectedStatus || current.source_url !== opts.expectedSourceUrl) {
      throw new EntryMaintenanceError('Entry changed before write', 409);
    }

    const resolution = await resolveDuplicateChain(client, opts.duplicateOfId);
    if (resolution.error || resolution.id === null) {
      throw new EntryMaintenanceError(
        `Duplicate parent chain is invalid (${resolution.error || 'unknown'})`,
        409,
      );
    }
    if (resolution.id === entryId) throw new EntryMaintenanceError('Duplicate link would create a cycle', 409);

    // The terminal parent may be beyond the requested endpoint. Lock it, then
    // resolve again so a stale chain snapshot cannot drive the mutation.
    const terminalResult = await client.query(
      `SELECT id, status, duplicate_of_id
       FROM scan_entries WHERE id = $1 FOR UPDATE`,
      [resolution.id],
    );
    const terminal = terminalResult.rows[0];
    if (!terminal || terminal.status === 'duplicate' || terminal.duplicate_of_id !== null) {
      throw new EntryMaintenanceError('Duplicate parent changed before write', 409);
    }
    const revalidated = await resolveDuplicateChain(client, opts.duplicateOfId);
    if (revalidated.error || revalidated.id !== resolution.id) {
      throw new EntryMaintenanceError('Duplicate parent changed before write', 409);
    }

    if (opts.dryRun) {
      await client.query('ROLLBACK');
      return { entryId, duplicateOfId: resolution.id, requestedParentId: opts.duplicateOfId, dryRun: true };
    }

    const audit = JSON.stringify([{
      at: new Date().toISOString(),
      actor: opts.actor,
      reason: opts.reason,
      requested_parent_id: opts.duplicateOfId,
      canonical_parent_id: resolution.id,
      chain_depth: resolution.depth,
    }]);
    const params: unknown[] = [
      entryId,
      resolution.id,
      opts.reason,
      opts.actor,
      audit,
      opts.expectedStatus,
      opts.expectedSourceUrl,
    ];
    const updated = await client.query(
      `UPDATE scan_entries SET
         status = 'duplicate',
         duplicate_of_id = $2,
         duplicate_reason = $3,
         distributable = false,
         actioned_by = $4,
         action_reason = $3,
         metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           '{explicit_duplicate_links}',
           COALESCE(metadata->'explicit_duplicate_links', '[]'::jsonb) || $5::jsonb,
           true
         ),
         updated_at = NOW()
       WHERE id = $1 AND status = $6 AND source_url = $7
       RETURNING id`,
      params,
    );
    if (updated.rowCount !== 1) throw new EntryMaintenanceError('Entry changed before write', 409);

    await reconcileDuplicateReferences(client, entryId, resolution.id);

    await client.query('COMMIT');
    return { entryId, duplicateOfId: resolution.id, requestedParentId: opts.duplicateOfId, dryRun: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
