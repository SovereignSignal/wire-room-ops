/**
 * A funder that already landed on a Telegram wire stays off the queue for a
 * window (default 30 days). Match on org, program, or a normalized funder
 * name taken from the entry name and tags.
 */

import type { Pool, PoolClient } from 'pg';
import { getPool } from '../db';
import { extractOrgFromName } from './org-extractor';

const NAME_STOP = new Set([
  'the', 'and', 'for', 'new', 'open', 'grant', 'grants', 'starter',
  'program', 'programs', 'funding', 'fund', 'foundation',
]);

export interface RepeatFunderPrior {
  entryId: number;
  name: string;
  wire: string;
  externalId: string | null;
  sentAt: string;
}

export interface RepeatFunderHold {
  entryId: number;
  held: boolean;
  windowDays: number;
  priors: RepeatFunderPrior[];
}

export class RepeatFunderHoldError extends Error {
  readonly statusCode: number;
  constructor(
    public readonly holds: RepeatFunderHold[],
    statusCode = 409,
  ) {
    super(statusCode === 400 ? 'override_repeat_funder requires a reason' : 'repeat_funder');
    this.name = 'RepeatFunderHoldError';
    this.statusCode = statusCode;
  }
}

type Queryable = { query: Pool['query'] | PoolClient['query'] };

interface Identity {
  id: number;
  orgId: number | null;
  programId: number | null;
  names: string[];
  rawName: string;
  rawTags: string[];
}

/** REPEAT_FUNDER_WINDOW_DAYS, or 30 when unset or not a whole number of days. */
export function repeatFunderWindowDays(): number {
  const raw = process.env.REPEAT_FUNDER_WINDOW_DAYS;
  if (raw == null || raw.trim() === '') return 30;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3650) return 30;
  return parsed;
}

export function normalizeFunderName(value: string | null | undefined): string {
  return (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function addName(keys: Set<string>, value: string | null | undefined): void {
  const normalized = normalizeFunderName(value);
  if (normalized.length < 3 || NAME_STOP.has(normalized)) return;
  keys.add(normalized);
}

/**
 * Funder-name keys from an explicit tag, the org parsed out of the title,
 * or the title text before a dash or colon. A bare first word is not a key,
 * so "Crypto A" and "Crypto B" stay different funders.
 */
export function funderNameKeys(name: string | null | undefined, tags: string[] | null | undefined): string[] {
  const keys = new Set<string>();
  const title = (name || '').trim();
  addName(keys, extractOrgFromName(title));
  if (/[—–:]|\s-\s/.test(title)) addName(keys, title.split(/\s*[—–:]\s+|\s+-\s+/)[0]);
  for (const tag of tags || []) addName(keys, tag);
  return [...keys];
}

function identityOf(row: {
  id: number;
  org_id?: number | null;
  program_id?: number | null;
  name?: string | null;
  tags?: string[] | null;
}): Identity {
  const tags = Array.isArray(row.tags) ? row.tags : [];
  return {
    id: Number(row.id),
    orgId: row.org_id == null ? null : Number(row.org_id),
    programId: row.program_id == null ? null : Number(row.program_id),
    names: funderNameKeys(row.name, tags),
    rawName: row.name || '',
    rawTags: tags,
  };
}

function mentions(identity: Identity, key: string): boolean {
  const haystack = normalizeFunderName([identity.rawName, ...identity.rawTags].join(' '));
  const needle = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  return new RegExp(`(?:^|\\s)${needle}(?:\\s|$)`).test(haystack);
}

function sameFunder(candidate: Identity, prior: Identity): boolean {
  if (candidate.orgId != null && candidate.orgId === prior.orgId) return true;
  if (candidate.programId != null && candidate.programId === prior.programId) return true;
  if (candidate.names.some(name => prior.names.includes(name))) return true;
  return candidate.names.some(name => mentions(prior, name)) || prior.names.some(name => mentions(candidate, name));
}

export function repeatFunderPayload(error: RepeatFunderHoldError): Record<string, unknown> {
  if (error.statusCode === 400) {
    return { error: 'reason_required', message: error.message };
  }
  const windowDays = error.holds[0]?.windowDays ?? repeatFunderWindowDays();
  return {
    error: 'repeat_funder',
    reason: 'repeat_funder',
    message: `This funder already had a successful Telegram post in the last ${windowDays} days.`,
    windowDays,
    holds: error.holds,
  };
}

export async function repeatFunderHolds(
  db: Queryable,
  entryIds: number[],
  windowDays = repeatFunderWindowDays(),
): Promise<RepeatFunderHold[]> {
  const ids = [...new Set(entryIds)].filter(id => Number.isSafeInteger(id) && id > 0);
  if (!ids.length) return [];
  const entries = (await db.query(
    `SELECT id, name, tags, org_id, program_id FROM scan_entries WHERE id = ANY($1::int[])`,
    [ids],
  )).rows as Array<{ id: number; name: string | null; tags: string[] | null; org_id: number | null; program_id: number | null }>;
  const byId = new Map(entries.map(row => [Number(row.id), identityOf(row)]));
  const priors = (await db.query(
    `SELECT se.id, se.name, se.tags, se.org_id, se.program_id,
            dl.wire, dl.external_id, COALESCE(dl.sent_at, dl.created_at) AS sent_at
     FROM distribution_logs dl
     JOIN scan_entries se ON se.id = dl.entry_id
     WHERE dl.channel = 'telegram'
       AND dl.status = 'success'
       AND NOT (dl.entry_id = ANY($1::int[]))
       AND COALESCE(dl.sent_at, dl.created_at) >= NOW() - make_interval(days => $2::int)
     ORDER BY COALESCE(dl.sent_at, dl.created_at) DESC, dl.id DESC`,
    [ids, windowDays],
  )).rows as Array<{
    id: number; name: string | null; tags: string[] | null; org_id: number | null; program_id: number | null;
    wire: string; external_id: string | null; sent_at: Date;
  }>;

  return ids.map(id => {
    const candidate = byId.get(id);
    const matched = candidate
      ? priors.filter(row => sameFunder(candidate, identityOf(row)))
      : [];
    return {
      entryId: id,
      held: matched.length > 0,
      windowDays,
      priors: matched.map(row => ({
        entryId: Number(row.id),
        name: row.name || '',
        wire: row.wire,
        externalId: row.external_id,
        sentAt: new Date(row.sent_at).toISOString(),
      })),
    };
  });
}

/**
 * Throws when any entry would repeat a funder who already posted.
 * An override with a reason returns the holds so the caller can audit them.
 */
export async function enforceRepeatFunderHold(
  db: Queryable,
  entryIds: number[],
  opts: { override?: boolean; reason?: string } = {},
): Promise<RepeatFunderHold[]> {
  const holds = (await repeatFunderHolds(db, entryIds)).filter(hold => hold.held);
  if (!holds.length) return [];
  if (!opts.override) throw new RepeatFunderHoldError(holds);
  if (!opts.reason?.trim()) throw new RepeatFunderHoldError(holds, 400);
  return holds;
}

export async function recordRepeatFunderOverride(
  db: Queryable,
  holds: RepeatFunderHold[],
  actor: string,
  reason: string,
): Promise<void> {
  const at = new Date().toISOString();
  for (const hold of holds) {
    const record = {
      at,
      actor,
      reason,
      windowDays: hold.windowDays,
      priors: hold.priors,
    };
    await db.query(
      `UPDATE scan_entries
       SET metadata = jsonb_set(
         COALESCE(metadata, '{}'::jsonb),
         '{repeat_funder_overrides}',
         COALESCE(metadata->'repeat_funder_overrides', '[]'::jsonb) || $2::jsonb
       )
       WHERE id = $1`,
      [hold.entryId, JSON.stringify([record])],
    );
  }
}

export async function repeatFunderStatus(entryId: number): Promise<RepeatFunderHold | null> {
  const found = (await getPool().query(`SELECT id FROM scan_entries WHERE id = $1`, [entryId])).rows[0];
  if (!found) return null;
  const [hold] = await repeatFunderHolds(getPool(), [entryId]);
  return hold;
}
