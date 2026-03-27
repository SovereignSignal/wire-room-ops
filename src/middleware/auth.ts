/**
 * Auth middleware — Privy JWT verification + session-based auth
 */

import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { config } from '../config';
import { validateSession } from '../services/auth';

const privyJwks = jwksClient({
  jwksUri: `https://auth.privy.io/api/v1/apps/${config.privy.appId}/jwks.json`,
  cache: true,
  rateLimit: true,
});

export function verifyPrivyToken(token: string): Promise<jwt.JwtPayload> {
  return new Promise((resolve, reject) => {
    jwt.verify(token, (header, callback) => {
      privyJwks.getSigningKey(header.kid, (err, key) => {
        if (err) return callback(err);
        callback(null, key?.getPublicKey());
      });
    }, {
      issuer: 'privy.io',
      audience: config.privy.appId,
    }, (err, decoded) => {
      if (err) return reject(err);
      resolve(decoded as jwt.JwtPayload);
    });
  });
}

// Dev mode: skip auth — ONLY when explicitly set via DEV_MODE=true
export const isDevMode = process.env.DEV_MODE === 'true';

// Auth middleware - checks session from HttpOnly cookie only
export async function requireAuth(req: Request, res: Response, next: Function): Promise<void> {
  if (isDevMode) return next();
  const session = req.cookies?.session as string;
  if (!session || !(await validateSession(session))) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
