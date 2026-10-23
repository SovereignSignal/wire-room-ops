/**
 * Scout ledger writes, so grant-wire-scout holds no database credential:
 *   PUT  /api/scout/runs/:runId   record or update one run (idempotent by run id)
 *   POST /api/scout/alerts        record one alert (optional Idempotency-Key)
 *
 * Mounted at /api/scout behind requireAuthOrCurator. Only a curator key with
 * the `ledger` scope reaches a handler; a dashboard session is refused here.
 * Reads are GET /api/read/scout-runs and /api/read/scout-alerts.
 */

import { Router, Request, Response } from 'express';
import { getPool } from '../db';
import { readIdempotencyKey } from '../services/curator-idempotency';
import {
  LedgerInputError,
  insertScoutAlert,
  parseScoutAlert,
  parseScoutRun,
  upsertScoutRun,
} from '../services/scout-ledger';

const router = Router();

function ledgerPrincipal(req: Request, res: Response): string | null {
  const session = (req as Request & { agentSession?: { curator?: boolean; scopes?: string[]; userId?: string } }).agentSession;
  if (!session?.curator || !session.scopes?.includes('ledger') || !session.userId) {
    res.status(403).json({ error: 'Scout ledger writes need a curator key with the ledger scope' });
    return null;
  }
  return session.userId;
}

function fail(res: Response, route: string, error: unknown): void {
  if (error instanceof LedgerInputError) {
    res.status(400).json({ error: error.message });
    return;
  }
  console.error(`[ScoutLedger] ${route} failed:`, error);
  res.status(500).json({ error: 'ledger_write_failed' });
}

router.put('/runs/:runId', async (req: Request, res: Response) => {
  const principal = ledgerPrincipal(req, res);
  if (!principal) return;
  try {
    const input = parseScoutRun(req.params.runId, req.body);
    const result = await upsertScoutRun(getPool(), input, principal);
    if (!result) {
      res.status(409).json({ error: 'This run_id was recorded by another key' });
      return;
    }
    res.status(result.created ? 201 : 200).json({ run: result.run, created: result.created });
  } catch (error) {
    fail(res, 'PUT /api/scout/runs', error);
  }
});

router.post('/alerts', async (req: Request, res: Response) => {
  const principal = ledgerPrincipal(req, res);
  if (!principal) return;
  try {
    let idempotencyKey: string | null = null;
    if (req.headers['idempotency-key'] !== undefined) {
      const parsed = readIdempotencyKey(req.headers['idempotency-key']);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      idempotencyKey = parsed.key;
    }
    const input = parseScoutAlert(req.body);
    const result = await insertScoutAlert(getPool(), input, principal, idempotencyKey);
    if (result.kind === 'conflict') {
      res.status(409).json({ error: 'Idempotency-Key was already used with a different alert' });
      return;
    }
    // The curator audit line would otherwise carry the whole alert body.
    res.locals.curatorChange = {
      subject: `POST /api/scout/alerts #${result.alert.id}`,
      old: null,
      next: { subject: input.subject, channels_ok: input.channelsOk },
    };
    if (result.kind === 'replayed') res.setHeader('Idempotent-Replayed', 'true');
    res.status(result.kind === 'created' ? 201 : 200).json({ alert: result.alert, created: result.kind === 'created' });
  } catch (error) {
    fail(res, 'POST /api/scout/alerts', error);
  }
});

export { router as scoutLedgerRouter };
