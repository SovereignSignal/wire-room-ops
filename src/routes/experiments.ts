/**
 * Experiment API Routes
 *
 * GET  /api/experiments         — list all experiments
 * GET  /api/experiments/active  — current active experiment
 * POST /api/experiments/create  — create new experiment with specified params
 * POST /api/experiments/:id/rollback — manual rollback
 */

import { Router, Request, Response } from 'express';
import { ExperimentEngine, validateConstraints } from '../services/experiment-engine';
import type { ScoringParams } from '../types/intake';
import { DEFAULT_PARAMS } from '../services/quality-scorer';

const router = Router();

function getEngine(): ExperimentEngine {
  return new ExperimentEngine();
}

// GET /api/experiments — list all experiments
router.get('/', async (req: Request, res: Response) => {
  try {
    const engine = getEngine();
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 50;
    const experiments = await engine.listExperiments(status, limit);
    res.json({ experiments });
  } catch (error) {
    console.error('[Experiments] List failed:', error);
    res.status(500).json({ error: 'Failed to list experiments' });
  }
});

// GET /api/experiments/active — current active experiment
router.get('/active', async (_req: Request, res: Response) => {
  try {
    const engine = getEngine();
    const active = await engine.getActiveExperiment();

    if (!active) {
      res.json({ active: null, defaultParams: DEFAULT_PARAMS });
      return;
    }

    // Refresh counts
    const counts = await engine.refreshCounts(active.id);
    const results = await engine.computeResults(active.id);

    res.json({
      active: {
        ...active,
        ...counts,
        currentResults: results,
      },
      defaultParams: DEFAULT_PARAMS,
    });
  } catch (error) {
    console.error('[Experiments] Active fetch failed:', error);
    res.status(500).json({ error: 'Failed to fetch active experiment' });
  }
});

// POST /api/experiments/create — create new experiment
router.post('/create', async (req: Request, res: Response) => {
  try {
    const { name, params, parentId } = req.body as {
      name?: string;
      params?: ScoringParams;
      parentId?: string;
    };

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const experimentParams = params || DEFAULT_PARAMS;

    if (!validateConstraints(experimentParams)) {
      res.status(400).json({ error: 'Params violate constraints' });
      return;
    }

    const engine = getEngine();
    const mutationDesc = params
      ? describeChanges(DEFAULT_PARAMS, experimentParams)
      : '(default params)';

    const experiment = await engine.createExperiment(
      name,
      experimentParams,
      parentId ?? null,
      mutationDesc,
      'manual'
    );

    res.json({ experiment });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to create experiment';
    console.error('[Experiments] Create failed:', error);
    res.status(500).json({ error: msg });
  }
});

// POST /api/experiments/:id/rollback — manual rollback
router.post('/:id/rollback', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { reason } = req.body as { reason?: string };

    if (!id || typeof id !== 'string') {
      res.status(400).json({ error: 'Experiment ID required' });
      return;
    }

    const engine = getEngine();
    await engine.rollbackExperiment(id, reason || 'manual rollback');
    res.json({ success: true, message: `Experiment ${id} rolled back` });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to rollback experiment';
    console.error('[Experiments] Rollback failed:', error);
    res.status(500).json({ error: msg });
  }
});

// ============================================================
// Helpers
// ============================================================

function describeChanges(base: ScoringParams, changed: ScoringParams): string {
  const diffs: string[] = [];
  for (const key of Object.keys(base) as (keyof ScoringParams)[]) {
    if (base[key] !== changed[key]) {
      diffs.push(`${key}: ${base[key]} -> ${changed[key]}`);
    }
  }
  return diffs.length > 0 ? diffs.join(', ') : '(no changes)';
}

export { router as experimentsRouter };
