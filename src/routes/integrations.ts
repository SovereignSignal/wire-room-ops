/**
 * Integrations API Routes (Notion CRM Sync)
 *
 * GET    /api/integrations              — list all integrations
 * GET    /api/integrations/:id          — get single integration
 * POST   /api/integrations              — create integration
 * PUT    /api/integrations/:id          — update integration
 * DELETE /api/integrations/:id          — delete integration
 * POST   /api/integrations/:id/validate — validate Notion token + database
 * POST   /api/integrations/:id/sync     — trigger CRM sync
 */

import { Router, Request, Response } from 'express';
import { getIntegrationConfigs, getIntegrationById, upsertIntegration, updateIntegration, deleteIntegration, validateNotionToken, validateNotionDatabase, syncOrgsToNotion } from '../services/notion-sync';
import { noteCuratorChange } from '../services/curator-audit';

const router = Router();

// GET / — list all integrations
router.get('/', async (req: Request, res: Response) => {
  try {
    const provider = req.query.provider as string | undefined;
    const configs = await getIntegrationConfigs(provider);
    // Mask token
    const masked = configs.map(c => ({
      ...c,
      config: {
        ...c.config,
        notion_token: c.config.notion_token ? '****' + c.config.notion_token.slice(-4) : '',
      },
    }));
    res.json(masked);
  } catch (err) {
    console.error('[API] Failed to list integrations:', err);
    res.status(500).json({ error: 'Failed to list integrations' });
  }
});

// GET /:id — get single integration
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const config = await getIntegrationById(id);
    if (!config) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({
      ...config,
      config: {
        ...config.config,
        notion_token: config.config.notion_token ? '****' + config.config.notion_token.slice(-4) : '',
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get integration' });
  }
});

// POST / — create integration
router.post('/', async (req: Request, res: Response) => {
  try {
    const { provider = 'notion', name, enabled = false, config: configData } = req.body;
    if (!name) { res.status(400).json({ error: 'name is required' }); return; }
    const result = await upsertIntegration(provider, name, enabled, configData || {});
    noteCuratorChange(res, { subject: 'POST /api/integrations', old: null, next: result });
    res.json({
      ...result,
      config: {
        ...result.config,
        notion_token: result.config.notion_token ? '****' + result.config.notion_token.slice(-4) : '',
      },
    });
  } catch (err) {
    console.error('[API] Failed to create integration:', err);
    res.status(500).json({ error: 'Failed to create integration' });
  }
});

// PUT /:id — update integration
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { enabled, config: configData } = req.body;

    // Merge config — don't overwrite token if not provided
    const existing = await getIntegrationById(id);
    if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

    const mergedConfig = configData
      ? { ...existing.config, ...configData }
      : undefined;

    // If token is masked, keep the existing one
    if (mergedConfig?.notion_token?.startsWith('****')) {
      mergedConfig.notion_token = existing.config.notion_token;
    }

    const result = await updateIntegration(id, { enabled, config: mergedConfig });
    noteCuratorChange(res, { subject: `PUT /api/integrations/${id}`, old: existing, next: result });
    res.json({
      ...result,
      config: {
        ...result.config,
        notion_token: result.config.notion_token ? '****' + result.config.notion_token.slice(-4) : '',
      },
    });
  } catch (err) {
    console.error('[API] Failed to update integration:', err);
    res.status(500).json({ error: 'Failed to update integration' });
  }
});

// DELETE /:id — delete integration
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await getIntegrationById(id);
    await deleteIntegration(id);
    noteCuratorChange(res, { subject: `DELETE /api/integrations/${id}`, old: existing, next: { deleted: true } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete integration' });
  }
});

// POST /:id/validate — validate Notion token + database
router.post('/:id/validate', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const integration = await getIntegrationById(id);
    if (!integration) { res.status(404).json({ error: 'Not found' }); return; }

    const token = integration.config.notion_token;
    if (!token) { res.json({ valid: false, error: 'No token configured' }); return; }

    // Validate token
    const tokenResult = await validateNotionToken(token);
    if (!tokenResult.valid) {
      res.json({ valid: false, error: `Token invalid: ${tokenResult.error}` });
      return;
    }

    // Validate database if configured
    const dbId = integration.config.database_id;
    if (dbId) {
      const dbResult = await validateNotionDatabase(token, dbId);
      if (!dbResult.valid) {
        res.json({ valid: false, error: `Database not accessible: ${dbResult.error}`, workspace: tokenResult.workspace });
        return;
      }
      res.json({
        valid: true,
        workspace: tokenResult.workspace,
        database: dbResult.title,
        properties: dbResult.properties,
      });
    } else {
      res.json({ valid: true, workspace: tokenResult.workspace, database: null });
    }
  } catch (err) {
    res.status(500).json({ error: 'Validation failed' });
  }
});

// POST /:id/sync — trigger CRM sync
router.post('/:id/sync', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const stats = await syncOrgsToNotion(id);
    noteCuratorChange(res, { subject: `POST /api/integrations/${id}/sync`, old: null, next: { id, ...stats } });
    res.json({ success: true, ...stats });
  } catch (err) {
    console.error('[API] Sync failed:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Sync failed' });
  }
});

export { router as integrationRouter };
