/**
 * Monitored Accounts Routes
 *
 * GET    /monitored        — list all monitored accounts
 * POST   /monitored        — manually add an account
 * PATCH  /monitored/:handle — update enabled/wire
 * DELETE /monitored/:handle — remove account
 */

import { Router, Request, Response } from 'express';
import { getPool } from '../db';

const router = Router();

// GET /accounts/monitored
router.get('/monitored', async (_req: Request, res: Response) => {
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT id, handle, wire, source, approval_count, last_approved_at, last_checked_at, enabled, created_at
       FROM monitored_accounts
       ORDER BY approval_count DESC, handle ASC`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// POST /accounts/monitored
router.post('/monitored', async (req: Request, res: Response) => {
  const { handle, wire, enabled = true } = req.body;
  if (!handle || typeof handle !== 'string') {
    res.status(400).json({ error: 'handle is required' });
    return;
  }
  try {
    const pool = getPool();
    const result = await pool.query(
      `INSERT INTO monitored_accounts (handle, wire, source, enabled)
       VALUES ($1, $2, 'manual', $3)
       ON CONFLICT (handle) DO UPDATE SET wire = EXCLUDED.wire, enabled = EXCLUDED.enabled, updated_at = NOW()
       RETURNING *`,
      [handle.toLowerCase(), wire || null, enabled]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// PATCH /accounts/monitored/:handle
router.patch('/monitored/:handle', async (req: Request, res: Response) => {
  const handle = req.params.handle.toLowerCase();
  const { wire, enabled } = req.body;
  try {
    const pool = getPool();
    const updates: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    let idx = 1;
    if (wire !== undefined) { updates.push(`wire = $${idx++}`); values.push(wire); }
    if (enabled !== undefined) { updates.push(`enabled = $${idx++}`); values.push(enabled); }
    values.push(handle);
    const result = await pool.query(
      `UPDATE monitored_accounts SET ${updates.join(', ')} WHERE handle = $${idx} RETURNING *`,
      values
    );
    if (result.rows.length === 0) { res.status(404).json({ error: 'Account not found' }); return; }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// DELETE /accounts/monitored/:handle
router.delete('/monitored/:handle', async (req: Request, res: Response) => {
  const handle = req.params.handle.toLowerCase();
  try {
    const pool = getPool();
    await pool.query(`DELETE FROM monitored_accounts WHERE handle = $1`, [handle]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

export const accountsRouter = router;
