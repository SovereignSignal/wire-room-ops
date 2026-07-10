/**
 * Decided-Recheck Job
 *
 * Reviews freshly queued entries against the decided corpus (approved /
 * declined / queued / duplicate, last 365 days) to catch semantic duplicates
 * that exact URL/name dedup misses — the same program arriving with a
 * tweet-phrased name or a different URL.
 *
 * Three-outcome semantics, fail-open by design:
 *  - same_listing (high confidence, matched entry was approved/declined/queued)
 *      → marked duplicate with a pointer to the decided entry
 *  - update (same program, NEW round / reopened / material change)
 *      → STAYS QUEUED, gains an operator note with context. Updates are
 *        signal, not noise — never auto-filtered.
 *  - distinct / uncertain / any error → stays queued untouched.
 *
 * Candidate generation is deterministic SQL (domain match, name-token
 * overlap, squashed-name containment for hashtag-style names); the verdict
 * is one Grok call per entry that has candidates.
 */

import type { Pool } from 'pg';
import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { isBlockedHost, isSafeHttpUrl } from '../utils/ssrf';
import { getCachedProvider } from '../services/api-provider';
import { logApiUsage } from '../services/api-usage';
import { classifySourceLink, type SourceLinkClass } from '../services/source-filter';
import { reassignSeenUrlOwnership, resolveDuplicateChain } from '../services/duplicate-chain';
import { config } from '../config';

let isRunning = false;

const BATCH_SIZE = 20;
const MAX_CANDIDATES = 4;

// Domains too generic to imply "same program"
const PLATFORM_DOMAINS = [
  'x.com', 'twitter.com', 't.co', 'bit.ly', 'linkedin.com', 'medium.com',
  'github.com', 'docs.google.com', 'forms.gle', 'youtube.com', 'tally.so',
  'notion.so', 'substack.com', 'mirror.xyz',
];

const STOPWORDS = [
  '2025', '2026', '2027', 'grant', 'grants', 'program', 'programme', 'fund',
  'open', 'application', 'applications', 'deadline', 'with', 'from', 'this',
  'that', 'your', 'their', 'announcing', 'launch', 'launches', 'apply',
];

interface Candidate {
  id: number;
  name: string;
  status: string;
  source_url: string;
  decided_date: string;
  resolve_to: number | null;
  overlap: number;
  domain_match: boolean;
  squash_match: boolean;
}

interface RecheckTarget {
  id: number;
  wire: string;
  name: string;
  description: string | null;
  source_url: string;
  deadline: string | null;
}

async function findCandidates(pool: Pool, target: RecheckTarget): Promise<Candidate[]> {
  const result = await pool.query(
    `WITH t AS (
       SELECT
         lower(regexp_replace($2, '[^a-zA-Z0-9]', '', 'g')) AS squash,
         regexp_replace(lower($3), '^https?://(www\\.)?([^/]+).*$', '\\2') AS domain,
         ARRAY(
           SELECT tok FROM unnest(regexp_split_to_array(lower(regexp_replace($2, '[^a-zA-Z0-9 ]', ' ', 'g')), '\\s+')) tok
           WHERE length(tok) > 3 AND NOT (tok = ANY($4))
         ) AS tokens
     )
     SELECT d.id, d.name, d.status, d.source_url,
            d.updated_at::date::text AS decided_date,
            CASE WHEN d.status = 'duplicate' THEN d.duplicate_of_id ELSE NULL END AS resolve_to,
            (SELECT COUNT(*)::int FROM unnest(ARRAY(
               SELECT tok FROM unnest(regexp_split_to_array(lower(regexp_replace(d.name, '[^a-zA-Z0-9 ]', ' ', 'g')), '\\s+')) tok
               WHERE length(tok) > 3 AND NOT (tok = ANY($4))
             )) dtok, t WHERE dtok = ANY(t.tokens)) AS overlap,
            (regexp_replace(lower(d.source_url), '^https?://(www\\.)?([^/]+).*$', '\\2') = (SELECT domain FROM t)
              AND NOT ((SELECT domain FROM t) = ANY($5))) AS domain_match,
            (length((SELECT squash FROM t)) > 8 AND length(lower(regexp_replace(d.name, '[^a-zA-Z0-9]', '', 'g'))) > 8
              AND (position((SELECT squash FROM t) IN lower(regexp_replace(d.name, '[^a-zA-Z0-9]', '', 'g'))) > 0
                OR position(lower(regexp_replace(d.name, '[^a-zA-Z0-9]', '', 'g')) IN (SELECT squash FROM t)) > 0)) AS squash_match
     FROM scan_entries d, t
     WHERE d.id != $1
       AND d.status IN ('approved', 'declined', 'queued', 'duplicate')
       AND d.created_at > NOW() - INTERVAL '365 days'
       AND (
         (regexp_replace(lower(d.source_url), '^https?://(www\\.)?([^/]+).*$', '\\2') = (SELECT domain FROM t)
           AND NOT ((SELECT domain FROM t) = ANY($5)))
         OR (SELECT COUNT(*) FROM unnest(ARRAY(
              SELECT tok FROM unnest(regexp_split_to_array(lower(regexp_replace(d.name, '[^a-zA-Z0-9 ]', ' ', 'g')), '\\s+')) tok
              WHERE length(tok) > 3 AND NOT (tok = ANY($4))
            )) dtok, t WHERE dtok = ANY(t.tokens)) >= 2
         OR (length((SELECT squash FROM t)) > 8 AND length(lower(regexp_replace(d.name, '[^a-zA-Z0-9]', '', 'g'))) > 8
           AND (position((SELECT squash FROM t) IN lower(regexp_replace(d.name, '[^a-zA-Z0-9]', '', 'g'))) > 0
             OR position(lower(regexp_replace(d.name, '[^a-zA-Z0-9]', '', 'g')) IN (SELECT squash FROM t)) > 0))
       )
     ORDER BY domain_match DESC, squash_match DESC, overlap DESC
     LIMIT $6`,
    [target.id, target.name, target.source_url, STOPWORDS, PLATFORM_DOMAINS, MAX_CANDIDATES]
  );
  return result.rows;
}

interface Verdict {
  matched_id: number | null;
  verdict: 'same_listing' | 'update' | 'distinct';
  confidence: number;
  reason: string;
}

async function judgeCandidates(target: RecheckTarget, candidates: Candidate[]): Promise<Verdict | null> {
  const provider = getCachedProvider('grok');
  const model = provider?.default_model || 'grok-4.20-beta-0309-non-reasoning';
  const apiKey = provider?.api_key || config.apis.grok.apiKey;
  const baseUrl = provider?.base_url || config.apis.grok.baseUrl;
  if (!apiKey) return null;

  const prompt = `You deduplicate a grants-intelligence review queue. Compare the NEW entry against PREVIOUS entries (already seen, possibly already decided by the human operator).

NEW ENTRY:
Name: ${target.name}
Description: ${(target.description || '').slice(0, 400)}
URL: ${target.source_url}
Deadline: ${target.deadline || 'unknown'}

PREVIOUS ENTRIES:
${candidates.map(c => `- id ${c.id} [${c.status}${c.resolve_to ? ` -> #${c.resolve_to}` : ''}, ${c.decided_date}]: ${c.name} | ${c.source_url}`).join('\n')}

Verdicts:
- "same_listing": the NEW entry is the SAME program AND the SAME round/cycle with no material new information. (A tweet about a program vs the program page = same_listing.)
- "update": same program but a NEW round, a reopening, a changed deadline or amount, or otherwise material NEW information. Updates are valuable — the operator must see them.
- "distinct": a different program, even if from the same organization.

CRITICAL BIAS RULE: if torn between same_listing and update, answer "update". Filtering out a real update costs far more than showing a near-duplicate.

Respond with ONLY JSON: {"matched_id": <id or null>, "verdict": "same_listing"|"update"|"distinct", "confidence": <0.0-1.0>, "reason": "<one line>"}`;

  const start = Date.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 200, temperature: 0.1 }),
  });

  if (!response.ok) {
    logApiUsage({ provider: 'grok', model, purpose: 'decided-recheck', wire: target.wire, duration_ms: Date.now() - start, success: false, error_message: `${response.status}` });
    throw new Error(`Grok ${response.status}`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  logApiUsage({ provider: 'grok', model, purpose: 'decided-recheck', wire: target.wire, duration_ms: Date.now() - start, tokens_in: data.usage?.prompt_tokens, tokens_out: data.usage?.completion_tokens });

  const content = data.choices?.[0]?.message?.content;
  if (!content) return null;
  const cleaned = content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
  const parsed = JSON.parse(cleaned) as Verdict;
  if (!['same_listing', 'update', 'distinct'].includes(parsed.verdict)) return null;
  return parsed;
}

export async function applyVerdict(pool: Pool, target: RecheckTarget, candidates: Candidate[], verdict: Verdict): Promise<string> {
  const matched = candidates.find(c => c.id === verdict.matched_id);
  const stamp = {
    at: new Date().toISOString(),
    verdict: verdict.verdict,
    matched_id: verdict.matched_id,
    confidence: verdict.confidence,
    reason: verdict.reason,
  };

  if (verdict.verdict === 'same_listing' && matched && verdict.confidence >= 0.8) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT id, status, duplicate_of_id
         FROM scan_entries
         WHERE id = ANY($1::bigint[])
         ORDER BY id
         FOR UPDATE`,
        [[target.id, matched.id]],
      );
      const currentTarget = locked.rows.find(row => Number(row.id) === target.id);
      if (!currentTarget || currentTarget.status !== 'queued') {
        await client.query('ROLLBACK');
        return 'stale';
      }

      // Resolve from current database state after the external verdict call.
      // The candidate snapshot captured before Grok is only display context.
      const resolution = await resolveDuplicateChain(client, matched.id);
      const chainError = resolution.error || resolution.id === null
        ? resolution.error || 'missing'
        : resolution.id === target.id
          ? 'cycle-to-target'
          : null;
      if (chainError) {
        const errorStamp = {
          matched_id: matched.id,
          error: chainError,
          depth: resolution.depth,
          at: stamp.at,
        };
        const stalled = await client.query(
          `UPDATE scan_entries SET
             operator_notes = CONCAT_WS(E'\n', NULLIF(operator_notes, ''), $2::text),
             metadata = COALESCE(metadata, '{}'::jsonb)
               || jsonb_build_object('decided_recheck', $3::jsonb, 'duplicate_chain_error', $4::jsonb),
             updated_at = NOW()
           WHERE id = $1 AND status = 'queued'
           RETURNING id`,
          [
            target.id,
            `Automatic duplicate action blocked: matched #${matched.id} has an invalid duplicate chain (${chainError}).`,
            JSON.stringify(stamp),
            JSON.stringify(errorStamp),
          ],
        );
        await client.query('COMMIT');
        return stalled.rowCount === 1 ? 'chain-unresolved' : 'stale';
      }

      const resolvedId = resolution.id!;

      // Hold the terminal parent stable through the target mutation and registry move.
      const parentResult = await client.query(
        `SELECT id, status, duplicate_of_id
         FROM scan_entries
         WHERE id = $1
         FOR UPDATE`,
        [resolvedId],
      );
      const parent = parentResult.rows[0];
      if (!parent
          || !['approved', 'declined', 'queued'].includes(parent.status)
          || parent.duplicate_of_id !== null) {
        const errorStamp = {
          matched_id: matched.id,
          error: 'parent-changed',
          depth: resolution.depth,
          at: stamp.at,
        };
        const stalled = await client.query(
          `UPDATE scan_entries SET
             operator_notes = CONCAT_WS(E'\n', NULLIF(operator_notes, ''), $2::text),
             metadata = COALESCE(metadata, '{}'::jsonb)
               || jsonb_build_object('decided_recheck', $3::jsonb, 'duplicate_chain_error', $4::jsonb),
             updated_at = NOW()
           WHERE id = $1 AND status = 'queued'
           RETURNING id`,
          [
            target.id,
            `Automatic duplicate action blocked: canonical parent #${resolvedId} changed before mutation.`,
            JSON.stringify(stamp),
            JSON.stringify(errorStamp),
          ],
        );
        await client.query('COMMIT');
        return stalled.rowCount === 1 ? 'chain-unresolved' : 'stale';
      }

      const chainNote = resolvedId !== matched.id
        ? `, resolved ${resolution.depth} hop${resolution.depth === 1 ? '' : 's'} to canonical #${resolvedId}`
        : '';
      const reason = `Same listing as #${matched.id} "${matched.name.slice(0, 80)}" (${parent.status} ${matched.decided_date})${chainNote}: ${verdict.reason}`.slice(0, 400);
      const result = await client.query(
        `UPDATE scan_entries AS target SET status = 'duplicate', duplicate_of_id = $2,
           duplicate_reason = $3::text, distributable = false,
           actioned_by = 'decided-recheck', action_reason = $3::text,
           metadata = COALESCE(target.metadata, '{}'::jsonb) || jsonb_build_object('decided_recheck', $4::jsonb),
           updated_at = NOW()
         WHERE target.id = $1 AND target.status = 'queued'
           AND EXISTS (
             SELECT 1 FROM scan_entries AS parent
             WHERE parent.id = $2
               AND parent.status IN ('approved', 'declined', 'queued')
               AND parent.duplicate_of_id IS NULL
           )
         RETURNING target.id`,
        [target.id, resolvedId, reason, JSON.stringify(stamp)],
      );
      if (result.rowCount !== 1) {
        await client.query('ROLLBACK');
        return 'stale';
      }

      await reassignSeenUrlOwnership(client, target.id, resolvedId);
      await client.query('COMMIT');
      return 'duplicate';
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  if (verdict.verdict === 'update' && matched) {
    const result = await pool.query(
      `UPDATE scan_entries SET
         operator_notes = CONCAT_WS(E'\n', NULLIF(operator_notes, ''), $2::text),
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('decided_recheck', $3::jsonb, 'related_decided', $4::int),
         updated_at = NOW()
       WHERE id = $1 AND status = 'queued'
       RETURNING id`,
      [target.id, `↻ Update of #${matched.id} "${matched.name.slice(0, 80)}" (${matched.status} ${matched.decided_date}): ${verdict.reason}`.slice(0, 400), JSON.stringify(stamp), matched.id]
    );
    return result.rowCount === 1 ? 'update-noted' : 'stale';
  }

  const result = await pool.query(
    `UPDATE scan_entries
     SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('decided_recheck', $2::jsonb),
         updated_at = NOW()
     WHERE id = $1 AND status = 'queued'
     RETURNING id`,
    [target.id, JSON.stringify(stamp)]
  );
  return result.rowCount === 1 ? verdict.verdict : 'stale';
}

export { classifySourceLink, resolveDuplicateChain, type SourceLinkClass };


// DNS lookup that validates EVERY resolved address against the blocklist and
// pins the connection to a validated IP. Passed as http(s).request's `lookup`
// option, so the IP we approve is the exact IP connected to — this closes the
// DNS-rebinding / DNS-based-SSRF hole (a hostname resolving to 169.254.169.254
// or an RFC1918 host) and the TOCTOU window between validation and connect.
function validatingLookup(hostname: string, options: any, callback: any): void {
  const all = options && typeof options === 'object' ? options.all : false;
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses: any) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [addresses];
    for (const a of list) {
      if (isBlockedHost(a.address)) {
        return callback(new Error(`SSRF blocked: ${hostname} resolves to non-public ${a.address}`));
      }
    }
    if (all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

interface HeadResult { status: number; location: string | null }

function safeHeadRequest(u: URL): Promise<HeadResult> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      u,
      { method: 'HEAD', lookup: validatingLookup as any, timeout: 10_000 },
      (res) => {
        res.resume(); // drain, we never read the body
        resolve({ status: res.statusCode || 0, location: (res.headers.location as string) || null });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function resolveShortener(url: string): Promise<string | null> {
  let current = url;
  try {
    for (let hop = 0; hop < 4; hop++) {
      const safe = isSafeHttpUrl(current);
      if (!safe) return null;
      const res = await safeHeadRequest(safe);   // host validated + IP-pinned inside
      // Redirect? validate the next hop before following it.
      if (res.status >= 300 && res.status < 400) {
        if (!res.location) return null;
        const next = new URL(res.location, safe).toString();   // resolve relative redirects
        if (!isSafeHttpUrl(next)) return null;
        current = next;
        continue;
      }
      // Terminal response — the safe, fully-resolved URL
      if (current !== url && classifySourceLink(current) === 'ok') return current;
      return null;
    }
  } catch { /* fall through */ }
  return null; // too many hops or error
}

/**
 * Source-link quality sweep: classify every fresh queued entry's link,
 * auto-resolve shorteners to their real destination, and annotate entries
 * whose only source is a placeholder or tweet so the operator (and the
 * approval guard) see it. Never archives or declines — flag, don't filter.
 */
async function sweepSourceLinks(pool: Pool): Promise<number> {
  const batch = await pool.query(
    `SELECT id, source_url FROM scan_entries
     WHERE status = 'queued' AND (metadata -> 'source_link') IS NULL
       AND created_at > NOW() - INTERVAL '7 days'
     ORDER BY created_at ASC LIMIT 30`
  );

  let flagged = 0;
  for (const row of batch.rows as Array<{ id: number; source_url: string | null }>) {
    let cls = classifySourceLink(row.source_url);

    if (cls === 'shortener' && row.source_url) {
      const resolved = await resolveShortener(row.source_url);
      if (resolved) {
        await pool.query(`UPDATE scan_entries SET source_url = $2 WHERE id = $1`, [row.id, resolved]);
        console.log(`[DecidedRecheck] #${row.id}: resolved shortener → ${resolved}`);
        cls = 'ok';
      }
    }

    const note =
      cls === 'missing' || cls === 'placeholder' ? '⚠ No real source link — a primary URL is required before this can publish' :
      cls === 'invalid' ? '⚠ Source URL is invalid — replace it with an HTTP or HTTPS primary source' :
      cls === 'shortener' ? '⚠ Source is an unresolved shortener (resolution failed) — fix before publish' :
      cls === 'tweet-only' ? '⚠ Source is a tweet link only — find the primary program page before publishing' : null;

    if (note) {
      await pool.query(
        `UPDATE scan_entries SET
           operator_notes = CONCAT_WS(E'\n', NULLIF(operator_notes, ''), $2::text),
           metadata = metadata || jsonb_build_object('source_link', $3::text)
         WHERE id = $1 AND NOT COALESCE(operator_notes, '') LIKE '%' || $2 || '%'`,
        [row.id, note, cls]
      );
      flagged++;
    } else {
      await pool.query(
        `UPDATE scan_entries SET metadata = metadata || jsonb_build_object('source_link', $2::text) WHERE id = $1`,
        [row.id, cls]
      );
    }
  }
  if (flagged > 0) console.log(`[DecidedRecheck] Source-link sweep: ${batch.rows.length} checked, ${flagged} flagged`);
  return flagged;
}

export async function runDecidedRecheck(pool: Pool): Promise<{ checked: number; duplicates: number; updates: number; distinct: number; errors: number }> {
  if (isRunning) {
    return { checked: 0, duplicates: 0, updates: 0, distinct: 0, errors: 0 };
  }
  isRunning = true;
  const stats = { checked: 0, duplicates: 0, updates: 0, distinct: 0, errors: 0 };

  try {
    // Phase 0: source-link quality sweep (cheap, independent gating)
    try {
      await sweepSourceLinks(pool);
    } catch (err) {
      console.error('[DecidedRecheck] Source-link sweep failed:', err);
    }

    const batch = await pool.query(
      `SELECT id, wire, name, description, source_url, deadline
       FROM scan_entries
       WHERE status = 'queued'
         AND (metadata -> 'decided_recheck') IS NULL
         AND created_at > NOW() - INTERVAL '7 days'
       ORDER BY created_at ASC
       LIMIT $1`,
      [BATCH_SIZE]
    );

    for (const target of batch.rows as RecheckTarget[]) {
      try {
        const candidates = await findCandidates(pool, target);
        if (candidates.length === 0) {
          await pool.query(
            `UPDATE scan_entries SET metadata = metadata || '{"decided_recheck": {"verdict": "no_candidates"}}'::jsonb WHERE id = $1`,
            [target.id]
          );
          stats.checked++;
          continue;
        }

        const verdict = await judgeCandidates(target, candidates);
        if (!verdict) {
          await pool.query(
            `UPDATE scan_entries SET metadata = metadata || '{"decided_recheck": {"verdict": "skipped-error"}}'::jsonb WHERE id = $1`,
            [target.id]
          );
          stats.errors++;
          continue;
        }

        const outcome = await applyVerdict(pool, target, candidates, verdict);
        if (outcome === 'duplicate') stats.duplicates++;
        else if (outcome === 'update-noted') stats.updates++;
        else stats.distinct++;
        stats.checked++;
        console.log(`[DecidedRecheck] #${target.id} "${target.name.slice(0, 50)}" → ${outcome}${verdict.matched_id ? ` (vs #${verdict.matched_id})` : ''}`);
      } catch (err) {
        stats.errors++;
        // Mark so a persistent failure doesn't retry forever
        await pool.query(
          `UPDATE scan_entries SET metadata = metadata || '{"decided_recheck": {"verdict": "skipped-error"}}'::jsonb WHERE id = $1`,
          [target.id]
        ).catch(() => {});
        console.error(`[DecidedRecheck] Error on entry ${target.id}:`, err instanceof Error ? err.message : err);
      }
    }

    if (stats.checked > 0 || stats.errors > 0) {
      console.log(`[DecidedRecheck] Done: ${stats.checked} checked, ${stats.duplicates} duplicates, ${stats.updates} updates noted, ${stats.errors} errors`);
    }
  } finally {
    isRunning = false;
  }

  return stats;
}

// Exposed for unit testing the SSRF guard
export const __ssrf = {
  isSafeHttpUrl: (u: string): boolean => isSafeHttpUrl(u) !== null,
  isBlockedHost,
  // Resolves a hostname through the same validating lookup used for real
  // connections; returns true if it would be allowed, false if blocked.
  validatesClean: (hostname: string): Promise<boolean> => new Promise((res) => {
    validatingLookup(hostname, { all: true }, (err: any) => res(!err));
  }),
};
