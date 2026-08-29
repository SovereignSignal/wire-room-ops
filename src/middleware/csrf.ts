/**
 * CSRF origin check for cookie-authenticated mutating requests.
 *
 * Browser cross-site POSTs send Origin. Same-site dashboard fetches do too.
 * Missing Origin/Referer is allowed for non-cookie clients (curl, agents)
 * but rejected when a session cookie is present — that is the CSRF hole
 * the previous "allow missing Origin" fallback left open.
 *
 * Bearer tokens (internal agents) and the Telegram webhook are exempt:
 * they are not cookie-authenticated.
 */
import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

export const CSRF_EXEMPT_PATHS = ['/api/telegram/intake-webhook'] as const;

export function isBearerAuth(req: { headers: { authorization?: string } }): boolean {
  const auth = req.headers.authorization;
  return typeof auth === 'string' && auth.startsWith('Bearer ');
}

export function hasSessionCookie(req: { headers: { cookie?: string } }): boolean {
  const raw = req.headers.cookie || '';
  return /(^|;\s*)session=/.test(raw);
}

export function isCsrfExemptPath(path: string): boolean {
  return CSRF_EXEMPT_PATHS.some(p => path === p || path.startsWith(`${p}/`));
}

function hostMatches(raw: string | undefined, appHost: string): boolean | null {
  if (!raw) return null;
  try {
    return new URL(raw).host === appHost;
  } catch {
    return false;
  }
}

export type CsrfDecision = 'ok' | 'mismatch' | 'missing';

export function evaluateCsrf(
  req: { method: string; path: string; headers: { origin?: string; referer?: string; authorization?: string; cookie?: string } },
  appUrl: string,
): CsrfDecision {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return 'ok';
  if (isCsrfExemptPath(req.path)) return 'ok';
  if (isBearerAuth(req)) return 'ok';

  let appHost: string;
  try {
    appHost = new URL(appUrl).host;
  } catch {
    return 'ok';
  }

  const originOk = hostMatches(req.headers.origin, appHost);
  if (originOk === true) return 'ok';
  if (originOk === false) return 'mismatch';

  const refererOk = hostMatches(req.headers.referer, appHost);
  if (refererOk === true) return 'ok';
  if (refererOk === false) return 'mismatch';

  return hasSessionCookie(req) ? 'missing' : 'ok';
}

export function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  const decision = evaluateCsrf(req, config.app.url);
  if (decision === 'ok') {
    next();
    return;
  }
  if (decision === 'mismatch') {
    res.status(403).json({ error: 'Forbidden: origin mismatch' });
    return;
  }
  res.status(403).json({ error: 'Forbidden: origin required' });
}
