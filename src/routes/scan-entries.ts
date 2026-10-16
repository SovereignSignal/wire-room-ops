/**
 * Scan Entry Routes
 *
 * GET    /entries                — query entries with filters (status, wire, date, etc.)
 * GET    /entries/:id            — single entry (dashboard deep link from digest email)
 * POST   /submit                — single entry submission
 * POST   /submit-batch          — batch submission (Prompt A/B/C x-scan sections)
 * POST   /telegram-batch        — same processBatchMessage path as the Telegram intake bot
 * POST   /manual-intake         — dashboard paste (scan_source=manual-intake)
 * GET    /queue                  — list queued entries
 * GET    /stats                  — scan pipeline statistics
 * GET    /status-counts          — count by status
 * GET    /seen-urls              — URL dedup stats
 * GET    /prompt-stats           — prompt effectiveness
 * PATCH  /entries/:id/wire       — reassign wire
 * PATCH  /entries/:id/source     — guarded canonical source rewrite
 * PATCH  /entries/:id/content    — edit post text and record fields; never sends
 * POST   /entries/:id/unwithhold — release a withheld publication; never enqueues or sends
 * POST   /entries/:id/link-duplicate — guarded explicit duplicate link
 * POST   /entries/bulk-action    — bulk approve/decline/reviewlater/restore
 * POST   /entries/:id/action     — single entry action
 * GET    /entries/:id/distribution — distribution logs for single entry
 * POST   /entries/:id/redistribute — retry failed distribution
 */

import { Router, Request, Response } from 'express';
import { getPool, getAvailableWires, getEntriesByStatus, getStatusCounts, getSeenUrlStats, getSeenUrlsList, getDistributionLogs, getDistributionStatusForEntries, isCoreWire } from '../db';
import { isQueueClassification, isQueueDateStatus, isQueueRoute } from '../db/entry-query';
import { rateLimit } from '../middleware/rate-limit';
import { isValidUuid, isValidFeedKey } from '../utils/validation';
import { buildSubmission, buildBatchSubmission } from '../services/intake';
import { runDailyIntake, getDailyQueue, getIntakeStats, resolveQueueMinScore } from '../jobs/daily-intake';
import { getPromptEffectivenessStats } from '../services/scan-stats';
import { reviewedApprovalRate } from '../services/approval-rate';
import { singleEntryAction, bulkEntryAction, ApprovalBlockedError, BulkApprovalBlockedError, EntryActionConflictError } from '../services/entry-actions';
import { RepeatFunderHoldError, repeatFunderPayload } from '../services/repeat-funder';
import { rewriteEntrySource, rewriteEntryWires, linkEntryDuplicate, EntryMaintenanceError } from '../services/entry-maintenance';
import { ContentEditError, parseContentPatch, releaseWithheldEntry, updateEntryContent } from '../services/entry-content';
import { applyCuratorWrite, planCuratorWrite } from '../services/curator';
import { attachCuratorEvidence, parseCuratorEvidence, type CuratorEvidence } from '../services/curator-evidence';
import { openCuratorIdempotency } from '../services/curator-idempotency';
import { retryDistribution } from '../services/distribution';
import { curatorConfirmed } from '../services/curator-confirm';
import { getDistributionPace } from '../services/distribution-pace';
import { PACING_REQUIRED_ERROR, withholdPublications, WithholdConflictError } from '../services/publication-queue';
import { PROMPT_VARIANTS, SCAN_SOURCES } from '../types/intake';
import { isBatchMessage, processBatchMessage, processIntakeMessage, type IntakeOptions } from '../services/intake-core';
import { runDecidedRecheckForIds } from '../jobs/decided-recheck';
import { noteCuratorChange } from '../services/curator-audit';

const router = Router();

/** Bind maintenance audit attribution to the authenticated principal. */
export function resolveMaintenanceActor(req: Request): string {
  return (req as any).agentSession?.userId || (req as any).authSession?.userId || '';
}

/** Internal-key agents may approve quietly, but may never bypass approval guards. */
export function resolveApprovalForce(req: Request): boolean {
  return !Boolean((req as any).agentSession) && req.query?.force === 'true';
}

function isCuratorSession(req: Request): boolean {
  return Boolean((req as any).agentSession?.curator);
}

async function markCuratorPrior(req: Request, res: Response, ids: number[]): Promise<void> {
  if (!isCuratorSession(req) || ids.length === 0) return;
  try {
    const rows = await getPool().query(
      'SELECT id, status, wire, source_url, name FROM scan_entries WHERE id = ANY($1::int[])',
      [ids],
    );
    res.locals.curatorPrior = rows.rows;
  } catch {
    res.locals.curatorPrior = null;
  }
}

function presentForCurator<T>(req: Request, value: T): T {
  if (!isCuratorSession(req) || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => presentForCurator(req, item)) as T;
  const copy = { ...(value as Record<string, unknown>) };
  delete copy.raw_output;
  delete copy.rawOutput;
  return copy as T;
}

type CuratorGate =
  | { ok: false }
  | {
      ok: true;
      evidence: CuratorEvidence | null;
      finish: (statusCode: number, payload: unknown) => Promise<void>;
      abort: () => Promise<void>;
    };

/** Evidence, then idempotency. Internal keys skip both. */
async function beginCuratorWrite(req: Request, res: Response, opts: { requireQuote: boolean }): Promise<CuratorGate> {
  if (!isCuratorSession(req)) {
    return { ok: true, evidence: null, finish: async () => {}, abort: async () => {} };
  }
  const parsed = parseCuratorEvidence(req.body, opts);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return { ok: false };
  }
  const idem = await openCuratorIdempotency(req, res);
  if (idem.sent) return { ok: false };
  return { ok: true, evidence: parsed.evidence, finish: idem.finish, abort: idem.abort };
}

type QuietDecision =
  | { ok: true; quiet: boolean }
  | { ok: false; status: number; body: { error: string; message?: string } };

/**
 * Curator approvals stay quiet. publish:true books a paced slot only when
 * this is a curator session, confirm is set, and pacing is on and not paused.
 * A plain internal key stays quiet. A dashboard session keeps the quiet flag
 * it sent.
 */
async function quietForAction(req: Request, action: string): Promise<QuietDecision> {
  const agent = (req as Request & { agentSession?: { isAgent?: boolean; curator?: boolean } }).agentSession;
  const isAgent = !!agent?.isAgent;
  const dashboardQuiet = !!req.body?.quiet;
  if (action !== 'approve') return { ok: true, quiet: isAgent ? true : dashboardQuiet };
  if (!isAgent) return { ok: true, quiet: dashboardQuiet };
  if (!agent?.curator || req.body?.publish !== true) return { ok: true, quiet: true };
  if (!curatorConfirmed(req)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'confirm_required',
        message: 'Publishing an approval onto the paced queue needs confirm=true.',
      },
    };
  }
  const pace = await getDistributionPace();
  if (!pace.enabled || pace.paused) {
    return { ok: false, status: 409, body: { error: PACING_REQUIRED_ERROR } };
  }
  return { ok: true, quiet: false };
}

async function remember(gate: Extract<CuratorGate, { ok: true }>, statusCode: number, payload: unknown, res: Response): Promise<void> {
  await gate.finish(statusCode, payload);
  res.status(statusCode).json(payload);
}

/** Withhold is a publication-queue write, not a status change, so it does not go through entry-actions. */
async function respondWithhold(req: Request, res: Response, gate: Extract<CuratorGate, { ok: true }>, entryIds: number[]): Promise<void> {
  try {
    await markCuratorPrior(req, res, entryIds);
    const result = await withholdPublications(entryIds, {
      actor: resolveMaintenanceActor(req) || undefined,
      reason: gate.evidence?.reason || (typeof req.body?.reason === 'string' ? req.body.reason : undefined),
      evidence: gate.evidence,
      dryRun: !!req.body?.dryRun,
    });
    await remember(gate, 200, result, res);
  } catch (error) {
    if (error instanceof WithholdConflictError) {
      await remember(gate, 409, { error: error.message, blocked: error.blocked }, res);
      return;
    }
    await gate.abort();
    console.error('Failed to withhold entries:', error);
    res.status(500).json({ error: 'Failed to withhold entries' });
  }
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
    if (source === 'x-monitor') {
      res.status(400).json({ error: 'x-monitor is reserved for the Account Monitor canonical-URL intake path' });
      return;
    }

    const submission = buildSubmission(
      rawText,
      wire,
      promptVariant,
      scanDate,
      source || 'x-scan'
    );
    const agentSession = (req as any).agentSession;
    if (agentSession?.curator) submission.submittedBy = agentSession.userId;

    const pool = getPool();
    // Agent (internal-key) submissions return fast: entries are inserted raw
    // and the background processor handles dedup/classify/queue within ~5 min.
    // Synchronous processing held the connection through LLM classification,
    // which read as a hang to API clients and caused retry storms.
    const isAgent = Boolean((req as any).agentSession);
    const summary = await runDailyIntake(pool, [submission], isAgent ? { insertOnly: true } : {});
    noteCuratorChange(res, { subject: 'POST /api/scan/submit', old: null, next: { wire, source: source || 'x-scan', processing: isAgent ? 'background' : 'complete' } });

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
    if (source === 'x-monitor') {
      res.status(400).json({ error: 'x-monitor is reserved for the Account Monitor canonical-URL intake path' });
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

const TEXT_INTAKE_MAX = 20_000;

async function handleTextIntake(
  req: Request,
  res: Response,
  opts: { scanSource: string; rateKey: string; logLabel: string; wireHint?: string },
): Promise<void> {
  if (!rateLimit(opts.rateKey, 20, 5 * 60 * 1000)) {
    res.status(429).json({ error: `${opts.rateKey} recently run. Please wait.` });
    return;
  }

  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (!text.trim()) {
    res.status(400).json({ error: 'text is required and must be a non-empty string' });
    return;
  }
  if (text.length > TEXT_INTAKE_MAX) {
    res.status(400).json({ error: `text exceeds ${TEXT_INTAKE_MAX} characters` });
    return;
  }

  const actor = resolveMaintenanceActor(req) || `http:${opts.rateKey}`;
  const intakeMsg = {
    text,
    senderId: actor,
    channelMessageId: `http-${Date.now()}`,
  };
  // Same signal /submit uses: an internal-key caller is an agent, so its rows
  // start raw and the 5-min process-raw cycle classifies them. A human session
  // keeps the operator dumb pipe (queued, unclassified, wide net).
  const isAgent = Boolean((req as any).agentSession?.isAgent);
  const intakeOptions: IntakeOptions = {
    origin: isAgent ? 'agent' : 'operator',
    ...(opts.wireHint ? { wireHint: opts.wireHint } : {}),
  };
  const backgroundNote = isAgent
    ? { processing: 'background', note: 'Entries inserted raw; dedup/classification completes in the background within ~5 minutes. Do NOT retry this request.' }
    : {};

  try {
    if (isBatchMessage(text)) {
      const batch = await processBatchMessage(intakeMsg, opts.scanSource, intakeOptions);
      if (batch.retryableErrors > 0) {
        res.setHeader('Retry-After', '5');
        res.status(503).json({
          error: 'Retryable persistence errors',
          inserted: batch.inserted,
          duplicates: batch.duplicates,
          skippedAlreadySeen: batch.skippedAlreadySeen ?? 0,
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
          console.error(`[${opts.logLabel}] History check failed:`, error);
        }
      }

      noteCuratorChange(res, {
        subject: `${req.method} ${req.path}`,
        old: null,
        next: {
          inserted: batch.inserted,
          duplicates: batch.duplicates,
          skippedAlreadySeen: batch.skippedAlreadySeen ?? 0,
          errors: batch.errors,
        },
      });
      res.json({
        success: true,
        inserted: batch.inserted,
        duplicates: batch.duplicates,
        skippedAlreadySeen: batch.skippedAlreadySeen ?? 0,
        errors: batch.errors,
        retryableErrors: batch.retryableErrors,
        entries: batch.entries,
        ...backgroundNote,
      });
      return;
    }

    const result = await processIntakeMessage(intakeMsg, opts.scanSource, intakeOptions);
    if (result.status === 'error') {
      res.setHeader('Retry-After', '5');
      res.status(503).json({ error: result.errorMessage || `${opts.logLabel} intake failed`, result });
      return;
    }
    noteCuratorChange(res, {
      subject: `${req.method} ${req.path}`,
      old: null,
      next: { status: result.status, entryId: result.entryId || null },
    });
    res.json({
      success: result.status === 'inserted',
      ...(result.skippedAlreadySeen ? { inserted: 0, duplicates: 0, skippedAlreadySeen: 1 } : {}),
      result,
      ...(result.status === 'inserted' ? backgroundNote : {}),
    });
  } catch (error) {
    console.error(`${opts.logLabel} intake failed:`, error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
}

/**
 * POST /telegram-batch — HTTP door into the Grant Wire summarizer intake.
 * Same parseBatchEntries + URL/name dedupe + queued insert as the Telegram bot.
 * Body: { text: string }  (the markdown Sov pastes into the Telegram intake bot)
 * Auth: session or INTERNAL_API_KEY (this router is already behind requireAuthOrInternalKey).
 */
router.post('/telegram-batch', async (req: Request, res: Response) => {
  await handleTextIntake(req, res, {
    scanSource: 'telegram',
    rateKey: 'telegram-batch',
    logLabel: 'TelegramBatch',
  });
});

/**
 * POST /manual-intake — dashboard paste (historically the highest-approval channel).
 * Same intake path as telegram-batch, but scan_source is always manual-intake.
 * Body: { text: string, wire?: 'crypto'|'ai'|'oss' }
 */
router.post('/manual-intake', async (req: Request, res: Response) => {
  const wire = typeof req.body?.wire === 'string' ? req.body.wire.trim().toLowerCase() : '';
  if (wire && !isCoreWire(wire)) {
    res.status(400).json({ error: `Invalid wire "${wire}". Valid: crypto, ai, oss` });
    return;
  }
  await handleTextIntake(req, res, {
    scanSource: 'manual-intake',
    rateKey: 'manual-intake',
    logLabel: 'ManualIntake',
    wireHint: wire || undefined,
  });
});

// GET /queue — list queued entries.
// Omitted minScore includes unscored rows. Pass minScore to keep the old floor.
router.get('/queue', async (req: Request, res: Response) => {
  const wire = (req.query.wire as string) || null;
  const resolved = resolveQueueMinScore(req.query.minScore);
  if (!resolved.ok) {
    res.status(400).json({ error: resolved.error });
    return;
  }
  const minScore = resolved.minScore;
  const date = (req.query.date as string) || null;

  // Validate date format if provided
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    return;
  }

  try {
    const pool = getPool();
    const entries = presentForCurator(req, await getDailyQueue(pool, wire, minScore, date));
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
    const classification = req.query.classification as string | undefined;
    const route = req.query.route as string | undefined;
    const dateStatus = req.query.dateStatus as string | undefined;
    const includeDistributionStatus = req.query.includeDistributionStatus === '1' || req.query.includeDistributionStatus === 'true';
    if (wire && !isCoreWire(wire)) {
      res.status(400).json({ error: `Invalid wire "${wire}".` });
      return;
    }
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
      return;
    }
    if (promptId && !isValidUuid(promptId)) {
      res.status(400).json({ error: 'Invalid promptId format.' });
      return;
    }
    if (classification && !isQueueClassification(classification)) {
      res.status(400).json({ error: 'Invalid classification filter.' });
      return;
    }
    if (route && !isQueueRoute(route)) {
      res.status(400).json({ error: 'Invalid route filter.' });
      return;
    }
    if (dateStatus && !isQueueDateStatus(dateStatus)) {
      res.status(400).json({ error: 'Invalid dateStatus filter.' });
      return;
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);
    const rawMinScore = parseInt(req.query.minScore as string, 10);
    const minScore = isNaN(rawMinScore) ? undefined : Math.max(0, Math.min(100, rawMinScore));
    const rawMaxScore = parseInt(req.query.maxScore as string, 10);
    const maxScore = isNaN(rawMaxScore) ? undefined : Math.max(0, Math.min(100, rawMaxScore));
    const unscored = req.query.unscored === '1' || req.query.unscored === 'true';
    const excludeSources = req.query.excludeSources ? (req.query.excludeSources as string).split(',').map(s => s.trim()).filter(Boolean) : undefined;

    const autoSummarizeFailed = req.query.autoSummarizeFailed === 'true';

    let { entries, total } = await getEntriesByStatus(statuses, {
      wire,
      date,
      promptId,
      limit,
      offset,
      minScore,
      maxScore,
      unscored: unscored || undefined,
      excludeSources,
      classification,
      route,
      dateStatus: dateStatus && isQueueDateStatus(dateStatus) ? dateStatus : undefined,
    });

    if (autoSummarizeFailed) {
      const pool = getPool();
      const failedResult = await pool.query(
        `SELECT id, name, description, source_url, wire, status, quality_score, classification,
                wire_area, amount, deadline, enriched_summary, scan_source, actioned_by, action_reason,
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

    res.json({ entries: presentForCurator(req, entries), total, count: entries.length });
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
    res.json({ entry: presentForCurator(req, rows[0]) });
  } catch (error) {
    console.error('Failed to fetch scan entry:', error);
    res.status(500).json({ error: 'Failed to fetch scan entry' });
  }
});

// POST /entries/bulk-action — bulk approve/decline/reviewlater/restore, or withhold from the Telegram stream
router.post('/entries/bulk-action', async (req: Request, res: Response) => {
  const { ids, action, reason, dryRun } = req.body;
  const gate = await beginCuratorWrite(req, res, { requireQuote: action === 'approve' });
  if (!gate.ok) return;

  if (!Array.isArray(ids) || ids.length === 0) {
    await remember(gate, 400, { error: 'ids must be a non-empty array' }, res);
    return;
  }
  if (ids.length > 200) {
    await remember(gate, 400, { error: 'Maximum 200 entries per bulk action' }, res);
    return;
  }

  const entryIds = ids.map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id));
  if (entryIds.length === 0) {
    await remember(gate, 400, { error: 'No valid entry IDs provided' }, res);
    return;
  }
  if (action === 'withhold') {
    await respondWithhold(req, res, gate, entryIds);
    return;
  }

  try {
    const decided = await quietForAction(req, action);
    if (!decided.ok) {
      await gate.abort();
      res.status(decided.status).json(decided.body);
      return;
    }
    const auditReason = gate.evidence?.reason || reason || undefined;
    await markCuratorPrior(req, res, entryIds);
    const result = await bulkEntryAction(entryIds, action, {
      quiet: decided.quiet,
      force: resolveApprovalForce(req),
      actor: resolveMaintenanceActor(req) || undefined,
      reason: auditReason,
      dryRun: !!dryRun,
      overrideRepeatFunder: req.body?.override_repeat_funder === true,
    });
    if (gate.evidence && !dryRun) {
      await attachCuratorEvidence(getPool(), entryIds, gate.evidence, resolveMaintenanceActor(req));
    }
    await remember(gate, 200, result, res);
  } catch (error) {
    if (error instanceof RepeatFunderHoldError) {
      await remember(gate, error.statusCode, repeatFunderPayload(error), res);
      return;
    }
    if (error instanceof EntryActionConflictError) {
      await remember(gate, 409, { error: error.message }, res);
      return;
    }
    if (error instanceof BulkApprovalBlockedError) {
      await remember(gate, 422, {
        error: 'Some entries blocked',
        blocked: error.blocked,
        passCount: error.passCount,
        blockCount: error.blockCount,
      }, res);
      return;
    }
    if (error instanceof Error && error.message.startsWith('Invalid action')) {
      await remember(gate, 400, { error: error.message }, res);
      return;
    }
    await gate.abort();
    console.error('Failed to bulk update entry status:', error);
    res.status(500).json({ error: 'Failed to bulk update entries' });
  }
});

// POST /entries/:id/action — single entry action (approve/decline/reviewlater/restore/withhold)
router.post('/entries/:id/action', async (req: Request, res: Response) => {
  const entryId = parseInt(req.params.id, 10);
  if (isNaN(entryId)) {
    res.status(400).json({ error: 'Invalid entry ID' });
    return;
  }

  const { action, reason, dryRun } = req.body;
  const gate = await beginCuratorWrite(req, res, { requireQuote: action === 'approve' });
  if (!gate.ok) return;
  if (action === 'withhold') {
    await respondWithhold(req, res, gate, [entryId]);
    return;
  }

  try {
    const decided = await quietForAction(req, action);
    if (!decided.ok) {
      await gate.abort();
      res.status(decided.status).json(decided.body);
      return;
    }
    const auditReason = gate.evidence?.reason || reason || undefined;
    await markCuratorPrior(req, res, [entryId]);
    const result = await singleEntryAction(entryId, action, {
      quiet: decided.quiet,
      force: resolveApprovalForce(req),
      actor: resolveMaintenanceActor(req) || undefined,
      reason: auditReason,
      dryRun: !!dryRun,
      overrideRepeatFunder: req.body?.override_repeat_funder === true,
    });
    if (gate.evidence && !dryRun) {
      await attachCuratorEvidence(getPool(), [entryId], gate.evidence, resolveMaintenanceActor(req));
    }
    await remember(gate, 200, result, res);
  } catch (error) {
    if (error instanceof RepeatFunderHoldError) {
      await remember(gate, error.statusCode, repeatFunderPayload(error), res);
      return;
    }
    if (error instanceof EntryActionConflictError) {
      await remember(gate, 409, { error: error.message }, res);
      return;
    }
    if (error instanceof ApprovalBlockedError) {
      await remember(gate, 422, {
        error: 'Approval blocked',
        issues: error.errors,
        warnings: error.warnings,
      }, res);
      return;
    }
    if (error instanceof Error && error.message === 'Entry not found') {
      await remember(gate, 404, { error: 'Entry not found' }, res);
      return;
    }
    if (error instanceof Error && error.message.startsWith('Invalid action')) {
      await remember(gate, 400, { error: error.message }, res);
      return;
    }
    await gate.abort();
    console.error('Failed to update entry status:', error);
    res.status(500).json({ error: 'Failed to update entry' });
  }
});

// POST /entries/:id/curate — write the curator's route + confidence recommendation.
// Stamp-only for operators and INTERNAL_API_KEY. A curator key with route
// decline also declines the entry through entry-actions (quiet, no distribution).
router.post('/entries/:id/curate', async (req: Request, res: Response) => {
  const entryId = parseInt(req.params.id, 10);
  if (isNaN(entryId)) {
    res.status(400).json({ error: 'Invalid entry ID' });
    return;
  }

  const agentSession = (req as any).agentSession;
  const gate = await beginCuratorWrite(req, res, { requireQuote: false });
  if (!gate.ok) return;

  let plan;
  try {
    plan = planCuratorWrite({
      isCurator: Boolean(agentSession?.curator),
      route: req.body?.route,
      confidence: req.body?.confidence,
      rationale: gate.evidence?.reason || req.body?.rationale,
      by: resolveMaintenanceActor(req) || undefined,
    });
  } catch (err) {
    await remember(gate, 400, { error: err instanceof Error ? err.message : 'Invalid curator input' }, res);
    return;
  }

  try {
    await markCuratorPrior(req, res, [entryId]);
    const payload = await applyCuratorWrite({
      entryId,
      plan,
      actor: resolveMaintenanceActor(req) || undefined,
      reason: gate.evidence?.reason,
      declineEntry: (id, opts) => singleEntryAction(id, 'decline', opts),
      writeStamp: async (id, stamp) => {
        const result = await getPool().query(
          `UPDATE scan_entries
           SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
               updated_at = now()
           WHERE id = $2
           RETURNING id`,
          [JSON.stringify({ curator: stamp }), id]
        );
        return (result.rowCount || 0) > 0;
      },
    });
    if (gate.evidence) {
      await attachCuratorEvidence(getPool(), [entryId], gate.evidence, resolveMaintenanceActor(req));
    }
    await remember(gate, 200, payload, res);
  } catch (error) {
    if (error instanceof Error && error.message === 'Entry not found') {
      await remember(gate, 404, { error: 'Entry not found' }, res);
      return;
    }
    if (error instanceof EntryActionConflictError) {
      await remember(gate, 409, { error: error.message }, res);
      return;
    }
    await gate.abort();
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

  const gate = await beginCuratorWrite(req, res, { requireQuote: false });
  if (!gate.ok) return;

  if (wireArray.length === 0) {
    await remember(gate, 400, { error: 'At least one wire is required' }, res);
    return;
  }

  try {
    // Validate all wires against active feeds
    const activeWires = await getAvailableWires();
    const validWireKeys = activeWires.map((w: any) => w.key || w.wire);
    const invalid = wireArray.filter(w => !validWireKeys.includes(w));
    if (invalid.length > 0) {
      await remember(gate, 400, { error: `Invalid wire(s): ${invalid.join(', ')}. Must be one of: ${validWireKeys.join(', ')}` }, res);
      return;
    }

    await markCuratorPrior(req, res, [entryId]);
    const result = await rewriteEntryWires(getPool(), entryId, {
      wires: wireArray,
      actor: resolveMaintenanceActor(req) || undefined,
      reason: gate.evidence?.reason || (typeof req.body?.reason === 'string' ? req.body.reason : undefined),
    });

    if (gate.evidence) {
      await attachCuratorEvidence(getPool(), [entryId], gate.evidence, resolveMaintenanceActor(req));
    }
    await remember(gate, 200, { success: true, wire: result.wire, wires: result.wires }, res);
  } catch (error) {
    if (error instanceof EntryMaintenanceError) {
      await remember(gate, error.statusCode, { error: error.message }, res);
      return;
    }
    await gate.abort();
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[WireRewrite] Failed:', error);
    res.status(500).json({ error: message });
  }
});

// PATCH /entries/:id/source — guarded canonical source rewrite with registry synchronization
router.patch('/entries/:id/source', async (req: Request, res: Response) => {
  const entryId = parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(entryId) || entryId <= 0) {
    res.status(400).json({ error: 'Invalid entry ID' });
    return;
  }
  const gate = await beginCuratorWrite(req, res, { requireQuote: false });
  if (!gate.ok) return;
  try {
    const dryRun = req.body.dryRun === true;
    await markCuratorPrior(req, res, [entryId]);
    const result = await rewriteEntrySource(getPool(), entryId, {
      expectedStatus: req.body.expectedStatus,
      expectedSourceUrl: req.body.expectedSourceUrl,
      newSourceUrl: req.body.newSourceUrl,
      actor: resolveMaintenanceActor(req),
      reason: gate.evidence?.reason || req.body.reason,
      dryRun,
    });
    if (gate.evidence && !dryRun) {
      await attachCuratorEvidence(getPool(), [entryId], gate.evidence, resolveMaintenanceActor(req));
    }
    await remember(gate, 200, { success: true, ...result }, res);
  } catch (error) {
    if (error instanceof EntryMaintenanceError) {
      await remember(gate, error.statusCode, { error: error.message }, res);
      return;
    }
    await gate.abort();
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[SourceRewrite] Failed:', error);
    res.status(500).json({ error: message });
  }
});

function entryIdParam(req: Request, res: Response): number | null {
  const entryId = parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(entryId) || entryId <= 0) {
    res.status(400).json({ error: 'Invalid entry ID' });
    return null;
  }
  return entryId;
}

const CONFIRM_MESSAGE = 'Editing entry content or releasing a withhold needs confirm=true. This action does not send.';

function requireExplicitConfirm(req: Request, res: Response): boolean {
  if (curatorConfirmed(req)) return true;
  res.status(400).json({ error: 'confirm_required', message: CONFIRM_MESSAGE });
  return false;
}

/**
 * Evidence for every caller, then the curator idempotency claim.
 * Field checks happen before this so a bad patch does not consume the key.
 */
async function beginEvidenceWrite(req: Request, res: Response): Promise<CuratorGate> {
  const parsed = parseCuratorEvidence(req.body, { requireQuote: false });
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return { ok: false };
  }
  const gate = await beginCuratorWrite(req, res, { requireQuote: false });
  if (!gate.ok) return gate;
  return { ...gate, evidence: parsed.evidence };
}

// PATCH /entries/:id/content — edit post text, classification, tags, and metadata.amount. Never sends.
router.patch('/entries/:id/content', async (req: Request, res: Response) => {
  const entryId = entryIdParam(req, res);
  if (entryId === null) return;
  if (!requireExplicitConfirm(req, res)) return;
  const parsed = parseContentPatch(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const gate = await beginEvidenceWrite(req, res);
  if (!gate.ok || !gate.evidence) return;
  try {
    const actor = resolveMaintenanceActor(req);
    if (!actor) {
      await remember(gate, 401, { error: 'Unauthorized' }, res);
      return;
    }
    await markCuratorPrior(req, res, [entryId]);
    const result = await updateEntryContent(entryId, parsed.patch, {
      actor,
      reason: gate.evidence.reason,
      sources: gate.evidence.sources,
      quotes: gate.evidence.quotes,
      dryRun: req.body?.dryRun === true,
    });
    if (!result.dryRun) {
      noteCuratorChange(res, {
        subject: `PATCH /api/scan/entries/${entryId}/content`,
        old: { id: entryId },
        next: { changed: result.changed, enqueued: false, sent: false },
      });
    }
    await remember(gate, 200, result, res);
  } catch (error) {
    if (error instanceof ContentEditError) {
      await remember(gate, error.statusCode, { error: error.message }, res);
      return;
    }
    await gate.abort();
    console.error('[ContentEdit] Failed:', error);
    res.status(500).json({ error: 'Failed to edit entry content' });
  }
});

// POST /entries/:id/unwithhold — return a withheld entry to approved without enqueueing or sending.
router.post('/entries/:id/unwithhold', async (req: Request, res: Response) => {
  const entryId = entryIdParam(req, res);
  if (entryId === null) return;
  if (!requireExplicitConfirm(req, res)) return;
  const gate = await beginEvidenceWrite(req, res);
  if (!gate.ok || !gate.evidence) return;
  try {
    const actor = resolveMaintenanceActor(req);
    if (!actor) {
      await remember(gate, 401, { error: 'Unauthorized' }, res);
      return;
    }
    await markCuratorPrior(req, res, [entryId]);
    const result = await releaseWithheldEntry(entryId, {
      actor,
      reason: gate.evidence.reason,
      sources: gate.evidence.sources,
      quotes: gate.evidence.quotes,
      dryRun: req.body?.dryRun === true,
    });
    if (!result.dryRun) {
      noteCuratorChange(res, {
        subject: `POST /api/scan/entries/${entryId}/unwithhold`,
        old: { id: entryId, queue: 'withheld' },
        next: { status: 'approved', enqueued: false, sent: false },
      });
    }
    await remember(gate, 200, result, res);
  } catch (error) {
    if (error instanceof ContentEditError) {
      await remember(gate, error.statusCode, { error: error.message }, res);
      return;
    }
    await gate.abort();
    console.error('[Unwithhold] Failed:', error);
    res.status(500).json({ error: 'Failed to release withheld entry' });
  }
});

// POST /entries/:id/link-duplicate — guarded link to a recursively resolved canonical parent
router.post('/entries/:id/link-duplicate', async (req: Request, res: Response) => {
  const entryId = parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(entryId) || entryId <= 0) {
    res.status(400).json({ error: 'Invalid entry ID' });
    return;
  }
  const gate = await beginCuratorWrite(req, res, { requireQuote: false });
  if (!gate.ok) return;
  try {
    const dryRun = req.body.dryRun === true;
    await markCuratorPrior(req, res, [entryId]);
    const result = await linkEntryDuplicate(getPool(), entryId, {
      expectedStatus: req.body.expectedStatus,
      expectedSourceUrl: req.body.expectedSourceUrl,
      duplicateOfId: Number(req.body.duplicateOfId),
      actor: resolveMaintenanceActor(req),
      reason: gate.evidence?.reason || req.body.reason,
      dryRun,
    });
    if (gate.evidence && !dryRun) {
      await attachCuratorEvidence(getPool(), [entryId], gate.evidence, resolveMaintenanceActor(req));
    }
    await remember(gate, 200, { success: true, ...result }, res);
  } catch (error) {
    if (error instanceof EntryMaintenanceError) {
      await remember(gate, error.statusCode, { error: error.message }, res);
      return;
    }
    await gate.abort();
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[DuplicateLink] Failed:', error);
    res.status(500).json({ error: message });
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
  // The internal key still cannot publish. A curator token may retry a send
  // only after confirm=true, which the auth guard enforces before this handler.
  const agent = (req as any).agentSession;
  if (agent?.isAgent && !agent.curator) {
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

    await markCuratorPrior(req, res, [entryId]);
    const result = await retryDistribution(entryId, wire);
    noteCuratorChange(res, { subject: `POST /api/scan/entries/${entryId}/redistribute`, old: { id: entryId, wire }, next: { success: true } });
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
    const stored = await autoSummarizeOnApprove(
      entry.id, null, entry.name, entry.description || '', entry.amount, entry.deadline, entry.source_url, entry.wire
    );
    if (!stored) {
      res.status(502).json({ success: false, entryId, error: 'No usable summary was generated; entry left flagged' });
      return;
    }
    noteCuratorChange(res, {
      subject: `POST /api/scan/entries/${entryId}/retry-summarize`,
      old: { id: entry.id, name: entry.name },
      next: { success: true, entryId },
    });
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
          COUNT(*) FILTER (WHERE status = 'declined') AS declined_entries,
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
        COALESCE(ec.declined_entries, 0) AS declined_entries,
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
      const declinedEntries = parseInt(row.declined_entries) || 0;
      const estimatedCost = parseFloat(row.estimated_cost) || 0;
      // approvalRate stays approved / every row (duplicates included), as a percent.
      // reviewedApprovalRate is approved / (approved + declined), 0–1.
      const approvalRate = totalEntries > 0 ? Math.round((approvedEntries / totalEntries) * 1000) / 10 : 0;
      const reviewedRate = reviewedApprovalRate(approvedEntries, declinedEntries);
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
        declinedEntries,
        approvalRate,
        reviewedApprovalRate: reviewedRate,
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
      `SELECT name, wire, wire_area, quality_score, classification, scan_source,
              LEFT(description, 200) as description, source_url
       FROM scan_entries
       WHERE status = 'approved'
       ORDER BY created_at DESC LIMIT 30`
    );
    const declined = await pool.query(
      `SELECT name, wire, wire_area, quality_score, classification, scan_source,
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
