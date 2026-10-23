/**
 * Read API: named, read-only views for agents and ops scripts that used to
 * run raw SQL over the public database proxy (wro-ro-query, the scout
 * heartbeat and digest, box QC scripts). Contract: docs/read-api.md.
 *
 * Mounted at /api/read behind requireAuthOrCurator. A curator key needs
 * read_queue; any other method is forbidden. Each request runs in one
 * READ ONLY transaction with a statement timeout, and raw_output never
 * leaves the database.
 */

import { Router, Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { getPool, isCoreWire } from '../db';
import { QUEUE_CLASSIFICATIONS } from '../db/entry-query';
import { SCAN_SOURCES, SCAN_STATUSES, DistributionChannel, DistributionStatus } from '../types/intake';
import { reviewedApprovalRate } from '../services/approval-rate';
import { urlLookupKeys } from '../utils/url';

const router = Router();

const STATEMENT_TIMEOUT = '15s';
const HOUR_MS = 60 * 60 * 1000;
const MAX_WINDOW_HOURS = 400 * 24;
const DELIVERY_STATUSES: readonly DistributionStatus[] = ['pending', 'success', 'failed', 'skipped', 'acknowledged'];
const DELIVERY_CHANNELS: readonly DistributionChannel[] = ['telegram', 'discord', 'slack', 'x', 'newsletter'];

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

type Query = Request['query'];

function single(q: Query, name: string): string | undefined {
  const raw = q[name];
  if (raw == null) return undefined;
  if (typeof raw !== 'string') throw new HttpError(400, `${name} must be given once`);
  const value = raw.trim();
  return value === '' ? undefined : value;
}

function csv(q: Query, name: string, allowed?: readonly string[]): string[] {
  const raw = q[name];
  const parts = (Array.isArray(raw) ? raw : raw == null ? [] : [raw]).flatMap(v => String(v).split(','));
  const values = [...new Set(parts.map(v => v.trim()).filter(Boolean))];
  if (allowed) {
    const unknown = values.filter(v => !allowed.includes(v));
    if (unknown.length) throw new HttpError(400, `Unknown ${name}: ${unknown.join(', ')}`);
  }
  return values;
}

function integer(q: Query, name: string, opts: { fallback: number; min: number; max: number }): number {
  const raw = single(q, name);
  if (raw === undefined) return opts.fallback;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, `${name} must be a whole number`);
  const value = Number(raw);
  if (value < opts.min || value > opts.max) throw new HttpError(400, `${name} must be between ${opts.min} and ${opts.max}`);
  return value;
}

function optionalId(q: Query, name: string): number | undefined {
  if (single(q, name) === undefined) return undefined;
  return integer(q, name, { fallback: 0, min: 1, max: 2_147_483_647 });
}

function wireParam(q: Query): string | undefined {
  const wire = single(q, 'wire');
  if (wire !== undefined && !isCoreWire(wire)) throw new HttpError(400, `Unknown wire: ${wire}`);
  return wire;
}

function timestamp(q: Query, name: string): Date | null {
  const raw = single(q, name);
  if (raw === undefined) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) throw new HttpError(400, `${name} must be an ISO 8601 date or timestamp`);
  return new Date(ms);
}

interface Window {
  since: Date | null;
  until: Date | null;
}

/**
 * hours, days, or since (+ optional until). One of hours/days/since at most.
 * defaultHours null means no lower bound when none is given.
 */
function windowParam(q: Query, defaultHours: number | null, maxHours = MAX_WINDOW_HOURS): Window {
  const given = ['hours', 'days', 'since'].filter(name => single(q, name) !== undefined);
  if (given.length > 1) throw new HttpError(400, `Use only one of ${given.join(', ')}`);
  const until = timestamp(q, 'until');
  let since: Date | null = null;
  if (given[0] === 'since') {
    since = timestamp(q, 'since');
  } else {
    let hours: number | null = defaultHours;
    if (given[0] === 'hours') hours = integer(q, 'hours', { fallback: 0, min: 1, max: maxHours });
    if (given[0] === 'days') hours = integer(q, 'days', { fallback: 0, min: 1, max: Math.floor(maxHours / 24) }) * 24;
    if (hours !== null) since = new Date(Date.now() - hours * HOUR_MS);
  }
  if (since && until && since >= until) throw new HttpError(400, 'since must be before until');
  return { since, until };
}

function include(q: Query, field: string): boolean {
  return csv(q, 'include', [field]).includes(field);
}

class Filters {
  readonly params: unknown[] = [];
  private readonly clauses: string[] = [];

  bind(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  add(clause: string): void {
    this.clauses.push(clause);
  }

  window(column: string, w: Window): void {
    if (w.since) this.add(`${column} >= ${this.bind(w.since)}`);
    if (w.until) this.add(`${column} < ${this.bind(w.until)}`);
  }

  where(): string {
    return this.clauses.length ? `WHERE ${this.clauses.join(' AND ')}` : '';
  }
}

function windowOut(w: Window): { since: string | null; until: string | null } {
  return { since: w.since?.toISOString() ?? null, until: w.until?.toISOString() ?? null };
}

async function readOnly<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await getPool().connect();
  try {
    await db.query('BEGIN READ ONLY');
    await db.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
    const result = await work(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

function read(path: string, handler: (req: Request) => Promise<unknown>): void {
  router.get(path, async (req: Request, res: Response) => {
    try {
      res.json(await handler(req));
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      console.error(`[ReadAPI] GET /api/read${path} failed:`, error);
      res.status(500).json({ error: 'read_failed' });
    }
  });
}

/** limit + 1 rows were fetched; trim and report whether more exist. */
function page<T>(rows: T[], limit: number): { rows: T[]; hasMore: boolean } {
  return rows.length > limit ? { rows: rows.slice(0, limit), hasMore: true } : { rows, hasMore: false };
}

const ENTRY_COLUMNS = `
  e.id, e.name, e.description, e.enriched_summary, e.source_url, e.amount, e.deadline,
  e.deadline_parsed::text AS deadline_parsed, e.wire, e.scan_source, e.submitted_by, e.status,
  e.classification, e.classification_reason, e.quality_score,
  e.quality_breakdown->>'scoreReason' AS quality_reason,
  e.metadata->>'operator_route' AS operator_route, e.metadata->'curator' AS curator,
  e.lifecycle, e.tags, e.org_id, e.program_id, e.duplicate_of_id, e.duplicate_reason,
  e.operator_notes, e.distributable, e.actioned_by, e.action_reason, e.decision_at,
  e.created_at, e.updated_at`;

// Queue rows by status, a producer's recent rows, or any filtered slice.
read('/entries', async req => {
  const q = req.query;
  const statuses = csv(q, 'status', SCAN_STATUSES);
  const sources = csv(q, 'source', SCAN_SOURCES);
  const classifications = csv(q, 'classification', QUEUE_CLASSIFICATIONS);
  const wire = wireParam(q);
  const submittedBy = single(q, 'submitted_by');
  const window = windowParam(q, null);
  const beforeId = optionalId(q, 'before_id');
  const afterId = optionalId(q, 'after_id');
  const order = single(q, 'order') ?? 'newest';
  if (order !== 'newest' && order !== 'oldest') throw new HttpError(400, 'order must be newest or oldest');
  const limit = integer(q, 'limit', { fallback: 100, min: 1, max: 500 });
  const withMetadata = include(q, 'metadata');

  const f = new Filters();
  if (statuses.length) f.add(`e.status = ANY(${f.bind(statuses)}::text[])`);
  if (sources.length) f.add(`e.scan_source = ANY(${f.bind(sources)}::text[])`);
  if (classifications.length) f.add(`e.classification = ANY(${f.bind(classifications)}::text[])`);
  if (wire) f.add(`e.wire = ${f.bind(wire)}`);
  if (submittedBy) f.add(`e.submitted_by = ${f.bind(submittedBy)}`);
  f.window('e.created_at', window);
  if (beforeId) f.add(`e.id < ${f.bind(beforeId)}`);
  if (afterId) f.add(`e.id > ${f.bind(afterId)}`);

  const { rows } = await readOnly(db => db.query(
    `SELECT ${ENTRY_COLUMNS}${withMetadata ? ', e.metadata' : ''}
     FROM scan_entries e
     ${f.where()}
     ORDER BY e.id ${order === 'newest' ? 'DESC' : 'ASC'}
     LIMIT ${f.bind(limit + 1)}`,
    f.params,
  ));
  const out = page(rows, limit);
  const last = out.rows[out.rows.length - 1];
  return {
    entries: out.rows,
    count: out.rows.length,
    has_more: out.hasMore,
    next: out.hasMore && last ? { [order === 'newest' ? 'before_id' : 'after_id']: last.id } : null,
    window: windowOut(window),
  };
});

// One entry with all metadata, its delivery logs, and its publication row.
read('/entries/:id', async req => {
  const id = /^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN;
  if (!(id >= 1 && id <= 2_147_483_647)) throw new HttpError(400, 'Invalid entry id');
  return readOnly(async db => {
    const entry = await db.query(`SELECT to_jsonb(e) - 'raw_output' AS entry FROM scan_entries e WHERE e.id = $1`, [id]);
    if (entry.rows.length === 0) throw new HttpError(404, 'not_found');
    const [deliveries, publication] = await Promise.all([
      db.query(
        `SELECT id, channel, wire, status, external_id, error_message, needs_review, post_text, channel_id,
                sent_at, created_at, acknowledged_at, acknowledged_by, acknowledged_reason, resolved_by, resolved_at
         FROM distribution_logs WHERE entry_id = $1 ORDER BY created_at, id`,
        [id],
      ),
      db.query(
        `SELECT status, attempts, available_at, error_message, post_text, generated_at, model,
                check_result, verifier_result, created_at, updated_at
         FROM publication_queue WHERE entry_id = $1`,
        [id],
      ),
    ]);
    return { entry: entry.rows[0].entry, deliveries: deliveries.rows, publication: publication.rows[0] ?? null };
  });
});

// Recent approvals by recorded decision date, with publication and delivery state.
read('/approvals', async req => {
  const q = req.query;
  const wire = wireParam(q);
  const actionedBy = single(q, 'actioned_by');
  const window = windowParam(q, 24, 90 * 24);
  const limit = integer(q, 'limit', { fallback: 200, min: 1, max: 500 });

  const f = new Filters();
  f.add(`e.status = 'approved'`);
  f.add('e.decision_at IS NOT NULL');
  f.window('e.decision_at', window);
  if (wire) f.add(`e.wire = ${f.bind(wire)}`);
  if (actionedBy) f.add(`e.actioned_by = ${f.bind(actionedBy)}`);

  const { rows } = await readOnly(db => db.query(
    `SELECT e.id, e.name, e.wire, e.scan_source, e.submitted_by, e.source_url, e.amount, e.deadline,
            e.classification, e.quality_score, e.metadata->>'operator_route' AS operator_route,
            e.actioned_by, e.action_reason, e.distributable, e.decision_at, e.created_at,
            pq.status AS publication_status, pq.available_at AS publication_available_at,
            COALESCE((
              SELECT json_agg(json_build_object(
                'channel', dl.channel, 'wire', dl.wire, 'status', dl.status,
                'external_id', dl.external_id, 'sent_at', dl.sent_at, 'created_at', dl.created_at
              ) ORDER BY dl.created_at, dl.id)
              FROM distribution_logs dl WHERE dl.entry_id = e.id
            ), '[]'::json) AS deliveries
     FROM scan_entries e
     LEFT JOIN publication_queue pq ON pq.entry_id = e.id
     ${f.where()}
     ORDER BY e.decision_at DESC, e.id DESC
     LIMIT ${f.bind(limit + 1)}`,
    f.params,
  ));
  const out = page(rows, limit);
  return { approvals: out.rows, count: out.rows.length, truncated: out.hasMore, window: windowOut(window) };
});

// Delivery logs (distribution_logs), newest first.
read('/deliveries', async req => {
  const q = req.query;
  const statuses = csv(q, 'status', DELIVERY_STATUSES);
  const channels = csv(q, 'channel', DELIVERY_CHANNELS);
  const wire = wireParam(q);
  const entryId = optionalId(q, 'entry_id');
  const window = windowParam(q, entryId ? null : 7 * 24);
  const beforeId = optionalId(q, 'before_id');
  const limit = integer(q, 'limit', { fallback: 200, min: 1, max: 1000 });
  const withPostText = include(q, 'post_text');

  const f = new Filters();
  if (statuses.length) f.add(`dl.status = ANY(${f.bind(statuses)}::text[])`);
  if (channels.length) f.add(`dl.channel = ANY(${f.bind(channels)}::text[])`);
  if (wire) f.add(`dl.wire = ${f.bind(wire)}`);
  if (entryId) f.add(`dl.entry_id = ${f.bind(entryId)}`);
  f.window('dl.created_at', window);
  if (beforeId) f.add(`dl.id < ${f.bind(beforeId)}`);

  const { rows } = await readOnly(db => db.query(
    `SELECT dl.id, dl.entry_id, e.name AS entry_name, dl.channel, dl.wire, dl.status, dl.external_id,
            dl.error_message, dl.needs_review, dl.channel_id, dl.sent_at, dl.created_at,
            dl.acknowledged_at, dl.acknowledged_by, dl.resolved_by, dl.resolved_at
            ${withPostText ? ', dl.post_text' : ''}
     FROM distribution_logs dl
     LEFT JOIN scan_entries e ON e.id = dl.entry_id
     ${f.where()}
     ORDER BY dl.id DESC
     LIMIT ${f.bind(limit + 1)}`,
    f.params,
  ));
  const out = page(rows, limit);
  const last = out.rows[out.rows.length - 1];
  return {
    deliveries: out.rows,
    count: out.rows.length,
    has_more: out.hasMore,
    next: out.hasMore && last ? { before_id: last.id } : null,
    window: windowOut(window),
  };
});

// Seen URLs: exact lookup with ?url=, otherwise an incremental list by id.
read('/seen-urls', async req => {
  const q = req.query;
  const wire = wireParam(q);
  const url = single(q, 'url');

  if (url !== undefined) {
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
    let parsed: URL | null = null;
    try {
      parsed = new URL(candidate);
    } catch {
      parsed = null;
    }
    const keys = parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.includes('.')
      ? urlLookupKeys(candidate)
      : [];
    if (keys.length === 0) throw new HttpError(400, 'url must be an http(s) URL');
    const f = new Filters();
    f.add(`s.normalized_url = ANY(${f.bind(keys)}::text[])`);
    if (wire) f.add(`s.wire = ${f.bind(wire)}`);
    const { rows } = await readOnly(db => db.query(
      `SELECT s.id, s.url, s.normalized_url, s.wire, s.first_seen_entry_id, s.first_seen_date::text AS first_seen_date,
              s.created_at, e.status AS entry_status, e.name AS entry_name
       FROM seen_urls s
       LEFT JOIN scan_entries e ON e.id = s.first_seen_entry_id
       ${f.where()}
       ORDER BY s.id`,
      f.params,
    ));
    return { url, normalized_url: keys[0], seen: rows.length > 0, matches: rows };
  }

  const scope = single(q, 'scope') ?? 'all';
  if (scope !== 'all' && scope !== 'seed') throw new HttpError(400, 'scope must be all or seed');
  const window = windowParam(q, null);
  const afterId = optionalId(q, 'after_id');
  const limit = integer(q, 'limit', { fallback: 1000, min: 1, max: 5000 });

  const f = new Filters();
  if (scope === 'seed') f.add('s.first_seen_entry_id IS NULL');
  if (wire) f.add(`s.wire = ${f.bind(wire)}`);
  f.window('s.created_at', window);
  if (afterId) f.add(`s.id > ${f.bind(afterId)}`);

  const { rows } = await readOnly(db => db.query(
    `SELECT s.id, s.url, s.normalized_url, s.wire, s.first_seen_entry_id,
            s.first_seen_date::text AS first_seen_date, s.created_at
     FROM seen_urls s
     ${f.where()}
     ORDER BY s.id
     LIMIT ${f.bind(limit + 1)}`,
    f.params,
  ));
  const out = page(rows, limit);
  const last = out.rows[out.rows.length - 1];
  return {
    urls: out.rows,
    count: out.rows.length,
    has_more: out.hasMore,
    next: out.hasMore && last ? { after_id: last.id } : null,
    window: windowOut(window),
  };
});

const COUNT_DIMENSIONS: Record<string, { select: string[]; keys: string[] }> = {
  source: { select: ['e.scan_source AS source'], keys: ['source'] },
  wire: { select: ['e.wire AS wire'], keys: ['wire'] },
  submitted_by: { select: ['e.submitted_by AS submitted_by'], keys: ['submitted_by'] },
  classification: { select: ['e.classification AS classification'], keys: ['classification'] },
  route: { select: [`e.metadata->>'operator_route' AS route`], keys: ['route'] },
  prompt: { select: ['e.prompt_id::text AS prompt_id', 'p.label AS prompt_label'], keys: ['prompt_id', 'prompt_label'] },
  variant: { select: ['e.prompt_variant AS variant'], keys: ['variant'] },
  day: { select: [`(e.created_at AT TIME ZONE 'UTC')::date::text AS day`], keys: ['day'] },
  week: { select: [`date_trunc('week', e.created_at AT TIME ZONE 'UTC')::date::text AS week`], keys: ['week'] },
};

interface CountTally {
  total: number;
  by_status: Record<string, number>;
  score_sum: number;
  scored: number;
}

interface CountGroup extends CountTally {
  [key: string]: unknown;
  first_created_at: Date | null;
  last_created_at: Date | null;
}

function summarize<T extends CountTally>(group: T) {
  const { score_sum, scored, ...rest } = group;
  const approved = group.by_status.approved || 0;
  const declined = group.by_status.declined || 0;
  const duplicate = group.by_status.duplicate || 0;
  return {
    ...rest,
    approval_rate: reviewedApprovalRate(approved, declined),
    dup_rate: group.total > 0 ? Math.round((duplicate / group.total) * 1000) / 1000 : null,
    avg_quality_score: scored > 0 ? Math.round((score_sum / scored) * 10) / 10 : null,
  };
}

// Intake counts per source (or wire, producer, prompt, variant, route, day, week), split by status.
read('/intake-counts', async req => {
  const q = req.query;
  const by = csv(q, 'by', Object.keys(COUNT_DIMENSIONS));
  const dimensions = by.length ? by : ['source'];
  const sources = csv(q, 'source', SCAN_SOURCES);
  const statuses = csv(q, 'status', SCAN_STATUSES);
  const wire = wireParam(q);
  const submittedBy = single(q, 'submitted_by');
  const window = windowParam(q, 7 * 24);

  const f = new Filters();
  if (sources.length) f.add(`e.scan_source = ANY(${f.bind(sources)}::text[])`);
  if (statuses.length) f.add(`e.status = ANY(${f.bind(statuses)}::text[])`);
  if (wire) f.add(`e.wire = ${f.bind(wire)}`);
  if (submittedBy) f.add(`e.submitted_by = ${f.bind(submittedBy)}`);
  f.window('e.created_at', window);

  const select = dimensions.flatMap(d => COUNT_DIMENSIONS[d].select);
  const keys = dimensions.flatMap(d => COUNT_DIMENSIONS[d].keys);
  const groupBy = select.map((_, i) => String(i + 1));
  const statusPosition = select.length + 1;
  const { rows } = await readOnly(db => db.query(
    `SELECT ${select.join(', ')}, e.status AS status, COUNT(*)::int AS n,
            COALESCE(SUM(e.quality_score), 0)::float8 AS score_sum, COUNT(e.quality_score)::int AS scored,
            MIN(e.created_at) AS first_created_at, MAX(e.created_at) AS last_created_at
     FROM scan_entries e
     ${dimensions.includes('prompt') ? 'LEFT JOIN scan_prompts p ON p.id = e.prompt_id' : ''}
     ${f.where()}
     GROUP BY ${[...groupBy, String(statusPosition)].join(', ')}
     ORDER BY ${[...groupBy, String(statusPosition)].join(', ')}`,
    f.params,
  ));

  const groups = new Map<string, CountGroup>();
  const totals: CountTally = { total: 0, by_status: {}, score_sum: 0, scored: 0 };
  for (const row of rows) {
    const id = JSON.stringify(keys.map(k => row[k]));
    let group = groups.get(id);
    if (!group) {
      group = { total: 0, by_status: {}, score_sum: 0, scored: 0, first_created_at: null, last_created_at: null };
      for (const k of keys) group[k] = row[k];
      groups.set(id, group);
    }
    for (const tally of [group, totals]) {
      tally.total += row.n;
      tally.by_status[row.status] = (tally.by_status[row.status] || 0) + row.n;
      tally.score_sum += row.score_sum;
      tally.scored += row.scored;
    }
    if (!group.first_created_at || row.first_created_at < group.first_created_at) group.first_created_at = row.first_created_at;
    if (!group.last_created_at || row.last_created_at > group.last_created_at) group.last_created_at = row.last_created_at;
  }

  return {
    by: dimensions,
    window: windowOut(window),
    groups: [...groups.values()].map(summarize),
    totals: summarize(totals),
  };
});

// Rows still waiting in the pipeline, per wire and status, with the oldest age.
read('/backlog', async req => {
  const q = req.query;
  const requested = csv(q, 'status', SCAN_STATUSES);
  const statuses = requested.length ? requested : ['raw', 'queued'];
  const wire = wireParam(q);

  const f = new Filters();
  f.add(`status = ANY(${f.bind(statuses)}::text[])`);
  if (wire) f.add(`wire = ${f.bind(wire)}`);
  const { rows } = await readOnly(db => db.query(
    `SELECT wire, status, COUNT(*)::int AS count,
            MIN(created_at) AS oldest_created_at, MAX(created_at) AS newest_created_at
     FROM scan_entries
     ${f.where()}
     GROUP BY wire, status
     ORDER BY wire, status`,
    f.params,
  ));
  return { statuses, backlog: rows };
});

// Program names a scout should not resubmit: decided rows by status, plus the
// caller's own rows when source is given (origin "self", listed first).
read('/names', async req => {
  const q = req.query;
  const wire = wireParam(q);
  if (!wire) throw new HttpError(400, 'wire is required');
  const statuses = csv(q, 'status', SCAN_STATUSES);
  const sources = csv(q, 'source', SCAN_SOURCES);
  if (statuses.length === 0 && sources.length === 0) throw new HttpError(400, 'Give status, source, or both');
  const days = integer(q, 'days', { fallback: 120, min: 1, max: 730 });
  const limit = integer(q, 'limit', { fallback: 400, min: 1, max: 10000 });

  const f = new Filters();
  const selfSources = f.bind(sources);
  f.add(`e.wire = ${f.bind(wire)}`);
  f.add('e.name IS NOT NULL AND length(trim(e.name)) >= 3');
  f.add(`e.created_at >= NOW() - make_interval(days => ${f.bind(days)}::int)`);
  f.add(`(e.scan_source = ANY(${selfSources}::text[]) OR e.status = ANY(${f.bind(statuses)}::text[]))`);

  const { rows } = await readOnly(db => db.query(
    `SELECT e.name AS name,
            CASE WHEN bool_or(e.scan_source = ANY(${selfSources}::text[])) THEN 'self' ELSE 'decided' END AS origin,
            array_agg(DISTINCT e.status ORDER BY e.status) AS statuses,
            MAX(e.created_at) AS last_seen
     FROM scan_entries e
     ${f.where()}
     GROUP BY e.name
     ORDER BY MIN(CASE WHEN e.scan_source = ANY(${selfSources}::text[]) THEN 0 ELSE 1 END), MAX(e.created_at) DESC, e.name
     LIMIT ${f.bind(limit + 1)}`,
    f.params,
  ));
  const out = page(rows, limit);
  return { wire, days, names: out.rows, count: out.rows.length, truncated: out.hasMore };
});

// API spend per UTC day, provider, model, job, and purpose (api_usage_log).
read('/usage-daily', async req => {
  const q = req.query;
  const wire = wireParam(q);
  const provider = single(q, 'provider');
  const job = single(q, 'job');
  const purpose = single(q, 'purpose');
  const window = windowParam(q, 7 * 24, 90 * 24);

  const f = new Filters();
  f.window('created_at', window);
  if (wire) f.add(`wire = ${f.bind(wire)}`);
  if (provider) f.add(`provider = ${f.bind(provider)}`);
  if (job) f.add(`job = ${f.bind(job)}`);
  if (purpose) f.add(`purpose = ${f.bind(purpose)}`);

  const { rows } = await readOnly(db => db.query(
    `SELECT (created_at AT TIME ZONE 'UTC')::date::text AS day, provider, model, job, purpose,
            COUNT(*)::int AS calls,
            COALESCE(SUM(tokens_in), 0)::float8 AS tokens_in,
            COALESCE(SUM(tokens_out), 0)::float8 AS tokens_out,
            COALESCE(SUM(estimated_cost_usd), 0)::float8 AS estimated_cost_usd,
            COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL)::int AS unpriced_calls,
            COUNT(*) FILTER (WHERE NOT success)::int AS errors
     FROM api_usage_log
     ${f.where()}
     GROUP BY 1, 2, 3, 4, 5
     ORDER BY 1 DESC, estimated_cost_usd DESC`,
    f.params,
  ));
  return { window: windowOut(window), days: rows };
});

export { router as readApiRouter };
