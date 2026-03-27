/**
 * Background Job Trigger Routes
 *
 * POST /summary-sync         — manual trigger for tele-sum summary sync
 * POST /process-raw          — manual trigger for dedup+score raw entries
 * POST /enrich               — enrich queued entries with thin descriptions
 * POST /scan/classify-queue  — batch-classify queued entries with Grok LLM
 * POST /telegram/intake-webhook — Telegram intake bot webhook (NO auth — validated by secret)
 *
 * SSE:
 * GET  /job/:jobId/progress  — SSE endpoint for job progress
 */

import { Router, Request, Response } from 'express';
import { config } from '../config';
import { rateLimit } from '../middleware/rate-limit';
import { requireAuth } from '../middleware/auth';
import { jobQueue } from '../services/job-queue';
import { getPool } from '../db';
import { syncSummariesToScanEntries } from '../jobs/summary-sync';
import { processRawEntries } from '../jobs/process-raw';
import { runEnrichment } from '../jobs/enrichment';
import { handleTelegramUpdate } from '../services/telegram-adapter';

const router = Router();

// SSE endpoint for job progress (auth required)
router.get('/job/:jobId/progress', requireAuth, (req: Request, res: Response) => {
  const { jobId } = req.params;
  const job = jobQueue.getJob(jobId);

  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send keepalive comment every 30s to prevent proxy timeouts
  const keepalive = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      clearInterval(keepalive);
    }
  }, 30_000);

  // Subscribe to job updates
  const unsubscribe = jobQueue.subscribe(jobId, (status) => {
    res.write(`data: ${JSON.stringify(status)}\n\n`);

    // Close connection when job is complete or failed
    if (status.status === 'completed' || status.status === 'failed') {
      clearInterval(keepalive);
      setTimeout(() => {
        res.end();
      }, 100);
    }
  });

  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(keepalive);
    unsubscribe();
  });
});

// API: Manual trigger for summary sync (tele-sum summaries -> scan_entries)
router.post('/summary-sync', requireAuth, async (_req: Request, res: Response) => {
  if (!rateLimit('summary-sync', 3, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Summary sync recently run. Please wait 5 minutes.' });
    return;
  }

  try {
    const pool = getPool();
    const result = await syncSummariesToScanEntries(pool);
    res.json({ success: true, ...result });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[SummarySync] Manual trigger failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// API: Manual trigger for process-raw (dedup+score raw entries)
router.post('/process-raw', requireAuth, async (_req: Request, res: Response) => {
  if (!rateLimit('process-raw', 3, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Process-raw recently run. Please wait 5 minutes.' });
    return;
  }

  try {
    const pool = getPool();
    const result = await processRawEntries(pool);
    res.json({ success: true, ...result });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[ProcessRaw] Manual trigger failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// API: Enrich queued entries with thin descriptions
router.post('/enrich', requireAuth, async (req: Request, res: Response) => {
  if (!rateLimit('enrich', 3, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Enrichment recently run. Please wait 5 minutes.' });
    return;
  }

  try {
    const wire = req.body?.wire as string | undefined;
    const result = await runEnrichment(wire);
    res.json({ success: true, ...result });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Enrichment] Manual trigger failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// API: Batch-classify queued entries with Grok LLM (Gate 2)
router.post('/scan/classify-queue', requireAuth, async (req: Request, res: Response) => {
  if (!rateLimit('classify-queue', 3, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Classification recently run. Please wait a few minutes.' });
    return;
  }

  try {
    const pool = getPool();
    const wire = req.body?.wire as string | undefined;

    const conditions = [`status IN ('queued', 'approved')`, `(classification IS NULL OR classification = 'UNCHECKED')`];
    const values: any[] = [];
    let paramIndex = 1;

    if (wire) {
      conditions.push(`wire = $${paramIndex++}`);
      values.push(wire);
    }

    const result = await pool.query(
      `SELECT id, name, description, source_url, wire FROM scan_entries
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT 200`,
      values
    );

    if (result.rows.length === 0) {
      res.json({ classified: 0, errors: 0, durationMs: 0 });
      return;
    }

    const { classifyBatch } = await import('../services/classifier');
    const start = Date.now();
    const stats = await classifyBatch(result.rows, pool);
    const durationMs = Date.now() - start;

    res.json({ ...stats, durationMs });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[ClassifyQueue] Failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// API: Telegram intake webhook (no auth — validated by secret header)
router.post('/telegram/intake-webhook', async (req: Request, res: Response) => {
  const secret = config.telegramIntake.webhookSecret;

  // Reject ALL calls if webhook secret is not configured
  if (!secret) {
    res.status(401).json({ error: 'Webhook not configured' });
    return;
  }

  // Validate the secret header
  if (req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    console.warn('[TelegramIntake] Webhook called with invalid secret');
    res.sendStatus(200);
    return;
  }

  // Fire and forget — respond immediately
  handleTelegramUpdate(req.body).catch(err => {
    console.error('[TelegramIntake] Handler error:', err);
  });

  res.sendStatus(200);
});

export { router as jobRouter };
