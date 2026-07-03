/**
 * Internal API key auth middleware
 *
 * Accepts either:
 * 1. A valid named internal API key bearer token (agent access) — each key
 *    maps to its own agent identity so the audit trail distinguishes agents:
 *      INTERNAL_API_KEY            → agent:stringer   (The Stringer)
 *      INTERNAL_API_KEY_DAILY_SCAN → agent:daily-scan (claude.ai daily-grant-scan routine)
 *    Backward compatible: until the routine gets its own key, both agents
 *    authenticate with INTERNAL_API_KEY and appear as agent:stringer.
 * 2. A valid Privy session (existing requireAuth fallback)
 *
 * NOTE: agent identities can approve/decline/submit/curate but can never
 * publish — approvals are force-quieted server-side and /redistribute
 * rejects agent sessions.
 */

import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { requireAuth } from './auth';

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
    if (timingSafeMatch(token, process.env.INTERNAL_API_KEY)) {
      (req as any).agentSession = { userId: 'agent:stringer', isAgent: true };
      return next();
    }
    if (timingSafeMatch(token, process.env.INTERNAL_API_KEY_DAILY_SCAN)) {
      (req as any).agentSession = { userId: 'agent:daily-scan', isAgent: true };
      return next();
    }
  }

  // Fall through to normal Privy session check
  return requireAuth(req, res, next);
}
