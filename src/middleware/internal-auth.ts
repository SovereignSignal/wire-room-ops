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
 * Dashboard routers use requireAuthOrCurator: the same curator bearer or a
 * session. The internal master key does not open those routers.
 *
 * A present-but-invalid WIRE_ROOM_CURATOR_KEYS value is 503 curator_unavailable
 * for any bearer that is not an internal key, so a bad Railway setting is not
 * a silent 401. Unset is not an error.
 *
 * Agent approvals stay force-quiet. A curator token may send only with
 * confirm=true. Other agent keys still cannot publish.
 */

import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { requireAuth } from './auth';
import { rateLimit } from './rate-limit';
import { CuratorKey, loadCuratorKeys, matchCuratorKey, requiredCuratorScope } from '../services/curator-keys';
import { installCuratorAudit } from '../services/curator-audit';
import { enforceCuratorGuards } from '../services/curator-confirm';

const AGENT_WRITE_WINDOW_MS = 5 * 60 * 1000;
const AGENT_WRITE_MAX = 40;
const AGENT_SUBMIT_MAX = 20;
const AGENT_READ_MAX = 120;

type CuratorBearer =
  | { kind: 'none' }
  | { kind: 'matched'; key: CuratorKey }
  | { kind: 'forbidden' }
  | { kind: 'malformed' }
  | { kind: 'unmatched' };

function timingSafeMatch(token: string, key: string | undefined): boolean {
  return Boolean(
    key && token.length === key.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(key))
  );
}

function bearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

function classifyCuratorBearer(req: Request): CuratorBearer {
  const token = bearerToken(req);
  if (token == null) return { kind: 'none' };
  const loaded = loadCuratorKeys();
  if (loaded.malformed) return { kind: 'malformed' };
  const key = matchCuratorKey(token, loaded.keys);
  if (!key) return { kind: 'unmatched' };
  const scope = requiredCuratorScope(req.method, req.originalUrl || req.path || '');
  if (scope === 'forbidden' || !key.scopes.includes(scope)) return { kind: 'forbidden' };
  return { kind: 'matched', key };
}

function acceptMatchedCurator(req: Request, res: Response, next: NextFunction, key: CuratorKey): void {
  (req as any).agentSession = {
    userId: key.userId,
    isAgent: true,
    curator: true,
    scopes: key.scopes,
    keyId: key.id,
  };
  const guard = enforceCuratorGuards(req);
  if (guard) {
    res.status(guard.status).json(guard.body);
    return;
  }
  installCuratorAudit(req, res);
  enforceAgentRateLimit(req, res, next);
}

function isInternalBearer(req: Request): boolean {
  const token = bearerToken(req);
  if (token == null) return false;
  return timingSafeMatch(token, process.env.INTERNAL_API_KEY)
    || timingSafeMatch(token, process.env.INTERNAL_API_KEY_DAILY_SCAN);
}

export function requireAuthOrInternalKey(req: Request, res: Response, next: NextFunction) {
  const curator = classifyCuratorBearer(req);
  if (curator.kind === 'matched') {
    // A router mounted earlier in this request already counted the rate limit.
    if ((req as any).agentSession?.curator) {
      installCuratorAudit(req, res);
      next();
      return;
    }
    acceptMatchedCurator(req, res, next, curator.key);
    return;
  }
  if (curator.kind === 'forbidden') {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  const token = bearerToken(req);
  if (token != null && timingSafeMatch(token, process.env.INTERNAL_API_KEY)) {
    (req as any).agentSession = { userId: 'agent:stringer', isAgent: true };
    const guard = enforceCuratorGuards(req);
    if (guard) {
      res.status(guard.status).json(guard.body);
      return;
    }
    enforceAgentRateLimit(req, res, next);
    return;
  }
  if (token != null && timingSafeMatch(token, process.env.INTERNAL_API_KEY_DAILY_SCAN)) {
    (req as any).agentSession = { userId: 'agent:daily-scan', isAgent: true };
    const guard = enforceCuratorGuards(req);
    if (guard) {
      res.status(guard.status).json(guard.body);
      return;
    }
    enforceAgentRateLimit(req, res, next);
    return;
  }
  if (curator.kind === 'malformed' && !isInternalBearer(req)) {
    res.status(503).json({ error: 'curator_unavailable' });
    return;
  }

  return requireAuth(req, res, next);
}

/**
 * Dashboard routers. A curator bearer with the route's scope, or a session.
 * The internal master key stays on requireAuth here, so it does not gain
 * settings writes that were session-only.
 */
export function requireAuthOrCurator(req: Request, res: Response, next: NextFunction) {
  if ((req as any).agentSession?.curator) {
    const guard = enforceCuratorGuards(req);
    if (guard) {
      res.status(guard.status).json(guard.body);
      return;
    }
    installCuratorAudit(req, res);
    next();
    return;
  }

  const curator = classifyCuratorBearer(req);
  if (curator.kind === 'matched') {
    acceptMatchedCurator(req, res, next, curator.key);
    return;
  }
  if (curator.kind === 'forbidden') {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  if (curator.kind === 'malformed' && !isInternalBearer(req)) {
    res.status(503).json({ error: 'curator_unavailable' });
    return;
  }
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
