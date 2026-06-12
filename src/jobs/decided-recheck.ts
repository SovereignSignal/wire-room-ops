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
import { getCachedProvider } from '../services/api-provider';
import { logApiUsage } from '../services/api-usage';
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
  const stamp = { at: new Date().toISOString(), verdict: verdict.verdict, matched_id: verdict.matched_id, confidence: verdict.confidence };

  if (verdict.verdict === 'same_listing' && matched && verdict.confidence >= 0.8
      && ['approved', 'declined', 'queued'].includes(matched.status)) {
    await pool.query(
      `UPDATE scan_entries SET status = 'duplicate', duplicate_of_id = $2,
         duplicate_reason = $3::text, actioned_by = 'decided-recheck',
         metadata = metadata || jsonb_build_object('decided_recheck', $4::jsonb)
       WHERE id = $1 AND status = 'queued'`,
      [target.id, matched.id, `Same listing as #${matched.id} "${matched.name.slice(0, 80)}" (${matched.status} ${matched.decided_date}): ${verdict.reason}`.slice(0, 400), JSON.stringify(stamp)]
    );
    return 'duplicate';
  }

  if (verdict.verdict === 'update' && matched) {
    await pool.query(
      `UPDATE scan_entries SET
         operator_notes = CONCAT_WS(E'\n', NULLIF(operator_notes, ''), $2::text),
         metadata = metadata || jsonb_build_object('decided_recheck', $3::jsonb, 'related_decided', $4::int)
       WHERE id = $1 AND status = 'queued'`,
      [target.id, `↻ Update of #${matched.id} "${matched.name.slice(0, 80)}" (${matched.status} ${matched.decided_date}): ${verdict.reason}`.slice(0, 400), JSON.stringify(stamp), matched.id]
    );
    return 'update-noted';
  }

  await pool.query(
    `UPDATE scan_entries SET metadata = metadata || jsonb_build_object('decided_recheck', $2::jsonb) WHERE id = $1`,
    [target.id, JSON.stringify(stamp)]
  );
  return verdict.verdict;
}

export type SourceLinkClass = 'missing' | 'placeholder' | 'shortener' | 'tweet-only' | 'ok';

export function classifySourceLink(url: string | null | undefined): SourceLinkClass {
  const u = (url || '').trim();
  if (!u) return 'missing';
  if (u.startsWith('https://t.me/manual/') || u.startsWith('scan://')) return 'placeholder';
  if (/^https?:\/\/(t\.co|bit\.ly|tinyurl\.com|buff\.ly|ow\.ly)\//i.test(u)) return 'shortener';
  if (/^https?:\/\/(x|twitter)\.com\//i.test(u)) return 'tweet-only';
  return 'ok';
}

// Block resolution to non-public addresses. Shortener targets come from
// scraped tweets (untrusted), so an attacker could point one at cloud
// metadata (169.254.169.254) or an internal Railway host. We validate the
// host at every hop and never let fetch auto-follow redirects.
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  // IPv4 literal?
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some(n => n > 255)) return true;
    const [a, b] = o;
    if (a === 0 || a === 127 || a === 10 || a >= 224) return true;            // 0/8, loopback, 10/8, multicast/reserved
    if (a === 169 && b === 254) return true;                                  // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;                         // 172.16/12
    if (a === 192 && b === 168) return true;                                  // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true;                        // CGNAT 100.64/10
    return false;
  }
  // IPv6 literal — block loopback, link-local, ULA, unspecified
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;
    if (h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true;
    if (h.startsWith('::ffff:')) return true;                                 // IPv4-mapped — reject; can't cheaply re-validate here
    return false;
  }
  return false; // a DNS name; the per-hop fetch below resolves it and we re-check the final URL
}

function isSafeHttpUrl(raw: string): URL | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;               // reject user:pass@ userinfo
  if (isBlockedHost(u.hostname)) return null;
  return u;
}

async function resolveShortener(url: string): Promise<string | null> {
  let current = url;
  try {
    for (let hop = 0; hop < 4; hop++) {
      const safe = isSafeHttpUrl(current);
      if (!safe) return null;
      const res = await fetch(safe.toString(), { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      // Redirect? validate the next hop before following it.
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return null;
        const next = new URL(loc, safe).toString();      // resolve relative redirects
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
export const __ssrf = { isSafeHttpUrl: (u: string): boolean => isSafeHttpUrl(u) !== null, isBlockedHost };
