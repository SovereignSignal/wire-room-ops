/**
 * Registry watch reads for a curator token.
 *
 * GET  /pending          — last dry run's would-submit items
 * GET  /surfaces         — watched pages
 * PUT  /surfaces/:id     — edit url, type, wire, tier, status, or org name
 */

import { Router, Request, Response } from 'express';
import { CORE_WIRES, getPool, getAppState } from '../db';
import { SURFACE_TYPES } from '../types/intake';
import { isSafeHttpUrl } from '../utils/ssrf';
import { noteCuratorChange } from '../services/curator-audit';
import { REGISTRY_WATCH_PENDING_KEY, normalizePendingSnapshot } from '../jobs/registry-watch';

const router = Router();
const STATUSES = new Set(['active', 'paused']);

router.get('/pending', async (_req: Request, res: Response) => {
  try {
    const raw = await getAppState(REGISTRY_WATCH_PENDING_KEY);
    res.json(normalizePendingSnapshot(raw));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

router.get('/surfaces', async (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status : '';
  const wire = typeof req.query.wire === 'string' ? req.query.wire : '';
  if (status && !STATUSES.has(status)) {
    res.status(400).json({ error: 'status must be active or paused' });
    return;
  }
  if (wire && !(CORE_WIRES as readonly string[]).includes(wire)) {
    res.status(400).json({ error: 'wire must be crypto, ai, or oss' });
    return;
  }
  try {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (status) { values.push(status); clauses.push(`status = $${values.length}`); }
    if (wire) { values.push(wire); clauses.push(`wire = $${values.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await getPool().query(
      `SELECT id, org_name, wire, surface_type, url, tier, status,
              last_checked_at, last_changed_at, failure_streak, items_found_30d, updated_at
         FROM watch_surfaces
         ${where}
        ORDER BY org_name ASC, id ASC`,
      values,
    );
    res.json({ surfaces: rows });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

router.put('/surfaces/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'surface id must be a positive integer' });
    return;
  }
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({ error: 'JSON object required' });
    return;
  }
  const updates: string[] = ['updated_at = NOW()'];
  const values: unknown[] = [];
  const assign = (column: string, value: unknown) => {
    values.push(value);
    updates.push(`${column} = $${values.length}`);
  };

  if (body.url !== undefined) {
    if (typeof body.url !== 'string' || !isSafeHttpUrl(body.url.trim()) || !body.url.trim().toLowerCase().startsWith('https://')) {
      res.status(400).json({ error: 'url must be an https address' });
      return;
    }
    assign('url', body.url.trim());
  }
  if (body.surface_type !== undefined) {
    if (typeof body.surface_type !== 'string' || !(SURFACE_TYPES as readonly string[]).includes(body.surface_type)) {
      res.status(400).json({ error: 'surface_type is not a known watch surface type' });
      return;
    }
    assign('surface_type', body.surface_type);
  }
  if (body.wire !== undefined) {
    if (body.wire !== null && (typeof body.wire !== 'string' || !(CORE_WIRES as readonly string[]).includes(body.wire))) {
      res.status(400).json({ error: 'wire must be crypto, ai, oss, or null' });
      return;
    }
    assign('wire', body.wire);
  }
  if (body.tier !== undefined) {
    if (body.tier !== null && (typeof body.tier !== 'string' || body.tier.length > 80)) {
      res.status(400).json({ error: 'tier must be a short string or null' });
      return;
    }
    assign('tier', body.tier);
  }
  if (body.status !== undefined) {
    if (typeof body.status !== 'string' || !STATUSES.has(body.status)) {
      res.status(400).json({ error: 'status must be active or paused' });
      return;
    }
    assign('status', body.status);
  }
  if (body.org_name !== undefined) {
    if (typeof body.org_name !== 'string' || !body.org_name.trim() || body.org_name.length > 200) {
      res.status(400).json({ error: 'org_name is required and must be 200 characters or fewer' });
      return;
    }
    assign('org_name', body.org_name.trim());
  }
  if (values.length === 0) {
    res.status(400).json({ error: 'No editable fields in the body' });
    return;
  }

  try {
    const pool = getPool();
    const previous = await pool.query(`SELECT * FROM watch_surfaces WHERE id = $1`, [id]);
    if (previous.rows.length === 0) {
      res.status(404).json({ error: 'Surface not found' });
      return;
    }
    values.push(id);
    const result = await pool.query(
      `UPDATE watch_surfaces SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values,
    );
    noteCuratorChange(res, {
      subject: `PUT /api/registry-watch/surfaces/${id}`,
      old: previous.rows[0],
      next: result.rows[0],
    });
    res.json(result.rows[0]);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: string }).code : '';
    if (code === '23505') {
      res.status(409).json({ error: 'A surface with that type and URL already exists' });
      return;
    }
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

export const registryWatchRouter = router;
