/**
 * Internal API key auth middleware
 *
 * Accepts either:
 * 1. A valid INTERNAL_API_KEY bearer token (for agent access)
 * 2. A valid Privy session (existing requireAuth fallback)
 */

import { Request, Response, NextFunction } from 'express';
import { config } from '../config/index.js';
import { requireAuth } from './auth.js';

export function requireAuthOrInternalKey(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (config.internalApiKey && token === config.internalApiKey) {
      // Valid internal key — attach a synthetic agent identity
      (req as any).session = { userId: 'agent:stringer', isAgent: true };
      return next();
    }
  }

  // Fall through to normal Privy session check
  return requireAuth(req, res, next);
}
