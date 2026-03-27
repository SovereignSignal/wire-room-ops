/**
 * Internal API key auth middleware
 *
 * Accepts either:
 * 1. A valid INTERNAL_API_KEY bearer token (for agent access)
 * 2. A valid Privy session (existing requireAuth fallback)
 */

import { Request, Response, NextFunction } from 'express';
import { requireAuth } from './auth.js';

export function requireAuthOrInternalKey(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const internalKey = process.env.INTERNAL_API_KEY;
    if (internalKey && token === internalKey) {
      // Valid internal key — attach a synthetic agent identity
      (req as any).agentSession = { userId: 'agent:stringer', isAgent: true };
      return next();
    }
  }

  // Fall through to normal Privy session check
  return requireAuth(req, res, next);
}
