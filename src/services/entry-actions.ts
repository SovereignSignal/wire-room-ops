/**
 * Entry Actions Service — approve/decline/restore business logic
 *
 * Extracted from server.ts HTTP handlers so that both REST endpoints
 * and autonomous agents (The Stringer) can call the same functions.
 *
 * All fire-and-forget side effects (distribution, auto-summarize,
 * org linking) stay as setImmediate to preserve existing behavior.
 */

import { getPool } from '../db';
import { insertApprovedSummary } from '../db';
import { validateForApproval } from './approval-guard';
import { distributeEntry } from './distribution';
import { autoSummarizeOnApprove } from './auto-summarize';
import { extractOrgFromName, upsertOrgProfile, linkEntryToOrg, findSimilarOrg } from './org-extractor';
import { enrichSingleOrg } from './org-enricher';
import { refreshProgramCounters } from './program-identity';
import { config } from '../config';
import type { Pool } from 'pg';
import { normalizeUrl } from './intake';
import { lockDuplicateGraph } from './duplicate-chain';

// --- Types ---

export interface ActionOptions {
  quiet?: boolean;
  force?: boolean;
  actor?: string;   // who is taking this action ('stringer' | 'sov' | 'system')
  reason?: string;  // why this action was taken (for audit trail)
  dryRun?: boolean; // if true, validate and return result without committing
}

/** Force is reserved for authenticated human operators, never agent principals. */
export function canForceApproval(opts: ActionOptions): boolean {
  return opts.force === true && !(opts.actor || '').startsWith('agent:');
}

export interface SingleActionResult {
  success: boolean;
  newStatus: string;
  summaryId?: number | null;
  warnings?: string[];
}

export interface BulkActionResult {
  success: boolean;
  updated: number;
  newStatus: string;
  summaryIds: Record<number, number | null>;
}

export class ApprovalBlockedError extends Error {
  constructor(
    public readonly errors: string[],
    public readonly warnings: string[],
  ) {
    super('Approval blocked');
    this.name = 'ApprovalBlockedError';
  }
}

export class BulkApprovalBlockedError extends Error {
  constructor(
    public readonly blocked: Array<{ id: number; errors: string[]; warnings: string[] }>,
    public readonly passCount: number,
    public readonly blockCount: number,
  ) {
    super('Some entries blocked');
    this.name = 'BulkApprovalBlockedError';
  }
}

export class EntryActionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntryActionConflictError';
  }
}

// --- Migration: ensure audit columns on scan_entries ---

export async function ensureEntryActionColumns(): Promise<void> {
  const pool = getPool();
  await pool.query(`ALTER TABLE scan_entries ADD COLUMN IF NOT EXISTS actioned_by TEXT`);
  await pool.query(`ALTER TABLE scan_entries ADD COLUMN IF NOT EXISTS action_reason TEXT`);
  console.log('[DB] Entry action audit columns ready');
}

// --- Internal helpers ---

const ACTION_MAP: Record<string, string> = {
  approve: 'approved',
  decline: 'declined',
  reviewlater: 'skipped',
  restore: 'queued',
};

function resolveAction(action: string): string {
  const status = ACTION_MAP[action];
  if (!status) throw new Error('Invalid action. Must be approve, decline, reviewlater, or restore.');
  return status;
}

const X_MONITOR_RESTORE_ROUTES = new Set(['publish', 'source_check']);
const X_MONITOR_RESTORABLE_STATUSES = new Set(['archived', 'declined', 'skipped']);

function metadataRoute(metadata: unknown): string | null {
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch { return null; }
  }
  if (!metadata || typeof metadata !== 'object') return null;
  const route = (metadata as Record<string, unknown>).operator_route;
  return typeof route === 'string' ? route : null;
}

/** Restore rows under the global URL and duplicate lifecycle lock. */
export async function restoreEntryRows(
  pool: Pool,
  entryIds: number[],
  opts: ActionOptions = {},
): Promise<any[]> {
  const ids = [...new Set(entryIds)];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockDuplicateGraph(client);
    const currentResult = await client.query(
      `SELECT id, status, scan_source, classification, metadata, source_url, wire, program_id
       FROM scan_entries
       WHERE id = ANY($1::bigint[])
       ORDER BY id
       FOR UPDATE`,
      [ids],
    );
    if (currentResult.rows.length !== ids.length) throw new Error('Entry not found');

    for (const row of currentResult.rows) {
      if (row.scan_source !== 'x-monitor') continue;
      if (!X_MONITOR_RESTORABLE_STATUSES.has(row.status)) {
        throw new EntryActionConflictError(
          `x-monitor entry #${row.id} cannot restore from status ${row.status}`,
        );
      }
      const route = metadataRoute(row.metadata);
      if (!row.classification || row.classification === 'UNCHECKED' || !route || !X_MONITOR_RESTORE_ROUTES.has(route)) {
        throw new EntryActionConflictError(
          `x-monitor entry #${row.id} must settle to publish or source_check before queue restore`,
        );
      }
      const owner = await client.query(
        `SELECT first_seen_entry_id
         FROM seen_urls
         WHERE normalized_url = $1 AND wire = $2
         FOR UPDATE`,
        [normalizeUrl(row.source_url), row.wire],
      );
      if (owner.rows.length !== 1 || Number(owner.rows[0].first_seen_entry_id) !== Number(row.id)) {
        throw new EntryActionConflictError(
          `x-monitor entry #${row.id} no longer owns its canonical URL`,
        );
      }
    }

    if (opts.dryRun) {
      await client.query('ROLLBACK');
      return currentResult.rows.map(row => ({ ...row, status: 'queued', distributable: false }));
    }

    const restored = await client.query(
      `UPDATE scan_entries
       SET status = 'queued', distributable = false,
           actioned_by = COALESCE($2, actioned_by),
           action_reason = COALESCE($3, action_reason),
           updated_at = NOW()
       WHERE id = ANY($1::bigint[])
       RETURNING id, status, wire, name, description, enriched_summary, quality_score,
                 amount, deadline, source_url, org_id, program_id, scan_date, tags`,
      [ids, opts.actor || null, opts.reason || null],
    );
    if (restored.rows.length !== ids.length) {
      throw new EntryActionConflictError('Entries changed before restore');
    }
    await client.query('COMMIT');
    return restored.rows;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Fire-and-forget approve side effects for a single entry row.
 * Called from both single and bulk approve paths.
 */
function scheduleApproveSideEffects(
  row: any,
  summaryId: number | null,
  quiet: boolean,
): void {
  // Distribution (skip if quiet)
  if (!quiet) {
    setImmediate(() => {
      distributeEntry(row.id, row.wire).catch(err => {
        console.error(`[Distribution] Auto-distribute failed for entry ${row.id}:`, err);
      });
    });
  }

  // Auto-summarize if enriched_summary is missing/thin
  if (!row.enriched_summary || row.enriched_summary.length < 60) {
    setImmediate(() => {
      autoSummarizeOnApprove(
        row.id, summaryId, row.name,
        row.description || '', row.amount, row.deadline, row.source_url, row.wire
      ).catch(err => console.error(`[AutoSummarize] Failed for entry ${row.id}:`, err));
    });
  }

  // Org linking + enrichment (with fuzzy dedup)
  if (!row.org_id) {
    setImmediate(async () => {
      try {
        const orgName = extractOrgFromName(row.name);
        if (!orgName) return;
        const similar = await findSimilarOrg(orgName);
        let orgId: number;
        if (similar) {
          orgId = similar.id;
        } else {
          orgId = await upsertOrgProfile(orgName, row.wire, row.scan_date?.toISOString?.()?.split('T')[0]);
        }
        await linkEntryToOrg(row.id, orgId);
        if (config.crm.enrichEnabled) {
          await enrichSingleOrg(orgId).catch(err =>
            console.error(`[OrgEnrich] Failed for entry ${row.id}:`, err)
          );
        }
      } catch (err) {
        console.error(`[OrgLink] Failed for entry ${row.id}:`, err);
      }
    });
  }
}

// --- Public API ---

/**
 * Approve, decline, skip, or restore a single entry.
 * Throws ApprovalBlockedError if approval validation fails (unless force=true).
 */
export async function singleEntryAction(
  entryId: number,
  action: string,
  opts: ActionOptions = {},
): Promise<SingleActionResult> {
  const newStatus = resolveAction(action);
  const pool = getPool();
  const forceApproval = canForceApproval(opts);

  // Pre-approval validation gate
  let approvalWarnings: string[] = [];
  if (action === 'approve') {
    const preCheck = await pool.query(
      `SELECT id, name, description, source_url, classification, quality_score, deadline
       FROM scan_entries WHERE id = $1`,
      [entryId]
    );

    if (preCheck.rows.length === 0) {
      throw new Error('Entry not found');
    }

    const validation = validateForApproval(preCheck.rows[0]);
    approvalWarnings = validation.warnings;

    if (!validation.valid && !forceApproval) {
      throw new ApprovalBlockedError(validation.errors, validation.warnings);
    }
  }

  // Dry run: return what would happen without committing. Restore dry runs
  // still enter the guarded transaction so lifecycle conflicts are visible.
  if (opts.dryRun && action !== 'restore') {
    const response: SingleActionResult = {
      success: true,
      newStatus,
      warnings: approvalWarnings.length > 0 ? approvalWarnings : undefined,
    };
    return response;
  }

  const distributable = opts.quiet ? false : true;
  const result = action === 'restore'
    ? { rows: await restoreEntryRows(pool, [entryId], opts) }
    : await pool.query(
    `UPDATE scan_entries SET status = $1, distributable = $2, actioned_by = COALESCE($3, actioned_by), action_reason = COALESCE($4, action_reason), updated_at = NOW() WHERE id = $5
     RETURNING id, status, wire, name, description, enriched_summary, quality_score, amount, deadline, source_url, org_id, program_id, scan_date, tags`,
    [newStatus, distributable, opts.actor || null, opts.reason || null, entryId]
  );

  if (result.rows.length === 0) {
    throw new Error('Entry not found');
  }

  if (opts.dryRun) {
    return { success: true, newStatus };
  }

  await refreshProgramCounters(pool, result.rows.map(row => row.program_id).filter((id): id is number => Number.isSafeInteger(id)));

  let summaryId: number | null = null;

  if (action === 'approve') {
    const row = result.rows[0];

    // Write-through to summaries table
    try {
      summaryId = await insertApprovedSummary({
        title: row.name,
        summary: row.enriched_summary || row.description || '',
        wire: row.wire,
        qualityScore: row.quality_score,
        entities: {
          amounts: row.amount ? [row.amount] : [],
          deadlines: row.deadline ? [row.deadline] : [],
          source_url: row.source_url,
          orgs: row.tags || [],
        },
      });
    } catch (err) {
      console.error(`[Approve] Failed to write summary for entry ${entryId}:`, err);
    }

    scheduleApproveSideEffects(row, summaryId, !!opts.quiet);

    // Track X account if source URL is a tweet — used for auto-promotion
    if (row.source_url && row.source_url.includes('x.com')) {
      setImmediate(async () => {
        try {
          const match = (row.source_url as string).match(/x\.com\/([^\/\?]+)\/status/);
          if (match) {
            const handle = match[1].toLowerCase();
            if (!['i', 'search', 'intent', 'share', 'hashtag'].includes(handle)) {
              await pool.query(`
                INSERT INTO monitored_accounts (handle, wire, source, approval_count, last_approved_at)
                VALUES ($1, $2, 'auto', 1, NOW())
                ON CONFLICT (handle) DO UPDATE SET
                  approval_count = monitored_accounts.approval_count + 1,
                  last_approved_at = NOW(),
                  enabled = CASE WHEN monitored_accounts.approval_count + 1 >= 3 THEN true ELSE monitored_accounts.enabled END,
                  updated_at = NOW()
              `, [handle, row.wire]);
            }
          }
        } catch (err) {
          console.warn('[EntryActions] Failed to track monitored account:', err);
        }
      });
    }
  }

  const response: SingleActionResult = { success: true, newStatus, summaryId };
  if (approvalWarnings.length > 0) {
    response.warnings = approvalWarnings;
  }
  return response;
}

/**
 * Bulk approve, decline, skip, or restore multiple entries.
 * Throws BulkApprovalBlockedError if any entries fail validation (unless force=true).
 */
export async function bulkEntryAction(
  entryIds: number[],
  action: string,
  opts: ActionOptions = {},
): Promise<BulkActionResult> {
  const newStatus = resolveAction(action);
  const pool = getPool();
  const forceApproval = canForceApproval(opts);

  // Pre-approval validation gate for bulk approve
  if (action === 'approve') {
    const preCheck = await pool.query(
      `SELECT id, name, description, source_url, classification, quality_score, deadline
       FROM scan_entries WHERE id = ANY($1)`,
      [entryIds]
    );

    const blocked: Array<{ id: number; errors: string[]; warnings: string[] }> = [];
    let passCount = 0;

    for (const row of preCheck.rows) {
      const validation = validateForApproval(row);
      if (!validation.valid) {
        blocked.push({ id: row.id, errors: validation.errors, warnings: validation.warnings });
      } else {
        passCount++;
      }
    }

    if (blocked.length > 0 && !forceApproval) {
      throw new BulkApprovalBlockedError(blocked, passCount, blocked.length);
    }
  }

  // Dry run: restore still validates lifecycle ownership and routing.
  if (opts.dryRun && action !== 'restore') {
    return { success: true, updated: entryIds.length, newStatus, summaryIds: {} };
  }

  // Bulk update status
  const distributable = opts.quiet ? false : true;
  const result = action === 'restore'
    ? { rows: await restoreEntryRows(pool, entryIds, opts) }
    : await pool.query(
    `UPDATE scan_entries SET status = $1, distributable = $2, actioned_by = COALESCE($3, actioned_by), action_reason = COALESCE($4, action_reason), updated_at = NOW()
     WHERE id = ANY($5)
     RETURNING id, status, wire, name, description, enriched_summary, quality_score, amount, deadline, source_url, org_id, program_id, scan_date, tags`,
    [newStatus, distributable, opts.actor || null, opts.reason || null, entryIds]
  );

  const updated = result.rows;
  if (opts.dryRun) {
    return { success: true, updated: updated.length, newStatus, summaryIds: {} };
  }
  await refreshProgramCounters(pool, updated.map(row => row.program_id).filter((id): id is number => Number.isSafeInteger(id)));
  const summaryIds: Record<number, number | null> = {};

  // On bulk approve: write each entry to summaries + fire-and-forget side effects
  if (action === 'approve') {
    for (const row of updated) {
      try {
        const sid = await insertApprovedSummary({
          title: row.name,
          summary: row.enriched_summary || row.description || '',
          wire: row.wire,
          qualityScore: row.quality_score,
          entities: {
            amounts: row.amount ? [row.amount] : [],
            deadlines: row.deadline ? [row.deadline] : [],
            source_url: row.source_url,
            orgs: row.tags || [],
          },
        });
        summaryIds[row.id] = sid;
      } catch (err) {
        console.error(`[BulkApprove] Failed to write summary for entry ${row.id}:`, err);
      }

      scheduleApproveSideEffects(row, summaryIds[row.id] ?? null, !!opts.quiet);
    }
  }

  return { success: true, updated: updated.length, newStatus, summaryIds };
}

// --- Read helpers ---

export interface ScanEntry {
  id: number;
  name: string;
  description: string | null;
  source_url: string;
  wire: string;
  status: string;
  quality_score: number | null;
  classification: string | null;
  amount: string | null;
  deadline: string | null;
  enriched_summary: string | null;
  scan_source: string;
  scan_date: Date;
  actioned_by: string | null;
  action_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Get a single entry by ID.
 */
export async function getEntry(entryId: number): Promise<ScanEntry | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, name, description, source_url, wire, status, quality_score, classification,
            amount, deadline, enriched_summary, scan_source, scan_date,
            actioned_by, action_reason, created_at, updated_at
     FROM scan_entries WHERE id = $1`,
    [entryId]
  );
  return result.rows.length > 0 ? (result.rows[0] as ScanEntry) : null;
}

/**
 * Get queued entries with optional filters.
 */
export async function getQueuedEntries(filters?: {
  wire?: string;
  source?: string;
  limit?: number;
  offset?: number;
}): Promise<ScanEntry[]> {
  const pool = getPool();
  const conditions: string[] = [`status = 'queued'`];
  const values: any[] = [];
  let paramIndex = 1;

  if (filters?.wire) {
    conditions.push(`wire = $${paramIndex++}`);
    values.push(filters.wire);
  }
  if (filters?.source) {
    conditions.push(`scan_source = $${paramIndex++}`);
    values.push(filters.source);
  }

  const limit = filters?.limit || 100;
  const offset = filters?.offset || 0;

  const result = await pool.query(
    `SELECT id, name, description, source_url, wire, status, quality_score, classification,
            amount, deadline, enriched_summary, scan_source, scan_date,
            actioned_by, action_reason, created_at, updated_at
     FROM scan_entries
     WHERE ${conditions.join(' AND ')}
     ORDER BY quality_score DESC NULLS LAST, created_at DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
    [...values, limit, offset]
  );
  return result.rows as ScanEntry[];
}
