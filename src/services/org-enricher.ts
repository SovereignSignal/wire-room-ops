/**
 * Organization Enricher
 *
 * Uses Grok LLM (with web_search tool) to classify and enrich org_profiles with:
 * - org_type (Web2, Non-Profit/NGO, etc.)
 * - source_type (X Account, Forum, Blog, etc.)
 * - website URL
 * - twitter URL
 * - github_url
 * - description (1-2 sentences)
 * - tags (3-5 lowercase keywords)
 * - last_signal (most recent notable thing they shipped/announced)
 * - source (a URL backing the claims)
 *
 * Also computes derived fields:
 * - avg_quality_score from linked scan_entries
 * - tier from entry_count + avg_quality_score rules
 */

import { getPool } from '../db';
import { getCachedProvider, isProviderExplicitlyDisabled } from './api-provider';
import { logApiUsage } from './api-usage';
import { resolveGrokSearchModel } from './grok';
import { findDeadUrlFields } from './url-verify';

// ============================================================
// Allowed enum values
// ============================================================

const VALID_ORG_TYPES = [
  'Web2', 'Non-Profit/NGO', 'Corporate', 'Ecosystem DAO',
  'Protocol DAO', 'Foundation/Lab', 'Education', 'Government', 'Healthcare',
];

const VALID_SOURCE_TYPES = [
  'X Account', 'Forum', 'Blog', 'Website', 'Newsletter',
  'Discord', 'Protocol/Infrastructure', 'Advocate', 'Official',
];

// ============================================================
// Exported types
// ============================================================

export interface EnrichedOrg {
  id: number;
  org_type: string | null;
  source_type: string | null;
  website: string | null;
  twitter: string | null;
  github_url: string | null;
  description: string | null;
  tags: string[];
  last_signal: string | null;
  operator_read: string | null;
  source: string | null;
}

// ============================================================
// Pure parse/validate function (exported for testing)
// ============================================================

export class EnrichmentResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnrichmentResponseError';
  }
}

function parseSafeId(value: unknown): number {
  const normalized = typeof value === 'string' && /^\d+$/.test(value.trim())
    ? Number(value.trim())
    : value;
  if (typeof normalized !== 'number' || !Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new EnrichmentResponseError('response contains a missing or invalid org id');
  }
  return normalized;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nullableHttpUrl(value: unknown): string | null {
  const candidate = nullableString(value);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Parse and validate a raw JSON string returned by Grok enrichment.
 * Invalid JSON, empty arrays, unsafe IDs, duplicates, and IDs outside the
 * submitted batch throw so callers cannot partially write uncertain data.
 */
export function parseEnrichmentResponse(
  text: string,
  allowedIds?: ReadonlySet<number>,
): EnrichedOrg[] {
  // Strip markdown code fences
  const stripped = text.replace(/^```[\w]*\n?/m, '').replace(/\n?```$/m, '').trim();

  // Extract JSON array
  const arrayMatch = stripped.match(/\[[\s\S]*\]/);
  if (!arrayMatch) throw new EnrichmentResponseError('response does not contain a JSON array');

  let parsed: unknown[];
  try {
    const result = JSON.parse(arrayMatch[0]);
    if (!Array.isArray(result)) throw new EnrichmentResponseError('response JSON must be an array');
    parsed = result;
  } catch (err) {
    if (err instanceof EnrichmentResponseError) throw err;
    throw new EnrichmentResponseError('response contains malformed JSON');
  }

  if (parsed.length === 0) throw new EnrichmentResponseError('response array is empty');

  const seenIds = new Set<number>();
  return parsed.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new EnrichmentResponseError('response contains a non-object item');
    }
    const o = item as Record<string, unknown>;
    const id = parseSafeId(o.id);
    if (seenIds.has(id)) throw new EnrichmentResponseError(`response contains duplicate org id ${id}`);
    if (allowedIds && !allowedIds.has(id)) {
      throw new EnrichmentResponseError(`response contains org id ${id} outside the submitted batch`);
    }
    seenIds.add(id);

    const tags = Array.isArray(o.tags)
      ? [...new Set(o.tags
        .filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
        .map(tag => tag.trim()))].slice(0, 5)
      : [];

    return {
      id,
      org_type: typeof o.org_type === 'string' && VALID_ORG_TYPES.includes(o.org_type.trim())
        ? o.org_type.trim()
        : null,
      source_type: typeof o.source_type === 'string' && VALID_SOURCE_TYPES.includes(o.source_type.trim())
        ? o.source_type.trim()
        : null,
      website: nullableHttpUrl(o.website),
      twitter: nullableHttpUrl(o.twitter),
      github_url: nullableHttpUrl(o.github_url),
      description: nullableString(o.description),
      tags,
      last_signal: nullableString(o.last_signal),
      operator_read: nullableString(o.operator_read),
      source: nullableHttpUrl(o.source),
    };
  });
}

// ============================================================
// LLM Enrichment (web-augmented via Grok Responses API)
// ============================================================

export function formatEnrichmentParseError(err: unknown, model: string, content: string): string {
  const base = err instanceof Error ? err.message : String(err);
  const preview = content.trim().replace(/\s+/g, ' ').slice(0, 200);
  return preview
    ? `${base} [model=${model} preview=${JSON.stringify(preview)}]`
    : `${base} [model=${model} empty output]`;
}

// Response format for the /v1/responses endpoint (mirrors grok.ts)
interface ResponsesAPIOutput {
  type: string;
  content?: Array<{ type: string; text?: string }>;
}
interface ResponsesAPIResponse {
  output: ResponsesAPIOutput[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Enrich a batch of orgs via Grok LLM with web search enabled.
 * Returns a map of org id → enrichment data.
 */
export async function enrichOrgs(
  orgs: Array<{ id: number; name: string; wires: string[]; entry_count: number }>
): Promise<Map<number, EnrichedOrg>> {
  const results = new Map<number, EnrichedOrg>();
  if (orgs.length === 0) return results;

  const allowedIds = new Set(orgs.map(org => org.id));
  if (allowedIds.size !== orgs.length || [...allowedIds].some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('Org enrichment input contains unsafe or duplicate IDs');
  }

  const provider = getCachedProvider('grok');
  if (!provider?.api_key) {
    throw new Error(isProviderExplicitlyDisabled('grok')
      ? 'Grok provider is disabled'
      : 'Grok API key not configured');
  }
  const apiKey = provider.api_key;

  // Strip trailing /v1 to build the Responses API URL (mirrors grok.ts line 176)
  const baseUrl = (provider.base_url || 'https://api.x.ai/v1').replace(/\/v1$/, '');
  const model = resolveGrokSearchModel(provider.default_model);
  const configuredModel = (provider.default_model || '').trim();
  if (configuredModel && model !== configuredModel) {
    console.warn(`[OrgEnricher] grok default_model "${configuredModel}" cannot use web_search; using ${model}`);
  }

  const orgList = orgs.map((o, i) =>
    `${i + 1}. [ID:${o.id}] "${o.name}" (wires: ${o.wires.join(', ')}, entries: ${o.entry_count})`
  ).join('\n');

  const prompt = `You are enriching organizations in a business-development intelligence asset for a senior operator-for-hire whose specialty is FUNDING ECOSYSTEMS (grant program operations, ecosystem BD/partnerships/revenue, governance operations). For each org below, research it on the web and return a JSON array with these fields:

- id: the numeric ID shown in brackets
- org_type: exactly one of: ${VALID_ORG_TYPES.join(', ')}
- source_type: exactly one of: ${VALID_SOURCE_TYPES.join(', ')}
- website: the org's primary website URL (https://...), or null if unknown
- twitter: the org's Twitter/X URL (https://x.com/...), or null if unknown
- github_url: the org's GitHub URL (https://github.com/...), or null if unknown
- description: 2-3 sentences, BD lens: what the org is AND how it runs funding/programs — do they operate grant/ecosystem/credit programs, who runs them (name teams or leads when sourced), are those programs growing, restructuring, or winding down? Written for an operator deciding whether this org could need him.
- tags: 3-5 lowercase keywords describing the org (e.g. ["defi","grants","ethereum"])
- last_signal: the most recent CONCRETE org-side trigger, dated (~last 60 days if any): a program launched/expanded/paused, a fund raised/allocated, a key hire or departure, a governance change. If nothing recent, the most recent notable event with its date.
- operator_read: one blunt sentence — the org-side operator need (or absence of one) an outside senior operator could serve right now, e.g. "scaling a new $30M fund with a 2-person team" or "mature program, no visible gap". Ground it in what you found; never invent need.
- source: a URL (https://...) that backs the claims you are making

Rules:
- Use web search to find current, accurate information
- Only return URLs you can verify — do not guess
- Twitter URLs should use x.com format
- Return ONLY the JSON array. No explanation, no markdown fences.

Organizations:
${orgList}`;

  const start = Date.now();

  let response: Response;
  try {
    // Use the Responses API with web_search tool — mirrors executeScanPrompt in grok.ts
    response = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      signal: AbortSignal.timeout(180_000),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search' }],
      }),
    });
  } catch (err) {
    logApiUsage({ provider: 'grok', model, purpose: 'org-enrichment', duration_ms: Date.now() - start, success: false, error_message: String(err) });
    throw err;
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'unknown');
    logApiUsage({ provider: 'grok', model, purpose: 'org-enrichment', duration_ms: Date.now() - start, success: false, error_message: `${response.status} ${errorText.slice(0, 200)}`.trim() });
    throw new Error(`Grok returned ${response.status}: ${errorText}`);
  }

  let data: ResponsesAPIResponse;
  try {
    data = await response.json() as ResponsesAPIResponse;
  } catch {
    const error = new EnrichmentResponseError('malformed Grok API response JSON');
    logApiUsage({
      provider: 'grok', model, purpose: 'org-enrichment', duration_ms: Date.now() - start,
      success: false, error_message: error.message,
    });
    throw error;
  }

  // Extract text from the Responses API output (mirrors grok.ts lines 203-211)
  let content = '';
  for (const item of data.output || []) {
    if (item.type === 'message' && item.content) {
      for (const block of item.content) {
        if (block.type === 'output_text' && block.text) {
          content += block.text;
        }
      }
    }
  }

  let enriched: EnrichedOrg[];
  try {
    enriched = parseEnrichmentResponse(content, allowedIds);
  } catch (err) {
    const error_message = formatEnrichmentParseError(err, model, content);
    logApiUsage({
      provider: 'grok', model, purpose: 'org-enrichment', duration_ms: Date.now() - start,
      tokens_in: data.usage?.input_tokens, tokens_out: data.usage?.output_tokens,
      success: false,
      error_message,
    });
    throw new EnrichmentResponseError(error_message);
  }

  logApiUsage({
    provider: 'grok', model, purpose: 'org-enrichment', duration_ms: Date.now() - start,
    tokens_in: data.usage?.input_tokens, tokens_out: data.usage?.output_tokens,
  });

  for (const item of enriched) {
    results.set(item.id, item);
  }

  return results;
}

/**
 * Batch-enrich unenriched org profiles.
 * Processes in chunks of 10 with 2s delay between batches.
 */
export async function enrichBatch(opts?: {
  force?: boolean;
  limit?: number;
}): Promise<{ enriched: number; errors: number }> {
  const pool = getPool();
  const limit = Math.min(opts?.limit || 200, 200);
  const stats = { enriched: 0, errors: 0 };

  const { rows: orgs } = await pool.query(
    `SELECT id, name, wires, entry_count FROM org_profiles
     WHERE ($1::boolean OR enriched_at IS NULL OR enriched_at < NOW() - INTERVAL '30 days')
     ORDER BY entry_count DESC LIMIT $2`,
    [!!opts?.force, limit]
  );

  if (orgs.length === 0) {
    console.log('[OrgEnricher] No orgs to enrich');
    return stats;
  }

  console.log(`[OrgEnricher] Enriching ${orgs.length} orgs...`);

  const CHUNK_SIZE = 10;
  for (let i = 0; i < orgs.length; i += CHUNK_SIZE) {
    const chunk = orgs.slice(i, i + CHUNK_SIZE);

    try {
      const enrichments = await enrichOrgs(chunk);

      for (const [orgId, data] of enrichments) {
        try {
          // Drop any URL fields that are definitively 404/410 (hallucination guard).
          // Fields that are blocked (403/429) or time out remain unchanged (inconclusive).
          const deadFields = await findDeadUrlFields(data);
          if (deadFields.length > 0) {
            const today = new Date().toISOString().slice(0, 10);
            for (const field of deadFields) {
              console.warn(`[OrgEnricher] Dropping ${field} for org ${orgId} (404/410): ${(data as unknown as Record<string, unknown>)[field]}`);
              (data as unknown as Record<string, unknown>)[field] = null;
            }
            // Append dropped-URL note to provenance; will be written with the source note below
            const dropNote = deadFields.map(f => `[dropped ${f}: 404]`).join(' ');
            data.source = data.source
              ? `${data.source} ${dropNote}`
              : dropNote;
            // If source itself was 404 and nulled by findDeadUrlFields, it won't appear here
            // because findDeadUrlFields only checks website/github_url/twitter.
            // Append the drop note to relationship_context directly when source is null.
            if (!data.source || data.source === dropNote) {
              // Keep the note accessible; it will land in relationship_context via the source param below
            }
            void today; // used implicitly via toISOString above
          }

          await pool.query(
            `UPDATE org_profiles SET
              org_type = COALESCE($1, org_type),
              source_type = COALESCE($2, source_type),
              website = COALESCE($3, website),
              twitter = COALESCE($4, twitter),
              github_url = COALESCE($5, github_url),
              description = COALESCE($6, description),
              operator_read = COALESCE($11, operator_read),
              tags = CASE WHEN array_length($7::text[],1) IS NULL THEN tags
                          ELSE (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tags,'{}') || $7::text[]))) END,
              last_signal = $8,
              relationship_context = CASE WHEN $9::text IS NULL THEN relationship_context
                   ELSE left(COALESCE(relationship_context,'') || E'\n[enriched ' || to_char(NOW(),'YYYY-MM-DD') || '] source: ' || $9, 4000) END,
              enriched_at = NOW(), updated_at = NOW()
            WHERE id = $10`,
            [
              data.org_type, data.source_type, data.website, data.twitter,
              data.github_url, data.description,
              data.tags.length > 0 ? data.tags : null,
              data.last_signal, data.source, orgId,
              data.operator_read,
            ]
          );
          stats.enriched++;
        } catch (err) {
          console.error(`[OrgEnricher] DB update failed for org ${orgId}:`, err);
          stats.errors++;
        }
      }

      // Partial responses are retryable failures. Leave omitted rows unstamped
      // so the next enrichment cycle can recover them.
      const omittedCount = chunk.filter(org => !enrichments.has(org.id)).length;
      if (omittedCount > 0) {
        console.warn(`[OrgEnricher] Grok omitted ${omittedCount}/${chunk.length} orgs; leaving them eligible for retry`);
        stats.errors += omittedCount;
      }
    } catch (err) {
      console.error(`[OrgEnricher] Batch failed:`, err);
      stats.errors += chunk.length;
    }

    // Rate limit between batches
    if (i + CHUNK_SIZE < orgs.length) {
      await new Promise(r => setTimeout(r, 10000));
    }
  }

  console.log(`[OrgEnricher] Done: ${stats.enriched} enriched, ${stats.errors} errors`);
  return stats;
}

/**
 * Enrich a single org by ID. Skips if already enriched (idempotent).
 * Used in the approve flow for fire-and-forget enrichment.
 */
export async function enrichSingleOrg(orgId: number): Promise<void> {
  const pool = getPool();

  const { rows } = await pool.query(
    `SELECT id, name, wires, entry_count, enriched_at FROM org_profiles WHERE id = $1`,
    [orgId]
  );

  if (rows.length === 0) return;
  if (rows[0].enriched_at) return; // Already enriched

  const org = rows[0];

  try {
    const enrichments = await enrichOrgs([org]);
    const data = enrichments.get(orgId);

    if (data) {
      // Drop any URL fields that are definitively 404/410 (hallucination guard).
      const deadFields = await findDeadUrlFields(data);
      if (deadFields.length > 0) {
        for (const field of deadFields) {
          console.warn(`[OrgEnricher] Dropping ${field} for org ${orgId} (404/410): ${(data as unknown as Record<string, unknown>)[field]}`);
          (data as unknown as Record<string, unknown>)[field] = null;
        }
        const dropNote = deadFields.map(f => `[dropped ${f}: 404]`).join(' ');
        data.source = data.source ? `${data.source} ${dropNote}` : dropNote;
      }

      await pool.query(
        `UPDATE org_profiles SET
          org_type = COALESCE($1, org_type),
          source_type = COALESCE($2, source_type),
          website = COALESCE($3, website),
          twitter = COALESCE($4, twitter),
          github_url = COALESCE($5, github_url),
          description = COALESCE($6, description),
          operator_read = COALESCE($11, operator_read),
          tags = CASE WHEN array_length($7::text[],1) IS NULL THEN tags
                      ELSE (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tags,'{}') || $7::text[]))) END,
          last_signal = $8,
          relationship_context = CASE WHEN $9::text IS NULL THEN relationship_context
               ELSE left(COALESCE(relationship_context,'') || E'\n[enriched ' || to_char(NOW(),'YYYY-MM-DD') || '] source: ' || $9, 4000) END,
          enriched_at = NOW(), updated_at = NOW()
        WHERE id = $10 AND enriched_at IS NULL`,
        [
          data.org_type, data.source_type, data.website, data.twitter,
          data.github_url, data.description,
          data.tags.length > 0 ? data.tags : null,
          data.last_signal, data.source, orgId, data.operator_read,
        ]
      );
    } else {
      console.warn(`[OrgEnricher] Grok omitted org id=${orgId}; leaving it eligible for retry`);
      return;
    }

    console.log(`[OrgEnricher] Enriched org id=${orgId} "${org.name}"`);
  } catch (err) {
    console.error(`[OrgEnricher] Failed to enrich org ${orgId}:`, err);
  }
}

// ============================================================
// Derived field computation
// ============================================================

/**
 * Compute avg_quality_score and tier for all org profiles in a single bulk UPDATE.
 * - avg_quality_score: average quality_score of linked approved/queued entries
 * - tier: Tier 1 (entry_count >= 5 AND avg >= 60), Tier 2 (entry_count >= 2 OR avg >= 50), else Tier 3
 */
export async function computeDerivedFields(): Promise<{ updated: number }> {
  const pool = getPool();

  const result = await pool.query(`
    UPDATE org_profiles op SET
      entry_count = sub.real_entry_count,
      avg_quality_score = sub.avg_score,
      tier = CASE
        WHEN sub.real_entry_count >= 5 AND sub.avg_score >= 60 THEN 'Tier 1 - Official'
        WHEN sub.real_entry_count >= 2 OR sub.avg_score >= 50 THEN 'Tier 2 - Secondary'
        ELSE 'Tier 3 - Monitor'
      END,
      updated_at = NOW()
    FROM (
      SELECT
        op2.id,
        COUNT(se.id)::int AS real_entry_count,
        ROUND(AVG(se.quality_score)::numeric, 1) AS avg_score
      FROM org_profiles op2
      LEFT JOIN scan_entries se ON se.org_id = op2.id AND se.status IN ('queued', 'approved')
      GROUP BY op2.id
    ) sub
    WHERE op.id = sub.id
  `);

  const updated = result.rowCount ?? 0;
  console.log(`[OrgEnricher] Computed derived fields for ${updated} orgs`);
  return { updated };
}
