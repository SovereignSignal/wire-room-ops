/**
 * Admin Routes
 *
 * POST /run-migration       — one-time data cleanup
 * POST /recover-self-dupes  — recover self-duplicated entries
 * POST /clean-stale-seen    — remove stale dedup records for archived entries
 * POST /purge-source        — delete all entries from a scan_source
 * POST /classify-backfill   — batch-classify UNCHECKED entries
 * POST /tag-backfill        — batch-extract entity tags for entries missing them
 * POST /summary-sync-backfill — historical Telegram summary import
 * POST /cohort-bridge        — run the Notion cohort bridge (heartbeat + backfill)
 * POST /close-expired-calls  — close open calls past their deadline (dry run unless apply=true)
 * POST /clean-orgs          — archive junk org profiles (+ matching Notion pages)
 * POST /dedup-orgs          — merge duplicate org profiles
 * POST /enrich-orgs         — LLM-based org profile enrichment
 * POST /discover-contacts   — LLM-based contact discovery (org + content sources)
 */

import { Router, Request, Response } from 'express';
import { rateLimit } from '../middleware/rate-limit';
import { getPool } from '../db';
import { syncSummariesToScanEntries } from '../jobs/summary-sync';
import { enrichBatch, computeDerivedFields } from '../services/org-enricher';
import { purgeSourceEntries } from '../services/source-purge';

const router = Router();

// POST /run-migration — one-time data cleanup for existing bad entries
router.post('/run-migration', async (_req: Request, res: Response) => {
  if (!rateLimit('admin-migration', 1, 30 * 60 * 1000)) {
    res.status(429).json({ error: 'Migration recently run. Please wait 30 minutes.' });
    return;
  }

  try {
    const { runDataCleanup } = await import('../migrations/cleanup-approved-data');
    const pool = getPool();
    const result = await runDataCleanup(pool);
    res.json(result);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Migration] Data cleanup failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// POST /contacts-sync — reconcile the Notion Contacts DB → people-monitor
router.post('/contacts-sync', async (_req: Request, res: Response) => {
  if (!rateLimit('contacts-sync', 3, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Recently run. Please wait a few minutes.' });
    return;
  }
  try {
    const { runContactsSync } = await import('../jobs/contacts-sync');
    const result = await runContactsSync(getPool());
    res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    console.error('[Admin] contacts-sync error:', error);
    res.status(500).json({ error: 'Contacts sync failed' });
  }
});

// POST /recover-self-dupes — recover entries where duplicate_of_id = own id
router.post('/recover-self-dupes', async (req: Request, res: Response) => {
  if (!rateLimit('recover-self-dupes', 1, 10 * 60 * 1000)) {
    res.status(429).json({ error: 'Recently run. Please wait 10 minutes.' });
    return;
  }
  try {
    const pool = getPool();
    // Find entries that were marked as duplicates of themselves
    const selfDupes = await pool.query(
      `SELECT id FROM scan_entries WHERE status = 'duplicate' AND duplicate_of_id = id`
    );
    if (selfDupes.rows.length === 0) {
      res.json({ recovered: 0, message: 'No self-duplicated entries found' });
      return;
    }
    const ids = selfDupes.rows.map((r: { id: number }) => r.id);
    // Clean up seen_urls and seen_names so reprocessing doesn't re-duplicate
    await pool.query(`DELETE FROM seen_urls WHERE first_seen_entry_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM seen_names WHERE entry_id = ANY($1)`, [ids]);
    // Reset to raw so processRawEntries can reprocess correctly
    await pool.query(
      `UPDATE scan_entries SET status = 'raw', duplicate_of_id = NULL, duplicate_reason = NULL WHERE id = ANY($1)`,
      [ids]
    );
    console.log(`[Admin] Recovered ${ids.length} self-duplicated entries: ${ids.join(', ')}`);
    res.json({ recovered: ids.length, ids });
  } catch (error) {
    console.error('[Admin] recover-self-dupes error:', error);
    res.status(500).json({ error: 'Recovery failed' });
  }
});

// POST /clean-stale-seen — remove stale seen records for archived entries
router.post('/clean-stale-seen', async (req: Request, res: Response) => {
  if (!rateLimit('clean-stale-seen', 1, 10 * 60 * 1000)) {
    res.status(429).json({ error: 'Recently run. Please wait 10 minutes.' });
    return;
  }
  try {
    const pool = getPool();
    // Find archived entries that have seen_names/seen_urls records (should never happen with the fix)
    const staleNames = await pool.query(
      `DELETE FROM seen_names WHERE entry_id IN (
        SELECT id FROM scan_entries WHERE status = 'archived'
      ) RETURNING entry_id`
    );
    const staleUrls = await pool.query(
      `DELETE FROM seen_urls WHERE first_seen_entry_id IN (
        SELECT id FROM scan_entries WHERE status = 'archived'
      ) RETURNING first_seen_entry_id`
    );
    const cleanedNames = staleNames.rowCount || 0;
    const cleanedUrls = staleUrls.rowCount || 0;
    console.log(`[Admin] Cleaned stale seen records: ${cleanedNames} names, ${cleanedUrls} urls`);
    res.json({ cleanedNames, cleanedUrls });
  } catch (error) {
    console.error('[Admin] clean-stale-seen error:', error);
    res.status(500).json({ error: 'Cleanup failed' });
  }
});

// POST /purge-source — delete all entries from a given scan_source
router.post('/purge-source', async (req: Request, res: Response) => {
  if (!rateLimit('purge-source', 1, 30 * 60 * 1000)) {
    res.status(429).json({ error: 'Recently run. Please wait 30 minutes.' });
    return;
  }

  const { source } = req.body;
  if (!source || typeof source !== 'string') {
    res.status(400).json({ error: 'source is required (e.g. "forum", "telegram")' });
    return;
  }

  try {
    const result = await purgeSourceEntries(getPool(), source);
    if (result.deleted === 0) {
      res.json({ deleted: 0, message: `No entries found with scan_source = '${source}'` });
      return;
    }
    console.log(`[Admin] Purged ${result.deleted} entries with scan_source='${source}' and repaired ${result.programsRepaired} programs`);
    res.json(result);
  } catch (error) {
    console.error('[Admin] purge-source error:', error);
    res.status(500).json({ error: 'Purge failed' });
  }
});

// POST /classify-backfill — batch-classify UNCHECKED queue entries
router.post('/classify-backfill', async (req: Request, res: Response) => {
  if (!rateLimit('classify-backfill', 3, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Backfill recently run. Please wait a few minutes.' });
    return;
  }

  try {
    const pool = getPool();
    const limit = Math.min(Math.max(Number(req.body?.limit) || 50, 1), 200);

    const result = await pool.query(
      `SELECT id, name, description, source_url, wire, amount,
              deadline_parsed AS "deadlineParsed",
              source_published_at AS "sourcePublishedAt"
       FROM scan_entries
       WHERE classification = 'UNCHECKED' AND status = 'queued'
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );

    if (result.rows.length === 0) {
      res.json({ processed: 0, classified: 0, errors: 0 });
      return;
    }

    const { classifyBatch } = await import('../services/classifier');
    const stats = await classifyBatch(result.rows, pool);

    res.json({ processed: result.rows.length, ...stats });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[ClassifyBackfill] Failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// POST /tag-backfill — batch-extract entity tags for entries missing them
router.post('/tag-backfill', async (req: Request, res: Response) => {
  if (!rateLimit('tag-backfill', 3, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Tag backfill recently run. Please wait a few minutes.' });
    return;
  }

  try {
    const pool = getPool();
    const limit = Math.min(Math.max(Number(req.body?.limit) || 100, 1), 500);

    const result = await pool.query(
      `SELECT id, name, description, wire FROM scan_entries
       WHERE (tags IS NULL OR tags = '{}') AND status IN ('queued', 'approved')
       ORDER BY status DESC, created_at DESC
       LIMIT $1`,
      [limit]
    );

    if (result.rows.length === 0) {
      res.json({ processed: 0, tagged: 0, errors: 0 });
      return;
    }

    const { tagBatch } = await import('../services/classifier');
    const stats = await tagBatch(result.rows, pool);

    res.json({ processed: result.rows.length, ...stats });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[TagBackfill] Failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// POST /summary-sync-backfill — historical Telegram summary import
router.post('/summary-sync-backfill', async (req: Request, res: Response) => {
  if (!rateLimit('summary-sync-backfill', 1, 30 * 60 * 1000)) {
    res.status(429).json({ error: 'Backfill recently run. Please wait 30 minutes.' });
    return;
  }

  try {
    const pool = getPool();
    const requestedHours = typeof req.body?.lookbackHours === 'number' ? req.body.lookbackHours : 8760;
    const lookbackHours = Math.min(Math.max(1, requestedHours), 17520); // Cap at 2 years
    console.log(`[SummarySync] Backfill triggered with lookbackHours=${lookbackHours}`);
    const result = await syncSummariesToScanEntries(pool, lookbackHours);
    res.json({ success: true, lookbackHours, ...result });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[SummarySync] Backfill failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// POST /cohort-bridge — ingest the Cowork+Codex Notion table and stamp source_runs
router.post('/cohort-bridge', async (req: Request, res: Response) => {
  if (!rateLimit('cohort-bridge', 1, 10 * 60 * 1000)) {
    res.status(429).json({ error: 'Cohort bridge recently ran. Please wait 10 minutes.' });
    return;
  }

  try {
    const { runCohortBridge } = await import('../jobs/cohort-bridge');
    const dryRun = req.body?.dryRun === true;
    console.log(`[Admin] Cohort bridge triggered (dryRun=${dryRun})`);
    const result = await runCohortBridge(getPool(), { dryRun });
    res.status(result.ok || result.skipped ? 200 : 500).json(result);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Admin] Cohort bridge failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// POST /close-expired-calls — mark past-deadline open calls closed (dry run unless apply=true)
router.post('/close-expired-calls', async (req: Request, res: Response) => {
  const dryRun = req.body?.apply !== true;
  if (!rateLimit(dryRun ? 'close-expired-calls-dry' : 'close-expired-calls', 6, 15 * 60 * 1000)) {
    res.status(429).json({ error: 'Open-call expiry recently ran. Please wait a few minutes.' });
    return;
  }
  try {
    const { closeExpiredOpenCalls } = await import('../services/open-call-expiry');
    res.json(await closeExpiredOpenCalls(getPool(), { dryRun }));
  } catch (error) {
    console.error('[Admin] Open-call expiry failed:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// POST /clean-orgs — archive junk org profiles (+ matching Notion pages)
router.post('/clean-orgs', async (req: Request, res: Response) => {
  const dryRun = req.body?.dryRun === true;
  if (!rateLimit(dryRun ? 'clean-orgs-dry' : 'clean-orgs', 1, 30 * 60 * 1000)) {
    res.status(429).json({ error: 'Cleanup recently run. Please wait 30 minutes.' });
    return;
  }

  try {
    const { runOrgCleanup } = await import('../migrations/cleanup-org-profiles');
    const pool = getPool();
    const result = await runOrgCleanup(pool, { dryRun });
    res.json(result);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Admin] Org cleanup failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// POST /dedup-orgs — LLM-powered org deduplication
router.post('/dedup-orgs', async (_req: Request, res: Response) => {
  if (!rateLimit('dedup-orgs', 1, 30 * 60 * 1000)) {
    res.status(429).json({ error: 'Dedup recently run. Please wait 30 minutes.' });
    return;
  }

  try {
    const { runOrgDedup } = await import('../migrations/dedup-org-profiles');
    const pool = getPool();
    const result = await runOrgDedup(pool);
    res.json(result);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Admin] Org dedup failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// POST /enrich-orgs — batch-enrich org profiles via LLM
router.post('/enrich-orgs', async (req: Request, res: Response) => {
  if (!rateLimit('enrich-orgs', 1, 10 * 60 * 1000)) {
    res.status(429).json({ error: 'Enrichment recently run. Please wait 10 minutes.' });
    return;
  }

  try {
    const limit = Math.min(Math.max(Number(req.body?.limit) || 50, 1), 200);
    const force = req.body?.force === true;
    const result = await enrichBatch({ force, limit });
    // Also recompute derived fields after enrichment
    const derived = await computeDerivedFields();
    res.json({ ...result, derivedFieldsUpdated: derived.updated });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Admin] Org enrichment failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

// POST /sync-crm — push org_profiles rows to the SimpleCRM Notion DB
router.post('/sync-crm', async (_req: Request, res: Response) => {
  if (!rateLimit('sync-crm', 3, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Recently run. Please wait a few minutes.' });
    return;
  }

  try {
    const { getIntegrationConfigs, syncOrgsToNotion } = await import('../services/notion-sync');
    const crm = (await getIntegrationConfigs('notion')).find(
      (i) => i.name === 'SimpleCRM - Notion' && i.enabled
    );
    if (!crm) {
      res.status(404).json({ success: false, error: 'SimpleCRM integration not found/enabled' });
      return;
    }
    const result = await syncOrgsToNotion(crm.id);
    res.json({ success: true, ...result });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Admin] sync-crm failed:', error);
    res.status(500).json({ success: false, error: errorMsg });
  }
});

// POST /discover-contacts — discover contacts via Grok web_search (org + content sources)
router.post('/discover-contacts', async (req: Request, res: Response) => {
  if (!rateLimit('discover-contacts', 1, 10 * 60 * 1000)) {
    res.status(429).json({ error: 'Discovery recently run. Please wait 10 minutes.' });
    return;
  }

  try {
    const limit = Math.min(Math.max(Number(req.body?.limit || req.query['limit']) || 20, 1), 50);
    const { runContactDiscovery } = await import('../services/contact-discovery');
    const result = await runContactDiscovery(getPool(), { limit });
    res.json({ success: true, ...result });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Admin] Contact discovery failed:', error);
    res.status(500).json({ error: errorMsg });
  }
});

export { router as adminRouter };
