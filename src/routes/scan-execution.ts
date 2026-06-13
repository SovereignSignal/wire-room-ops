/**
 * Scan Execution Routes
 *
 * POST /scan/run   — trigger automated scan execution (async with SSE progress)
 * POST /forum/run  — trigger forum scan via discuss.watch (async with SSE progress)
 */

import { Router, Request, Response } from 'express';
import { config } from '../config';
import { rateLimit } from '../middleware/rate-limit';
import { jobQueue } from '../services/job-queue';
import { getPool } from '../db';
import { runScanExecution } from '../jobs/scan-execution';
import { runForumScan } from '../jobs/forum-scan';
import { runSourceFeeds } from '../jobs/source-feeds';
import { sendScanDigestEmail } from '../services/email';

const router = Router();

// Running job trackers to prevent concurrent execution
let runningScanJobId: string | null = null;
let runningForumJobId: string | null = null;
let runningFeedsJobId: string | null = null;

// API: Trigger automated scan execution (async with SSE progress)
router.post('/scan/run', async (req: Request, res: Response) => {
  if (!rateLimit('scan-run', 1, 15 * 60 * 1000)) {
    res.status(429).json({ error: 'Scan already running or recently completed. Please wait 15 minutes between scans.' });
    return;
  }

  // Prevent concurrent scan jobs
  if (runningScanJobId) {
    const existingJob = jobQueue.getJob(runningScanJobId);
    if (existingJob && existingJob.status === 'running') {
      res.status(409).json({ error: 'A scan job is already running', jobId: runningScanJobId });
      return;
    }
    runningScanJobId = null;
  }

  const { wire } = req.body;
  const pool = getPool();

  const jobId = jobQueue.createJob();
  runningScanJobId = jobId;
  res.json({ jobId });

  (async () => {
    jobQueue.updateJob(jobId, { status: 'running' });

    try {
      const result = await runScanExecution(pool, {
        wire: wire || undefined,
        onProgress: (message, pct) => {
          jobQueue.updateProgress(jobId, {
            current: pct,
            total: 100,
            step: message,
          });
        },
      });

      jobQueue.completeJob(jobId, result);

      // Send digest email for manual scans too
      if (result.totalResults > 0) {
        try {
          await sendScanDigestEmail(result, config.app.url);
          console.log(`[ScanRun] Digest email sent`);
        } catch (emailErr) {
          console.error(`[ScanRun] Failed to send digest email:`, emailErr);
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      jobQueue.failJob(jobId, errorMsg);
    } finally {
      runningScanJobId = null;
      jobQueue.cleanup();
    }
  })().catch(error => {
    console.error('Unexpected error in scan runner:', error);
    runningScanJobId = null;
  });
});

// API: Trigger forum scan via discuss.watch (async with SSE progress)
router.post('/forum/run', async (req: Request, res: Response) => {
  if (!config.forum.enabled) {
    res.status(400).json({ error: 'Forum scanning is not enabled. Set FORUM_SCAN_ENABLED=true to enable.' });
    return;
  }

  // Check concurrent first (does not consume rate limit token)
  if (runningForumJobId) {
    const existingJob = jobQueue.getJob(runningForumJobId);
    if (existingJob && existingJob.status === 'running') {
      res.status(409).json({ error: 'A forum scan job is already running', jobId: runningForumJobId });
      return;
    }
    runningForumJobId = null;
  }

  if (!rateLimit('forum-run', 1, 15 * 60 * 1000)) {
    res.status(429).json({ error: 'Forum scan recently completed. Please wait 15 minutes.' });
    return;
  }

  const { wire } = req.body;
  const pool = getPool();

  const jobId = jobQueue.createJob();
  runningForumJobId = jobId;
  res.json({ jobId });

  (async () => {
    jobQueue.updateJob(jobId, { status: 'running' });

    try {
      const result = await runForumScan(pool, {
        wire: wire || undefined,
        onProgress: (message, pct) => {
          jobQueue.updateProgress(jobId, {
            current: pct,
            total: 100,
            step: message,
          });
        },
      });

      jobQueue.completeJob(jobId, result);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      jobQueue.failJob(jobId, errorMsg);
    } finally {
      runningForumJobId = null;
      jobQueue.cleanup();
    }
  })().catch(error => {
    console.error('Unexpected error in forum scan runner:', error);
    runningForumJobId = null;
  });
});

// API: Trigger source-feeds ingest (aggregators + foundation portals + funder feeds)
router.post('/feeds/run', async (req: Request, res: Response) => {
  if (runningFeedsJobId) {
    const existingJob = jobQueue.getJob(runningFeedsJobId);
    if (existingJob && existingJob.status === 'running') {
      res.status(409).json({ error: 'A source-feeds job is already running', jobId: runningFeedsJobId });
      return;
    }
    runningFeedsJobId = null;
  }

  if (!rateLimit('feeds-run', 1, 10 * 60 * 1000)) {
    res.status(429).json({ error: 'Source feeds recently ran. Please wait 10 minutes.' });
    return;
  }

  const { wire, sourceKeys } = req.body;
  const pool = getPool();

  const jobId = jobQueue.createJob();
  runningFeedsJobId = jobId;
  res.json({ jobId });

  (async () => {
    jobQueue.updateJob(jobId, { status: 'running' });
    try {
      const result = await runSourceFeeds(pool, {
        wire: wire || undefined,
        sourceKeys: Array.isArray(sourceKeys) && sourceKeys.length ? sourceKeys : undefined,
        onProgress: (message, pct) => jobQueue.updateProgress(jobId, { current: pct, total: 100, step: message }),
      });
      jobQueue.completeJob(jobId, result);
    } catch (error) {
      jobQueue.failJob(jobId, error instanceof Error ? error.message : 'Unknown error');
    } finally {
      runningFeedsJobId = null;
      jobQueue.cleanup();
    }
  })().catch(error => {
    console.error('Unexpected error in source-feeds runner:', error);
    runningFeedsJobId = null;
  });
});

export { router as scanExecutionRouter };
