/**
 * Change log for dashboard writes made with a curator bearer token.
 * The actor string is always `curator-api`. Secret fields are redacted
 * before they are logged or returned.
 */

import { Request, Response } from 'express';

export const CURATOR_API_ACTOR = 'curator-api';

const AUDIT_INSTALLED = Symbol('curatorAuditInstalled');

type AuditedResponse = Response & { [AUDIT_INSTALLED]?: boolean };

export interface CuratorChange {
  subject: string;
  old: unknown;
  next: unknown;
}

export function isCuratorRequest(req: Request): boolean {
  return Boolean((req as Request & { agentSession?: { curator?: boolean } }).agentSession?.curator);
}

/** `curator-api` when this request authenticated with a curator key. */
export function curatorApiActor(req: Request): string | null {
  return isCuratorRequest(req) ? CURATOR_API_ACTOR : null;
}

export function isSecretKey(key: string): boolean {
  const norm = key
    .replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
    .replace(/^_/, '')
    .toLowerCase();
  return /(?:^|_)(api_key|token|secret|password|credential|credentials|database_url|authorization|webhook_url)$/.test(norm)
    || norm === 'databaseurl'
    || norm === 'credentials';
}

function scrubConnectionStrings(value: string): string {
  return value.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://****');
}

/** Replace secret-shaped fields. Masked and raw values both become `****`. */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (typeof value === 'string') return scrubConnectionStrings(value);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => redactSecrets(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'confirm') continue;
    if (isSecretKey(key)) {
      out[key] = item == null || item === '' ? item : '****';
      continue;
    }
    out[key] = redactSecrets(item, depth + 1);
  }
  return out;
}

export function noteCuratorChange(res: Response, change: CuratorChange): void {
  if (!isCuratorRequest(res.req)) return;
  res.locals.curatorChange = {
    subject: change.subject,
    old: redactSecrets(change.old),
    next: redactSecrets(change.next),
  };
}

function requestPath(req: Request): string {
  return (req.originalUrl || req.path || '').split('?')[0].replace(/\/+$/, '') || '/';
}

/**
 * Log a successful curator write and strip secrets from the JSON body.
 * Idempotent replays are not logged again.
 */
export function installCuratorAudit(req: Request, res: Response): void {
  if (!isCuratorRequest(req)) return;
  const audited = res as AuditedResponse;
  if (audited[AUDIT_INSTALLED]) return;
  audited[AUDIT_INSTALLED] = true;

  const original = res.json.bind(res);
  res.json = (body?: unknown) => {
    const status = res.statusCode || 200;
    const safeBody = redactSecrets(body);
    const replay = res.getHeader('Idempotent-Replayed') === 'true';
    const writing = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
    if (writing && status < 400 && !replay) {
      const noted = res.locals.curatorChange as CuratorChange | undefined;
      const prior = res.locals.curatorPrior;
      const oldValue = noted ? noted.old : (prior !== undefined ? redactSecrets(prior) : null);
      const nextValue = noted
        ? noted.next
        : (prior !== undefined ? safeBody : redactSecrets(req.body));
      const subject = noted?.subject || `${req.method.toUpperCase()} ${requestPath(req)}`;
      console.log(`[curator-api] ${subject} actor=${CURATOR_API_ACTOR} ${JSON.stringify(oldValue)} -> ${JSON.stringify(nextValue)}`);
    }
    return original(safeBody);
  };
}
