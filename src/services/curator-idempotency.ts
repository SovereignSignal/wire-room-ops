/**
 * Idempotency-Key for curator-key decide/curate writes.
 * Stored in the existing app_state table (no migration).
 * INTERNAL_API_KEY requests never enter this module.
 *
 * Same key + same method/path/body replays the stored response and sets
 * Idempotent-Replayed: true. Same key + different body is 409.
 * A claim still pending after 15 minutes can be taken over.
 * Completed replays last 24 hours.
 */

import crypto from 'crypto';
import type { Request, Response } from 'express';
import { getAppState, setAppState } from '../db';

const PENDING_MS = 15 * 60 * 1000;
const REPLAY_MS = 24 * 60 * 60 * 1000;
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export interface IdempotencyRecord {
  state: 'pending' | 'done';
  bodyHash: string;
  at: string;
  statusCode?: number;
  payload?: unknown;
}

export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | null>;
  set(key: string, value: IdempotencyRecord | null): Promise<void>;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function idempotencyBodyHash(method: string, path: string, body: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson({
    method: method.toUpperCase(),
    path: path.split('?')[0],
    body: body ?? null,
  })).digest('hex');
}

export function readIdempotencyKey(header: string | string[] | undefined): { ok: true; key: string } | { ok: false; error: string } {
  const raw = Array.isArray(header) ? header[0] : header;
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key) return { ok: false, error: 'Idempotency-Key is required' };
  if (!KEY_PATTERN.test(key)) {
    return { ok: false, error: 'Idempotency-Key must be 8-128 characters from A-Z a-z 0-9 . _ : -' };
  }
  return { ok: true, key };
}

const appStateStore: IdempotencyStore = {
  async get(key) {
    return getAppState<IdempotencyRecord>(key);
  },
  async set(key, value) {
    await setAppState(key, value);
  },
};

export interface IdempotencyClaim {
  kind: 'replay' | 'conflict' | 'proceed';
  statusCode?: number;
  payload?: unknown;
  error?: string;
  finish?: (statusCode: number, payload: unknown) => Promise<void>;
  abort?: () => Promise<void>;
}

export async function claimIdempotency(input: {
  store: IdempotencyStore;
  storageKey: string;
  bodyHash: string;
  now?: Date;
}): Promise<IdempotencyClaim> {
  const now = input.now ?? new Date();
  const existing = await input.store.get(input.storageKey);
  if (existing && existing.state === 'done' && existing.bodyHash === input.bodyHash) {
    const age = now.getTime() - Date.parse(existing.at);
    if (age >= 0 && age < REPLAY_MS && typeof existing.statusCode === 'number') {
      return { kind: 'replay', statusCode: existing.statusCode, payload: existing.payload };
    }
  }
  if (existing && existing.bodyHash !== input.bodyHash && existing.state !== 'pending') {
    const age = now.getTime() - Date.parse(existing.at);
    if (Number.isNaN(age) || age < REPLAY_MS) {
      return { kind: 'conflict', statusCode: 409, error: 'Idempotency-Key was already used with a different request body' };
    }
  }
  if (existing && existing.state === 'pending') {
    const age = now.getTime() - Date.parse(existing.at);
    if (age >= 0 && age < PENDING_MS) {
      return { kind: 'conflict', statusCode: 409, error: 'Idempotency-Key is already in progress' };
    }
    if (existing.bodyHash !== input.bodyHash) {
      return { kind: 'conflict', statusCode: 409, error: 'Idempotency-Key was already used with a different request body' };
    }
  }

  await input.store.set(input.storageKey, {
    state: 'pending',
    bodyHash: input.bodyHash,
    at: now.toISOString(),
  });

  return {
    kind: 'proceed',
    finish: async (statusCode, payload) => {
      await input.store.set(input.storageKey, {
        state: 'done',
        bodyHash: input.bodyHash,
        at: now.toISOString(),
        statusCode,
        payload,
      });
    },
    abort: async () => {
      const current = await input.store.get(input.storageKey);
      if (current?.state === 'pending' && current.bodyHash === input.bodyHash) {
        await input.store.set(input.storageKey, null);
      }
    },
  };
}

export function curatorIdempotencyStorageKey(keyId: string, idempotencyKey: string): string {
  return `curator:idem:${keyId}:${idempotencyKey}`;
}

/** Send a replay or conflict, or return the finish/abort pair. `sent` means the response is done. */
export async function openCuratorIdempotency(
  req: Request,
  res: Response,
  store: IdempotencyStore = appStateStore,
): Promise<
  | { sent: true }
  | { sent: false; finish: (statusCode: number, payload: unknown) => Promise<void>; abort: () => Promise<void> }
> {
  const session = (req as { agentSession?: { curator?: boolean; keyId?: string } }).agentSession;
  if (!session?.curator) return { sent: false, finish: async () => {}, abort: async () => {} };

  const parsed = readIdempotencyKey(req.headers['idempotency-key']);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return { sent: true };
  }
  const claim = await claimIdempotency({
    store,
    storageKey: curatorIdempotencyStorageKey(session.keyId || 'curator', parsed.key),
    bodyHash: idempotencyBodyHash(req.method, req.originalUrl || req.path || '', req.body),
  });
  if (claim.kind === 'replay') {
    res.setHeader('Idempotent-Replayed', 'true');
    res.status(claim.statusCode || 200).json(claim.payload ?? {});
    return { sent: true };
  }
  if (claim.kind === 'conflict') {
    res.status(claim.statusCode || 409).json({ error: claim.error || 'Idempotency conflict' });
    return { sent: true };
  }
  return { sent: false, finish: claim.finish!, abort: claim.abort! };
}
