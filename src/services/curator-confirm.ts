/**
 * Extra gate for curator-token writes that delete data, replace a secret,
 * or send a message. Entry content edits and withhold releases also require
 * confirm from every caller, including a dashboard session. Other agent
 * keys still cannot send.
 */

import { Request } from 'express';
import { isSecretKey } from './curator-audit';

/** Entry content edits and withhold releases. Confirm is required. These are not sends. */
const EDITORIAL_CONFIRM_PATHS: { method: string; pattern: RegExp }[] = [
  { method: 'PATCH', pattern: /^\/api\/scan\/entries\/\d+\/content$/ },
  { method: 'POST', pattern: /^\/api\/scan\/entries\/\d+\/unwithhold$/ },
];

/** Frozen post regenerate and override. Confirm is required. These do not send. */
const POST_TEXT_CONFIRM_PATHS: { method: string; pattern: RegExp }[] = [
  { method: 'POST', pattern: /^\/api\/distribution\/queue\/\d+\/regenerate$/ },
  { method: 'PATCH', pattern: /^\/api\/distribution\/queue\/\d+\/post$/ },
];

/** Close a failed send. Confirm is required. This does not send. */
const ACKNOWLEDGE_CONFIRM_PATHS: { method: string; pattern: RegExp }[] = [
  { method: 'POST', pattern: /^\/api\/distribution\/logs\/\d+\/acknowledge$/ },
];

export const ACKNOWLEDGE_CONFIRM_MESSAGE = 'Acknowledging a failed send needs confirm=true. This action does not send.';

const SEND_PATHS = [
  /^\/api\/distribution\/run\/[^/]+$/,
  /^\/api\/distribution\/channels\/[^/]+\/test$/,
  /^\/api\/distribution\/queue\/\d+\/enqueue$/,
  /^\/api\/distribution\/queue\/[^/]+\/retry$/,
  /^\/api\/distribution\/review\/[^/]+\/resolve$/,
  /^\/api\/distribution\/newsletter\/[^/]+\/confirm$/,
  /^\/api\/scan\/entries\/\d+\/redistribute$/,
  /^\/api\/digest\/send-now$/,
  /^\/api\/test-alert$/,
];

export interface CuratorGuard {
  status: number;
  body: { error: string; message?: string };
}

function requestPath(req: Request): string {
  return (req.originalUrl || req.path || '').split('?')[0].replace(/\/+$/, '') || '/';
}

export function isSendPath(method: string, path: string): boolean {
  if (method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD') return false;
  return SEND_PATHS.some(pattern => pattern.test(path));
}

function matchesPath(method: string, path: string, paths: { method: string; pattern: RegExp }[]): boolean {
  const verb = method.toUpperCase();
  const clean = (path || '').split('?')[0].replace(/\/+$/, '') || '/';
  return paths.some(item => item.method === verb && item.pattern.test(clean));
}

export function isEditorialConfirmPath(method: string, path: string): boolean {
  return matchesPath(method, path, EDITORIAL_CONFIRM_PATHS);
}

export function isPostTextConfirmPath(method: string, path: string): boolean {
  return matchesPath(method, path, POST_TEXT_CONFIRM_PATHS);
}

export function isAcknowledgeConfirmPath(method: string, path: string): boolean {
  return matchesPath(method, path, ACKNOWLEDGE_CONFIRM_PATHS);
}

function isMasked(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('****');
}

/** A new secret is present when a secret field is set and not the masked placeholder. */
export function bodyHasNewSecret(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (key === 'confirm') continue;
    if (isSecretKey(key)) {
      if (value && typeof value === 'object') {
        if (bodyHasNewSecret(value)) return true;
        continue;
      }
      if (value == null || value === '' || isMasked(value)) continue;
      return true;
    }
    if (value && typeof value === 'object' && bodyHasNewSecret(value)) return true;
  }
  return false;
}

export function curatorConfirmRequired(method: string, path: string, body: unknown): boolean {
  const verb = method.toUpperCase();
  if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') return false;
  if (verb === 'DELETE') return true;
  if (isSendPath(verb, path)) return true;
  if (isEditorialConfirmPath(verb, path)) return true;
  if (isPostTextConfirmPath(verb, path)) return true;
  if (isAcknowledgeConfirmPath(verb, path)) return true;
  return bodyHasNewSecret(body);
}

export function curatorConfirmed(req: Request): boolean {
  const query = req.query?.confirm;
  if (query === 'true' || query === '1') return true;
  const body = req.body;
  return Boolean(body && typeof body === 'object' && !Array.isArray(body) && (body as { confirm?: unknown }).confirm === true);
}

/**
 * Curator tokens must pass `confirm=true` for risky writes.
 * Any other agent key is refused on send paths.
 */
export function enforceCuratorGuards(req: Request): CuratorGuard | null {
  const agent = (req as Request & { agentSession?: { isAgent?: boolean; curator?: boolean } }).agentSession;
  if (!agent?.isAgent) return null;
  const path = requestPath(req);
  const method = req.method.toUpperCase();
  if (!agent.curator && isSendPath(method, path)) {
    return { status: 403, body: { error: 'Agents cannot publish. This action sends or retries a delivery.' } };
  }
  if (!agent.curator && isEditorialConfirmPath(method, path) && !curatorConfirmed(req)) {
    return {
      status: 400,
      body: {
        error: 'confirm_required',
        message: 'Editing entry content or releasing a withhold needs confirm=true. This action does not send.',
      },
    };
  }
  if (!agent.curator && isPostTextConfirmPath(method, path) && !curatorConfirmed(req)) {
    return {
      status: 400,
      body: {
        error: 'confirm_required',
        message: 'Regenerating or replacing a queued post needs confirm=true. This action does not send.',
      },
    };
  }
  if (agent.curator && curatorConfirmRequired(method, path, req.body) && !curatorConfirmed(req)) {
    const editorial = isEditorialConfirmPath(method, path);
    const postText = isPostTextConfirmPath(method, path);
    const acknowledge = isAcknowledgeConfirmPath(method, path);
    return {
      status: 400,
      body: {
        error: 'confirm_required',
        message: postText
          ? 'Regenerating or replacing a queued post needs confirm=true. This action does not send.'
          : editorial
            ? 'Editing entry content or releasing a withhold needs confirm=true. This action does not send.'
            : acknowledge
              ? ACKNOWLEDGE_CONFIRM_MESSAGE
              : 'This action deletes data, changes a secret, or sends a message. Retry with confirm=true.',
      },
    };
  }
  return null;
}
