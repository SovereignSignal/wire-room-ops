/**
 * Org Profiles API Routes
 *
 * GET    /api/orgs           — list org profiles
 * GET    /api/orgs/:id       — get single org with linked entries
 * POST   /api/orgs/extract   — run org extraction
 * POST   /api/orgs/merge     — merge two orgs (source into target)
 * DELETE  /api/orgs/:id       — archive (delete) an org
 */

import { Router, Request, Response } from 'express';
import { runOrgExtraction, getOrgProfiles, getOrgById, getEntriesByOrg } from '../services/org-extractor';
import { mergeOrgs, archiveOrg } from '../services/org-merge';

const router = Router();

// GET / — List org profiles
router.get('/', async (req: Request, res: Response) => {
  try {
    const wire = req.query.wire as string | undefined;
    const search = req.query.search as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const { orgs, total } = await getOrgProfiles({ wire, search, limit, offset });
    res.json({ orgs, total });
  } catch (err) {
    console.error('[API] Failed to list orgs:', err);
    res.status(500).json({ error: 'Failed to list organizations' });
  }
});

// GET /:id — Get single org with linked entries
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const orgId = parseInt(req.params.id, 10);
    if (isNaN(orgId)) { res.status(400).json({ error: 'Invalid org ID' }); return; }
    const org = await getOrgById(orgId);
    if (!org) { res.status(404).json({ error: 'Org not found' }); return; }
    const entries = await getEntriesByOrg(orgId);
    res.json({ org, entries });
  } catch (err) {
    console.error('[API] Failed to get org:', err);
    res.status(500).json({ error: 'Failed to get organization' });
  }
});

// POST /extract — Run org extraction
router.post('/extract', async (req: Request, res: Response) => {
  try {
    const stats = await runOrgExtraction();
    res.json({ success: true, ...stats });
  } catch (err) {
    console.error('[API] Org extraction failed:', err);
    res.status(500).json({ error: 'Org extraction failed' });
  }
});

// POST /merge — Merge two orgs (source into target)
router.post('/merge', async (req: Request, res: Response) => {
  try {
    const { sourceId, targetId } = req.body;
    const sId = parseInt(sourceId, 10);
    const tId = parseInt(targetId, 10);
    if (isNaN(sId) || isNaN(tId)) {
      res.status(400).json({ error: 'sourceId and targetId must be valid integers' });
      return;
    }
    const result = await mergeOrgs(sId, tId);
    res.json({ success: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[API] Org merge failed:', err);
    res.status(500).json({ error: msg });
  }
});

// DELETE /:id — Archive (delete) an org
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const orgId = parseInt(req.params.id, 10);
    if (isNaN(orgId)) { res.status(400).json({ error: 'Invalid org ID' }); return; }
    const result = await archiveOrg(orgId);
    res.json({ success: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[API] Org archive failed:', err);
    res.status(500).json({ error: msg });
  }
});

export { router as orgRouter };
