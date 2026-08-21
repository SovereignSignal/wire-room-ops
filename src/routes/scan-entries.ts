/**
 * Scan Entry Routes
 *
 * GET    /entries                — query entries with filters (status, wire, date, etc.)
 * GET    /entries/:id            — single entry (dashboard deep link from digest email)
 * POST   /submit                — single entry submission
 * POST   /submit-batch          — batch submission (Prompt A/B/C x-scan sections)
 * POST   /telegram-batch        — same processBatchMessage path as @GrantWireSummarizer_bot
 * GET    /queue                  — list queued entries
 * GET    /stats                  — scan pipeline statistics
 * GET    /status-counts          — count by status
 * GET    /seen-urls              — URL dedup stats
 * GET    /prompt-stats           — prompt effectiveness
 * PATCH  /entries/:id/wire       — reassign wire
 * PATCH  /entries/:id/source     — guarded canonical source rewrite
 * POST   /entries/:id/link-duplicate — guarded explicit duplicate link
 * POST   /entries/bulk-action    — bulk approve/decline/reviewlater/restore
 * POST   /entries/:id/action     — single entry action
 * GET    /entries/:id/distribution — distribution logs for single entry
 * POST   /entries/:id/redistribute — retry failed distribution
 */

import { Router, Request, Response } from 'express';
import { getPool, getAvailableWires, getEntriesByStatus, getStatusCounts, getSeenUrlStats, getSeenUrlsList, getDistributionLogs, getDistributionStatusForEntries } from '../db';
import { rateLimit } from '../middleware/rate-limit';
import { isValidUuid, isValidFeedKey } from '../utils/validation';
import { buildSubmission, buildBatchSubmission } from '../services/intake';
import { runDailyIntake, getDailyQueue, getIntakeStats } from '../jobs/daily-intake';
import { getPromptEffectivenessStats } from '../services/scan-stats';
import { singleEntryAction, bulkEntryAction, ApprovalBlockedError, BulkApprovalBlockedError } from '../services/entry-actions';
import { rewriteEntrySource, linkEntryDuplicate, EntryMaintenanceError } from '../services/entry-maintenance';
import { buildCuratorStamp } from '../services/curator';
import { retryDistribution } from '../services/distribution';
import { PROMPT_VARIANTS, SCAN_SOURCES } from '../types/intake';
import { isBatchMessage, processBatchMessage, processIntakeMessage } from '../services/intake-core';
import { runDecidedRecheckForIds } from '../jobs/decided-recheck';

const router = Router();

/** Bind maintenance audit attribution to the authenticated principal. */
export function resolveMaintenanceActor(req: Request): string {
  return (req as any).agentSession?.userId || (req as any).authSession?.userId || '';
}

/** Internal-key agents may approve quietly, but may never bypass approval guards. */
export function resolveApprovalForce(req: Request): boolean {
  return !Boolean((req as any).agentSession) && req.query?.force === 'true';
}

function sendMaintenanceError(res: Response, error: unknown, label: string): void {
  if (error instanceof EntryMaintenanceError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : 'Unknown error';
  console.error(`[${label}] Failed:`, error);
  res.status(500).json({ error: message });
}

// POST /submit — single entry submission
router.post('/submit', async (req: Request, res: Response) => {
  const { wire, promptVariant, scanDate, rawText, source } = req.body;

  try {
    // Validate wire against the canonical core wires
    const validKeys = (await getAvailableWires()).map(w => w.key);
    if (!wire || !validKeys.includes(wire)) {
      res.status(400).json({ error: `Invalid wire "${wire}". Valid: ${validKeys.join(', ')}` });
      return;
    }
    if (!promptVariant || !PROMPT_VARIANTS.includes(promptVariant)) {
      res.status(400).json({ error: `Invalid promptVariant "${promptVariant}". Valid: ${PROMPT_VARIANTS.join(', ')}` });
      return;
    }
    if (!scanDate || !/^\d{4}-\d{2}-\d{2}$/.test(scanDate) || isNaN(Date.parse(scanDate))) {
      res.status(400).json({ error: 'scanDate must be a valid date string (YYYY-MM-DD)' });
      return;
    }
    if (!rawText || typeof rawText !== 'string' || rawText.trim().length === 0) {
      res.status(400).json({ error: 'rawText is required and must be non-empty' });
      return;
    }
    // Validate source against the shared ScanSource list — an unknown value
    // would otherwise fail the DB CHECK constraint deep in intake (a silent
    // insert failure for background/agent submissions, a 500 for sync ones).
    if (source !== undefined && !SCAN_SOURCES.includes(source)) {
      res.status(400).json({ error: `Invalid source "${source}". Valid: ${SCAN_SOURCES.join(', ')}` });
      return;
    }

    const submission = buildSubmission(
      rawText,
      wire,
      promptVariant,
      scanDate,
      source || 'x-scan'
    );

    const pool = getPool();
    // Agent (internal-key) submissions return fast: entries are inserted raw
    // and the background processor handles dedup/classify/queue within ~5 min.
    // Synchronous processing held the connection through LLM classification,
    // which read as a hang to API clients and caused retry storms.
    const isAgent = Boolean((req as any).agentSession);
    const summary = await runDailyIntake(pool, [submission], isAgent ? { insertOnly: true } : {});

    res.json({
      success: true,
      summary,
      processing: isAgent ? 'background' : 'complete',
      ...(isAgent ? { note: 'Entries inserted; dedup/classification completes in the background within ~5 minutes. Do NOT retry this request.' } : {}),
    });
  } catch (error) {
    console.error('Scan submit failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// POST /submit-batch — batch submission
router.post('/submit-batch', async (req: Request, res: Response) => {
  const { wire, scanDate, rawText, source } = req.body;

  try {
    const validKeys = (await getAvailableWires()).map(w => w.key);
    if (!wire || !validKeys.includes(wire)) {
      res.status(400).json({ error: `Invalid wire "${wire}". Valid: ${validKeys.join(', ')}` });
      return;
    }
    if (!scanDate || !/^\d{4}-\d{2}-\d{2}$/.test(scanDate) || isNaN(Date.parse(scanDate))) {
      res.status(400).json({ error: 'scanDate must be a valid date string (YYYY-MM-DD)' });
      return;
    }
    if (!rawText || typeof rawText !== 'string' || rawText.trim().length === 0) {
      res.status(400).json({ error: 'rawText is required and must be non-empty' });
      return;
    }
    if (source !== undefined && !SCAN_SOURCES.includes(source)) {
      res.status(400).json({ error: `Invalid source "${source}". Valid: ${SCAN_SOURCES.join(', ')}` });
      return;
    }

    const submissions = buildBatchSubmission(
      rawText,
      wire,
      scanDate,
      source || 'x-scan'
    );

    if (submissions.length === 0) {
      res.status(400).json({ error: 'Could not parse any prompt sections from rawText. Expected headers like "Prompt A", "Prompt B", etc.' });
      return;
    }

    const pool = getPool();
    const summary = await runDailyIntake(pool, submissions);

    res.json({ success: true, summary });
  } catch (error) {
    console.error('Scan batch submit failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

const TELEGRAM_BATCH_TEXT_MAX = 20_000;

/**
 * POST /telegram-batch — HTTP door into the Grant Wire summarizer intake.
 * Same parseBatchEntries + URL/name dedupe + queued insert as the Telegram bot.
 * Body: { text: string }  (the markdown Sov pastes into @GrantWireSummarizer_bot)
 * Auth: session or INTERNAL_API_KEY (this router is already behind requireAuthOrInternalKey).
 */
router.post('/telegram-batch', async (req: Request, res: Response) => {
  if (!rateLimit('telegram-batch', 20, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'telegram-batch recently run. Please wait.' });
    return;
  }

  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (!text.trim()) {
    res.status(400).json({ error: 'text is required and must be a non-empty string' });
    return;
  }
  if (text.length > TELEGRAM_BATCH_TEXT_MAX) {
    res.status(400).json({ error: `text exceeds ${TELEGRAM_BATCH_TEXT_MAX} characters` });
    return;
  }

  const actor = resolveMaintenanceActor(req) || 'http:telegram-batch';
  const intakeMsg = {
    text,
    senderId: actor,
    channelMessageId: `http-${Date.now()}`,
  };

  try {
    if (isBatchMessage(text)) {
      const batch = await processBatchMessage(intakeMsg, 'telegram');
      if (batch.retryableErrors > 0) {
        res.setHeader('Retry-After', '5');
        res.status(503).json({
          error: 'Retryable persistence errors',
          inserted: batch.inserted,
          duplicates: batch.duplicates,
          errors: batch.errors,
          retryableErrors: batch.retryableErrors,
          entries: batch.entries,
        });
        return;
      }

      const acceptedIds = batch.entries
        .filter(entry => entry.id && !entry.isDuplicate)
        .map(entry => entry.id!);
      if (acceptedIds.length > 0) {
        try {
          await runDecidedRecheckForIds(getPool(), acceptedIds);
        } catch (error) {
          console.error('[TelegramBatch] History check failed:', error);
        }
      }

      res.json({
        success: true,
        inserted: batch.inserted,
        duplicates: batch.duplicates,
        errors: batch.errors,
        retryableErrors: batch.retryableErrors,
        entries: batch.entries,
      });
      return;
    }

    const result = await processIntakeMessage(intakeMsg, 'telegram');
    if (result.status === 'error') {
      res.setHeader('Retry-After', '5');
      res.status(503).json({ error: result.errorMessage || 'Telegram intake failed', result });
      return;
    }
    res.json({ success: result.status === 'inserted', result });
  } catch (error) {
    console.error('Telegram-batch intake failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// GET /queue — list queued entries
router.get('/queue', async (req: Request, res: Response) => {
  const wire = (req.query.wire as string) || null;
  const rawScore = parseInt(req.query.minScore as string);
  const minScore = isNaN(rawScore) ? 40 : Math.max(0, Math.min(100, rawScore));
  const date = (req.query.date as string) || null;

  // Validate date format if provided
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    return;
  }

  try {
    const pool = getPool();
    const entries = await getDailyQueue(pool, wire, minScore, date);
    res.json({ entries, count: entries.length });
  } catch (error) {
    console.error('Failed to get scan queue:', error);
    res.status(500).json({ error: 'Failed to get scan queue' });
  }
});

// GET /stats — scan pipeline statistics
router.get('/stats', async (req: Request, res: Response) => {
  const days = parseInt(req.query.days as string) || 7;

  try {
    const pool = getPool();
    const stats = await getIntakeStats(pool, days);
    res.json(stats);
  } catch (error) {
    console.error('Failed to get intake stats:', error);
    res.status(500).json({ error: 'Failed to get intake stats' });
  }
});

// GET /status-counts — count by status (optionally grouped by scan_source)
router.get('/status-counts', async (req: Request, res: Response) => {
  try {
    const wire = req.query.wire as string | undefined;
    const date = req.query.date as string | undefined;
    const promptId = req.query.promptId as string | undefined;
    const includeBySource =
      req.query.bySource === '1' || req.query.bySource === 'true' ||
      req.query.includeBySource === '1' || req.query.includeBySource === 'true';
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
      return;
    }
    if (promptId && !isValidUuid(promptId)) {
      res.status(400).json({ error: 'Invalid promptId format.' });
      return;
    }

    const [statusResult, urlStats] = await Promise.all([
      getStatusCounts(wire, date, promptId, includeBySource),
      getSeenUrlStats(wire),
    ]);

    res.json({
      counts: statusResult.byStatus,
      bySource: statusResult.bySourceStatus,
      seededUrls: urlStats.seededCount,
      totalUrls: urlStats.totalCount,
    });
  } catch (error) {
    console.error('Failed to fetch status counts:', error);
    res.status(500).json({ error: 'Failed to fetch status counts' });
  }
});

// GET /seen-urls — URL dedup view.
//   default (scope=seed): the original stats view — only the one-time bootstrap rows, cap 500.
//   scope=all:            the COMPLETE seen set for the wire (every registered URL), higher cap.
//                         This is what the grant scout's dedup must use; the seed-only view
//                         starved it to ~1% of the catalog so it never dropped anything.
router.get('/seen-urls', async (req: Request, res: Response) => {
  try {
    const wire = req.query.wire as string | undefined;
    const scope = req.query.scope === 'all' ? 'all' : 'seed';
    // scope=all needs the whole set (a few thousand rows); the seed view stays capped at 500.
    const maxLimit = scope === 'all' ? 100000 : 500;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || (scope === 'all' ? maxLimit : 50), 1), maxLimit);
    const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

    const { urls, total } = await getSeenUrlsList({ wire, limit, offset, scope });
    res.json({ urls, total, seededTotal: total });
  } catch (error) {
    console.error('Failed to fetch seen URLs:', error);
    res.status(500).json({ error: 'Failed to fetch seen URLs' });
  }
});

// GET /prompt-stats — prompt effectiveness
router.get('/prompt-stats', async (req: Request, res: Response) => {
  const days = Math.min(Math.max(parseInt(req.query.days as string, 10) || 7, 1), 365);
  const wire = req.query.wire as string | undefined;

  try {
    const pool = getPool();
    const stats = await getPromptEffectivenessStats(pool, days, wire);
    res.json(stats);
  } catch (error) {
    console.error('Failed to fetch prompt stats:', error);
    res.status(500).json({ error: 'Failed to fetch prompt stats' });
  }
});

// GET /entries — query entries with filters
router.get('/entries', async (req: Request, res: Response) => {
  try {
    const statusParam = (req.query.status as string) || 'queued';
    const statuses = statusParam.split(',').map(s => s.trim()).filter(Boolean);
    const wire = req.query.wire as string | undefined;
    const date = req.query.date as string | undefined;
    const promptId = req.query.promptId as string | undefined;
    const includeDistributionStatus = req.query.includeDistributionStatus === '1' || req.query.includeDistributionStatus === 'true';
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
      return;
    }
    if (promptId && !isValidUuid(promptId)) {
      res.status(400).json({ error: 'Invalid promptId format.' });
      return;
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);
    const rawMinScore = parseInt(req.query.minScore as string, 10);
    const minScore = isNaN(rawMinScore) ? undefined : Math.max(0, Math.min(100, rawMinScore));
    const excludeSources = req.query.excludeSources ? (req.query.excludeSources as string).split(',').map(s => s.trim()).filter(Boolean) : undefined;

    const autoSummarizeFailed = req.query.autoSummarizeFailed === 'true';

    let { entries, total } = await getEntriesByStatus(statuses, { wire, date, promptId, limit, offset, minScore, excludeSources });

    if (autoSummarizeFailed) {
      const pool = getPool();
      const failedResult = await pool.query(
        `SELECT id, name, description, source_url, wire, status, quality_score, classification,
                amount, deadline, enriched_summary, scan_source, actioned_by, action_reason,
                created_at, updated_at
         FROM scan_entries
         WHERE auto_summarize_failed = true
           AND ($1::text[] IS NULL OR status = ANY($1))
           AND ($2::text IS NULL OR wire = $2)
         ORDER BY updated_at DESC
         LIMIT $3 OFFSET $4`,
        [statuses.length > 0 ? statuses : null, wire || null, limit, offset]
      );
      entries = failedResult.rows;
      total = failedResult.rowCount || 0;
    }

    if (includeDistributionStatus && entries.length > 0) {
      const distributionStatus = await getDistributionStatusForEntries(entries.map(entry => entry.id));
      entries = entries.map(entry => ({
        ...entry,
        distributionStatus: distributionStatus[entry.id] || {},
      }));
    }

    res.json({ entries, total, count: entries.length });
  } catch (error) {
    console.error('Failed to fetch scan entries:', error);
    res.status(500).json({ error: 'Failed to fetch scan entries' });
  }
});

// GET /entries/:id — single entry (dashboard deep links from the digest email)
router.get('/entries/:id', async (req: Request, res: Response) => {
  const entryId = parseInt(req.params.id, 10);
  if (isNaN(entryId) || String(entryId) !== req.params.id) {
    res.status(400).json({ error: 'Invalid entry ID' });
    return;
  }
  try {
    const pool = getPool();
    const { rows } = await pool.query(`SELECT * FROM scan_entries WHERE id = $1`, [entryId]);
    if (rows.length === 0) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }
    res.json({ entry: rows[0] });
  } catch (error) {
    console.error('Failed to fetch scan entry:', error);
    res.status(500).json({ error: 'Failed to fetch scan entry' });
  }
});

// POST /entries/bulk-action — bulk approve/decline/reviewlater/restore
router.post('/entries/bulk-action', async (req: Request, res: Response) => {
  const { ids, action, quiet, reason, dryRun } = req.body;
  const agentSession = (req as any).agentSession;

  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: 'ids must be a non-empty array' });
    return;
  }
  if (ids.length > 200) {
    res.status(400).json({ error: 'Maximum 200 entries per bulk action' });
    return;
  }

  const entryIds = ids.map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id));
  if (entryIds.length === 0) {
    res.status(400).json({ error: 'No valid entry IDs provided' });
    return;
  }

  try {
    // Agent calls (internal API key) always use quiet=true — no auto-distribution
    const isAgent = !!(agentSession?.isAgent);
    const result = await bulkEntryAction(entryIds, action, {
      quiet: isAgent ? true : !!quiet,
      force: resolveApprovalForce(req),
      actor: resolveMaintenanceActor(req) || undefined,
      reason: reason || undefined,
      dryRun: !!dryRun,
    });
    res.json(result);
  } catch (error) {
    if (error instanceof BulkApprovalBlockedError) {
      res.status(422).json({
        error: 'Some entries blocked',
        blocked: error.blocked,
        passCount: error.passCount,
        blockCount: error.blockCount,
      });
      return;
    }
    if (error instanceof Error && error.message.startsWith('Invalid action')) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error('Failed to bulk update entry status:', error);
    res.status(500).json({ error: 'Failed to bulk update entries' });
  }
});

// POST /entries/:id/action — single entry action
router.post('/entries/:id/action', async (req: Request, res: Response) => {
  const entryId = parseInt(req.params.id, 10);
  if (isNaN(entryId)) {
    res.status(400).json({ error: 'Invalid entry ID' });
    return;
  }

  const { action, quiet, reason, dryRun } = req.body;
  const agentSession = (req as any).agentSession;

  try {
    // Agent calls (internal API key) always use quiet=true — no auto-distribution
    const isAgent = !!(agentSession?.isAgent);
    const result = await singleEntryAction(entryId, action, {
      quiet: isAgent ? true : !!quiet,
      force: resolveApprovalForce(req),
      actor: resolveMaintenanceActor(req) || undefined,
      reason: reason || undefined,
      dryRun: !!dryRun,
    });
    res.json(result);
  } catch (error) {
    if (error instanceof ApprovalBlockedError) {
      res.status(422).json({
        error: 'Approval blocked',
        issues: error.errors,
        warnings: error.warnings,
      });
      return;
    }
    if (error instanceof Error && error.message === 'Entry not found') {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }
    if (error instanceof Error && error.message.startsWith('Invalid action')) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error('Failed to update entry status:', error);
    res.status(500).json({ error: 'Failed to update entry' });
  }
});

// POST /entries/:id/curate — write the curator's route + confidence recommendation.
// Non-destructive: merges into metadata.curator, never changes status. This is
// the queue's judgment signal that replaced the old inline quality_score.
router.post('/entries/:id/curate', async (req: Request, res: Response) => {
  const entryId = parseInt(req.params.id, 10);
  if (isNaN(entryId)) {
    res.status(400).json({ error: 'Invalid entry ID' });
    return;
  }

  const agentSession = (req as any).agentSession;
  let stamp;
  try {
    stamp = buildCuratorStamp({
      route: req.body?.route,
      confidence: req.body?.confidence,
      rationale: req.body?.rationale,
      by: resolveMaintenanceActor(req) || undefined,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid curator input' });
    return;
  }

  try {
    const result = await getPool().query(
      `UPDATE scan_entries
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
           updated_at = now()
       WHERE id = $2
       RETURNING id`,
      [JSON.stringify({ curator: stamp }), entryId]
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }
    res.json({ id: entryId, curator: stamp });
  } catch (error) {
    console.error('Failed to write curator stamp:', error);
    res.status(500).json({ error: 'Failed to curate entry' });
  }
});

// PATCH /entries/:id/wire — reassign wire
router.patch('/entries/:id/wire', async (req: Request, res: Response) => {
  const entryId = parseInt(req.params.id, 10);
  if (isNaN(entryId)) {
    res.status(400).json({ error: 'Invalid entry ID' });
    return;
  }

  // Accept either { wire: 'crypto' } (legacy) or { wires: ['crypto', 'ai'] } (multi-pick)
  const { wire, wires } = req.body;
  const wireArray: string[] = Array.isArray(wires) ? wires.filter((w: unknown) => typeof w === 'string') : (wire ? [wire] : []);

  if (wireArray.length === 0) {
    res.status(400).json({ error: 'At least one wire is required' });
    return;
  }

  try {
    // Validate all wires against active feeds
    const activeWires = await getAvailableWires();
    const validWireKeys = activeWires.map((w: any) => w.key || w.wire);
    const invalid = wireArray.filter(w => !validWireKeys.includes(w));
    if (invalid.length > 0) {
      res.status(400).json({ error: `Invalid wire(s): ${invalid.join(', ')}. Must be one of: ${validWireKeys.join(', ')}` });
      return;
    }

    const primaryWire = wireArray[0];
    const pool = getPool();
    
    // Get current wire before update
    const currentResult = await pool.query(
      `SELECT wire, name FROM scan_entries WHERE id = $1`,
      [entryId]
    );
    
    if (currentResult.rows.length === 0) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }
    
    const currentWire = currentResult.rows[0].wire;
    const entryName = currentResult.rows[0].name;
    
    // Update scan_entries
    const result = await pool.query(
      `UPDATE scan_entries SET wire = $1, wires = $2, updated_at = NOW() WHERE id = $3 RETURNING id, wire, wires`,
      [primaryWire, wireArray, entryId]
    );

    // Also update seen_names to keep wire in sync for dedup
    if (currentWire !== primaryWire) {
      await pool.query(
        `UPDATE seen_names SET wire = $1 WHERE entry_id = $2`,
        [primaryWire, entryId]
      );
      console.log(`[WireUpdate] Updated entry #${entryId} wire: ${currentWire} → ${primaryWire} (also updated seen_names)`);
    }

    res.json({ success: true, wire: result.rows[0].wire, wires: result.rows[0].wires });
  } catch (error) {
    console.error('Failed to update entry wire:', error);
    res.status(500).json({ error: 'Failed to update wire' });
  }
});

// PATCH /entries/:id/source — guarded canonical source rewrite with registry synchronization
router.patch('/entries/:id/source', async (req: Request, res: Response) => {
  const entryId = parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(entryId) || entryId <= 0) {
    res.status(400).json({ error: 'Invalid entry ID' });
    return;
  }
  try {
    const result = await rewriteEntrySource(getPool(), entryId, {
      expectedStatus: req.body.expectedStatus,
      expectedSourceUrl: req.body.expectedSourceUrl,
      newSourceUrl: req.body.newSourceUrl,
      actor: resolveMaintenanceActor(req),
      reason: req.body.reason,
      dryRun: req.body.dryRun === true,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    sendMaintenanceError(res, error, 'SourceRewrite');
  }
});

// POST /entries/:id/link-duplicate — guarded link to a recursively resolved canonical parent
router.post('/entries/:id/link-duplicate', async (req: Request, res: Response) => {
  const entryId = parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(entryId) || entryId <= 0) {
    res.status(400).json({ error: 'Invalid entry ID' });
    return;
  }
  try {
    const result = await linkEntryDuplicate(getPool(), entryId, {
      expectedStatus: req.body.expectedStatus,
      expectedSourceUrl: req.body.expectedSourceUrl,
      duplicateOfId: Number(req.body.duplicateOfId),
      actor: resolveMaintenanceActor(req),
      reason: req.body.reason,
      dryRun: req.body.dryRun === true,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    sendMaintenanceError(res, error, 'DuplicateLink');
  }
});

// GET /entries/:id/distribution — distribution logs for single entry
router.get('/entries/:id/distribution', async (req: Request, res: Response) => {
  const entryId = parseInt(req.params.id, 10);
  if (isNaN(entryId)) {
    res.status(400).json({ error: 'Invalid entry ID' });
    return;
  }

  try {
    const logs = await getDistributionLogs(entryId);
    res.json(logs);
  } catch (error) {
    console.error('Failed to fetch distribution logs:', error);
    res.status(500).json({ error: 'Failed to fetch distribution logs' });
  }
});

// POST /entries/:id/redistribute — retry failed distribution
router.post('/entries/:id/redistribute', async (req: Request, res: Response) => {
  // Publishing is operator-only: the internal API key must not be able to
  // trigger a send (it would bypass the forced-quiet rule on agent approvals).
  if ((req as any).agentSession) {
    res.status(403).json({ error: 'Redistribute is operator-only — agent keys cannot publish' });
    return;
  }
  const entryId = parseInt(req.params.id, 10);
  if (isNaN(entryId)) {
    res.status(400).json({ error: 'Invalid entry ID' });
    return;
  }

  if (!rateLimit('redistribute', 5, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Too many retry attempts. Please wait a few minutes.' });
    return;
  }

  try {
    // Look up the entry's wire
    const pool = getPool();
    const entryResult = await pool.query('SELECT wire FROM scan_entries WHERE id = $1', [entryId]);
    if (entryResult.rows.length === 0) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }
    const wire = entryResult.rows[0].wire;

    const result = await retryDistribution(entryId, wire);
    res.json({ success: true, ...result });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Distribution] Redistribute failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// POST /entries/:id/retry-summarize — retry auto-summarization for a failed entry
router.post('/entries/:id/retry-summarize', async (req: Request, res: Response) => {
  const entryId = parseInt(req.params.id, 10);
  if (isNaN(entryId)) { res.status(400).json({ error: 'Invalid entry ID' }); return; }

  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT id, name, description, source_url, wire, amount, deadline FROM scan_entries WHERE id = $1`,
      [entryId]
    );
    if (result.rows.length === 0) { res.status(404).json({ error: 'Entry not found' }); return; }

    const entry = result.rows[0];
    const { autoSummarizeOnApprove } = await import('../services/auto-summarize');
    await autoSummarizeOnApprove(
      entry.id, null, entry.name, entry.description || '', entry.amount, entry.deadline, entry.source_url, entry.wire
    );

    // Clear the failed flag
    await pool.query(`UPDATE scan_entries SET auto_summarize_failed = false WHERE id = $1`, [entryId]);
    res.json({ success: true, entryId });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: msg });
  }
});

export const scanEntryRouter = router;

// GET /cost-stats — cost and performance analytics for scan prompts (last 30 days)
router.get('/cost-stats', async (_req: Request, res: Response) => {
  try {
    const pool = getPool();

    const result = await pool.query(`
      WITH scan_costs AS (
        SELECT
          COALESCE(SUM(estimated_cost_usd) FILTER (WHERE purpose = 'scan'), 0) AS total_scan_cost,
          COALESCE(SUM(estimated_cost_usd) FILTER (WHERE purpose = 'classify'), 0) AS total_classify_cost,
          COALESCE(SUM(estimated_cost_usd), 0) AS total_cost
        FROM api_usage_log
        WHERE created_at > NOW() - INTERVAL '30 days'
        AND provider = 'grok'
      ),
      entry_counts AS (
        SELECT
          prompt_id,
          COUNT(*) AS total_entries,
          COUNT(*) FILTER (WHERE status = 'approved') AS approved_entries,
          SUM(COUNT(*)) OVER () AS grand_total
        FROM scan_entries
        WHERE created_at > NOW() - INTERVAL '30 days'
        AND prompt_id IS NOT NULL
        GROUP BY prompt_id
      ),
      total_approved AS (
        SELECT COUNT(*) AS cnt FROM scan_entries
        WHERE created_at > NOW() - INTERVAL '30 days'
        AND status = 'approved'
      )
      SELECT
        sp.id, sp.wire, sp.variant, sp.label, sp.tool_type, sp.is_active,
        COALESCE(ec.total_entries, 0) AS total_entries,
        COALESCE(ec.approved_entries, 0) AS approved_entries,
        sc.total_scan_cost,
        sc.total_classify_cost,
        sc.total_cost,
        ta.cnt AS total_approved_30d,
        CASE WHEN COALESCE(ec.grand_total, 0) > 0
          THEN ROUND((COALESCE(ec.total_entries, 0)::numeric / ec.grand_total) * sc.total_scan_cost, 4)
          ELSE 0 END AS estimated_cost
      FROM scan_prompts sp
      LEFT JOIN entry_counts ec ON ec.prompt_id = sp.id
      CROSS JOIN scan_costs sc
      CROSS JOIN total_approved ta
      ORDER BY sp.wire, sp.variant
    `);

    if (result.rows.length === 0) {
      res.json({ summary: {}, byPrompt: [] });
      return;
    }

    const firstRow = result.rows[0];
    const totalScanCost = parseFloat(firstRow.total_scan_cost) || 0;
    const totalClassifyCost = parseFloat(firstRow.total_classify_cost) || 0;
    const totalCost = parseFloat(firstRow.total_cost) || 0;
    const totalApproved = parseInt(firstRow.total_approved_30d) || 0;

    const byPrompt = result.rows.map((row) => {
      const totalEntries = parseInt(row.total_entries) || 0;
      const approvedEntries = parseInt(row.approved_entries) || 0;
      const estimatedCost = parseFloat(row.estimated_cost) || 0;
      const approvalRate = totalEntries > 0 ? Math.round((approvedEntries / totalEntries) * 1000) / 10 : 0;
      const costPerApproved = approvedEntries > 0 ? Math.round((estimatedCost / approvedEntries) * 10000) / 10000 : null;

      return {
        promptId: row.id,
        wire: row.wire,
        variant: row.variant,
        label: row.label,
        toolType: row.tool_type,
        isActive: row.is_active,
        totalEntries,
        approvedEntries,
        approvalRate,
        estimatedCost,
        costPerApproved,
      };
    });

    res.json({
      summary: {
        totalCost30d: Math.round(totalCost * 10000) / 10000,
        scanCost30d: Math.round(totalScanCost * 10000) / 10000,
        classifyCost30d: Math.round(totalClassifyCost * 10000) / 10000,
        totalApproved30d: totalApproved,
        costPerApproved: totalApproved > 0 ? Math.round((totalCost / totalApproved) * 10000) / 10000 : null,
      },
      byPrompt,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[CostStats] Failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// GET /deadline-digest — entries with deadlines in the next N days, grouped by wire
router.get('/deadline-digest', async (req: Request, res: Response) => {
  try {
    const pool = getPool();
    const days = Math.min(30, Math.max(1, parseInt(req.query.days as string) || 7));
    const wire = req.query.wire as string | undefined;
    const { runDeadlineDigest } = await import('../jobs/deadline-digest');
    const results = await runDeadlineDigest(pool, wire, days);
    res.json(results);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: msg });
  }
});

// ── Agent endpoints ───────────────────────────��─────────────────────────────

// GET /agent/approval-patterns — recent approved/declined examples for agent few-shot learning
router.get('/agent/approval-patterns', async (_req: Request, res: Response) => {
  if (!rateLimit('agent-approval-patterns', 5, 60000)) {
    res.status(429).json({ error: 'Rate limit exceeded' });
    return;
  }
  try {
    const pool = getPool();
    const approved = await pool.query(
      `SELECT name, wire, quality_score, classification, scan_source,
              LEFT(description, 200) as description, source_url
       FROM scan_entries
       WHERE status = 'approved'
       ORDER BY created_at DESC LIMIT 30`
    );
    const declined = await pool.query(
      `SELECT name, wire, quality_score, classification, scan_source,
              LEFT(description, 200) as description, action_reason
       FROM scan_entries
       WHERE status = 'declined'
       ORDER BY created_at DESC LIMIT 30`
    );
    res.json({ approved: approved.rows, declined: declined.rows });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// POST /agent/send-brief — record the daily agent brief.
// The brief is persisted to app_state and folded into the next daily digest
// email (single combined morning email) rather than sent as its own email.
router.post('/agent/send-brief', async (req: Request, res: Response) => {
  if (!rateLimit('agent-send-brief', 3, 60000)) {
    res.status(429).json({ error: 'Rate limit exceeded' });
    return;
  }
  try {
    const { getAppState, setAppState } = await import('../db');
    const brief = (req.body && typeof req.body === 'object') ? req.body : {};
    const date = typeof brief.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(brief.date)
      ? brief.date
      : new Date().toISOString().slice(0, 10);
    const key = `agent-brief:${date}`;
    const existing = await getAppState<{ runs: unknown[] }>(key);
    const runs = Array.isArray(existing?.runs) ? existing.runs : [];
    runs.push({ ...brief, receivedAt: new Date().toISOString() });
    await setAppState(key, { runs });
    res.json({
      success: true,
      stored: true,
      runs: runs.length,
      note: 'Brief recorded; it will be included in the daily digest email.',
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});
