import { Pool } from 'pg';
import { normalizeUrl } from './intake';
import { classifySourceLink } from './source-filter';
import { resolveDuplicateChain } from './duplicate-chain';

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
  expectedSourceUrl?: string;
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
  if (sourceClass === 'placeholder' || sourceClass === 'shortener' || sourceClass === 'missing') {
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
    const currentResult = await client.query(
      `SELECT id, status, source_url, wire, scan_date
       FROM scan_entries WHERE id = $1 FOR UPDATE`,
      [entryId],
    );
    const current = currentResult.rows[0];
    if (!current) throw new EntryMaintenanceError('Entry not found', 404);
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

/** Link an entry to a canonical duplicate parent after recursively validating the chain. */
export async function linkEntryDuplicate(
  pool: Pool,
  entryId: number,
  opts: LinkDuplicateOptions,
): Promise<{ entryId: number; duplicateOfId: number; requestedParentId: number; dryRun: boolean }> {
  requireAuditFields(opts);
  if (!Number.isSafeInteger(opts.duplicateOfId) || opts.duplicateOfId <= 0) {
    throw new EntryMaintenanceError('duplicateOfId must be a positive integer', 400);
  }
  if (entryId === opts.duplicateOfId) throw new EntryMaintenanceError('Entry cannot duplicate itself', 400);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const currentResult = await client.query(
      `SELECT id, status, source_url
       FROM scan_entries WHERE id = $1 FOR UPDATE`,
      [entryId],
    );
    const current = currentResult.rows[0];
    if (!current) throw new EntryMaintenanceError('Entry not found', 404);
    if (current.status !== opts.expectedStatus
        || (opts.expectedSourceUrl !== undefined && current.source_url !== opts.expectedSourceUrl)) {
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
    ];
    let sourceGuard = '';
    if (opts.expectedSourceUrl !== undefined) {
      params.push(opts.expectedSourceUrl);
      sourceGuard = ` AND source_url = $${params.length}`;
    }
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
       WHERE id = $1 AND status = $6${sourceGuard}
       RETURNING id`,
      params,
    );
    if (updated.rowCount !== 1) throw new EntryMaintenanceError('Entry changed before write', 409);

    await client.query('COMMIT');
    return { entryId, duplicateOfId: resolution.id, requestedParentId: opts.duplicateOfId, dryRun: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
