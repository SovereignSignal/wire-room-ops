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

import { config } from '../config';
import { getPool } from '../db';
import { getCachedProvider } from './api-provider';

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
  source: string | null;
}

// ============================================================
// Pure parse/validate function (exported for testing)
// ============================================================

/**
 * Parse and validate a raw JSON string returned by Grok enrichment.
 * Strips markdown fences, validates per-field, returns [] on any parse error.
 */
export function parseEnrichmentResponse(text: string): EnrichedOrg[] {
  // Strip markdown code fences
  const stripped = text.replace(/^```[\w]*\n?/m, '').replace(/\n?```$/m, '').trim();

  // Extract JSON array
  const arrayMatch = stripped.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return [];

  let parsed: unknown[];
  try {
    const result = JSON.parse(arrayMatch[0]);
    if (!Array.isArray(result)) return [];
    parsed = result;
  } catch {
    return [];
  }

  return parsed.map((item) => {
    const o = item as Record<string, unknown>;

    const isHttpUrl = (v: unknown): boolean =>
      typeof v === 'string' && v.startsWith('http');

    return {
      id: Number(o['id']),
      org_type: typeof o['org_type'] === 'string' && VALID_ORG_TYPES.includes(o['org_type'])
        ? o['org_type']
        : null,
      source_type: typeof o['source_type'] === 'string' ? o['source_type'] : null,
      website: isHttpUrl(o['website']) ? (o['website'] as string) : null,
      twitter: isHttpUrl(o['twitter']) ? (o['twitter'] as string) : null,
      github_url: isHttpUrl(o['github_url']) ? (o['github_url'] as string) : null,
      description: typeof o['description'] === 'string' ? o['description'] : null,
      tags: Array.isArray(o['tags'])
        ? (o['tags'] as unknown[]).slice(0, 5).map(String)
        : [],
      last_signal: typeof o['last_signal'] === 'string' ? o['last_signal'] : null,
      source: isHttpUrl(o['source']) ? (o['source'] as string) : null,
    };
  });
}

// ============================================================
// LLM Enrichment (web-augmented via Grok Responses API)
// ============================================================

// Model that supports the web_search tool via the Responses API
const ENRICH_MODEL = 'grok-4.20-beta-0309-non-reasoning';

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

  const provider = getCachedProvider('grok');
  const apiKey = provider?.api_key || config.apis.grok.apiKey;

  if (!apiKey) {
    console.warn('[OrgEnricher] No Grok API key — skipping enrichment');
    return results;
  }

  // Strip trailing /v1 to build the Responses API URL (mirrors grok.ts line 176)
  const baseUrl = (provider?.base_url || config.apis.grok.baseUrl).replace(/\/v1$/, '');
  const model = provider?.default_model || ENRICH_MODEL;

  const orgList = orgs.map((o, i) =>
    `${i + 1}. [ID:${o.id}] "${o.name}" (wires: ${o.wires.join(', ')}, entries: ${o.entry_count})`
  ).join('\n');

  const prompt = `You are enriching organizations that appear in a grant/funding discovery pipeline. For each org below, research it on the web and return a JSON array with these fields:

- id: the numeric ID shown in brackets
- org_type: exactly one of: ${VALID_ORG_TYPES.join(', ')}
- source_type: exactly one of: ${VALID_SOURCE_TYPES.join(', ')}
- website: the org's primary website URL (https://...), or null if unknown
- twitter: the org's Twitter/X URL (https://x.com/...), or null if unknown
- github_url: the org's GitHub URL (https://github.com/...), or null if unknown
- description: 1-2 sentences describing what the org does
- tags: 3-5 lowercase keywords describing the org (e.g. ["defi","grants","ethereum"])
- last_signal: the most recent notable thing they shipped, announced, or funded (1 sentence)
- source: a URL (https://...) that backs the claims you are making

Rules:
- Use web search to find current, accurate information
- Only return URLs you can verify — do not guess
- Twitter URLs should use x.com format
- Return ONLY the JSON array. No explanation, no markdown fences.

Organizations:
${orgList}`;

  // Use the Responses API with web_search tool — mirrors executeScanPrompt in grok.ts
  const response = await fetch(`${baseUrl}/v1/responses`, {
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

  if (!response.ok) {
    throw new Error(`Grok returned ${response.status}: ${await response.text().catch(() => 'unknown')}`);
  }

  const data = await response.json() as ResponsesAPIResponse;

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

  if (!content) {
    console.warn('[OrgEnricher] No text content in Grok Responses API reply');
    return results;
  }

  const enriched = parseEnrichmentResponse(content.trim());
  if (enriched.length === 0) {
    console.warn('[OrgEnricher] No JSON array in Grok response');
    return results;
  }

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
          await pool.query(
            `UPDATE org_profiles SET
              org_type = COALESCE($1, org_type),
              source_type = COALESCE($2, source_type),
              website = COALESCE($3, website),
              twitter = COALESCE($4, twitter),
              github_url = COALESCE($5, github_url),
              description = COALESCE($6, description),
              tags = CASE WHEN array_length($7::text[],1) IS NULL THEN tags
                          ELSE (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tags,'{}') || $7::text[]))) END,
              last_signal = COALESCE($8, last_signal),
              relationship_context = CASE WHEN $9::text IS NULL THEN relationship_context
                   ELSE left(COALESCE(relationship_context,'') || E'\n[enriched ' || to_char(NOW(),'YYYY-MM-DD') || '] source: ' || $9, 4000) END,
              enriched_at = NOW(), updated_at = NOW()
            WHERE id = $10`,
            [
              data.org_type, data.source_type, data.website, data.twitter,
              data.github_url, data.description,
              data.tags.length > 0 ? data.tags : null,
              data.last_signal, data.source, orgId,
            ]
          );
          stats.enriched++;
        } catch (err) {
          console.error(`[OrgEnricher] DB update failed for org ${orgId}:`, err);
          stats.errors++;
        }
      }

      // Mark orgs that weren't in the response as enriched (with no data) to avoid re-processing
      for (const org of chunk) {
        if (!enrichments.has(org.id)) {
          await pool.query(
            `UPDATE org_profiles SET enriched_at = NOW(), updated_at = NOW() WHERE id = $1 AND enriched_at IS NULL`,
            [org.id]
          );
        }
      }
    } catch (err) {
      console.error(`[OrgEnricher] Batch failed:`, err);
      stats.errors += chunk.length;
    }

    // Rate limit between batches
    if (i + CHUNK_SIZE < orgs.length) {
      await new Promise(r => setTimeout(r, 2000));
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
      await pool.query(
        `UPDATE org_profiles SET
          org_type = COALESCE($1, org_type),
          source_type = COALESCE($2, source_type),
          website = COALESCE($3, website),
          twitter = COALESCE($4, twitter),
          github_url = COALESCE($5, github_url),
          description = COALESCE($6, description),
          tags = CASE WHEN array_length($7::text[],1) IS NULL THEN tags
                      ELSE (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tags,'{}') || $7::text[]))) END,
          last_signal = COALESCE($8, last_signal),
          relationship_context = CASE WHEN $9::text IS NULL THEN relationship_context
               ELSE left(COALESCE(relationship_context,'') || E'\n[enriched ' || to_char(NOW(),'YYYY-MM-DD') || '] source: ' || $9, 4000) END,
          enriched_at = NOW(), updated_at = NOW()
        WHERE id = $10 AND enriched_at IS NULL`,
        [
          data.org_type, data.source_type, data.website, data.twitter,
          data.github_url, data.description,
          data.tags.length > 0 ? data.tags : null,
          data.last_signal, data.source, orgId,
        ]
      );
    } else {
      // Mark as enriched even if no data returned
      await pool.query(
        `UPDATE org_profiles SET enriched_at = NOW(), updated_at = NOW() WHERE id = $1 AND enriched_at IS NULL`,
        [orgId]
      );
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
