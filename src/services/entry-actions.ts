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

// --- Types ---

export interface ActionOptions {
  quiet?: boolean;
  force?: boolean;
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
        await enrichSingleOrg(orgId).catch(err =>
          console.error(`[OrgEnrich] Failed for entry ${row.id}:`, err)
        );
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

    if (!validation.valid && !opts.force) {
      throw new ApprovalBlockedError(validation.errors, validation.warnings);
    }
  }

  const distributable = opts.quiet ? false : true;
  const result = await pool.query(
    `UPDATE scan_entries SET status = $1, distributable = $2, updated_at = NOW() WHERE id = $3
     RETURNING id, status, wire, name, description, enriched_summary, quality_score, amount, deadline, source_url, org_id, scan_date, tags`,
    [newStatus, distributable, entryId]
  );

  if (result.rows.length === 0) {
    throw new Error('Entry not found');
  }

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

    if (blocked.length > 0 && !opts.force) {
      throw new BulkApprovalBlockedError(blocked, passCount, blocked.length);
    }
  }

  // Bulk update status
  const distributable = opts.quiet ? false : true;
  const result = await pool.query(
    `UPDATE scan_entries SET status = $1, distributable = $2, updated_at = NOW()
     WHERE id = ANY($3)
     RETURNING id, status, wire, name, description, enriched_summary, quality_score, amount, deadline, source_url, org_id, scan_date, tags`,
    [newStatus, distributable, entryIds]
  );

  const updated = result.rows;
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
