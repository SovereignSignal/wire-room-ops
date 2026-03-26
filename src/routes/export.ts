/**
 * CSV Export Routes
 *
 * GET  /csv  — direct CSV/MD file download
 * POST /csv  — generate + email CSV export on demand
 */

import { Router, Request, Response } from 'express';
import { rateLimit } from '../middleware/rate-limit';
import { config } from '../config';
import { getPool } from '../db';
import { getSchedules } from '../services/scheduler';
import { createMagicLink } from '../services/auth';
import { sendCsvExportEmail } from '../services/email';
import { runCsvExport } from '../jobs/csv-export';

const router = Router();

// GET /csv — direct CSV file download
router.get('/csv', async (req: Request, res: Response) => {
  const hoursBack = Math.min(168, Math.max(1, parseInt(req.query.hoursBack as string, 10) || 24));

  if (!rateLimit('export-csv-download', 5, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Export recently generated. Please wait a few minutes.' });
    return;
  }

  const format = (req.query.format as string)?.toLowerCase() === 'md' ? 'md' : 'csv';

  try {
    const pool = getPool();
    const result = await runCsvExport(pool, hoursBack);
    if (result.entryCount === 0) {
      res.status(200).json({ success: true, message: 'No approved entries in the specified timeframe', entryCount: 0 });
      return;
    }
    const dateStr = new Date().toISOString().slice(0, 10);
    if (format === 'md') {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="wireops-export-${dateStr}.md"`);
      res.send(result.markdownContent);
    } else {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="wireops-export-${dateStr}.csv"`);
      res.send(result.csvContent);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Export] Download failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// POST /csv — generate + email CSV export on demand
router.post('/csv', async (req: Request, res: Response) => {
  const hoursBack = Math.min(168, Math.max(1, parseInt(req.body?.hoursBack, 10) || 24));

  if (!rateLimit('export-csv-email', 3, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Export email recently sent. Please wait a few minutes.' });
    return;
  }

  try {
    const pool = getPool();
    const result = await runCsvExport(pool, hoursBack);
    if (result.entryCount === 0) {
      res.json({ success: true, message: 'No approved entries in the specified timeframe', entryCount: 0 });
      return;
    }

    // Build download links
    const email = config.email.notificationEmail;
    const downloadUrls = {
      csv: result.csvFileId ? createMagicLink(email, result.csvFileId) : null,
      md: result.mdFileId ? createMagicLink(email, result.mdFileId) : null,
    };

    // Resolve recipients from any daily-digest schedule's notifyEmails
    let recipients: string[] | undefined;
    try {
      const schedules = await getSchedules();
      const digestSchedule = schedules.find(s => s.scheduleType === 'daily-digest');
      if (digestSchedule?.notifyEmails) {
        recipients = digestSchedule.notifyEmails.split(',').map(e => e.trim()).filter(Boolean);
      }
    } catch { /* fall back to default notification email */ }

    await sendCsvExportEmail(result, downloadUrls, recipients);
    res.json({ success: true, entryCount: result.entryCount, wires: result.wires });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Export] CSV email failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

export { router as exportRouter };
