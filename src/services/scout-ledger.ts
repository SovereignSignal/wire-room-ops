/**
 * The scout ledger: one scout_runs row per grant-wire-scout run and one
 * scout_alerts row per exception alert. The scouts write through /api/scout
 * with a `ledger` key and read back through /api/read. Contract:
 * docs/read-api.md. Schema: src/db/scout-ledger.ts.
 */
import type { Pool, PoolClient } from 'pg';
import { CORE_WIRES, isCoreWire } from '../db';
import { redactSecrets } from './curator-audit';

/** The statuses run-scout.sh passes to lib/ledger.py. */
export const SCOUT_RUN_STATUSES = ['ok', 'skipped', 'auth', 'quota', 'empty', 'timeout', 'delivery', 'failed', 'other'] as const;
export type ScoutRunStatus = typeof SCOUT_RUN_STATUSES[number];

/** Run ids look like claude-code-2026-09-24T042656Z or grok-build-…-skipped. */
export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const VARIANT_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
const MODEL_PATTERN = /^[^\u0000-\u001f\u007f]{1,200}$/;
const ERROR_CLASS_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;
const CHANNELS_PATTERN = /^[a-z0-9_-]{1,32}(?:,[a-z0-9_-]{1,32}){0,7}$/;
const MAX_COUNT = 1_000_000;
// duration_ms may be INTEGER on a table grant-wire-scout created by hand.
const MAX_DURATION_MS = 2_147_483_647;
const MAX_COST_USD = 100_000;
const MAX_SUBJECT = 500;
const MAX_BODY = 32_000;
const CLOCK_SKEW_MS = 10 * 60 * 1000;
const EARLIEST_MS = Date.parse('2020-01-01T00:00:00Z');

const RUN_FIELDS = [
  'run_id', 'wire', 'variant', 'model', 'status', 'opportunity_count', 'found_count', 'dedup_dropped',
  'error_class', 'cost_usd', 'duration_ms', 'started_at', 'finished_at',
] as const;
const ALERT_FIELDS = ['subject', 'body', 'channels_ok'] as const;

/** Casts keep the JSON types stable whatever the hand-made table used. */
export const SCOUT_RUN_COLUMNS = `
  r.run_id, r.wire, r.variant, r.model, r.status, r.opportunity_count::int AS opportunity_count,
  r.found_count::int AS found_count, r.dedup_dropped::int AS dedup_dropped, r.error_class,
  r.cost_usd::float8 AS cost_usd, r.duration_ms::float8 AS duration_ms,
  r.started_at, r.finished_at, r.created_at, r.recorded_by`;

export const SCOUT_ALERT_COLUMNS = `a.id::int AS id, a.subject, a.channels_ok, a.created_at, a.recorded_by`;

type Db = Pool | PoolClient;

export class LedgerInputError extends Error {}

export interface ScoutRunInput {
  runId: string;
  wire: string;
  variant: string | null;
  model: string | null;
  status: ScoutRunStatus;
  opportunityCount: number | null;
  foundCount: number | null;
  dedupDropped: number | null;
  errorClass: string | null;
  costUsd: number | null;
  durationMs: number | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface ScoutAlertInput {
  subject: string;
  body: string | null;
  channelsOk: string;
}

function fields(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new LedgerInputError('Body must be a JSON object');
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record).filter(key => !allowed.includes(key));
  if (unknown.length) throw new LedgerInputError(`Unknown field: ${unknown.join(', ')}`);
  return record;
}

function wholeNumber(record: Record<string, unknown>, name: string, max = MAX_COUNT): number | null {
  const value = record[name];
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    throw new LedgerInputError(`${name} must be a whole number from 0 to ${max}`);
  }
  return value;
}

function matching(record: Record<string, unknown>, name: string, pattern: RegExp): string | null {
  const value = record[name];
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !pattern.test(value)) throw new LedgerInputError(`Invalid ${name}`);
  return value;
}

function pastTimestamp(record: Record<string, unknown>, name: string, now: number): Date | null {
  const value = record[name];
  if (value == null) return null;
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isNaN(ms) || ms < EARLIEST_MS || ms > now + CLOCK_SKEW_MS) {
    throw new LedgerInputError(`${name} must be an ISO 8601 timestamp that is not in the future`);
  }
  return new Date(ms);
}

function scrub(value: string): string {
  return redactSecrets(value) as string;
}

/** PUT body for one run. Omitted fields are recorded as unknown, the way ledger.py writes them. */
export function parseScoutRun(runId: string, body: unknown, now = Date.now()): ScoutRunInput {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new LedgerInputError('run_id must be 1-200 characters from A-Z a-z 0-9 . _ : - starting with a letter or digit');
  }
  const record = fields(body, RUN_FIELDS);
  if (record.run_id != null && record.run_id !== runId) throw new LedgerInputError('run_id in the body does not match the path');

  const status = record.status;
  if (typeof status !== 'string' || !(SCOUT_RUN_STATUSES as readonly string[]).includes(status)) {
    throw new LedgerInputError(`status must be one of ${SCOUT_RUN_STATUSES.join(', ')}`);
  }
  let wire = '';
  if (record.wire != null && record.wire !== '') {
    if (typeof record.wire !== 'string' || !isCoreWire(record.wire)) {
      throw new LedgerInputError(`wire must be one of ${CORE_WIRES.join(', ')}, or empty when unknown`);
    }
    wire = record.wire;
  }
  const cost = record.cost_usd;
  if (cost != null && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0 || cost > MAX_COST_USD)) {
    throw new LedgerInputError(`cost_usd must be a number from 0 to ${MAX_COST_USD}`);
  }
  const startedAt = pastTimestamp(record, 'started_at', now);
  const finishedAt = pastTimestamp(record, 'finished_at', now);
  if (startedAt && finishedAt && startedAt > finishedAt) throw new LedgerInputError('started_at is after finished_at');

  return {
    runId,
    wire,
    variant: matching(record, 'variant', VARIANT_PATTERN),
    model: matching(record, 'model', MODEL_PATTERN),
    status: status as ScoutRunStatus,
    opportunityCount: wholeNumber(record, 'opportunity_count'),
    foundCount: wholeNumber(record, 'found_count'),
    dedupDropped: wholeNumber(record, 'dedup_dropped'),
    errorClass: matching(record, 'error_class', ERROR_CLASS_PATTERN),
    costUsd: (cost as number | null | undefined) ?? null,
    durationMs: wholeNumber(record, 'duration_ms', MAX_DURATION_MS),
    startedAt,
    finishedAt,
  };
}

export function parseScoutAlert(body: unknown): ScoutAlertInput {
  const record = fields(body, ALERT_FIELDS);
  const subject = typeof record.subject === 'string' ? record.subject.trim() : '';
  if (!subject) throw new LedgerInputError('subject is required');
  if (subject.length > MAX_SUBJECT) throw new LedgerInputError(`subject must be at most ${MAX_SUBJECT} characters`);
  let text: string | null = null;
  if (record.body != null) {
    if (typeof record.body !== 'string') throw new LedgerInputError('body must be a string');
    if (record.body.length > MAX_BODY) throw new LedgerInputError(`body must be at most ${MAX_BODY} characters`);
    text = scrub(record.body);
  }
  const channelsOk = matching(record, 'channels_ok', CHANNELS_PATTERN) ?? 'none';
  return { subject: scrub(subject), body: text, channelsOk };
}

/**
 * Upsert by run_id, as ledger.py does: the outcome fields are replaced, the
 * earliest started_at is kept, and wire/variant/model fill in only when the
 * row has none. A row belongs to the key that first wrote it through the API
 * (rows from direct SQL have no owner yet). Returns null when another key owns it.
 */
export async function upsertScoutRun(
  db: Db,
  input: ScoutRunInput,
  recordedBy: string,
): Promise<{ run: Record<string, unknown>; created: boolean } | null> {
  const { rows } = await db.query(
    `INSERT INTO scout_runs AS r
       (run_id, wire, variant, model, status, opportunity_count, found_count, dedup_dropped,
        error_class, cost_usd, duration_ms, started_at, finished_at, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, COALESCE($13::timestamptz, NOW()), $14)
     ON CONFLICT (run_id) DO UPDATE SET
       wire = CASE WHEN COALESCE(r.wire, '') = '' THEN EXCLUDED.wire ELSE r.wire END,
       variant = COALESCE(r.variant, EXCLUDED.variant),
       model = COALESCE(r.model, EXCLUDED.model),
       status = EXCLUDED.status,
       opportunity_count = EXCLUDED.opportunity_count,
       found_count = EXCLUDED.found_count,
       dedup_dropped = EXCLUDED.dedup_dropped,
       error_class = EXCLUDED.error_class,
       cost_usd = EXCLUDED.cost_usd,
       duration_ms = EXCLUDED.duration_ms,
       started_at = COALESCE(r.started_at, EXCLUDED.started_at),
       finished_at = EXCLUDED.finished_at,
       recorded_by = EXCLUDED.recorded_by
     WHERE r.recorded_by IS NULL OR r.recorded_by = EXCLUDED.recorded_by
     RETURNING (r.xmax = 0) AS created, ${SCOUT_RUN_COLUMNS}`,
    [
      input.runId, input.wire, input.variant, input.model, input.status, input.opportunityCount,
      input.foundCount, input.dedupDropped, input.errorClass, input.costUsd, input.durationMs,
      input.startedAt, input.finishedAt, recordedBy,
    ],
  );
  if (rows.length === 0) return null;
  const { created, ...run } = rows[0];
  return { run, created: Boolean(created) };
}

export type AlertWrite =
  | { kind: 'created' | 'replayed'; alert: Record<string, unknown> }
  | { kind: 'conflict' };

/**
 * Insert one alert. With an idempotency key, a retry of the same alert by the
 * same key returns the stored row; the same key with a different alert is a conflict.
 */
export async function insertScoutAlert(
  db: Db,
  input: ScoutAlertInput,
  recordedBy: string,
  idempotencyKey: string | null,
): Promise<AlertWrite> {
  const inserted = await db.query(
    `INSERT INTO scout_alerts AS a (subject, body, channels_ok, recorded_by, idempotency_key)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (recorded_by, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING ${SCOUT_ALERT_COLUMNS}`,
    [input.subject, input.body, input.channelsOk, recordedBy, idempotencyKey],
  );
  if (inserted.rows[0]) return { kind: 'created', alert: inserted.rows[0] };

  const existing = await db.query(
    `SELECT ${SCOUT_ALERT_COLUMNS}, a.body AS stored_body
     FROM scout_alerts a WHERE a.recorded_by = $1 AND a.idempotency_key = $2`,
    [recordedBy, idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) return { kind: 'conflict' };
  const { stored_body: storedBody, ...alert } = row;
  const same = alert.subject === input.subject && storedBody === input.body && alert.channels_ok === input.channelsOk;
  return same ? { kind: 'replayed', alert } : { kind: 'conflict' };
}
