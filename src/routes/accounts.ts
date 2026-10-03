/**
 * Monitored Accounts Routes
 *
 * GET    /monitored        — list all monitored accounts
 * POST   /monitored        — manually add an account
 * PATCH  /monitored/:handle — update enabled/wire
 * DELETE /monitored/:handle — remove account
 */

import { Router, Request, Response } from 'express';
import { CORE_WIRES, getPool } from '../db';
import { noteCuratorChange } from '../services/curator-audit';

const router = Router();

function cleanHandle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const handle = raw.trim().replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9_]{1,50}$/.test(handle)) return null;
  return handle;
}

function cleanWire(raw: unknown): { ok: true; wire: string | null } | { ok: false } {
  if (raw === undefined) return { ok: true, wire: null };
  if (raw === null || raw === '') return { ok: true, wire: null };
  if (typeof raw !== 'string' || !(CORE_WIRES as readonly string[]).includes(raw)) return { ok: false };
  return { ok: true, wire: raw };
}

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
  const handle = cleanHandle(req.body?.handle);
  if (!handle) {
    res.status(400).json({ error: 'handle is required' });
    return;
  }
  const wire = cleanWire(req.body?.wire);
  if (!wire.ok) {
    res.status(400).json({ error: 'wire must be crypto, ai, or oss' });
    return;
  }
  const enabled = req.body?.enabled === undefined ? true : req.body.enabled === true;
  try {
    const pool = getPool();
    const previous = await pool.query(`SELECT * FROM monitored_accounts WHERE handle = $1`, [handle]);
    const result = await pool.query(
      `INSERT INTO monitored_accounts (handle, wire, source, enabled)
       VALUES ($1, $2, 'manual', $3)
       ON CONFLICT (handle) DO UPDATE SET wire = EXCLUDED.wire, enabled = EXCLUDED.enabled, updated_at = NOW()
       RETURNING *`,
      [handle, wire.wire, enabled]
    );
    noteCuratorChange(res, {
      subject: 'POST /api/accounts/monitored',
      old: previous.rows[0] || null,
      next: result.rows[0],
    });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// PATCH /accounts/monitored/:handle
router.patch('/monitored/:handle', async (req: Request, res: Response) => {
  const handle = cleanHandle(req.params.handle);
  if (!handle) {
    res.status(400).json({ error: 'handle is required' });
    return;
  }
  const { wire, enabled } = req.body || {};
  if (wire !== undefined && wire !== null && (typeof wire !== 'string' || !(CORE_WIRES as readonly string[]).includes(wire))) {
    res.status(400).json({ error: 'wire must be crypto, ai, or oss' });
    return;
  }
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be true or false' });
    return;
  }
  if (wire === undefined && enabled === undefined) {
    res.status(400).json({ error: 'No editable fields in the body' });
    return;
  }
  try {
    const pool = getPool();
    const previous = await pool.query(`SELECT * FROM monitored_accounts WHERE handle = $1`, [handle]);
    if (previous.rows.length === 0) { res.status(404).json({ error: 'Account not found' }); return; }
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
    noteCuratorChange(res, {
      subject: `PATCH /api/accounts/monitored/${handle}`,
      old: previous.rows[0],
      next: result.rows[0],
    });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// DELETE /accounts/monitored/:handle
router.delete('/monitored/:handle', async (req: Request, res: Response) => {
  const handle = cleanHandle(req.params.handle);
  if (!handle) {
    res.status(400).json({ error: 'handle is required' });
    return;
  }
  try {
    const pool = getPool();
    const previous = await pool.query(`SELECT * FROM monitored_accounts WHERE handle = $1`, [handle]);
    await pool.query(`DELETE FROM monitored_accounts WHERE handle = $1`, [handle]);
    noteCuratorChange(res, {
      subject: `DELETE /api/accounts/monitored/${handle}`,
      old: previous.rows[0] || null,
      next: null,
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

export const accountsRouter = router;
