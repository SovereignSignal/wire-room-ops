/**
 * Model & Wire Lookup Routes
 *
 * GET /models — list all available AI models
 * GET /wires  — list available wires (feeds) from database
 */

import { Router, Request, Response } from 'express';
import { getAllModels } from '../services/models';
import { getAvailableWires } from '../db';

const router = Router();

// API: Get available models
router.get('/models', async (req: Request, res: Response) => {
  try {
    const models = await getAllModels();
    res.json(models);
  } catch (error) {
    console.error('Failed to fetch models:', error);
    res.status(500).json({ error: 'Failed to fetch models' });
  }
});

// API: Get available wires (feeds) from database
router.get('/wires', async (req: Request, res: Response) => {
  try {
    const wires = await getAvailableWires();
    res.json(wires);
  } catch (error) {
    console.error('Failed to fetch wires:', error);
    res.status(500).json({ error: 'Failed to fetch wires' });
  }
});

export { router as modelRouter };
