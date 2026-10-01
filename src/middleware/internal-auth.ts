/**
 * Internal API key auth middleware
 *
 * Accepts, in order:
 * 1. A scoped curator key from WIRE_ROOM_CURATOR_KEYS (hashed bearer).
 *    Principal is `agent:<name>` (Hedwig → agent:hedwig). Missing scope is 403.
 *    Checked before the internal keys so a curator token never falls through
 *    to the wider door.
 * 2. A named internal API key (full agent access, unchanged):
 *      INTERNAL_API_KEY            → agent:stringer   (The Stringer)
 *      INTERNAL_API_KEY_DAILY_SCAN → agent:daily-scan (claude.ai daily-grant-scan routine)
 * 3. A valid Privy session (existing requireAuth fallback)
 *
 * A present-but-invalid WIRE_ROOM_CURATOR_KEYS value is 503 curator_unavailable
 * for any bearer that is not an internal key, so a bad Railway setting is not
 * a silent 401. Unset is not an error.
 *
 * Agent identities can approve/decline/submit/curate but can never publish —
 * approvals are force-quieted server-side and /redistribute rejects agent sessions.
 */

import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { requireAuth } from './auth';
import { rateLimit } from './rate-limit';
import { loadCuratorKeys, matchCuratorKey, requiredCuratorScope } from '../services/curator-keys';

const AGENT_WRITE_WINDOW_MS = 5 * 60 * 1000;
const AGENT_WRITE_MAX = 40;
const AGENT_SUBMIT_MAX = 20;
const AGENT_READ_MAX = 120;

function timingSafeMatch(token: string, key: string | undefined): boolean {
  return Boolean(
    key && token.length === key.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(key))
  );
}

export function requireAuthOrInternalKey(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const loaded = loadCuratorKeys();
    if (!loaded.malformed) {
      const key = matchCuratorKey(token, loaded.keys);
      if (key) {
        const scope = requiredCuratorScope(req.method, req.originalUrl || req.path || '');
        if (scope === 'forbidden' || !key.scopes.includes(scope)) {
          res.status(403).json({ error: 'forbidden' });
          return;
        }
        (req as any).agentSession = {
          userId: key.userId,
          isAgent: true,
          curator: true,
          scopes: key.scopes,
          keyId: key.id,
        };
        return enforceAgentRateLimit(req, res, next);
      }
    }
    if (timingSafeMatch(token, process.env.INTERNAL_API_KEY)) {
      (req as any).agentSession = { userId: 'agent:stringer', isAgent: true };
      return enforceAgentRateLimit(req, res, next);
    }
    if (timingSafeMatch(token, process.env.INTERNAL_API_KEY_DAILY_SCAN)) {
      (req as any).agentSession = { userId: 'agent:daily-scan', isAgent: true };
      return enforceAgentRateLimit(req, res, next);
    }
    if (loaded.malformed) {
      res.status(503).json({ error: 'curator_unavailable' });
      return;
    }
  }

  // Fall through to normal Privy session check
  return requireAuth(req, res, next);
}

function enforceAgentRateLimit(req: Request, res: Response, next: NextFunction): void {
  const actor = (req as any).agentSession?.userId || 'agent:unknown';
  const url = req.originalUrl || req.path || '';
  const isWrite = req.method !== 'GET' && req.method !== 'HEAD';
  const isSubmit = /\/(?:submit(?:-batch)?|telegram-batch|manual-intake)(?:\?|$)/.test(url);
  const max = !isWrite ? AGENT_READ_MAX : isSubmit ? AGENT_SUBMIT_MAX : AGENT_WRITE_MAX;
  const bucket = isSubmit ? 'submit' : isWrite ? 'write' : 'read';
  if (!rateLimit(`agent:${actor}:${bucket}`, max, AGENT_WRITE_WINDOW_MS)) {
    res.status(429).json({ error: `Agent ${bucket} rate limit exceeded. Try again in a few minutes.` });
    return;
  }
  next();
}
