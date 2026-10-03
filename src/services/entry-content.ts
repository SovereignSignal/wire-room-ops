/**
 * Curator edits to the fields a Telegram post is built from, plus the record
 * fields that do not go into that post, and the release of a withheld
 * publication. Neither path books a slot or sends.
 *
 * Post text (name, description, enriched_summary, the amount column, deadline,
 * source_url) is refused when a publication is already sent, sending, in
 * review, or booked (`queued`). Classification, tags, and metadata.amount are
 * not inputs to post generation, so a patch that sets only those can land
 * after a send. Releasing a withhold deletes that queue row and leaves the
 * entry approved. Enqueue stays POST /api/distribution/queue/:id/enqueue.
 */

import type { Pool } from 'pg';
import { getPool } from '../db';
import { QUEUE_CLASSIFICATIONS, type QueueClassification } from '../db/entry-query';
import { lockDuplicateGraph } from './duplicate-chain';
import { normalizeUrl, parseAmount, parseDeadline } from './intake';
import { findSummaryLeak } from './summary-guard';
import { blockedSourceDomain, classifySourceLink } from './source-filter';

const POST_TEXT_FIELDS = ['name', 'description', 'enriched_summary', 'amount', 'deadline', 'source_url'] as const;
const RECORD_FIELDS = ['classification', 'tags', 'metadata.amount'] as const;
const CONTENT_FIELDS = [...POST_TEXT_FIELDS, ...RECORD_FIELDS] as const;
const BODY_FIELDS = new Set<string>([...POST_TEXT_FIELDS, 'classification', 'tags', 'metadata']);
const CONTROL_FIELDS = new Set(['confirm', 'reason', 'sources', 'quotes', 'dryRun']);
const MAX_TAGS = 5;
const MAX_TAG_LENGTH = 60;

export type ContentField = typeof CONTENT_FIELDS[number];
type PostTextField = typeof POST_TEXT_FIELDS[number];

export interface ContentPatch {
  name?: string;
  description?: string;
  enriched_summary?: string | null;
  amount?: string | null;
  deadline?: string | null;
  source_url?: string;
  classification?: QueueClassification;
  tags?: string[];
  metadata?: { amount?: string | null };
}

export class ContentEditError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'ContentEditError';
  }
}

type TextResult = { ok: true; value: string | null } | { ok: false; error: string };

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function readText(
  value: unknown,
  label: string,
  opts: { min: number; max: number; nullable: boolean },
): TextResult {
  if (value === null) {
    return opts.nullable ? { ok: true, value: null } : fail(`${label} is required`);
  }
  if (typeof value !== 'string') return fail(`${label} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) {
    return fail(opts.nullable ? `${label} is empty. Send null to clear it.` : `${label} is required`);
  }
  if (trimmed.length < opts.min) return fail(`${label} must be at least ${opts.min} characters`);
  if (trimmed.length > opts.max) return fail(`${label} must be at most ${opts.max} characters`);
  return { ok: true, value: trimmed };
}

const NONE_DEADLINE = /^(?:none|none listed|n\/a|na|not specified|not listed|tbd|unknown|no deadline)$/i;

function readDeadline(value: unknown): TextResult {
  const text = readText(value, 'deadline', { min: 1, max: 50, nullable: true });
  if (!text.ok || text.value === null) return text;
  if (NONE_DEADLINE.test(text.value)) return { ok: true, value: null };
  if (/[;)(]/.test(text.value) || /https?:\/\//i.test(text.value)) {
    return fail('deadline looks like junk data');
  }
  return text;
}

function readAmount(value: unknown, label = 'amount'): TextResult {
  const text = readText(value, label, { min: 1, max: 80, nullable: true });
  if (!text.ok || text.value === null) return text;
  if (/https?:\/\//i.test(text.value) || text.value.includes(';')) return fail(`${label} looks like junk data`);
  const bare = text.value.match(/^\$(\d{1,3})$/);
  if (bare && parseInt(bare[1], 10) < 100) return fail(`${label} looks like a misparse`);
  if (/^\d+(?:\.\d+)?\s*m(?:o|os|onths?)?$/i.test(text.value)) return fail(`${label} looks like a duration, not a sum`);
  return text;
}

function readClassification(value: unknown): { ok: true; value: QueueClassification } | { ok: false; error: string } {
  if (typeof value !== 'string') return fail('classification must be a string');
  const trimmed = value.trim().toUpperCase();
  if (!(QUEUE_CLASSIFICATIONS as readonly string[]).includes(trimmed)) {
    return fail(`classification must be one of ${QUEUE_CLASSIFICATIONS.join(', ')}`);
  }
  return { ok: true, value: trimmed as QueueClassification };
}

function readTags(value: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return fail('tags must be an array of strings');
  if (value.length > MAX_TAGS) return fail(`tags must contain at most ${MAX_TAGS} labels`);
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') return fail('tags must be an array of strings');
    const trimmed = item.trim();
    if (!trimmed) return fail('tags must not include empty labels. Send [] to clear them.');
    if (trimmed.length > MAX_TAG_LENGTH) return fail(`tags must be at most ${MAX_TAG_LENGTH} characters`);
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return fail(`tags contains a duplicate ("${trimmed}")`);
    seen.add(key);
    tags.push(trimmed);
  }
  return { ok: true, value: tags };
}

function readMetadataAmount(value: unknown): TextResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('metadata must be an object');
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'amount') return fail(`Unknown metadata field "${key}"`);
  }
  if (!Object.prototype.hasOwnProperty.call(record, 'amount')) {
    return fail('metadata.amount is required when metadata is set');
  }
  return readAmount(record.amount, 'metadata.amount');
}

function readSourceUrl(value: unknown): TextResult {
  const text = readText(value, 'source_url', { min: 1, max: 2000, nullable: false });
  if (!text.ok || text.value === null) return text;
  const sourceClass = classifySourceLink(text.value);
  if (sourceClass !== 'ok' && sourceClass !== 'tweet-only') {
    return fail(`source_url is not a usable link (${sourceClass})`);
  }
  if (blockedSourceDomain(text.value)) return fail('source_url is a blocked aggregator');
  return text;
}

function readSummary(value: unknown): TextResult {
  const text = readText(value, 'enriched_summary', { min: 10, max: 8000, nullable: true });
  if (!text.ok || text.value === null) return text;
  const leak = findSummaryLeak(text.value);
  if (leak) return fail(`enriched_summary looks like model reasoning (${leak.rule})`);
  return text;
}

/** Accept a partial content edit. Control keys are ignored. Unknown keys are rejected. */
export function parseContentPatch(body: unknown): { ok: true; patch: ContentPatch } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('JSON object body is required');
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (CONTROL_FIELDS.has(key) || BODY_FIELDS.has(key)) continue;
    if (key === 'type') return fail('Unknown field "type". Send classification (GRANT, NEWS, EXPIRED, NOISE, UNCHECKED).');
    if (key === 'metadata.amount') return fail('Send metadata.amount as {"metadata":{"amount":"..."}}');
    return fail(`Unknown field "${key}"`);
  }

  const patch: ContentPatch = {};
  const take = (key: PostTextField, parsed: TextResult): { ok: false; error: string } | null => {
    if (!parsed.ok) return parsed;
    (patch as Record<string, string | null>)[key] = parsed.value;
    return null;
  };

  if ('name' in record) {
    const rejected = take('name', readText(record.name, 'name', { min: 1, max: 120, nullable: false }));
    if (rejected) return rejected;
  }
  if ('description' in record) {
    const rejected = take('description', readText(record.description, 'description', { min: 10, max: 8000, nullable: false }));
    if (rejected) return rejected;
  }
  if ('enriched_summary' in record) {
    const rejected = take('enriched_summary', readSummary(record.enriched_summary));
    if (rejected) return rejected;
  }
  if ('amount' in record) {
    const rejected = take('amount', readAmount(record.amount));
    if (rejected) return rejected;
  }
  if ('deadline' in record) {
    const rejected = take('deadline', readDeadline(record.deadline));
    if (rejected) return rejected;
  }
  if ('source_url' in record) {
    const rejected = take('source_url', readSourceUrl(record.source_url));
    if (rejected) return rejected;
  }
  if ('classification' in record) {
    const parsed = readClassification(record.classification);
    if (!parsed.ok) return parsed;
    patch.classification = parsed.value;
  }
  if ('tags' in record) {
    const parsed = readTags(record.tags);
    if (!parsed.ok) return parsed;
    patch.tags = parsed.value;
  }
  if ('metadata' in record) {
    const parsed = readMetadataAmount(record.metadata);
    if (!parsed.ok) return parsed;
    patch.metadata = { amount: parsed.value };
  }
  if (!hasContentEdit(patch)) {
    return fail('at least one of name, description, enriched_summary, amount, deadline, source_url, classification, tags, metadata.amount is required');
  }
  return { ok: true, patch };
}

function hasContentEdit(patch: ContentPatch): boolean {
  return POST_TEXT_FIELDS.some(field => field in patch)
    || 'classification' in patch
    || 'tags' in patch
    || metadataAmountSpecified(patch);
}

/** The amount column is post text. metadata.amount is the separate record field. */
function metadataAmountSpecified(patch: ContentPatch): boolean {
  return !!patch.metadata && Object.prototype.hasOwnProperty.call(patch.metadata, 'amount');
}

function patchTouchesPostText(patch: ContentPatch): boolean {
  return POST_TEXT_FIELDS.some(field => field in patch);
}

export interface ContentEditResult {
  success: true;
  entryId: number;
  dryRun: boolean;
  unchanged: boolean;
  changed: ContentField[];
  actioned_by: string | null;
  queueStatus: string | null;
  enqueued: false;
  sent: false;
  entry: {
    name: string;
    description: string | null;
    enriched_summary: string | null;
    amount: string | null;
    deadline: string | null;
    source_url: string;
    classification: string | null;
    tags: string[];
    status: string;
    distributable: boolean | null;
  };
}

export interface UnwithholdResult {
  success: true;
  action: 'unwithhold';
  entryId: number;
  status: 'approved';
  dryRun: boolean;
  actioned_by: string;
  enqueued: false;
  sent: false;
}

interface AuditOpts {
  actor: string;
  reason: string;
  sources: string[];
  quotes?: { url: string; quote: string }[];
  dryRun?: boolean;
}

function requireAudit(opts: AuditOpts): void {
  if (!opts.actor?.trim()) throw new ContentEditError('actor is required', 400);
  if (!opts.reason?.trim()) throw new ContentEditError('reason is required', 400);
  if (!Array.isArray(opts.sources) || opts.sources.length === 0) {
    throw new ContentEditError('sources must be a non-empty array of https URLs', 400);
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...(value as Record<string, unknown>) };
  return {};
}

function history(metadata: Record<string, unknown>, key: string): unknown[] {
  const value = metadata[key];
  return Array.isArray(value) ? value.slice(-49) : [];
}

function dateOnly(value: Date | null): string | null {
  if (!value) return null;
  return value.toISOString().slice(0, 10);
}

/**
 * Booked, in-flight, and already-sent publications stay as they are.
 * `queued` here is publication_queue.status, not the review-queue status.
 */
function publicationBlock(queueStatus: string | null, telegramSent: boolean, telegramPending: boolean): string | null {
  if (telegramSent) return 'Entry already has a successful Telegram send';
  if (telegramPending || queueStatus === 'running') return 'Entry is sending now';
  if (queueStatus === 'review') return 'Entry is awaiting delivery review';
  if (queueStatus === 'queued') {
    return 'Entry is queued for send. Withhold it before editing, then enqueue again. This route does not re-book or send.';
  }
  return null;
}

interface LockedEntry {
  id: number;
  status: string;
  name: string;
  description: string | null;
  enriched_summary: string | null;
  amount: string | null;
  deadline: string | null;
  source_url: string;
  classification: string | null;
  tags: string[] | null;
  wire: string;
  scan_date: Date | string;
  actioned_by: string | null;
  distributable: boolean | null;
  metadata: unknown;
  queue_status: string | null;
  telegram_sent: boolean;
  telegram_pending: boolean;
}

async function lockEntry(client: { query: Pool['query'] }, entryId: number): Promise<LockedEntry> {
  const current = (await client.query(
    `SELECT se.id, se.status, se.name, se.description, se.enriched_summary, se.amount, se.deadline,
            se.source_url, se.classification, se.tags, se.wire, se.scan_date, se.actioned_by, se.distributable, se.metadata,
            EXISTS (
              SELECT 1 FROM distribution_logs dl
              WHERE dl.entry_id = se.id AND dl.channel = 'telegram' AND dl.status = 'success'
            ) AS telegram_sent,
            EXISTS (
              SELECT 1 FROM distribution_logs dl
              WHERE dl.entry_id = se.id AND dl.channel = 'telegram' AND dl.status = 'pending'
            ) AS telegram_pending
     FROM scan_entries se
     WHERE se.id = $1
     FOR UPDATE`,
    [entryId],
  )).rows[0];
  if (!current) throw new ContentEditError('Entry not found', 404);
  const queue = (await client.query(
    `SELECT status FROM publication_queue WHERE entry_id = $1 FOR UPDATE`,
    [entryId],
  )).rows[0];
  return {
    ...current,
    id: Number(current.id),
    queue_status: queue?.status ?? null,
    telegram_sent: current.telegram_sent === true,
    telegram_pending: current.telegram_pending === true,
  };
}

async function replaceOwnedUrl(
  client: { query: Pool['query'] },
  entry: LockedEntry,
  newSourceUrl: string,
): Promise<void> {
  const normalizedNew = normalizeUrl(newSourceUrl);
  const normalizedOld = entry.source_url ? normalizeUrl(entry.source_url) : '';
  if (normalizedNew === normalizedOld) {
    if (!normalizedNew) return;
    await client.query(
      `UPDATE seen_urls SET url = $1
       WHERE first_seen_entry_id = $2 AND wire = $3 AND normalized_url = $4`,
      [newSourceUrl, entry.id, entry.wire, normalizedNew],
    );
    return;
  }
  if (entry.status === 'duplicate') {
    throw new ContentEditError('Duplicate entries cannot own a rewritten source URL', 409);
  }
  const conflict = (await client.query(
    `SELECT first_seen_entry_id FROM seen_urls
     WHERE normalized_url = $1 AND wire = $2
     FOR UPDATE`,
    [normalizedNew, entry.wire],
  )).rows[0];
  const ownerId = conflict?.first_seen_entry_id == null ? null : Number(conflict.first_seen_entry_id);
  if (conflict && ownerId !== entry.id) {
    throw new ContentEditError(
      ownerId == null
        ? 'Canonical URL already exists in the seed registry'
        : `Canonical URL already belongs to entry #${ownerId}`,
      409,
    );
  }
  if (normalizedOld) {
    await client.query(
      `DELETE FROM seen_urls
       WHERE first_seen_entry_id = $1 AND wire = $2 AND normalized_url = $3`,
      [entry.id, entry.wire, normalizedOld],
    );
  }
  const registered = await client.query(
    `INSERT INTO seen_urls (url, normalized_url, first_seen_entry_id, first_seen_date, wire)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (normalized_url, wire) DO UPDATE SET
       url = EXCLUDED.url,
       first_seen_entry_id = EXCLUDED.first_seen_entry_id,
       first_seen_date = EXCLUDED.first_seen_date
     WHERE seen_urls.first_seen_entry_id = EXCLUDED.first_seen_entry_id
     RETURNING first_seen_entry_id`,
    [newSourceUrl, normalizedNew, entry.id, entry.scan_date, entry.wire],
  );
  if (registered.rowCount !== 1) throw new ContentEditError('Canonical URL was claimed concurrently', 409);
}

function present(entry: {
  name: string;
  description: string | null;
  enriched_summary: string | null;
  amount: string | null;
  deadline: string | null;
  source_url: string;
  classification: string | null;
  tags: string[] | null;
  status: string;
  distributable: boolean | null;
}): ContentEditResult['entry'] {
  return {
    name: entry.name,
    description: entry.description,
    enriched_summary: entry.enriched_summary,
    amount: entry.amount,
    deadline: entry.deadline,
    source_url: entry.source_url,
    classification: entry.classification,
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    status: entry.status,
    distributable: entry.distributable,
  };
}

function tagList(value: string[] | null | undefined): string[] {
  return Array.isArray(value) ? value : [];
}

function sameTags(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

function storedMetadataAmount(metadata: Record<string, unknown>): string | null {
  return typeof metadata.amount === 'string' ? metadata.amount : null;
}

/**
 * Rewrite post text and record fields. Does not book a publication slot and does not send.
 * A sent, running, in-review, or queued publication blocks post text and writes nothing.
 * Classification, tags, and metadata.amount are not post inputs, so they still apply.
 */
export async function updateEntryContent(
  entryId: number,
  patch: ContentPatch,
  opts: AuditOpts,
): Promise<ContentEditResult> {
  requireAudit(opts);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // Same lock source rewrites take, and taken first so the two cannot deadlock.
    if ('source_url' in patch) await lockDuplicateGraph(client);
    const current = await lockEntry(client, entryId);
    // Record fields are not post inputs, so they stay editable after a send.
    // Any post-text field in the same patch keeps the whole write blocked.
    if (patchTouchesPostText(patch)) {
      const blocked = publicationBlock(current.queue_status, current.telegram_sent, current.telegram_pending);
      if (blocked) throw new ContentEditError(blocked, 409);
    }

    const text: Record<PostTextField, string | null> = {
      name: current.name,
      description: current.description,
      enriched_summary: current.enriched_summary,
      amount: current.amount,
      deadline: current.deadline,
      source_url: current.source_url,
    };
    let classification = current.classification;
    let tags = tagList(current.tags);
    const from: Record<string, unknown> = {};
    const to: Record<string, unknown> = {};
    const changed: ContentField[] = [];
    const assign = (key: PostTextField, value: string | null, previous: string | null): void => {
      if (value === previous) return;
      from[key] = previous;
      to[key] = value;
      changed.push(key);
      text[key] = value;
    };
    if ('name' in patch) assign('name', patch.name ?? null, current.name);
    if ('description' in patch) assign('description', patch.description ?? null, current.description);
    if ('enriched_summary' in patch) assign('enriched_summary', patch.enriched_summary ?? null, current.enriched_summary);
    if ('amount' in patch) assign('amount', patch.amount ?? null, current.amount);
    if ('deadline' in patch) assign('deadline', patch.deadline ?? null, current.deadline);
    if ('source_url' in patch) assign('source_url', patch.source_url ?? null, current.source_url);
    if ('classification' in patch && patch.classification !== current.classification) {
      from.classification = current.classification;
      to.classification = patch.classification;
      changed.push('classification');
      classification = patch.classification ?? null;
    }
    if ('tags' in patch && !sameTags(tags, patch.tags ?? [])) {
      from.tags = tags;
      to.tags = patch.tags ?? [];
      changed.push('tags');
      tags = patch.tags ?? [];
    }
    const currentMetadataAmount = storedMetadataAmount(asObject(current.metadata));
    const specifiedMetadataAmount = metadataAmountSpecified(patch) ? (patch.metadata?.amount ?? null) : undefined;
    if (specifiedMetadataAmount !== undefined && specifiedMetadataAmount !== currentMetadataAmount) {
      from['metadata.amount'] = currentMetadataAmount;
      to['metadata.amount'] = specifiedMetadataAmount;
      changed.push('metadata.amount');
    }

    const preview = (actionedBy: string | null): ContentEditResult => ({
      success: true,
      entryId: current.id,
      dryRun: !!opts.dryRun,
      unchanged: changed.length === 0,
      changed,
      actioned_by: actionedBy,
      queueStatus: current.queue_status,
      enqueued: false,
      sent: false,
      entry: present({
        ...current,
        name: text.name ?? current.name,
        description: text.description,
        enriched_summary: text.enriched_summary,
        amount: text.amount,
        deadline: text.deadline,
        source_url: text.source_url ?? current.source_url,
        classification,
        tags,
      }),
    });

    if (opts.dryRun || changed.length === 0) {
      await client.query('ROLLBACK');
      return preview(changed.length === 0 ? current.actioned_by : opts.actor);
    }

    if ('source_url' in patch && patch.source_url && changed.includes('source_url')) {
      await replaceOwnedUrl(client, current, patch.source_url);
    }

    const at = new Date().toISOString();
    const metadata = asObject(current.metadata);
    metadata.content_edits = [...history(metadata, 'content_edits'), {
      at,
      actor: opts.actor,
      reason: opts.reason,
      sources: opts.sources,
      previous_actioned_by: current.actioned_by,
      from,
      to,
    }];
    metadata.curator_evidence = {
      reason: opts.reason,
      sources: opts.sources,
      quotes: opts.quotes ?? [],
      by: opts.actor,
      at,
    };
    if (specifiedMetadataAmount !== undefined) {
      if (specifiedMetadataAmount == null) delete metadata.amount;
      else metadata.amount = specifiedMetadataAmount;
    } else if (changed.includes('amount')) {
      if (text.amount == null) delete metadata.amount;
      else metadata.amount = text.amount;
    }
    if (changed.includes('deadline')) {
      if (text.deadline == null) delete metadata.deadline;
      else metadata.deadline = text.deadline;
    }
    if (changed.includes('enriched_summary')) {
      if (text.enriched_summary == null) delete metadata.summary;
      else metadata.summary = text.enriched_summary;
    }

    const sets = [
      'actioned_by = $2',
      'action_reason = $3',
      'metadata = $4::jsonb',
      'updated_at = NOW()',
    ];
    const params: unknown[] = [current.id, opts.actor, opts.reason, JSON.stringify(metadata)];
    const add = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (changed.includes('name')) add('name', text.name);
    if (changed.includes('description')) add('description', text.description);
    if (changed.includes('enriched_summary')) {
      add('enriched_summary', text.enriched_summary);
      if (text.enriched_summary) sets.push('auto_summarize_failed = false');
    }
    if (changed.includes('amount')) {
      const parsed = parseAmount(text.amount);
      add('amount', text.amount);
      add('amount_numeric', parsed?.numeric ?? null);
      add('amount_currency', parsed?.currency ?? null);
    }
    if (changed.includes('deadline')) {
      add('deadline', text.deadline);
      add('deadline_parsed', dateOnly(parseDeadline(text.deadline)));
    }
    if (changed.includes('source_url')) add('source_url', text.source_url);
    if (changed.includes('classification')) add('classification', classification);
    if (changed.includes('tags')) {
      params.push(tags);
      sets.push(`tags = $${params.length}::text[]`);
    }

    const updated = await client.query(
      `UPDATE scan_entries SET ${sets.join(', ')}
       WHERE id = $1
       RETURNING name, description, enriched_summary, amount, deadline, source_url,
                 classification, tags, status, distributable, actioned_by`,
      params,
    );
    if (updated.rowCount !== 1) throw new ContentEditError('Entry changed before write', 409);
    await client.query('COMMIT');
    const row = updated.rows[0];
    return {
      ...preview(row.actioned_by),
      dryRun: false,
      unchanged: false,
      entry: present(row),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Clear a withheld publication and leave the entry approved.
 * Does not insert a queue row and does not send.
 */
export async function releaseWithheldEntry(entryId: number, opts: AuditOpts): Promise<UnwithholdResult> {
  requireAudit(opts);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await lockEntry(client, entryId);
    if (current.status !== 'approved') {
      throw new ContentEditError(`Entry is ${current.status}, not approved`, 409);
    }
    if (current.queue_status !== 'withheld') throw new ContentEditError('Entry is not withheld', 409);

    const result: UnwithholdResult = {
      success: true,
      action: 'unwithhold',
      entryId: current.id,
      status: 'approved',
      dryRun: !!opts.dryRun,
      actioned_by: opts.actor,
      enqueued: false,
      sent: false,
    };
    if (opts.dryRun) {
      await client.query('ROLLBACK');
      return result;
    }

    const removed = await client.query(
      `DELETE FROM publication_queue WHERE entry_id = $1 AND status = 'withheld' RETURNING entry_id`,
      [current.id],
    );
    if (removed.rowCount !== 1) throw new ContentEditError('Entry changed while releasing the withhold', 409);

    const at = new Date().toISOString();
    const metadata = asObject(current.metadata);
    metadata.unwithhold = [...history(metadata, 'unwithhold'), {
      at,
      actor: opts.actor,
      reason: opts.reason,
      sources: opts.sources,
      previous_actioned_by: current.actioned_by,
    }];
    metadata.curator_evidence = {
      reason: opts.reason,
      sources: opts.sources,
      quotes: opts.quotes ?? [],
      by: opts.actor,
      at,
    };
    const updated = await client.query(
      `UPDATE scan_entries
       SET actioned_by = $2, action_reason = $3, metadata = $4::jsonb, updated_at = NOW()
       WHERE id = $1 AND status = 'approved'
       RETURNING status`,
      [current.id, opts.actor, opts.reason, JSON.stringify(metadata)],
    );
    if (updated.rowCount !== 1) throw new ContentEditError('Entry changed while releasing the withhold', 409);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
