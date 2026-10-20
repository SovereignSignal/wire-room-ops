/**
 * A funder that already landed on a Telegram wire stays off the queue for a
 * window (default 30 days). Match on org, program, or a normalized funder
 * name taken from the entry name and tags.
 *
 * Each EU Horizon topic ID is its own funder: a HORIZON-RAISE send does not
 * hold a HORIZON-BRIDGING topic. The hold lifts for a new program launch or
 * a pledge of $1M+. A liquidity incentive program is not a new launch.
 */

import type { Pool, PoolClient } from 'pg';
import { getPool } from '../db';
import { parseAmount } from './intake';
import { extractOrgFromName } from './org-extractor';

const PLEDGE_USD = 1_000_000;
const NEW_PROGRAM_LAUNCH = /\b(?:new (?:grant |funding )?(?:program|programme|fund|initiative)|(?:program|programme|fund) launch|launch(?:es|ing)|launched (?:a|an|its|their))\b/i;
const LIQUIDITY_INCENTIVE = /\bliquidity\s+incentiv\w*\b|\bliquidity\s+mining\b|\bliquidity\s+rewards?\b|\blp\s+incentiv\w*\b|\bincentiv\w*\s+liquidity\b/i;
const PLEDGE_LANGUAGE = /\b(?:pledg\w*|commit(?:s|ted|ment|ments)?|allocat(?:e|es|ed|ion|ions))\b/i;
const HORIZON_TOPIC = /\bHORIZON(?:-[A-Z0-9]+)+\b/i;

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

interface FunderFields {
  id?: number;
  name?: string | null;
  description?: string | null;
  sourceUrl?: string | null;
  source_url?: string | null;
  tags?: string[] | null;
  orgId?: number | null;
  org_id?: number | null;
  programId?: number | null;
  program_id?: number | null;
  amount?: string | null;
  amountNumeric?: number | string | null;
  amount_numeric?: number | string | null;
  metadata?: unknown;
}

interface Identity {
  id: number;
  orgId: number | null;
  programId: number | null;
  names: string[];
  rawName: string;
  rawTags: string[];
  description: string;
  sourceUrl: string;
  amountText: string;
  amountNumeric: number | null;
  metadataText: string;
}

function metadataText(metadata: unknown): string {
  if (metadata == null) return '';
  if (typeof metadata === 'string') return metadata;
  try {
    return JSON.stringify(metadata);
  } catch {
    return '';
  }
}

function firstHorizonTopic(text: string): string | null {
  const match = text.match(HORIZON_TOPIC);
  return match ? match[0].toUpperCase() : null;
}

/** The entry's own EU Horizon topic ID, preferring the URL and the title. */
export function horizonTopicId(input: FunderFields): string | null {
  const tags = Array.isArray(input.tags) ? input.tags.join(' ') : '';
  const fields = [
    input.sourceUrl || input.source_url || '',
    input.name || '',
    tags,
    input.description || '',
    metadataText(input.metadata),
  ];
  for (const field of fields) {
    const id = firstHorizonTopic(field);
    if (id) return id;
  }
  return null;
}

function finiteUsd(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Why this entry is not held. A $1M+ pledge lifts even for a liquidity
 * program. Liquidity incentive wording blocks only the launch lift.
 */
export function repeatFunderLift(input: FunderFields): 'new_program_launch' | 'pledge_1m' | null {
  const tags = Array.isArray(input.tags) ? input.tags : [];
  const text = [input.name || '', input.description || '', ...tags].join('\n');
  const stored = finiteUsd(input.amountNumeric ?? input.amount_numeric);
  const usd = stored ?? parseAmount(input.amount ?? null)?.numeric ?? null;
  if (usd != null && usd >= PLEDGE_USD && PLEDGE_LANGUAGE.test(text)) return 'pledge_1m';
  if (NEW_PROGRAM_LAUNCH.test(text) && !LIQUIDITY_INCENTIVE.test(text)) return 'new_program_launch';
  return null;
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

function identityOf(row: FunderFields & { id: number }): Identity {
  const tags = Array.isArray(row.tags) ? row.tags : [];
  const org = row.orgId ?? row.org_id;
  const program = row.programId ?? row.program_id;
  return {
    id: Number(row.id),
    orgId: org == null ? null : Number(org),
    programId: program == null ? null : Number(program),
    names: funderNameKeys(row.name, tags),
    rawName: row.name || '',
    rawTags: tags,
    description: row.description || '',
    sourceUrl: row.sourceUrl || row.source_url || '',
    amountText: row.amount || '',
    amountNumeric: finiteUsd(row.amountNumeric ?? row.amount_numeric),
    metadataText: metadataText(row.metadata),
  };
}

/** Same funder, except two different Horizon topic IDs. */
export function sameRepeatFunder(candidate: FunderFields & { id?: number }, prior: FunderFields & { id?: number }): boolean {
  return sameFunder(
    identityOf({ ...candidate, id: candidate.id ?? 0 }),
    identityOf({ ...prior, id: prior.id ?? 0 }),
  );
}

function mentions(identity: Identity, key: string): boolean {
  const haystack = normalizeFunderName([identity.rawName, ...identity.rawTags].join(' '));
  const needle = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  return new RegExp(`(?:^|\\s)${needle}(?:\\s|$)`).test(haystack);
}

function asFunderFields(identity: Identity): FunderFields {
  return {
    id: identity.id,
    name: identity.rawName,
    description: identity.description,
    sourceUrl: identity.sourceUrl,
    tags: identity.rawTags,
    orgId: identity.orgId,
    programId: identity.programId,
    amount: identity.amountText,
    amountNumeric: identity.amountNumeric,
    metadata: identity.metadataText,
  };
}

function sameFunder(candidate: Identity, prior: Identity): boolean {
  const candidateTopic = horizonTopicId(asFunderFields(candidate));
  const priorTopic = horizonTopicId(asFunderFields(prior));
  if (candidateTopic && priorTopic) return candidateTopic === priorTopic;
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
    `SELECT id, name, description, source_url, tags, org_id, program_id, amount, amount_numeric, metadata
     FROM scan_entries WHERE id = ANY($1::int[])`,
    [ids],
  )).rows as Array<FunderFields & { id: number }>;
  const byId = new Map(entries.map(row => [Number(row.id), identityOf(row)]));
  const priors = (await db.query(
    `SELECT se.id, se.name, se.description, se.source_url, se.tags, se.org_id, se.program_id,
            se.amount, se.amount_numeric, se.metadata,
            dl.wire, dl.external_id, COALESCE(dl.sent_at, dl.created_at) AS sent_at
     FROM distribution_logs dl
     JOIN scan_entries se ON se.id = dl.entry_id
     WHERE dl.channel = 'telegram'
       AND dl.status = 'success'
       AND NOT (dl.entry_id = ANY($1::int[]))
       AND COALESCE(dl.sent_at, dl.created_at) >= NOW() - make_interval(days => $2::int)
     ORDER BY COALESCE(dl.sent_at, dl.created_at) DESC, dl.id DESC`,
    [ids, windowDays],
  )).rows as Array<FunderFields & {
    id: number;
    wire: string; external_id: string | null; sent_at: Date;
  }>;

  return ids.map(id => {
    const candidate = byId.get(id);
    const lift = candidate ? repeatFunderLift(asFunderFields(candidate)) : null;
    const matched = candidate && !lift
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
