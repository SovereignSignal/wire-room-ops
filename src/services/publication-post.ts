/**
 * Freeze the Telegram post on publication_queue when a row is booked,
 * and replace it when the queued entry's text changes.
 */

import type { Pool, PoolClient } from 'pg';
import { getPool } from '../db';
import { generatePosts, templatePosts, verifyPostClaims, type PostCheckResult, type VerifierResult } from './post-generator';
import { checkFaithfulness, checkTelegramHtml } from './post-faithfulness';

export interface StoredPost {
  postText: string;
  generatedAt: string;
  model: string | null;
  checkResult: PostCheckResult | Record<string, unknown> | null;
  verifierResult: VerifierResult | Record<string, unknown> | null;
}

export interface PostSource {
  name: string;
  description: string;
  amount?: string | null;
  deadline?: string | null;
  sourceUrl: string;
}

type Queryable = Pool | PoolClient;

function sourceOf(row: {
  name: string;
  description: string | null;
  amount: string | null;
  deadline: string | null;
  source_url: string;
}): PostSource {
  return {
    name: row.name,
    description: row.description || '',
    amount: row.amount,
    deadline: row.deadline,
    sourceUrl: row.source_url,
  };
}

export async function composeStoredPost(entry: PostSource, wire: string): Promise<StoredPost> {
  try {
    const generated = await generatePosts(entry, wire);
    const postText = typeof generated.telegram === 'string' ? generated.telegram.trim() : '';
    if (postText) {
      return {
        postText,
        generatedAt: new Date().toISOString(),
        model: generated.model ?? null,
        checkResult: generated.checkResult ?? null,
        verifierResult: generated.verifierResult ?? null,
      };
    }
  } catch (error) {
    console.error('[PublicationPost] Generation failed, using template:', error);
  }
  const fallback = templatePosts(entry);
  const check = checkFaithfulness(
    [entry.name, entry.description, entry.amount, entry.deadline, entry.sourceUrl].filter(Boolean).join('\n'),
    fallback.telegram,
    { html: true },
  );
  return {
    postText: fallback.telegram,
    generatedAt: new Date().toISOString(),
    model: 'template',
    checkResult: { ...check, source: 'template', attempts: 0, rejected: [] },
    verifierResult: { ok: false, model: null, unsupported: [], error: 'not run' },
  };
}

export async function composePostsForIds(ids: number[]): Promise<Map<number, StoredPost>> {
  const posts = new Map<number, StoredPost>();
  if (!ids.length) return posts;
  const rows = (await getPool().query(
    `SELECT id, wire, name, description, amount, deadline, source_url
     FROM scan_entries WHERE id = ANY($1::int[])`,
    [ids],
  )).rows as Array<{
    id: number; wire: string; name: string; description: string | null;
    amount: string | null; deadline: string | null; source_url: string;
  }>;
  await Promise.all(rows.map(async row => {
    posts.set(Number(row.id), await composeStoredPost(sourceOf(row), row.wire || 'crypto'));
  }));
  return posts;
}

export function storedPostColumns(ids: number[], posts: Map<number, StoredPost>): {
  postText: (string | null)[];
  generatedAt: (string | null)[];
  model: (string | null)[];
  checkResult: (string | null)[];
  verifierResult: (string | null)[];
} {
  return {
    postText: ids.map(id => posts.get(id)?.postText ?? null),
    generatedAt: ids.map(id => posts.get(id)?.generatedAt ?? null),
    model: ids.map(id => posts.get(id)?.model ?? null),
    checkResult: ids.map(id => {
      const post = posts.get(id);
      return post ? JSON.stringify(post.checkResult) : null;
    }),
    verifierResult: ids.map(id => {
      const post = posts.get(id);
      return post ? JSON.stringify(post.verifierResult) : null;
    }),
  };
}

export async function writeStoredPost(db: Queryable, entryId: number, post: StoredPost, onlyIfQueued = false): Promise<boolean> {
  const result = await db.query(
    `UPDATE publication_queue
     SET post_text = $2, generated_at = $3, model = $4,
         check_result = $5::jsonb, verifier_result = $6::jsonb, updated_at = NOW()
     WHERE entry_id = $1 ${onlyIfQueued ? "AND status = 'queued'" : ''}`,
    [entryId, post.postText, post.generatedAt, post.model, JSON.stringify(post.checkResult), JSON.stringify(post.verifierResult)],
  );
  return result.rowCount === 1;
}

/** Legacy rows and re-queues that never stored a draft. Does not replace text that is already there. */
export async function fillMissingPublicationPost(entryId: number): Promise<void> {
  const row = (await getPool().query(
    `SELECT q.status, q.post_text, se.wire, se.name, se.description, se.amount, se.deadline, se.source_url
     FROM publication_queue q
     JOIN scan_entries se ON se.id = q.entry_id
     WHERE q.entry_id = $1`,
    [entryId],
  )).rows[0];
  if (!row || row.status !== 'queued' || (typeof row.post_text === 'string' && row.post_text.trim())) return;
  const post = await composeStoredPost(sourceOf(row), row.wire || 'crypto');
  await getPool().query(
    `UPDATE publication_queue
     SET post_text = $2, generated_at = $3, model = $4,
         check_result = $5::jsonb, verifier_result = $6::jsonb, updated_at = NOW()
     WHERE entry_id = $1 AND status = 'queued' AND (post_text IS NULL OR btrim(post_text) = '')`,
    [entryId, post.postText, post.generatedAt, post.model, JSON.stringify(post.checkResult), JSON.stringify(post.verifierResult)],
  );
}

export interface QueuedPostView {
  entryId: number;
  status: string;
  availableAt: string | null;
  postText: string | null;
  generatedAt: string | null;
  model: string | null;
  checkResult: unknown;
  verifierResult: unknown;
}

export async function readPublicationPost(entryId: number): Promise<QueuedPostView | null> {
  const row = (await getPool().query(
    `SELECT entry_id, status, available_at, post_text, generated_at, model, check_result, verifier_result
     FROM publication_queue WHERE entry_id = $1`,
    [entryId],
  )).rows[0];
  if (!row) return null;
  return {
    entryId: Number(row.entry_id),
    status: row.status,
    availableAt: row.available_at ? new Date(row.available_at).toISOString() : null,
    postText: row.post_text ?? null,
    generatedAt: row.generated_at ? new Date(row.generated_at).toISOString() : null,
    model: row.model ?? null,
    checkResult: row.check_result ?? null,
    verifierResult: row.verifier_result ?? null,
  };
}

export class PublicationPostError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'PublicationPostError';
  }
}

async function readQueuedSource(entryId: number): Promise<{
  wire: string;
  source: PostSource;
  postText: string | null;
}> {
  const row = (await getPool().query(
    `SELECT se.wire, se.name, se.description, se.amount, se.deadline, se.source_url,
            q.status, q.post_text
     FROM scan_entries se
     JOIN publication_queue q ON q.entry_id = se.id
     WHERE se.id = $1`,
    [entryId],
  )).rows[0];
  if (!row) throw new PublicationPostError('Entry has no publication row', 404);
  if (row.status !== 'queued') {
    throw new PublicationPostError(`Entry publication is ${row.status}, not queued`, 409);
  }
  return { wire: row.wire || 'crypto', source: sourceOf(row), postText: row.post_text ?? null };
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...(value as Record<string, unknown>) };
  return {};
}

async function auditPostChange(entryId: number, actor: string, reason: string, sources: string[], kind: 'regenerate' | 'override', from: string | null, to: string): Promise<void> {
  const current = (await getPool().query(`SELECT metadata FROM scan_entries WHERE id = $1`, [entryId])).rows[0];
  const metadata = asObject(current?.metadata);
  const history = Array.isArray(metadata.post_edits) ? metadata.post_edits.slice(-49) : [];
  const at = new Date().toISOString();
  metadata.post_edits = [...history, { at, actor, reason, sources, kind, from, to }];
  metadata.curator_evidence = { reason, sources, by: actor, at };
  await getPool().query(
    `UPDATE scan_entries
     SET actioned_by = $2, action_reason = $3, metadata = $4::jsonb, updated_at = NOW()
     WHERE id = $1`,
    [entryId, actor, reason, JSON.stringify(metadata)],
  );
}

export async function regenerateQueuedPost(entryId: number, actor: string, reason: string, sources: string[]): Promise<QueuedPostView> {
  const locked = await readQueuedSource(entryId);
  const post = await composeStoredPost(locked.source, locked.wire);
  const wrote = await writeStoredPost(getPool(), entryId, post, true);
  if (!wrote) throw new PublicationPostError('Entry changed before the post was stored', 409);
  await auditPostChange(entryId, actor, reason, sources, 'regenerate', locked.postText, post.postText);
  const view = await readPublicationPost(entryId);
  if (!view) throw new PublicationPostError('Entry has no publication row', 404);
  return view;
}

export async function overrideQueuedPost(entryId: number, postText: string, actor: string, reason: string, sources: string[]): Promise<QueuedPostView> {
  const text = postText.trim();
  if (!text) throw new PublicationPostError('postText is required', 400);
  if (text.length > 4096) throw new PublicationPostError('postText must be at most 4096 characters', 400);
  const html = checkTelegramHtml(text);
  if (html.length) throw new PublicationPostError(html[0], 400);
  const locked = await readQueuedSource(entryId);
  const facts = [locked.source.name, locked.source.description, locked.source.amount, locked.source.deadline, locked.source.sourceUrl]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join('\n');
  const check = checkFaithfulness(facts, text, { html: true });
  const verifier = await verifyPostClaims(facts, text, locked.wire);
  const post: StoredPost = {
    postText: text,
    generatedAt: new Date().toISOString(),
    model: 'manual',
    checkResult: { ...check, source: 'manual', attempts: 0, rejected: [] },
    verifierResult: { ...verifier, manual: true },
  };
  const wrote = await writeStoredPost(getPool(), entryId, post, true);
  if (!wrote) throw new PublicationPostError('Entry changed before the post was stored', 409);
  await auditPostChange(entryId, actor, reason, sources, 'override', locked.postText, text);
  const view = await readPublicationPost(entryId);
  if (!view) throw new PublicationPostError('Entry has no publication row', 404);
  return view;
}

/** Replace the frozen text after a queued entry's post inputs change. Caller holds the row lock. */
export async function refreshQueuedPost(db: Queryable, entryId: number, entry: PostSource, wire: string): Promise<StoredPost> {
  const post = await composeStoredPost(entry, wire);
  await writeStoredPost(db, entryId, post, true);
  return post;
}
