/**
 * Scoped curator keys. Modeled on grants.watch GRANTS_WATCH_CURATOR_KEYS.
 *
 * WIRE_ROOM_CURATOR_KEYS is a JSON array. Each entry has id, name, lowercase
 * SHA-256 of the bearer (sha256), scopes, UTC expires_at, and revoked.
 * The raw token is never stored. Checked on every request.
 *
 * Scopes: read_queue, decide, propose, intake. A key only receives the scopes listed.
 * intake is the producer scope: it opens POST /telegram-batch and nothing else,
 * so a batch producer gets its own agent:<name> identity without the internal key.
 *
 * Dashboard reads use read_queue and dashboard writes use decide, so Hedwig's
 * existing scopes open the same controls the dashboard session can use.
 * No new scope is required. Evidence and Idempotency-Key stay on the editorial
 * decide/curate writes only.
 */

import crypto from 'crypto';

export const CURATOR_SCOPES = ['read_queue', 'decide', 'propose', 'intake'] as const;
export type CuratorScope = typeof CURATOR_SCOPES[number];

export interface CuratorKey {
  id: string;
  name: string;
  sha256: string;
  scopes: CuratorScope[];
  expiresAt: string;
  revoked: boolean;
  userId: string;
}

export interface CuratorKeyLoad {
  keys: CuratorKey[];
  /** Set when the env var is present but not a valid key list. Unset is not malformed. */
  malformed: boolean;
}

const SHA256_HEX = /^[a-f0-9]{64}$/i;

/** Hedwig → agent:hedwig. The audit principal is the slug of the key's name. */
export function curatorUserId(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `agent:${slug || 'curator'}`;
}

export function hashCuratorToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function parseEntry(entry: unknown): CuratorKey | null {
  if (!entry || typeof entry !== 'object') return null;
  const row = entry as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  const sha = typeof row.sha256 === 'string' ? row.sha256.trim().toLowerCase() : '';
  const expiresAt = typeof row.expires_at === 'string' ? row.expires_at.trim() : '';
  if (!id || !name || !SHA256_HEX.test(sha) || Number.isNaN(Date.parse(expiresAt))) return null;
  if (!Array.isArray(row.scopes) || row.scopes.length === 0) return null;
  const scopes: CuratorScope[] = [];
  for (const scope of row.scopes) {
    if (typeof scope !== 'string' || !CURATOR_SCOPES.includes(scope as CuratorScope)) return null;
    if (!scopes.includes(scope as CuratorScope)) scopes.push(scope as CuratorScope);
  }
  let revoked = row.revoked === true;
  if (typeof row.revoked_at === 'string' && Date.parse(row.revoked_at) <= Date.now()) revoked = true;
  return { id, name, sha256: sha, scopes, expiresAt, revoked, userId: curatorUserId(name) };
}

export function loadCuratorKeys(raw: string | undefined = process.env.WIRE_ROOM_CURATOR_KEYS): CuratorKeyLoad {
  if (raw == null || raw.trim() === '') return { keys: [], malformed: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { keys: [], malformed: true };
  }
  if (!Array.isArray(parsed)) return { keys: [], malformed: true };
  const keys: CuratorKey[] = [];
  for (const entry of parsed) {
    const key = parseEntry(entry);
    if (!key) return { keys: [], malformed: true };
    keys.push(key);
  }
  return { keys, malformed: false };
}

export function matchCuratorKey(token: string, keys: CuratorKey[], now = new Date()): CuratorKey | null {
  if (!token || keys.length === 0) return null;
  const digest = Buffer.from(hashCuratorToken(token));
  for (const key of keys) {
    if (key.revoked) continue;
    if (Date.parse(key.expiresAt) <= now.getTime()) continue;
    const expected = Buffer.from(key.sha256);
    if (digest.length === expected.length && crypto.timingSafeEqual(digest, expected)) return key;
  }
  return null;
}

const DASHBOARD_PREFIXES = [
  '/api/distribution',
  '/api/schedules',
  '/api/dashboard',
  '/api/feeds',
  '/api/wires',
  '/api/models',
  '/api/providers',
  '/api/usage',
  '/api/pricing',
  '/api/database',
  '/api/grants-intel',
  '/api/integrations',
  '/api/scan/prompts',
  '/api/job/',
  '/api/accounts',
  '/api/registry-watch',
  '/api/source-feeds',
];

function isDashboardCuratorPath(path: string): boolean {
  if (
    path === '/api/digest/send-now' ||
    path === '/api/test-alert' ||
    path === '/api/scheduler-status' ||
    path === '/api/scan/manual-intake' ||
    path === '/api/scan/run' ||
    path === '/api/forum/run' ||
    path === '/api/cohort/run' ||
    path === '/api/scan/prompt-stats' ||
    path === '/api/scan/cost-stats' ||
    path === '/api/scan/stats'
  ) return true;
  if (/^\/api\/scan\/entries\/\d+\/(distribution|redistribute|retry-summarize)$/.test(path)) return true;
  return DASHBOARD_PREFIXES.some(prefix => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));
}

/**
 * Which scope a curator key needs for this request.
 * Editorial routes keep their original scopes. Dashboard routes the UI calls
 * use read_queue for reads and decide for writes. Anything else is forbidden.
 */
export function requiredCuratorScope(method: string, rawPath: string): CuratorScope | 'forbidden' {
  const path = (rawPath || '').split('?')[0].replace(/\/+$/, '') || '/';
  const m = method.toUpperCase();

  // Not dashboard controls. submit-batch and the agent brief are producer
  // doors. Admin maintenance stays on the session. Monitored accounts are
  // dashboard controls: read_queue to list, decide to add, remove, or enable.
  if (path.startsWith('/api/admin')) return 'forbidden';
  if (path === '/api/scan/submit-batch') return 'forbidden';
  if (path === '/api/scan/agent/send-brief') return 'forbidden';
  if (path === '/api/summary-sync' || path === '/api/process-raw' || path === '/api/enrich' || path === '/api/scan/classify-queue') return 'forbidden';

  // Rows from a scoped key start raw like any agent batch (handleTextIntake keys off isAgent).
  if (m === 'POST' && path === '/api/scan/telegram-batch') return 'intake';

  if (m === 'GET' && (
    path === '/api/scan/queue' ||
    path === '/api/scan/entries' ||
    /^\/api\/scan\/entries\/\d+$/.test(path) ||
    path === '/api/scan/seen-urls' ||
    path === '/api/scan/agent/approval-patterns' ||
    path === '/api/scan/status-counts' ||
    path === '/api/scan/deadline-digest'
  )) return 'read_queue';

  if (
    (m === 'POST' && /^\/api\/scan\/entries\/\d+\/action$/.test(path)) ||
    (m === 'POST' && path === '/api/scan/entries/bulk-action') ||
    (m === 'POST' && /^\/api\/scan\/entries\/\d+\/link-duplicate$/.test(path)) ||
    (m === 'PATCH' && /^\/api\/scan\/entries\/\d+\/wire$/.test(path)) ||
    (m === 'PATCH' && /^\/api\/scan\/entries\/\d+\/source$/.test(path)) ||
    (m === 'PATCH' && /^\/api\/scan\/entries\/\d+\/content$/.test(path)) ||
    (m === 'POST' && /^\/api\/scan\/entries\/\d+\/unwithhold$/.test(path))
  ) return 'decide';

  if (
    (m === 'POST' && /^\/api\/scan\/entries\/\d+\/curate$/.test(path)) ||
    (m === 'POST' && path === '/api/scan/submit')
  ) return 'propose';

  if (isDashboardCuratorPath(path)) {
    return m === 'GET' || m === 'HEAD' ? 'read_queue' : 'decide';
  }

  return 'forbidden';
}
