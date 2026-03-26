/**
 * Scan Entry Routes
 *
 * GET    /entries                — query entries with filters (status, wire, date, etc.)
 * POST   /submit                — single entry submission
 * POST   /submit-batch          — batch submission
 * GET    /queue                  — list queued entries
 * GET    /stats                  — scan pipeline statistics
 * GET    /status-counts          — count by status
 * GET    /seen-urls              — URL dedup stats
 * GET    /prompt-stats           — prompt effectiveness
 * PATCH  /entries/:id/wire       — reassign wire
 * POST   /entries/bulk-action    — bulk approve/decline/reviewlater/restore
 * POST   /entries/:id/action     — single entry action
 * GET    /entries/:id/distribution — distribution logs for single entry
 * POST   /entries/:id/redistribute — retry failed distribution
 */

import { Router, Request, Response } from 'express';
import { getPool, getAllFeeds, getAvailableWires, getEntriesByStatus, getStatusCounts, getSeenUrlStats, getSeenUrlsList, getDistributionLogs, getDistributionStatusForEntries } from '../db';
import { rateLimit } from '../middleware/rate-limit';
import { isValidUuid, isValidFeedKey } from '../utils/validation';
import { buildSubmission, buildBatchSubmission } from '../services/intake';
import { runDailyIntake, getDailyQueue, getIntakeStats } from '../jobs/daily-intake';
import { getPromptEffectivenessStats } from '../services/scan-stats';
import { singleEntryAction, bulkEntryAction, ApprovalBlockedError, BulkApprovalBlockedError } from '../services/entry-actions';
import { retryDistribution } from '../services/distribution';

const router = Router();

// POST /submit — single entry submission
router.post('/submit', async (req: Request, res: Response) => {
  const { wire, promptVariant, scanDate, rawText, source } = req.body;

  try {
    // Validate wire against feeds table
    const feeds = await getAllFeeds();
    const validKeys = feeds.map(f => f.key);
    if (!wire || !validKeys.includes(wire)) {
      res.status(400).json({ error: `Invalid wire "${wire}". Valid: ${validKeys.join(', ')}` });
      return;
    }
    if (!promptVariant || !['A', 'B', 'C'].includes(promptVariant)) {
      res.status(400).json({ error: 'promptVariant must be A, B, or C' });
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

    const submission = buildSubmission(
      rawText,
      wire,
      promptVariant,
      scanDate,
      source || 'x-scan'
    );

    const pool = getPool();
    const summary = await runDailyIntake(pool, [submission]);

    res.json({ success: true, summary });
  } catch (error) {
    console.error('Scan submit failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// POST /submit-batch — batch submission
router.post('/submit-batch', async (req: Request, res: Response) => {
  const { wire, scanDate, rawText, source } = req.body;

  try {
    const feeds = await getAllFeeds();
    const validKeys = feeds.map(f => f.key);
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

// GET /status-counts — count by status
router.get('/status-counts', async (req: Request, res: Response) => {
  try {
    const wire = req.query.wire as string | undefined;
    const date = req.query.date as string | undefined;
    const promptId = req.query.promptId as string | undefined;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
      return;
    }
    if (promptId && !isValidUuid(promptId)) {
      res.status(400).json({ error: 'Invalid promptId format.' });
      return;
    }

    const [counts, urlStats] = await Promise.all([
      getStatusCounts(wire, date, promptId),
      getSeenUrlStats(wire),
    ]);

    res.json({ counts, seededUrls: urlStats.seededCount, totalUrls: urlStats.totalCount });
  } catch (error) {
    console.error('Failed to fetch status counts:', error);
    res.status(500).json({ error: 'Failed to fetch status counts' });
  }
});

// GET /seen-urls — URL dedup stats
router.get('/seen-urls', async (req: Request, res: Response) => {
  try {
    const wire = req.query.wire as string | undefined;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 50, 1), 500);
    const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

    const { urls, total } = await getSeenUrlsList({ wire, limit, offset });
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

    let { entries, total } = await getEntriesByStatus(statuses, { wire, date, promptId, limit, offset, minScore, excludeSources });

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

// POST /entries/bulk-action — bulk approve/decline/reviewlater/restore
router.post('/entries/bulk-action', async (req: Request, res: Response) => {
  const { ids, action, quiet } = req.body;

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
    const result = await bulkEntryAction(entryIds, action, {
      quiet: !!quiet,
      force: req.query.force === 'true',
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

  const { action, quiet } = req.body;

  try {
    const result = await singleEntryAction(entryId, action, {
      quiet: !!quiet,
      force: req.query.force === 'true',
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
    const result = await pool.query(
      `UPDATE scan_entries SET wire = $1, wires = $2, updated_at = NOW() WHERE id = $3 RETURNING id, wire, wires`,
      [primaryWire, wireArray, entryId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }

    res.json({ success: true, wire: result.rows[0].wire, wires: result.rows[0].wires });
  } catch (error) {
    console.error('Failed to update entry wire:', error);
    res.status(500).json({ error: 'Failed to update wire' });
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

export const scanEntryRouter = router;
